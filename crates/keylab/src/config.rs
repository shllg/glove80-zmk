use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const MIN_TIER_A_SEAL_FLOOR: u32 = 25;
pub const MIN_TIER_B_SEAL_COUNT: u32 = 2_000;
pub const MIN_BUCKET_SECONDS: u64 = 10;

/// A Tier C window is sealed by *corrections*, where one correction is one completed backspace
/// run. Like the Tier A and Tier B floors this is an enforced minimum, not a preference.
pub const MIN_NGRAM_SEAL_COUNT: u32 = 500;
/// An ordered position trigram seen fewer than this many times in one window is written as its
/// finger-level projection instead. Targets the long tail where a repeated fumble lives.
pub const MIN_NGRAM_MIN_COUNT: u32 = 3;
/// Bounds the per-profile Tier C accumulators. `docs/keylab.md` promises bounded in-memory state,
/// so the maps are capped rather than allowed to grow with the stream.
pub const MAX_NGRAM_ENTRIES: usize = 4_096;
pub const MAX_NGRAM_FINGER_ENTRIES: usize = 1_024;

// The caps are hard ceilings, not tuning. At the enforced seal floor the position map cannot
// overflow from a single window at all; the cap is what still bounds it when `ngram_seal_count` is
// raised. The finger map is deliberately the smaller of the two: a degraded row carries strictly
// less identity, so it needs strictly less room.
const _: () = assert!(MAX_NGRAM_ENTRIES >= MIN_NGRAM_SEAL_COUNT as usize);
const _: () = assert!(MAX_NGRAM_FINGER_ENTRIES < MAX_NGRAM_ENTRIES);

/// Bounds the per-profile Tier B accumulators. This is a privacy invariant, not a preference:
/// each profile holds its own 81-slot histogram and the total footprint must stay bounded.
pub const MAX_PROFILES: usize = 8;
pub const DEFAULT_PROFILE: &str = "default";

/// Bounds the number of keymaps held in memory and the number of position spaces the analysis
/// guard has to reason about.
pub const MAX_DEVICE_RULES: usize = 8;
/// The keymap kind a pre-multi-device configuration and every pre-v3 database row belongs to.
pub const DEFAULT_KEYMAP_KIND: &str = "glove80";

