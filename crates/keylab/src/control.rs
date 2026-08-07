use crate::config::DEFAULT_PROFILE;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::warn;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct ProfileLease {
    pub id: String,
    pub restore_profile: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlState {
    pub paused: bool,
    pub profile: String,
    pub profile_lease: Option<ProfileLease>,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            paused: false,
            profile: DEFAULT_PROFILE.to_owned(),
            profile_lease: None,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct ControlFile {
    paused: bool,
    profile: String,
    updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile_lease: Option<ProfileLease>,
}

/// Reads the control file at most once per change. `poll` runs on every 10 ms loop iteration, so
/// it stats the file and only re-parses when the modification time or length moved.
pub struct ControlWatcher {
    path: PathBuf,
    profiles: Vec<String>,
    state: ControlState,
    signature: Option<(SystemTime, u64)>,
    parse_count: u64,
    warned: bool,
}

impl ControlWatcher {
    pub fn new(path: PathBuf, profiles: Vec<String>) -> Self {
        Self {
            path,
            profiles,
            state: ControlState::default(),
            signature: None,
            parse_count: 0,
            warned: false,
        }
    }

    #[cfg(test)]
    pub fn parse_count(&self) -> u64 {
        self.parse_count
    }

    pub fn poll(&mut self) -> ControlState {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(_) => {
                // No control file is the documented default, not a fault.
                self.signature = None;
                return self.state.clone();
            }
        };
        let signature = metadata
            .modified()
            .ok()
            .map(|mtime| (mtime, metadata.len()));
        if signature.is_some() && signature == self.signature {
            return self.state.clone();
        }
        self.signature = signature;
        self.parse_count += 1;
        match self.parse() {
            Ok(state) => {
                self.warned = false;
                self.state = state;
            }
            Err(error) => {
                if !self.warned {
                    warn!(error = %error, "unusable control file; keeping the last known state");
                    self.warned = true;
                }
            }
        }
        self.state.clone()
    }

    /// Keeps an already-resolved state when the daemon could not rewrite an expired lease. The
    /// unchanged-file fast path must not resurrect the stale leased profile on every 10 ms poll.
    #[allow(dead_code)] // `keylabctl` includes this module but only the daemon resolves leases.
    pub fn adopt(&mut self, state: ControlState) {
        self.state = state;
    }

    fn parse(&self) -> Result<ControlState> {
        let source = fs::read_to_string(&self.path).context("failed to read the control file")?;
        let parsed: ControlFile =
            serde_json::from_str(&source).context("invalid control file contents")?;
        if !self.profiles.contains(&parsed.profile) {
            anyhow::bail!("control file names a profile that is not configured");
        }
        if let Some(lease) = &parsed.profile_lease {
            if lease.id.is_empty() || lease.id.len() > 128 {
                anyhow::bail!("control file has an invalid profile lease id");
            }
            if !self.profiles.contains(&lease.restore_profile) {
                anyhow::bail!("control file lease restores a profile that is not configured");
            }
            if lease.expires_at < 0 {
                anyhow::bail!("control file has a negative profile lease expiry");
            }
        }
        Ok(ControlState {
            paused: parsed.paused,
            profile: parsed.profile,
            profile_lease: parsed.profile_lease,
        })
    }
}

/// Returns the state that must replace an expired profile lease. Expiry is wall-clock based so it
/// survives both Lab and daemon restarts; the ordinary profile-switch path applies the result.
pub fn expire_profile_lease(state: &ControlState, now: i64) -> Option<ControlState> {
    let lease = state.profile_lease.as_ref()?;
    if lease.expires_at > now {
        return None;
    }
    Some(ControlState {
        paused: state.paused,
        profile: lease.restore_profile.clone(),
        profile_lease: None,
    })
}

const LOCK_ATTEMPTS: usize = 50;
const LOCK_RETRY: Duration = Duration::from_millis(2);
const CORRUPT_LOCK_STALE_AFTER: Duration = Duration::from_secs(5);

struct ControlLock {
    path: PathBuf,
}

impl Drop for ControlLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("control.json");
    path.with_file_name(format!("{name}.{suffix}"))
}

