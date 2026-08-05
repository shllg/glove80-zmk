use crate::config::DEFAULT_PROFILE;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::warn;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlState {
    pub paused: bool,
    pub profile: String,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            paused: false,
            profile: DEFAULT_PROFILE.to_owned(),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct ControlFile {
    paused: bool,
    profile: String,
    updated_at: i64,
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
        let signature = metadata.modified().ok().map(|mtime| (mtime, metadata.len()));
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

    fn parse(&self) -> Result<ControlState> {
        let source = fs::read_to_string(&self.path).context("failed to read the control file")?;
        let parsed: ControlFile =
            serde_json::from_str(&source).context("invalid control file contents")?;
        if !self.profiles.iter().any(|name| *name == parsed.profile) {
            anyhow::bail!("control file names a profile that is not configured");
        }
        Ok(ControlState {
            paused: parsed.paused,
            profile: parsed.profile,
        })
    }
}

/// Writes via a sibling temporary file and `rename`, so a reader never observes a partial write.
pub fn write_control(path: &Path, state: &ControlState) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(&ControlFile {
        paused: state.paused,
        profile: state.profile.clone(),
        updated_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default(),
    })
    .context("failed to encode the control file")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        fs::write(&path, br#"{"paused":false,"profile":"nope","updated_at":0}"#)
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
}