/// Pairs an evdev name fragment with the position space that fragment's keyboards live in.
///
/// `name` is the *position space*, not the device: the laptop keyboard and an external QWERTY are
/// separate devices that legitimately share one `qwerty-ansi` space, and Tier B may only be pooled
/// inside a single space.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceRule {
    pub name: String,
    pub name_contains: String,
    pub keymap_meta_path: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Superseded by `devices`. Retained so an installed single-keyboard configuration keeps
    /// loading across the upgrade; `load` folds it into a single rule.
    pub device_name_contains: String,
    pub devices: Vec<DeviceRule>,
    pub db_path: PathBuf,
    /// Superseded by `DeviceRule::keymap_meta_path`, retained for the same reason.
    pub keymap_meta_path: PathBuf,
    pub bucket_seconds: u64,
    pub tier_a_seal_floor: u32,
    pub tier_b_seal_count: u32,
    pub live_snapshot_seconds: u64,
    pub profiles: Vec<String>,
    pub auto_revert_idle_seconds: u64,
    /// Tier C correction-context capture. On by default: a manually-armed capture would
    /// systematically miss ordinary work, which is the only thing worth measuring.
    pub ngram_capture: bool,
    pub ngram_seal_count: u32,
    pub ngram_min_count: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            device_name_contains: "Evsieve Virtual Device".to_owned(),
            devices: Vec::new(),
            db_path: PathBuf::from("~/.local/share/glove80-lab/keylab.db"),
            keymap_meta_path: PathBuf::from("/home/sascha/src/glove80-zmk/out/keymap-meta.json"),
            bucket_seconds: 10,
            tier_a_seal_floor: MIN_TIER_A_SEAL_FLOOR,
            tier_b_seal_count: MIN_TIER_B_SEAL_COUNT,
            live_snapshot_seconds: 1,
            profiles: vec![
                DEFAULT_PROFILE.to_owned(),
                "training-de".to_owned(),
                "training-en".to_owned(),
                "gaming".to_owned(),
                "training-code".to_owned(),
            ],
            auto_revert_idle_seconds: 900,
            ngram_capture: true,
            ngram_seal_count: MIN_NGRAM_SEAL_COUNT,
            ngram_min_count: MIN_NGRAM_MIN_COUNT,
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
        config.fold_legacy_device_fields();
        for rule in &mut config.devices {
            rule.keymap_meta_path = expand_home(&rule.keymap_meta_path)?;
        }
        config.validate()?;
        Ok(config)
    }

    /// A configuration written before multi-device support names one keyboard with two top-level
    /// keys. An absent `devices` list therefore *means* that single rule rather than "no devices",
    /// which keeps an installed configuration working untouched across the upgrade.
    pub fn effective_devices(&self) -> Vec<DeviceRule> {
        if !self.devices.is_empty() {
            return self.devices.clone();
        }
        vec![DeviceRule {
            name: DEFAULT_KEYMAP_KIND.to_owned(),
            name_contains: self.device_name_contains.clone(),
            keymap_meta_path: self.keymap_meta_path.clone(),
        }]
    }

    pub fn fold_legacy_device_fields(&mut self) {
        self.devices = self.effective_devices();
    }

    pub fn validate(&self) -> Result<()> {
        if self.device_name_contains.is_empty() {
            bail!("device_name_contains must not be empty");
        }
        self.validate_device_rules()?;
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
        if self.ngram_seal_count < MIN_NGRAM_SEAL_COUNT {
            bail!(
                "ngram_seal_count cannot be below privacy floor {}",
                MIN_NGRAM_SEAL_COUNT
            );
        }
        if self.ngram_min_count < MIN_NGRAM_MIN_COUNT {
            bail!(
                "ngram_min_count cannot be below privacy floor {}",
                MIN_NGRAM_MIN_COUNT
            );
        }
        if self.profiles.len() > MAX_PROFILES {
            bail!("at most {MAX_PROFILES} profiles are supported");
        }
        if self.profiles.first().map(String::as_str) != Some(DEFAULT_PROFILE) {
            bail!("the first profile must be \"{DEFAULT_PROFILE}\"");
        }
        for name in &self.profiles {
            if name.is_empty()
                || name.len() > 32
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                bail!("profile names must be 1-32 chars of [a-z0-9-]");
            }
        }
        let mut seen = self.profiles.clone();
        seen.sort();
        seen.dedup();
        if seen.len() != self.profiles.len() {
            bail!("profile names must be unique");
        }
        Ok(())
    }

    /// Rules are matched by substring, so an ambiguous set silently attributes one keyboard's
    /// keystrokes to another board's position space. That must fail at load, not at capture.
    fn validate_device_rules(&self) -> Result<()> {
        let devices = self.effective_devices();
        if devices.is_empty() {
            bail!("at least one device rule is required");
        }
        if devices.len() > MAX_DEVICE_RULES {
            bail!("at most {MAX_DEVICE_RULES} device rules are supported");
        }
        for rule in &devices {
            if rule.name.is_empty()
                || rule.name.len() > 32
                || !rule
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                bail!("device rule names must be 1-32 chars of [a-z0-9-]");
            }
            if rule.name_contains.is_empty() {
                bail!("device rule name_contains must not be empty");
            }
            if rule.keymap_meta_path.as_os_str().is_empty() {
                bail!("device rule keymap_meta_path must not be empty");
            }
        }
        for (index, rule) in devices.iter().enumerate() {
            for other in devices.iter().skip(index + 1) {
                if rule.name == other.name {
                    bail!("device rule names must be unique");
                }
                if rule.name_contains.contains(&other.name_contains)
                    || other.name_contains.contains(&rule.name_contains)
                {
                    bail!(
                        "device rule name fragments must be unambiguous; {:?} and {:?} can match the same device",
                        rule.name_contains,
                        other.name_contains
                    );
                }
            }
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
        assert!(config.ngram_capture);
        assert_eq!(config.ngram_seal_count, 500);
        assert_eq!(config.ngram_min_count, 3);
    }

    #[test]
    fn rejects_lower_ngram_seal_count() {
        let config = Config {
            ngram_seal_count: 499,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_lower_ngram_min_count() {
        let config = Config {
            ngram_min_count: 2,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    /// `Config` carries `#[serde(default)]`, so an installed configuration written before Tier C
    /// existed must keep loading and pick up the enforced defaults.
    #[test]
    fn a_config_without_ngram_keys_still_loads() {
        let source = r#"
device_name_contains = "Evsieve Virtual Device"
db_path = "/tmp/keylab.db"
keymap_meta_path = "/tmp/keymap-meta.json"
bucket_seconds = 10
tier_a_seal_floor = 25
tier_b_seal_count = 2000
live_snapshot_seconds = 1
profiles = ["default", "gaming"]
auto_revert_idle_seconds = 900
"#;
        let config: Config = toml::from_str(source).unwrap_or_else(|error| panic!("{error}"));
        assert!(config.ngram_capture);
        assert_eq!(config.ngram_seal_count, MIN_NGRAM_SEAL_COUNT);
        assert_eq!(config.ngram_min_count, MIN_NGRAM_MIN_COUNT);
        config
            .validate()
            .unwrap_or_else(|error| panic!("{error:#}"));
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

    #[test]
    fn rejects_more_profiles_than_the_cap() {
        let config = Config {
            profiles: (0..MAX_PROFILES + 1)
                .map(|index| format!("p{index}"))
                .collect(),
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_a_profile_list_without_the_default_profile() {
        let config = Config {
            profiles: vec!["gaming".to_owned()],
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_duplicate_and_malformed_profile_names() {
        let duplicated = Config {
            profiles: vec![
                DEFAULT_PROFILE.to_owned(),
                "gaming".to_owned(),
                "gaming".to_owned(),
            ],
            ..Config::default()
        };
        assert!(duplicated.validate().is_err());

        let malformed = Config {
            profiles: vec![DEFAULT_PROFILE.to_owned(), "Training DE".to_owned()],
            ..Config::default()
        };
        assert!(malformed.validate().is_err());
    }

    #[test]
    fn default_profiles_are_valid_and_start_with_default() {
        let config = Config::default();
        assert_eq!(
            config.profiles.first().map(String::as_str),
            Some(DEFAULT_PROFILE)
        );
        config
            .validate()
            .unwrap_or_else(|error| panic!("{error:#}"));
    }

    fn rule(name: &str, contains: &str) -> DeviceRule {
        DeviceRule {
            name: name.to_owned(),
            name_contains: contains.to_owned(),
            keymap_meta_path: PathBuf::from("/tmp/meta.json"),
        }
    }

    #[test]
    fn a_legacy_single_keyboard_config_folds_into_one_rule() {
        let mut config = Config::default();
        assert!(config.devices.is_empty());
        config.fold_legacy_device_fields();
        assert_eq!(config.devices.len(), 1);
        assert_eq!(config.devices[0].name, DEFAULT_KEYMAP_KIND);
        assert_eq!(config.devices[0].name_contains, "Evsieve Virtual Device");
        assert_eq!(config.devices[0].keymap_meta_path, config.keymap_meta_path);
        config
            .validate()
            .unwrap_or_else(|error| panic!("{error:#}"));
    }

    #[test]
    fn folding_never_overwrites_an_explicit_device_list() {
        let mut config = Config {
            devices: vec![rule("qwerty-ansi", "AT Translated")],
            ..Config::default()
        };
        config.fold_legacy_device_fields();
        assert_eq!(config.devices.len(), 1);
        assert_eq!(config.devices[0].name, "qwerty-ansi");
    }

    #[test]
    fn rejects_ambiguous_device_name_fragments() {
        let config = Config {
            devices: vec![rule("glove80", "Evsieve"), rule("other", "Evsieve Virtual")],
            ..Config::default()
        };
        let error = config
            .validate()
            .expect_err("one fragment contains the other");
        assert!(format!("{error:#}").contains("unambiguous"));
    }

    #[test]
    fn rejects_duplicate_device_rule_names() {
        let config = Config {
            devices: vec![rule("glove80", "Evsieve"), rule("glove80", "AT Translated")],
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_more_device_rules_than_the_cap() {
        let config = Config {
            devices: (0..MAX_DEVICE_RULES + 1)
                .map(|index| rule(&format!("kind{index}"), &format!("Device{index}")))
                .collect(),
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn accepts_two_unambiguous_device_rules() {
        let config = Config {
            devices: vec![
                rule("glove80", "Evsieve Virtual Device"),
                rule("qwerty-ansi", "AT Translated Set 2 keyboard"),
            ],
            ..Config::default()
        };
        config
            .validate()
            .unwrap_or_else(|error| panic!("{error:#}"));
    }

    #[test]
    fn accepts_a_disabled_idle_auto_revert() {
        let config = Config {
            auto_revert_idle_seconds: 0,
            ..Config::default()
        };
        config
            .validate()
            .unwrap_or_else(|error| panic!("{error:#}"));
    }
}