fn stale_lock(path: &Path) -> bool {
    if let Ok(source) = fs::read_to_string(path) {
        if let Ok(owner) = serde_json::from_str::<serde_json::Value>(&source) {
            if let Some(pid) = owner.get("pid").and_then(serde_json::Value::as_u64) {
                return !Path::new("/proc").join(pid.to_string()).exists();
            }
        }
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > CORRUPT_LOCK_STALE_AFTER)
}

fn acquire_lock(path: &Path) -> Result<ControlLock> {
    let lock_path = sibling(path, "lock");
    for _ in 0..LOCK_ATTEMPTS {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let owner = serde_json::json!({ "pid": std::process::id() }).to_string();
                if let Err(error) = file
                    .write_all(owner.as_bytes())
                    .and_then(|()| file.sync_all())
                {
                    let _ = fs::remove_file(&lock_path);
                    return Err(error).context("failed to record the control lock owner");
                }
                return Ok(ControlLock { path: lock_path });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if stale_lock(&lock_path) {
                    let _ = fs::remove_file(&lock_path);
                    continue;
                }
                thread::sleep(LOCK_RETRY);
            }
            Err(error) => return Err(error).context("failed to acquire the control lock"),
        }
    }
    anyhow::bail!("the keylab control file is busy; retry the operation")
}

fn read_current(path: &Path) -> Result<ControlState> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ControlState::default()),
        Err(error) => return Err(error).context("failed to read the current control file"),
    };
    let parsed: ControlFile =
        serde_json::from_str(&source).context("invalid current control file contents")?;
    Ok(ControlState {
        paused: parsed.paused,
        profile: parsed.profile,
        profile_lease: parsed.profile_lease,
    })
}

fn write_control_unlocked(path: &Path, state: &ControlState) -> Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temporary = sibling(path, &format!("{}.{}.tmp", std::process::id(), nonce));
    let payload = serde_json::to_vec_pretty(&ControlFile {
        paused: state.paused,
        profile: state.profile.clone(),
        profile_lease: state.profile_lease.clone(),
        updated_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default(),
    })
    .context("failed to encode the control file")?;
    let installed = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .context("failed to open the temporary control file")?;
        file.write_all(&payload)
            .context("failed to write the temporary control file")?;
        file.sync_all()
            .context("failed to flush the temporary control file")?;
        drop(file);
        fs::rename(&temporary, path).context("failed to install the control file")?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    installed
}

/// Serializes writers and installs a uniquely named sibling file, so readers never see a partial
/// write and concurrent Lab/keylabctl/daemon operations cannot share or truncate one temp file.
pub fn write_control(path: &Path, state: &ControlState) -> Result<()> {
    let _lock = acquire_lock(path)?;
    write_control_unlocked(path, state)
}

/// Reads and updates while holding the writer lock. Used by commands whose partial update must
/// preserve profile, pause, and lease fields written by a newer process.
#[allow(dead_code)] // The daemon and keylabctl compile this shared module as separate binaries.
pub fn update_control<F>(path: &Path, update: F) -> Result<ControlState>
where
    F: FnOnce(ControlState) -> ControlState,
{
    let _lock = acquire_lock(path)?;
    let next = update(read_current(path)?);
    write_control_unlocked(path, &next)?;
    Ok(next)
}

