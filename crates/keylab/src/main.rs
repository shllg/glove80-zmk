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

    fn last_key_event(&self) -> Instant {
        self.silence_since
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
    profile_id: i64,
    rule_index: usize,
    disconnected: bool,
    last_tier_a_tick: Instant,
    capture_watchdog: SilentCaptureWatchdog,
}

/// The state actually in force, resolved from both channels. `hard_paused` comes from the `PAUSED`
/// marker and keeps its documented meaning — it discards partial aggregates. `soft_paused` comes
/// from the control file and preserves the Tier B accumulators.
struct ResolvedControl {
    hard_paused: bool,
    soft_paused: bool,
    profile: String,
    profile_id: i64,
    profile_index: usize,
    last_activity: Instant,
}

impl ResolvedControl {
    fn paused(&self) -> bool {
        self.hard_paused || self.soft_paused
    }
}

/// A profile left active through an idle stretch silently mislabels everything typed after it.
/// Zero disables the revert entirely.
fn auto_revert_due(now: Instant, last_activity: Instant, idle_seconds: u64) -> bool {
    idle_seconds != 0
        && now.saturating_duration_since(last_activity) >= Duration::from_secs(idle_seconds)
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
    store.register_device(
        "verification fixture",
        None,
        unix_seconds()?,
        &store::DeviceKeymap {
            kind: config::DEFAULT_KEYMAP_KIND,
            hash: &keymap.hash,
        },
    )?;
    store.replace_live_snapshot(
        unix_seconds()?,
        &[0; 10],
        0,
        0,
        &store::LiveControl {
            paused: false,
            profile: config::DEFAULT_PROFILE,
            profiles: &[config::DEFAULT_PROFILE.to_owned()],
        },
    )?;
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
    let device_id = store.register_device(
        "verification fixture",
        None,
        start_ts,
        &store::DeviceKeymap {
            kind: config::DEFAULT_KEYMAP_KIND,
            hash: &keymap.hash,
        },
    )?;
    let mut aggregate = Aggregator::new(start_ts, 1);
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
    let profile_id = store.register_profile(config::DEFAULT_PROFILE)?;
    store.seal_tier_a(device_id, profile_id, &seal)?;
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

    let keymaps = load_device_keymaps(&config)?;
    let primary = keymaps
        .first()
        .context("at least one device keymap is required")?;
    let mut store = Store::open(&config.db_path, primary, unix_seconds()?)?;
    let data_dir = config
        .db_path
        .parent()
        .context("database path must have a parent directory")?;
    let pause_path = data_dir.join("PAUSED");
    let control_path = data_dir.join("control.json");

    let terminate = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(SIGTERM, Arc::clone(&terminate))
        .context("failed to install SIGTERM handler")?;
    signal_hook::flag::register(SIGINT, Arc::clone(&terminate))
        .context("failed to install SIGINT handler")?;

    event_loop(
        &config,
        &keymaps,
        &pause_path,
        &control_path,
        &terminate,
        &mut store,
    )?;
    store.close()
}

