// Logging policy: never log keycodes, positions, characters, or event Debug values; counts only.
// Profile names are user-authored labels and may be printed.

#[path = "../config.rs"]
mod config;
#[path = "../control.rs"]
mod control;
#[path = "../registry.rs"]
mod registry;

use anyhow::{bail, Context, Result};
use config::Config;
use control::{ControlState, ControlWatcher};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::process::Command as Process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEVICE_LIVENESS_LIMIT: usize = 4;
const USAGE: &str = concat!(
    "usage: keylabctl status|pause|resume|profile list|profile set <name>\n",
    "       keylabctl devices list\n",
    "       keylabctl devices merge <from>[,<from>...] --into <id>"
);
/// A merge fails rather than queues behind a live daemon, so the wait is only long enough to lose
/// a race with a checkpoint, not long enough to look like a hang.
const LOCK_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status,
    Pause,
    Resume,
    ListProfiles,
    SetProfile(String),
    ListDevices,
    MergeDevices { sources: Vec<i64>, target: i64 },
}

fn parse_command(args: &[String]) -> Result<Command> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["status"] => Ok(Command::Status),
        ["pause"] => Ok(Command::Pause),
        ["resume"] => Ok(Command::Resume),
        ["profile", "list"] => Ok(Command::ListProfiles),
        ["profile", "set", name] => Ok(Command::SetProfile((*name).to_owned())),
        ["devices", "list"] => Ok(Command::ListDevices),
        ["devices", "merge", sources, "--into", target] => Ok(Command::MergeDevices {
            sources: parse_device_ids(sources)?,
            target: parse_device_id(target)?,
        }),
        _ => bail!("{USAGE}"),
    }
}

fn parse_device_ids(list: &str) -> Result<Vec<i64>> {
    list.split(',')
        .map(str::trim)
        .map(parse_device_id)
        .collect()
}

fn parse_device_id(value: &str) -> Result<i64> {
    let id: i64 = value
        .parse()
        .with_context(|| format!("{value:?} is not a device id"))?;
    if id <= 0 {
        bail!("{value:?} is not a device id");
    }
    Ok(id)
}

