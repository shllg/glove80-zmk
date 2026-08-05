// Logging policy: never log keycodes, positions, characters, or event Debug values; counts only.

mod aggregate;
mod config;
mod control;
mod device;
mod encode;
mod keymap;
mod store;

use aggregate::Aggregator;
use anyhow::{bail, Context, Result};
use config::Config;
use keymap::Keymap;
use rusqlite::{Connection, OpenFlags};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use store::Store;
use tracing::{error, info, warn};

const SILENT_CAPTURE_WARNING_AFTER: Duration = Duration::from_secs(5 * 60);
const SILENT_CAPTURE_WARNING_REPEAT: Duration = Duration::from_secs(30 * 60);

struct SilentCaptureWatchdog {
    silence_since: Instant,
    last_warning_at: Option<Instant>,
}

impl SilentCaptureWatchdog {
    fn new(now: Instant) -> Self {
        Self {
            silence_since: now,
            last_warning_at: None,
        }
    }

    fn observe_key_event(&mut self, now: Instant) {
        self.silence_since = now;
    }

    fn resume(&mut self, now: Instant) {
        self.silence_since = now;
    }

    fn warning_due(&mut self, now: Instant) -> bool {
        if silent_capture_warning_due(now, self.silence_since, self.last_warning_at) {
            self.last_warning_at = Some(now);
            true
        } else {
            false
        }
    }
}

fn silent_capture_warning_due(
    now: Instant,
    silence_since: Instant,
    last_warning_at: Option<Instant>,
) -> bool {
    now.saturating_duration_since(silence_since) >= SILENT_CAPTURE_WARNING_AFTER
        && last_warning_at.is_none_or(|last_warning| {
            now.saturating_duration_since(last_warning) >= SILENT_CAPTURE_WARNING_REPEAT
        })
}

struct RuntimeDevice {
    input: device::InputDevice,
    aggregate: Aggregator,
    device_id: i64,
    disconnected: bool,
    last_tier_a_tick: Instant,
    capture_watchdog: SilentCaptureWatchdog,
}

fn main() {
    tracing_subscriber::fmt()
        .with_target(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .init();
    let exit_code = match dispatch() {
        Ok(()) => 0,
        Err(error) => {
            error!(error = %error, "keylab stopped after a fatal error");
            1
        }
    };
    std::process::exit(exit_code);
}

fn dispatch() -> Result<()> {
    match std::env::args_os().nth(1).as_deref() {
        Some(flag) if flag == "--selftest-db" => selftest_hold_database(&selftest_path(flag)?),
        Some(flag) if flag == "--selftest-db-reader" => {
            selftest_read_database(&selftest_path(flag)?)
        }
        Some(flag) if flag == "--selftest-replay" => selftest_replay(&selftest_path(flag)?),
        _ => run(),
    }
}

fn selftest_path(flag: &std::ffi::OsStr) -> Result<PathBuf> {
    let path = std::env::args_os()
        .nth(2)
        .map(PathBuf::from)
        .with_context(|| format!("{} requires a database path", flag.to_string_lossy()))?;
    if std::env::args_os().nth(3).is_some() {
        bail!(
            "{} accepts exactly one database path",
            flag.to_string_lossy()
        );
    }
    Ok(path)
}

fn selftest_keymap() -> Result<Keymap> {
    let path = std::env::var_os("KEYLAB_SELFTEST_KEYMAP_META")
        .map(PathBuf::from)
        .context("KEYLAB_SELFTEST_KEYMAP_META is required for hidden self-tests")?;
    Keymap::load(&path)
}

fn selftest_hold_database(path: &Path) -> Result<()> {
    let keymap = selftest_keymap()?;
    let mut store = Store::open(path, &keymap, unix_seconds()?)?;
    store.register_device("verification fixture", None, unix_seconds()?)?;
    store.replace_live_snapshot(unix_seconds()?, &[0; 10], 0, 0)?;
    println!("SELFTEST_DB_READY aggregate_rows=1");
    io::stdout()
        .flush()
        .context("failed to flush database self-test readiness marker")?;

    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn selftest_read_database(path: &Path) -> Result<()> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .context("failed to open the WAL database read-only")?;
    let metadata_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM meta", [], |row| row.get(0))
        .context("failed to read database metadata concurrently")?;
    let telemetry_rows: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM bucket)
                  + (SELECT COUNT(*) FROM key_window)
                  + (SELECT COUNT(*) FROM live_snapshot)",
            [],
            |row| row.get(0),
        )
        .context("failed to read aggregate tables concurrently")?;
    println!("SELFTEST_DB_READ_OK metadata_rows={metadata_rows} aggregate_rows={telemetry_rows}");
    Ok(())
}

