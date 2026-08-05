// Logging policy: never log keycodes, positions, characters, or event Debug values; counts only.
// Profile names are user-authored labels and may be printed.

#[path = "../config.rs"]
mod config;
#[path = "../control.rs"]
mod control;

use anyhow::{bail, Context, Result};
use config::Config;
use control::{ControlState, ControlWatcher};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::process::Command as Process;
use std::time::{SystemTime, UNIX_EPOCH};

const DEVICE_LIVENESS_LIMIT: usize = 4;
const USAGE: &str = "usage: keylabctl status|pause|resume|profile list|profile set <name>";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status,
    Pause,
    Resume,
    ListProfiles,
    SetProfile(String),
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
        _ => bail!("{USAGE}"),
    }
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
        Command::Pause => set_state(
            &control_path,
            &ControlState {
                paused: true,
                profile: current.profile,
            },
        ),
        Command::Resume => set_state(
            &control_path,
            &ControlState {
                paused: false,
                profile: current.profile,
            },
        ),
        Command::ListProfiles => {
            for name in &config.profiles {
                let marker = if *name == current.profile { "*" } else { " " };
                println!("{marker} {name}");
            }
            Ok(())
        }
        Command::SetProfile(name) => {
            if !config.profiles.iter().any(|configured| *configured == name) {
                bail!(
                    "unknown profile {name:?}; configured profiles are: {}",
                    config.profiles.join(", ")
                );
            }
            set_state(
                &control_path,
                &ControlState {
                    paused: current.paused,
                    profile: name,
                },
            )
        }
    }
}

fn set_state(control_path: &Path, state: &ControlState) -> Result<()> {
    control::write_control(control_path, state)?;
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
            "SELECT d.name, COALESCE(MAX(b.id), 0) AS last_bucket
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
        assert!(parse_command(&["nonsense".into()]).is_err());
        assert!(parse_command(&["profile".into(), "set".into()]).is_err());
        assert!(parse_command(&[]).is_err());
        assert!(parse_command(&["profile".into()]).is_err());
    }

    #[test]
    fn set_state_writes_a_file_the_watcher_accepts() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let control_path = temp.path().join("control.json");
        set_state(
            &control_path,
            &ControlState {
                paused: true,
                profile: "gaming".to_owned(),
            },
        )
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
