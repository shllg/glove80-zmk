use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const MIN_TIER_A_SEAL_FLOOR: u32 = 25;
pub const MIN_TIER_B_SEAL_COUNT: u32 = 2_000;
pub const MIN_BUCKET_SECONDS: u64 = 10;

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub device_name_contains: String,
    pub db_path: PathBuf,
    pub keymap_meta_path: PathBuf,
    pub bucket_seconds: u64,
    pub tier_a_seal_floor: u32,
    pub tier_b_seal_count: u32,
    pub live_snapshot_seconds: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            device_name_contains: "Evsieve Virtual Device".to_owned(),
            db_path: PathBuf::from("~/.local/share/glove80-lab/keylab.db"),
            keymap_meta_path: PathBuf::from("/home/sascha/src/glove80-zmk/out/keymap-meta.json"),
            bucket_seconds: 10,
            tier_a_seal_floor: MIN_TIER_A_SEAL_FLOOR,
            tier_b_seal_count: MIN_TIER_B_SEAL_COUNT,
            live_snapshot_seconds: 1,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let source = fs::read_to_string(path)
            .with_context(|| format!("failed to read config at {}", path.display()))?;
        let mut config: Self = toml::from_str(&source).context("invalid keylab configuration")?;
        config.db_path = expand_home(&config.db_path)?;
        config.keymap_meta_path = expand_home(&config.keymap_meta_path)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.device_name_contains.is_empty() {
            bail!("device_name_contains must not be empty");
        }
        if self.bucket_seconds < MIN_BUCKET_SECONDS {
            bail!(
                "bucket_seconds cannot be below privacy floor {}",
                MIN_BUCKET_SECONDS
            );
        }
        if self.live_snapshot_seconds == 0 {
            bail!("live_snapshot_seconds must be greater than zero");
        }
        if self.tier_a_seal_floor < MIN_TIER_A_SEAL_FLOOR {
            bail!(
                "tier_a_seal_floor cannot be below privacy floor {}",
                MIN_TIER_A_SEAL_FLOOR
            );
        }
        if self.tier_b_seal_count < MIN_TIER_B_SEAL_COUNT {
            bail!(
                "tier_b_seal_count cannot be below privacy floor {}",
                MIN_TIER_B_SEAL_COUNT
            );
        }
        Ok(())
    }
}

pub fn default_config_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".config/glove80-lab/keylab.toml"))
}

fn expand_home(path: &Path) -> Result<PathBuf> {
    let text = path.to_string_lossy();
    if text == "~" {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set");
    }
    if let Some(rest) = text.strip_prefix("~/") {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        return Ok(PathBuf::from(home).join(rest));
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_privacy_spec() {
        let config = Config::default();
        assert_eq!(config.device_name_contains, "Evsieve Virtual Device");
        assert_eq!(config.bucket_seconds, 10);
        assert_eq!(config.tier_a_seal_floor, 25);
        assert_eq!(config.tier_b_seal_count, 2_000);
        assert_eq!(config.live_snapshot_seconds, 1);
    }

    #[test]
    fn rejects_lower_tier_a_floor() {
        let config = Config {
            tier_a_seal_floor: 5,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_lower_tier_b_floor() {
        let config = Config {
            tier_b_seal_count: 100,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_shorter_tier_a_time_window() {
        let config = Config {
            bucket_seconds: 5,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }
}