fn selftest_replay(path: &Path) -> Result<()> {
    let keymap = selftest_keymap()?;
    let mut store = Store::open(path, &keymap, unix_seconds()?)?;
    let pause_path = path
        .parent()
        .context("self-test database path must have a parent directory")?
        .join("PAUSED");
    if pause_requested(&pause_path)? {
        info!("fixture replay skipped because recording is paused");
        return store.close();
    }

    let start_ts = unix_seconds()?;
    let device_id = store.register_device("verification fixture", None, start_ts)?;
    let mut aggregate = Aggregator::new(start_ts);
    for index in 0_u64..25 {
        let press_ts = index.saturating_mul(2);
        if aggregate
            .handle_event(press_ts, 30, 1, &keymap, 2_000)
            .is_some()
        {
            bail!("short verification fixture unexpectedly sealed Tier B");
        }
        aggregate.handle_event(press_ts.saturating_add(1), 30, 0, &keymap, 2_000);
    }
    let seal = aggregate
        .tick(start_ts.saturating_add(10), 10_000, 25)
        .context("verification fixture did not reach the Tier A floor")?;
    store.seal_tier_a(device_id, &seal)?;
    info!(
        aggregate_rows = 1,
        keystrokes = 25,
        "fixture replay complete"
    );
    store.close()
}

fn run() -> Result<()> {
    let config_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(config::default_config_path)?;
    let config = Config::load(&config_path)?;

    lock_process_memory()?;
    disable_process_dumping()?;

    let keymap = Keymap::load(&config.keymap_meta_path)?;
    let mut store = Store::open(&config.db_path, &keymap, unix_seconds()?)?;
    let pause_path = config
        .db_path
        .parent()
        .context("database path must have a parent directory")?
        .join("PAUSED");

    let terminate = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(SIGTERM, Arc::clone(&terminate))
        .context("failed to install SIGTERM handler")?;
    signal_hook::flag::register(SIGINT, Arc::clone(&terminate))
        .context("failed to install SIGINT handler")?;

    event_loop(&config, &keymap, &pause_path, &terminate, &mut store)?;
    store.close()
}

fn event_loop(
    config: &Config,
    keymap: &Keymap,
    pause_path: &Path,
    terminate: &AtomicBool,
    store: &mut Store,
) -> Result<()> {
    let bucket_duration = Duration::from_secs(config.bucket_seconds);
    let live_duration = Duration::from_secs(config.live_snapshot_seconds);
    let discovery_duration = Duration::from_secs(2);
    let mut devices: HashMap<PathBuf, RuntimeDevice> = HashMap::new();
    let mut next_discovery = Instant::now();
    let mut next_bucket_tick = Instant::now() + bucket_duration;
    let mut next_live_tick = Instant::now() + live_duration;
    let mut paused = false;
    let mut startup_scan_pending = true;

    while !terminate.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_discovery {
            discover_devices(config, store, &mut devices, startup_scan_pending)?;
            startup_scan_pending = false;
            next_discovery = now + discovery_duration;
        }

        refresh_pause_state(pause_path, &mut paused, &mut devices)?;
        if process_device_events(config, keymap, pause_path, paused, store, &mut devices)? {
            paused = true;
            discard_all_partials(&mut devices)?;
        }

        let disconnected = devices
            .values()
            .filter(|runtime| runtime.disconnected)
            .count();
        if disconnected > 0 {
            let next_bucket_id = current_bucket_id()?;
            devices.retain(|_, runtime| {
                if runtime.disconnected {
                    runtime.aggregate.discard_partials(next_bucket_id);
                    false
                } else {
                    true
                }
            });
            info!(count = disconnected, "input devices disconnected");
        }

        if !paused {
            warn_for_silent_capture(&mut devices, Instant::now());
        }

        if now >= next_bucket_tick {
            refresh_pause_state(pause_path, &mut paused, &mut devices)?;
            let next_bucket_id = current_bucket_id()?;
            if paused {
                discard_all_partials(&mut devices)?;
            } else {
                for runtime in devices.values_mut() {
                    let elapsed_ms =
                        duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
                    if let Some(seal) =
                        runtime
                            .aggregate
                            .tick(next_bucket_id, elapsed_ms, config.tier_a_seal_floor)
                    {
                        store.seal_tier_a(runtime.device_id, &seal)?;
                    }
                    runtime.last_tier_a_tick = now;
                }
            }
            next_bucket_tick = now + bucket_duration;
        }

        if now >= next_live_tick {
            refresh_pause_state(pause_path, &mut paused, &mut devices)?;
            if !paused {
                replace_live_snapshot(store, &devices, now)?;
            }
            next_live_tick = now + live_duration;
        }

        thread::sleep(Duration::from_millis(10));
    }

    let next_bucket_id = current_bucket_id()?;
    for runtime in devices.values_mut() {
        runtime.aggregate.discard_partials(next_bucket_id);
    }
    info!(device_count = devices.len(), "shutdown discard complete");
    Ok(())
}