fn event_loop(
    config: &Config,
    keymaps: &[Keymap],
    pause_path: &Path,
    control_path: &Path,
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
    let mut startup_scan_pending = true;
    let mut watcher =
        control::ControlWatcher::new(control_path.to_path_buf(), config.profiles.clone());
    let mut state = ResolvedControl {
        hard_paused: false,
        soft_paused: false,
        profile: config::DEFAULT_PROFILE.to_owned(),
        profile_id: store.register_profile(config::DEFAULT_PROFILE)?,
        profile_index: 0,
        last_activity: Instant::now(),
    };
    // Resolve once before the first discovery so devices are created under the right profile.
    refresh_control(
        &mut watcher,
        pause_path,
        config,
        store,
        &mut devices,
        &mut state,
    )?;

    while !terminate.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_discovery {
            discover_devices(
                config,
                keymaps,
                store,
                &mut devices,
                startup_scan_pending,
                &state,
            )?;
            startup_scan_pending = false;
            next_discovery = now + discovery_duration;
        }

        refresh_control(
            &mut watcher,
            pause_path,
            config,
            store,
            &mut devices,
            &mut state,
        )?;
        if process_device_events(config, keymaps, pause_path, &state, store, &mut devices)? {
            state.hard_paused = true;
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

        if !state.paused() {
            warn_for_silent_capture(&mut devices, Instant::now());
        }

        if now >= next_bucket_tick {
            refresh_control(
                &mut watcher,
                pause_path,
                config,
                store,
                &mut devices,
                &mut state,
            )?;
            let next_bucket_id = current_bucket_id()?;
            if state.hard_paused {
                discard_all_partials(&mut devices)?;
            } else if !state.soft_paused {
                for runtime in devices.values_mut() {
                    let elapsed_ms =
                        duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
                    if let Some(seal) =
                        runtime
                            .aggregate
                            .tick(next_bucket_id, elapsed_ms, config.tier_a_seal_floor)
                    {
                        store.seal_tier_a(runtime.device_id, runtime.profile_id, &seal)?;
                    }
                    runtime.last_tier_a_tick = now;
                }
            }
            apply_idle_auto_revert(config, control_path, &devices, &mut state, now);
            next_bucket_tick = now + bucket_duration;
        }

        if now >= next_live_tick {
            refresh_control(
                &mut watcher,
                pause_path,
                config,
                store,
                &mut devices,
                &mut state,
            )?;
            // The snapshot is written even while paused, with zeroed live figures. Freezing it
            // would leave the viewer showing a stale profile chip with no way to tell.
            replace_live_snapshot(config, store, &devices, &state, now)?;
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

/// One keymap per device rule, in rule order. `RuntimeDevice::rule_index` indexes this list, so a
/// device is only ever resolved against the position space its own rule names.
fn load_device_keymaps(config: &Config) -> Result<Vec<Keymap>> {
    config
        .devices
        .iter()
        .map(|rule| {
            Keymap::load(&rule.keymap_meta_path).with_context(|| {
                format!("failed to load the keymap for device rule {:?}", rule.name)
            })
        })
        .collect()
}

fn discover_devices(
    config: &Config,
    keymaps: &[Keymap],
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
    startup: bool,
    state: &ResolvedControl,
) -> Result<()> {
    let bucket_id = current_bucket_id()?;
    let first_ts = unix_seconds()?;
    let mut added = 0;
    let fragments: Vec<String> = config
        .devices
        .iter()
        .map(|rule| rule.name_contains.clone())
        .collect();
    let scan = device::for_each_matching(&fragments, |path, input, rule_index| {
        let rule = config
            .devices
            .get(rule_index)
            .context("device rule index is out of range")?;
        if startup {
            info!(
                device_name = %input.name,
                event_path = %path.display(),
                keymap_kind = %rule.name,
                "matched input device"
            );
        }
        if devices.contains_key(&path) {
            return Ok(());
        }
        let keymap = keymaps
            .get(rule_index)
            .context("device keymap index is out of range")?;
        let now = Instant::now();
        let device_id = store.register_device(
            &input.name,
            input.uniq.as_deref(),
            first_ts,
            &store::DeviceKeymap {
                kind: &rule.name,
                hash: &keymap.hash,
            },
        )?;
        let mut aggregate = Aggregator::new(bucket_id, config.profiles.len());
        aggregate.set_profile(state.profile_index);
        devices.insert(
            path,
            RuntimeDevice {
                input,
                aggregate,
                device_id,
                profile_id: state.profile_id,
                rule_index,
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
            rule_count = config.devices.len(),
            "startup input-device scan complete"
        );
        if scan.matched_count == 0 {
            let present_names = if scan.present_names.is_empty() {
                "(no readable input devices)".to_owned()
            } else {
                scan.present_names.join(", ")
            };
            error!(
                configured_substrings = %fragments.join(", "),
                present_device_names = %present_names,
                "no input devices matched any configured substring"
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
    keymaps: &[Keymap],
    pause_path: &Path,
    state: &ResolvedControl,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
) -> Result<bool> {
    let paused = state.paused();
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
            // evsieve merges the Kensington trackball into the keyboard's virtual device. A click
            // is not a keystroke: counting it would inflate the keystroke total and land in the
            // unattributed Tier B slot, since no keymap contains a BTN_* code.
            if event.is_pointer_button() {
                continue;
            }
            runtime.capture_watchdog.observe_key_event(Instant::now());
            if paused {
                continue;
            }
            if pause_requested(pause_path)? {
                return Ok(true);
            }
            let keymap = keymaps
                .get(runtime.rule_index)
                .context("device keymap index is out of range")?;
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
                store.seal_tier_b(runtime.device_id, runtime.profile_id, &seal)?;
            }
            debug_assert!(
                runtime.aggregate.bounded_footprint()
                    <= aggregate::footprint_bound(config.profiles.len())
            );
        }
    }
    Ok(false)
}

/// Resolves effective state from both channels. The `PAUSED` marker is the hard pause and keeps
/// its documented meaning: it discards partial aggregates. The control file is the soft pause and
/// preserves the Tier B accumulators.
fn refresh_control(
    watcher: &mut control::ControlWatcher,
    pause_path: &Path,
    config: &Config,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
    state: &mut ResolvedControl,
) -> Result<()> {
    let desired = watcher.poll();
    let hard_paused = pause_requested(pause_path)?;

    if hard_paused != state.hard_paused {
        discard_all_partials(devices)?;
        if !hard_paused {
            let now = Instant::now();
            for runtime in devices.values_mut() {
                runtime.capture_watchdog.resume(now);
            }
        }
        state.hard_paused = hard_paused;
    }

    if desired.profile != state.profile {
        seal_or_discard_all_tier_a(config, store, devices)?;
        let profile_id = store.register_profile(&desired.profile)?;
        let profile_index = config
            .profiles
            .iter()
            .position(|name| *name == desired.profile)
            .unwrap_or(0);
        for runtime in devices.values_mut() {
            runtime.profile_id = profile_id;
            runtime.aggregate.set_profile(profile_index);
        }
        info!(profile = %desired.profile, "activity profile changed");
        state.profile = desired.profile.clone();
        state.profile_id = profile_id;
        state.profile_index = profile_index;
        state.last_activity = Instant::now();
    }

    if desired.paused != state.soft_paused {
        if desired.paused {
            seal_or_discard_all_tier_a(config, store, devices)?;
        } else {
            let now = Instant::now();
            for runtime in devices.values_mut() {
                runtime.capture_watchdog.resume(now);
                runtime.last_tier_a_tick = now;
            }
            state.last_activity = now;
        }
        info!(paused = desired.paused, "soft pause state changed");
        state.soft_paused = desired.paused;
    }
    Ok(())
}

/// Closes the current Tier A bucket on every device at a boundary that must not straddle two
/// labels: the bucket is sealed when it clears both floors and discarded otherwise. Tier B is left
/// untouched — that is what separates a soft boundary from `discard_partials`.
fn seal_or_discard_all_tier_a(
    config: &Config,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
) -> Result<()> {
    let next_bucket_id = current_bucket_id()?;
    let now = Instant::now();
    for runtime in devices.values_mut() {
        let elapsed_ms = duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
        if let Some(seal) = runtime.aggregate.seal_or_discard_tier_a(
            next_bucket_id,
            elapsed_ms,
            config.tier_a_seal_floor,
        ) {
            store.seal_tier_a(runtime.device_id, runtime.profile_id, &seal)?;
        }
        runtime.last_tier_a_tick = now;
    }
    Ok(())
}

/// Rewrites the control file back to the default profile after an idle stretch. The change is
/// applied by the next `watcher.poll()` through the ordinary path, so a profile switch has exactly
/// one implementation. A control file that cannot be written must not stop capture.
fn apply_idle_auto_revert(
    config: &Config,
    control_path: &Path,
    devices: &HashMap<PathBuf, RuntimeDevice>,
    state: &mut ResolvedControl,
    now: Instant,
) {
    if let Some(latest) = devices
        .values()
        .map(|runtime| runtime.capture_watchdog.last_key_event())
        .max()
    {
        state.last_activity = state.last_activity.max(latest);
    }
    if state.paused()
        || state.profile == config::DEFAULT_PROFILE
        || !auto_revert_due(now, state.last_activity, config.auto_revert_idle_seconds)
    {
        return;
    }
    let reverted = control::ControlState {
        paused: state.soft_paused,
        profile: config::DEFAULT_PROFILE.to_owned(),
    };
    match control::write_control(control_path, &reverted) {
        Ok(()) => info!(
            idle_seconds = config.auto_revert_idle_seconds,
            "idle auto-revert to the default profile"
        ),
        Err(error) => warn!(error = %error, "failed to write the idle auto-revert"),
    }
    // Re-arm regardless: a failed write must not retry on every bucket tick.
    state.last_activity = now;
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
    config: &Config,
    store: &mut Store,
    devices: &HashMap<PathBuf, RuntimeDevice>,
    state: &ResolvedControl,
    now: Instant,
) -> Result<()> {
    let mut finger_counts = [0_u32; 10];
    let mut keystrokes = 0_u32;
    let mut aggregate_span_ms = 0_u64;
    for runtime in devices.values().filter(|_| !state.paused()) {
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
        &store::LiveControl {
            paused: state.paused(),
            profile: &state.profile,
            profiles: &config.profiles,
        },
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

    fn control_test_store(directory: &Path) -> (PathBuf, Store) {
        let db_path = directory.join("data").join("keylab.db");
        let keymap = Keymap::fixture(&[(
            30,
            keymap::KeyInfo {
                pos: 0,
                hand: 0,
                finger_id: 0,
                row_idx: 4,
            },
        )]);
        let store =
            Store::open(&db_path, &keymap, 1_000).unwrap_or_else(|error| panic!("{error:#}"));
        (db_path, store)
    }

    #[test]
    fn refresh_control_applies_the_control_file_to_the_resolved_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (db_path, mut store) = control_test_store(temp.path());
        let data_dir = db_path.parent().unwrap_or_else(|| unreachable!());
        let control_path = data_dir.join("control.json");
        let pause_path = data_dir.join("PAUSED");
        let config = Config::default();
        let mut watcher =
            control::ControlWatcher::new(control_path.clone(), config.profiles.clone());
        let mut devices: HashMap<PathBuf, RuntimeDevice> = HashMap::new();
        let mut state = ResolvedControl {
            hard_paused: false,
            soft_paused: false,
            profile: config::DEFAULT_PROFILE.to_owned(),
            profile_id: store
                .register_profile(config::DEFAULT_PROFILE)
                .unwrap_or_else(|error| panic!("{error:#}")),
            profile_index: 0,
            last_activity: Instant::now(),
        };

        control::write_control(
            &control_path,
            &control::ControlState {
                paused: true,
                profile: "gaming".to_owned(),
            },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        refresh_control(
            &mut watcher,
            &pause_path,
            &config,
            &mut store,
            &mut devices,
            &mut state,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));

        assert_eq!(state.profile, "gaming");
        assert_eq!(state.profile_index, 3);
        assert_ne!(state.profile_id, 1, "gaming must get its own profile row");
        assert!(state.soft_paused);
        assert!(!state.hard_paused);
        assert!(state.paused());

        // An unconfigured name is rejected by the watcher, so the resolved state must not move.
        std::fs::write(
            &control_path,
            br#"{"paused":false,"profile":"not-configured","updated_at":1}"#,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        refresh_control(
            &mut watcher,
            &pause_path,
            &config,
            &mut store,
            &mut devices,
            &mut state,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(state.profile, "gaming");
        assert!(state.soft_paused);
    }

    #[test]
    fn the_hard_pause_marker_is_resolved_independently_of_the_control_file() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (db_path, mut store) = control_test_store(temp.path());
        let data_dir = db_path.parent().unwrap_or_else(|| unreachable!());
        let control_path = data_dir.join("control.json");
        let pause_path = data_dir.join("PAUSED");
        let config = Config::default();
        let mut watcher = control::ControlWatcher::new(control_path, config.profiles.clone());
        let mut devices: HashMap<PathBuf, RuntimeDevice> = HashMap::new();
        let mut state = ResolvedControl {
            hard_paused: false,
            soft_paused: false,
            profile: config::DEFAULT_PROFILE.to_owned(),
            profile_id: 1,
            profile_index: 0,
            last_activity: Instant::now(),
        };

        std::fs::write(&pause_path, b"").unwrap_or_else(|error| panic!("{error}"));
        refresh_control(
            &mut watcher,
            &pause_path,
            &config,
            &mut store,
            &mut devices,
            &mut state,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(state.hard_paused);
        assert!(!state.soft_paused, "the control file said nothing");

        std::fs::remove_file(&pause_path).unwrap_or_else(|error| panic!("{error}"));
        refresh_control(
            &mut watcher,
            &pause_path,
            &config,
            &mut store,
            &mut devices,
            &mut state,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(!state.paused());
    }

    #[test]
    fn idle_auto_revert_fires_only_after_the_configured_idle_window() {
        let start = Instant::now();
        assert!(!auto_revert_due(
            start + Duration::from_secs(899),
            start,
            900
        ));
        assert!(auto_revert_due(
            start + Duration::from_secs(900),
            start,
            900
        ));
    }

    #[test]
    fn a_zero_idle_window_disables_the_auto_revert() {
        let start = Instant::now();
        assert!(!auto_revert_due(
            start + Duration::from_secs(86_400),
            start,
            0
        ));
    }

    #[test]
    fn resolved_control_is_paused_by_either_channel() {
        let mut state = ResolvedControl {
            hard_paused: false,
            soft_paused: false,
            profile: config::DEFAULT_PROFILE.to_owned(),
            profile_id: 1,
            profile_index: 0,
            last_activity: Instant::now(),
        };
        assert!(!state.paused());
        state.soft_paused = true;
        assert!(state.paused());
        state.soft_paused = false;
        state.hard_paused = true;
        assert!(state.paused());
    }

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