/// Compare-and-replace for daemon-derived transitions such as lease expiry and idle auto-revert.
/// A newer manual or Lab write wins instead of being overwritten by a stale watcher snapshot.
pub fn write_control_if_unchanged(
    path: &Path,
    expected: &ControlState,
    next: &ControlState,
) -> Result<bool> {
    let _lock = acquire_lock(path)?;
    if read_current(path)? != *expected {
        return Ok(false);
    }
    write_control_unlocked(path, next)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Barrier};

    fn watcher(directory: &Path) -> (PathBuf, ControlWatcher) {
        let path = directory.join("control.json");
        let profiles = vec!["default".to_owned(), "gaming".to_owned()];
        (path.clone(), ControlWatcher::new(path, profiles))
    }

    #[test]
    fn missing_file_yields_the_default_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (_path, mut watcher) = watcher(temp.path());
        let state = watcher.poll();
        assert!(!state.paused);
        assert_eq!(state.profile, "default");
        assert!(state.profile_lease.is_none());
    }

    #[test]
    fn round_trips_through_an_atomic_write() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState {
                paused: true,
                profile: "gaming".to_owned(),
                profile_lease: None,
            },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(!path.with_extension("json.tmp").exists());
        let state = watcher.poll();
        assert!(state.paused);
        assert_eq!(state.profile, "gaming");
    }

    #[test]
    fn malformed_content_keeps_the_last_known_good_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState {
                paused: true,
                profile: "gaming".to_owned(),
                profile_lease: None,
            },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(watcher.poll().paused);

        fs::write(&path, b"{ not json").unwrap_or_else(|error| panic!("{error}"));
        let state = watcher.poll();
        assert!(
            state.paused,
            "a parse failure must not silently resume capture"
        );
        assert_eq!(state.profile, "gaming");
    }

    #[test]
    fn an_unknown_profile_is_rejected_and_does_not_change_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        fs::write(
            &path,
            br#"{"paused":false,"profile":"nope","updated_at":0}"#,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(watcher.poll().profile, "default");
    }

    #[test]
    fn an_unchanged_file_is_not_reparsed() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState {
                paused: true,
                profile: "gaming".to_owned(),
                profile_lease: None,
            },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(watcher.poll().paused);
        let before = watcher.parse_count();
        watcher.poll();
        watcher.poll();
        assert_eq!(
            watcher.parse_count(),
            before,
            "mtime-gated reads must not reparse"
        );
    }

    #[test]
    fn an_expired_lease_restores_its_previous_profile() {
        let state = ControlState {
            paused: true,
            profile: "gaming".to_owned(),
            profile_lease: Some(ProfileLease {
                id: "session-1".to_owned(),
                restore_profile: "default".to_owned(),
                expires_at: 100,
            }),
        };
        assert!(expire_profile_lease(&state, 99).is_none());
        assert_eq!(
            expire_profile_lease(&state, 100),
            Some(ControlState {
                paused: true,
                profile: "default".to_owned(),
                profile_lease: None,
            })
        );
    }

    #[test]
    fn a_lease_round_trips_and_requires_a_configured_restore_profile() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        let leased = ControlState {
            paused: false,
            profile: "gaming".to_owned(),
            profile_lease: Some(ProfileLease {
                id: "session-1".to_owned(),
                restore_profile: "default".to_owned(),
                expires_at: 200,
            }),
        };
        write_control(&path, &leased).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(watcher.poll(), leased);

        fs::write(
            &path,
            br#"{"paused":false,"profile":"gaming","updated_at":0,"profile_lease":{"id":"session-2","restore_profile":"missing","expires_at":200}}"#,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            watcher.poll(),
            leased,
            "invalid leases keep the last known-good state"
        );
    }

    #[test]
    fn compare_and_write_refuses_to_overwrite_a_newer_owner() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        let expected = ControlState::default();
        let newer = ControlState {
            paused: false,
            profile: "gaming".to_owned(),
            profile_lease: Some(ProfileLease {
                id: "newer-owner".to_owned(),
                restore_profile: "default".to_owned(),
                expires_at: 200,
            }),
        };
        write_control(&path, &newer).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(
            !write_control_if_unchanged(&path, &expected, &ControlState::default())
                .unwrap_or_else(|error| panic!("{error:#}"))
        );
        assert_eq!(watcher.poll(), newer);
    }

    #[test]
    fn concurrent_writers_leave_one_complete_control_file_and_no_scratch_files() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let path = temp.path().join("control.json");
        let barrier = Arc::new(Barrier::new(8));
        let writers = (0..8)
            .map(|index| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    write_control(
                        &path,
                        &ControlState {
                            paused: index % 2 == 0,
                            profile: if index % 2 == 0 { "default" } else { "gaming" }.to_owned(),
                            profile_lease: None,
                        },
                    )
                })
            })
            .collect::<Vec<_>>();
        for writer in writers {
            writer
                .join()
                .unwrap_or_else(|_| panic!("control writer panicked"))
                .unwrap_or_else(|error| panic!("{error:#}"));
        }

        let mut watcher = ControlWatcher::new(
            path.clone(),
            vec!["default".to_owned(), "gaming".to_owned()],
        );
        let final_state = watcher.poll();
        assert!(matches!(final_state.profile.as_str(), "default" | "gaming"));
        let leftovers = fs::read_dir(temp.path())
            .unwrap_or_else(|error| panic!("{error}"))
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != "control.json")
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "writer scratch files must be cleaned up"
        );
    }
}