fn discover_devices(
    config: &Config,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
    startup: bool,
) -> Result<()> {
    let bucket_id = current_bucket_id()?;
    let first_ts = unix_seconds()?;
    let mut added = 0;
    let scan = device::for_each_matching(&config.device_name_contains, |path, input| {
        if startup {
            info!(
                device_name = %input.name,
                event_path = %path.display(),
                "matched input device"
            );
        }
        if devices.contains_key(&path) {
            return Ok(());
        }
        let now = Instant::now();
        let device_id = store.register_device(&input.name, input.uniq.as_deref(), first_ts)?;
        devices.insert(
            path,
            RuntimeDevice {
                input,
                aggregate: Aggregator::new(bucket_id),
                device_id,
                disconnected: false,
                last_tier_a_tick: now,
                capture_watchdog: SilentCaptureWatchdog::new(now),
            },
        );
        added += 1;
        Ok(())
    })?;
    if startup {
        info!(
            matched_count = scan.matched_count,
            "startup input-device scan complete"
        );
        if scan.matched_count == 0 {
            let present_names = if scan.present_names.is_empty() {
                "(no readable input devices)".to_owned()
            } else {
                scan.present_names.join(", ")
            };
            error!(
                configured_substring = %config.device_name_contains,
                present_device_names = %present_names,
                "no input devices matched the configured substring"
            );
        }
    } else if added > 0 {
        info!(count = added, "input devices connected");
    }
    Ok(())
}

/// Only a genuine device removal ends a capture session. Every other read failure is transient and
/// must not discard the device's partial aggregates.
fn is_device_gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::UnexpectedEof
        || matches!(error.raw_os_error(), Some(libc::ENODEV) | Some(libc::EIO))
}

fn process_device_events(
    config: &Config,
    keymap: &Keymap,
    pause_path: &Path,
    paused: bool,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
) -> Result<bool> {
    for runtime in devices.values_mut() {
        loop {
            let event = match runtime.input.next_event() {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(error) => {
                    if is_device_gone(&error) {
                        runtime.disconnected = true;
                    } else {
                        warn!(error = %error, "input device read failed; keeping the device");
                    }
                    break;
                }
            };
            if event.is_sequence_loss() {
                // SYN_DROPPED means the kernel overflowed this client's buffer, not that the
                // device went away. Re-sync and keep accumulating.
                warn!("kernel dropped input events; re-syncing device state");
                runtime.aggregate.resync_after_sequence_loss();
                continue;
            }
            if !event.is_key() {
                continue;
            }
            runtime.capture_watchdog.observe_key_event(Instant::now());
            if paused {
                continue;
            }
            if pause_requested(pause_path)? {
                return Ok(true);
            }
            if let Some(mut seal) = runtime.aggregate.handle_event(
                event.t_ms(),
                event.code(),
                event.value(),
                keymap,
                config.tier_b_seal_count,
            ) {
                if pause_requested(pause_path)? {
                    drop(seal);
                    return Ok(true);
                }
                translate_tier_b_timestamps(&mut seal)?;
                store.seal_tier_b(runtime.device_id, &seal)?;
            }
            debug_assert!(runtime.aggregate.bounded_footprint() < 600);
        }
    }
    Ok(false)
}

fn refresh_pause_state(
    pause_path: &Path,
    paused: &mut bool,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
) -> Result<()> {
    let pause_now = pause_requested(pause_path)?;
    if pause_now != *paused {
        discard_all_partials(devices)?;
        if !pause_now {
            let now = Instant::now();
            for runtime in devices.values_mut() {
                runtime.capture_watchdog.resume(now);
            }
        }
        *paused = pause_now;
    }
    Ok(())
}

fn warn_for_silent_capture(devices: &mut HashMap<PathBuf, RuntimeDevice>, now: Instant) {
    for (path, runtime) in devices {
        if runtime.capture_watchdog.warning_due(now) {
            warn!(
                device_name = %runtime.input.name,
                event_path = %path.display(),
                "matched input device has delivered no EV_KEY events for 5 minutes; another process may hold an exclusive EVIOCGRAB, so capture may be pointing at the wrong device"
            );
        }
    }
}

fn discard_all_partials(devices: &mut HashMap<PathBuf, RuntimeDevice>) -> Result<()> {
    let next_bucket_id = current_bucket_id()?;
    let now = Instant::now();
    for runtime in devices.values_mut() {
        runtime.aggregate.discard_partials(next_bucket_id);
        runtime.last_tier_a_tick = now;
    }
    Ok(())
}