fn main() {
    let exit_code = match run() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("keylabctl: {error:#}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = parse_command(&args)?;
    let config = Config::load(&config::default_config_path()?)?;
    let data_dir = config
        .db_path
        .parent()
        .context("database path must have a parent directory")?
        .to_path_buf();
    let control_path = data_dir.join("control.json");

    // The watcher is the single reader of the file format; the CLI never parses it itself.
    let mut watcher = ControlWatcher::new(control_path.clone(), config.profiles.clone());
    let current = watcher.poll();

    match command {
        Command::Status => print_status(&config, &data_dir, &current),
        Command::Pause => update_state(&control_path, |mut latest| {
            latest.paused = true;
            latest
        }),
        Command::Resume => update_state(&control_path, |mut latest| {
            latest.paused = false;
            latest
        }),
        Command::ListProfiles => {
            for name in &config.profiles {
                let marker = if *name == current.profile { "*" } else { " " };
                println!("{marker} {name}");
            }
            Ok(())
        }
        Command::SetProfile(name) => {
            if !config.profiles.contains(&name) {
                bail!(
                    "unknown profile {name:?}; configured profiles are: {}",
                    config.profiles.join(", ")
                );
            }
            update_state(&control_path, |mut latest| {
                latest.profile = name;
                // An explicit profile change owns the state and cancels any trainer lease.
                latest.profile_lease = None;
                latest
            })
        }
        Command::ListDevices => list_devices(&config.db_path),
        Command::MergeDevices { sources, target } => {
            merge_devices(&config.db_path, &sources, target)
        }
    }
}

fn list_devices(db_path: &Path) -> Result<()> {
    let connection = open_readonly(db_path)?;
    let rows = registry::list_devices(&connection)?;
    print!("{}", registry::format_device_table(&rows));
    Ok(())
}

/// The order is the guarantee: refuse, then prove nothing else is writing, then back up, then
/// write. Every step before the last one leaves the database exactly as it was found.
fn merge_devices(db_path: &Path, sources: &[i64], target: i64) -> Result<()> {
    let state = service_state();
    if !is_stopped(&state) {
        bail!(
            "keylab.service is {state}; stop it before merging devices:\n  \
             sudo systemctl stop keylab.service"
        );
    }
    let mut connection = open_read_write(db_path)?;
    let plan = registry::plan_merge(&connection, sources, target)?;
    registry::require_exclusive_write_access(&mut connection)?;

    let listing = registry::list_devices(&connection)?;
    let moving: i64 = listing
        .iter()
        .filter(|row| plan.sources.contains(&row.id))
        .map(|row| row.keystrokes)
        .sum();
    println!(
        "merging device{} {} into device {} ({})",
        if plan.sources.len() == 1 { "" } else { "s" },
        plan.sources
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        plan.target,
        plan.position_space.as_deref().unwrap_or("(none)")
    );
    println!("{moving} Tier A keystrokes change owner; the merged device rows are then removed.");
    println!("A merge cannot be undone except by restoring the backup.");

    let backup = registry::backup_database(&connection, db_path)?;
    println!("backup:       {}", backup.display());

    let report = registry::apply_merge(&mut connection, &plan)?;
    println!("buckets moved:       {}", report.buckets_moved);
    println!("buckets combined:    {}", report.buckets_combined);
    println!("Tier B windows:      {}", report.key_windows_moved);
    println!("Tier C windows:      {}", report.ngram_windows_moved);
    println!("device rows removed: {}", report.devices_removed);
    if report.buckets_combined > 0 {
        println!(
            "{} bucket{} sealed in the same second under the same profile and were summed rather \
             than dropped.",
            report.buckets_combined,
            if report.buckets_combined == 1 {
                ""
            } else {
                "s"
            }
        );
    }
    println!(
        "to roll back: cp '{}' '{}' && rm -f '{}'-wal '{}'-shm",
        backup.display(),
        db_path.display(),
        db_path.display(),
        db_path.display()
    );
    Ok(())
}

/// `systemctl` reports `activating` and `deactivating` too, and a daemon in either of those is a
/// daemon that will be writing shortly. Only a definitely-stopped unit passes.
fn is_stopped(state: &str) -> bool {
    matches!(state, "inactive" | "failed") || state.starts_with("unknown")
}

fn update_state<F>(control_path: &Path, update: F) -> Result<()>
where
    F: FnOnce(ControlState) -> ControlState,
{
    let state = control::update_control(control_path, update)?;
    println!("paused={} profile={}", state.paused, state.profile);
    Ok(())
}

fn print_status(config: &Config, data_dir: &Path, current: &ControlState) -> Result<()> {
    let hard_paused = data_dir.join("PAUSED").exists();
    println!("service:      {}", service_state());
    println!(
        "soft pause:   {} (control.json)",
        if current.paused { "yes" } else { "no" }
    );
    println!(
        "hard pause:   {} (PAUSED marker)",
        if hard_paused { "yes" } else { "no" }
    );
    println!("profile:      {}", current.profile);
    if let Some(lease) = &current.profile_lease {
        println!(
            "profile lease: active until {} (restores {})",
            lease.expires_at, lease.restore_profile
        );
    } else {
        println!("profile lease: none");
    }
    println!("configured:   {}", config.profiles.join(", "));
    match live_snapshot_age(&config.db_path) {
        Ok(Some(age)) => println!("last capture: {age}s ago"),
        Ok(None) => println!("last capture: never (no live snapshot yet)"),
        Err(error) => println!("last capture: unavailable ({error})"),
    }
    for line in device_liveness(&config.db_path) {
        println!("{line}");
    }
    Ok(())
}

fn service_state() -> String {
    // `is-active` exits non-zero for an inactive unit, so the status text is what matters.
    match Process::new("systemctl")
        .args(["is-active", "keylab.service"])
        .output()
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if text.is_empty() {
                "unknown".to_owned()
            } else {
                text
            }
        }
        Err(_) => "unknown (systemctl unavailable)".to_owned(),
    }
}

/// A stale snapshot is the symptom of a daemon that is running but no longer capturing, so the
/// age is reported rather than a bare "active".
fn live_snapshot_age(db_path: &Path) -> Result<Option<i64>> {
    let connection = open_readonly(db_path)?;
    let updated_at: Option<i64> = connection
        .query_row(
            "SELECT updated_at FROM live_snapshot WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read the live snapshot")?;
    let Some(updated_at) = updated_at else {
        return Ok(None);
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system wall clock is before the Unix epoch")?
        .as_secs();
    let now = i64::try_from(now).context("wall clock exceeds SQLite integer range")?;
    Ok(Some(now.saturating_sub(updated_at)))
}

fn device_liveness(db_path: &Path) -> Vec<String> {
    let Ok(connection) = open_readonly(db_path) else {
        return vec!["devices:      unavailable".to_owned()];
    };
    let rows = connection
        .prepare(
            // `b.ts` is the seal second. `b.id` stopped being it at schema v5, where it became a
            // surrogate key so two devices can seal in the same second.
            "SELECT d.name, COALESCE(MAX(b.ts), 0) AS last_bucket
             FROM device d LEFT JOIN bucket b ON b.device_id = d.id
             GROUP BY d.id ORDER BY last_bucket DESC, d.id DESC",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        });
    let Ok(rows) = rows else {
        return vec!["devices:      unavailable".to_owned()];
    };
    if rows.is_empty() {
        return vec!["devices:      none registered".to_owned()];
    }
    // A reconnect that changes the evdev `uniq` mints a new device row, so the history can hold
    // many entries for one physical keyboard. Only the recently active ones say anything useful.
    let total = rows.len();
    let mut lines: Vec<String> = rows
        .iter()
        .take(DEVICE_LIVENESS_LIMIT)
        .map(|(name, last_bucket)| {
            if *last_bucket == 0 {
                format!("device:       {name} (no sealed bucket yet)")
            } else {
                format!("device:       {name} (last sealed bucket at {last_bucket})")
            }
        })
        .collect();
    if total > DEVICE_LIVENESS_LIMIT {
        lines.push(format!(
            "device:       (+{} older registrations not shown)",
            total - DEVICE_LIVENESS_LIMIT
        ));
    }
    lines
}

fn open_readonly(db_path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .with_context(|| format!("failed to open {} read-only", db_path.display()))
}

fn open_read_write(db_path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .with_context(|| format!("failed to open {} for writing", db_path.display()))?;
    connection
        .busy_timeout(LOCK_WAIT)
        .context("failed to set the database busy timeout")?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_supported_command() {
        assert_eq!(parse_command(&["status".into()]).unwrap(), Command::Status);
        assert_eq!(parse_command(&["pause".into()]).unwrap(), Command::Pause);
        assert_eq!(parse_command(&["resume".into()]).unwrap(), Command::Resume);
        assert_eq!(
            parse_command(&["profile".into(), "set".into(), "gaming".into()]).unwrap(),
            Command::SetProfile("gaming".to_owned())
        );
        assert_eq!(
            parse_command(&["profile".into(), "list".into()]).unwrap(),
            Command::ListProfiles
        );
        assert_eq!(
            parse_command(&["devices".into(), "list".into()]).unwrap(),
            Command::ListDevices
        );
        assert!(parse_command(&["nonsense".into()]).is_err());
        assert!(parse_command(&["profile".into(), "set".into()]).is_err());
        assert!(parse_command(&[]).is_err());
        assert!(parse_command(&["profile".into()]).is_err());
    }

    fn merge_args(sources: &str, target: &str) -> Vec<String> {
        vec![
            "devices".into(),
            "merge".into(),
            sources.into(),
            "--into".into(),
            target.into(),
        ]
    }

    #[test]
    fn parses_a_merge_of_one_or_several_devices() {
        assert_eq!(
            parse_command(&merge_args("2", "1")).unwrap(),
            Command::MergeDevices {
                sources: vec![2],
                target: 1
            }
        );
        assert_eq!(
            parse_command(&merge_args("2,7, 9", "1")).unwrap(),
            Command::MergeDevices {
                sources: vec![2, 7, 9],
                target: 1
            }
        );
        // A device id is a positive integer and nothing else; anything looser would make a typo
        // into a merge of the wrong keyboard.
        assert!(parse_command(&merge_args("2,", "1")).is_err());
        assert!(parse_command(&merge_args("0", "1")).is_err());
        assert!(parse_command(&merge_args("-3", "1")).is_err());
        assert!(parse_command(&merge_args("2", "all")).is_err());
        assert!(parse_command(&["devices".into(), "merge".into(), "2".into()]).is_err());
    }

    #[test]
    fn only_a_definitely_stopped_unit_may_be_merged_under() {
        assert!(is_stopped("inactive"));
        assert!(is_stopped("failed"));
        assert!(is_stopped("unknown (systemctl unavailable)"));
        // A unit on its way up or down is a unit that will be writing shortly.
        assert!(!is_stopped("active"));
        assert!(!is_stopped("activating"));
        assert!(!is_stopped("deactivating"));
        assert!(!is_stopped("reloading"));
    }

    #[test]
    fn update_state_writes_a_file_the_watcher_accepts() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let control_path = temp.path().join("control.json");
        update_state(&control_path, |_| ControlState {
            paused: true,
            profile: "gaming".to_owned(),
            profile_lease: None,
        })
        .unwrap_or_else(|error| panic!("{error:#}"));
        let mut watcher = ControlWatcher::new(
            control_path,
            vec!["default".to_owned(), "gaming".to_owned()],
        );
        let state = watcher.poll();
        assert!(state.paused);
        assert_eq!(state.profile, "gaming");
    }
}