fn pause_requested(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("failed to inspect PAUSED marker"),
    }
}

fn translate_tier_b_timestamps(seal: &mut aggregate::TierBSeal) -> Result<()> {
    let elapsed_ms = seal.end_ts.saturating_sub(seal.start_ts);
    let end_wall_ms = unix_millis()?;
    seal.end_ts = end_wall_ms / 1_000;
    seal.start_ts = end_wall_ms.saturating_sub(elapsed_ms) / 1_000;
    Ok(())
}

fn replace_live_snapshot(
    store: &mut Store,
    devices: &HashMap<PathBuf, RuntimeDevice>,
    now: Instant,
) -> Result<()> {
    let mut finger_counts = [0_u32; 10];
    let mut keystrokes = 0_u32;
    let mut aggregate_span_ms = 0_u64;
    for runtime in devices.values() {
        for (target, value) in finger_counts
            .iter_mut()
            .zip(runtime.aggregate.live_finger_counts())
        {
            *target = target.saturating_add(*value);
        }
        keystrokes = keystrokes.saturating_add(runtime.aggregate.live_keystrokes());
        let current_bucket_elapsed_ms =
            duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
        aggregate_span_ms =
            aggregate_span_ms.max(runtime.aggregate.live_span_ms(current_bucket_elapsed_ms));
    }
    store.replace_live_snapshot(
        unix_seconds()?,
        &finger_counts,
        keystrokes,
        aggregate_span_ms,
    )
}

fn current_bucket_id() -> Result<i64> {
    unix_seconds()
}

fn unix_seconds() -> Result<i64> {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .context("system wall clock is before the Unix epoch")?
        .as_secs();
    i64::try_from(seconds).context("wall clock exceeds SQLite integer range")
}

fn unix_millis() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .context("system wall clock is before the Unix epoch")?;
    Ok(duration_millis(duration))
}

fn duration_millis(duration: Duration) -> u64 {
    duration
        .as_secs()
        .saturating_mul(1_000)
        .saturating_add(u64::from(duration.subsec_millis()))
}

fn lock_process_memory() -> Result<()> {
    // mlockall prevents normal swap-out, but not hibernation; the resume device must be encrypted.
    // SAFETY: mlockall takes only the documented flag bitmask and does not dereference pointers.
    let result = unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) };
    if result != 0 {
        return Err(io::Error::last_os_error()).context("mlockall failed; refusing to capture");
    }
    Ok(())
}

fn disable_process_dumping() -> Result<()> {
    // This blocks core dumps and same-user ptrace/proc-memory access. It is reset on exec and does
    // not protect against root or another privileged attacker.
    // SAFETY: PR_SET_DUMPABLE with argument zero has no pointer arguments.
    let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) };
    if result != 0 {
        return Err(io::Error::last_os_error())
            .context("PR_SET_DUMPABLE failed; refusing to capture");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_capture_watchdog_fires_at_five_minutes() {
        let start = Instant::now();
        assert!(silent_capture_warning_due(
            start + SILENT_CAPTURE_WARNING_AFTER,
            start,
            None
        ));
    }

    #[test]
    fn silent_capture_watchdog_does_not_fire_at_four_minutes() {
        let start = Instant::now();
        assert!(!silent_capture_warning_due(
            start + Duration::from_secs(4 * 60),
            start,
            None
        ));
    }

    #[test]
    fn silent_capture_watchdog_rearms_on_the_next_key_event() {
        let start = Instant::now();
        let mut watchdog = SilentCaptureWatchdog::new(start);
        let next_event = start + Duration::from_secs(4 * 60);
        watchdog.observe_key_event(next_event);
        assert!(!watchdog.warning_due(start + SILENT_CAPTURE_WARNING_AFTER));
        assert!(watchdog.warning_due(next_event + SILENT_CAPTURE_WARNING_AFTER));
    }

    #[test]
    fn silent_capture_watchdog_suppresses_repeats_for_thirty_minutes() {
        let start = Instant::now();
        let mut watchdog = SilentCaptureWatchdog::new(start);
        let first_warning = start + SILENT_CAPTURE_WARNING_AFTER;
        assert!(watchdog.warning_due(first_warning));
        watchdog.observe_key_event(first_warning + Duration::from_secs(60));
        assert!(!watchdog
            .warning_due(first_warning + SILENT_CAPTURE_WARNING_REPEAT - Duration::from_secs(1)));
        assert!(watchdog.warning_due(first_warning + SILENT_CAPTURE_WARNING_REPEAT));
    }
}
