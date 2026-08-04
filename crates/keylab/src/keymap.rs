use crate::encode::{
    finger_id, FINGER_INDEX, FINGER_MIDDLE, FINGER_PINKY, FINGER_RING, FINGER_THUMB, HAND_LEFT,
    HAND_RIGHT,
};
use anyhow::{bail, Context, Result};
use serde::de::{Error as DeError, SeqAccess, Visitor};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::Path;

#[derive(Clone, Copy)]
pub struct KeyInfo {
    pub pos: u8,
    pub hand: u8,
    pub finger_id: u8,
    pub row_idx: u8,
}

pub struct Keymap {
    pub hash: String,
    pub git_commit: String,
    pub alt_hand_ambiguous: bool,
    by_keycode: HashMap<u16, KeyInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeymapFile {
    schema_version: u32,
    keymap_hash: String,
    git_commit: String,
    positions: Positions,
}

struct Positions(HashMap<u8, Position>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Position {
    pos: u8,
    hand: String,
    row: u8,
    finger: String,
    finger_id: u8,
    linux_keycode: Option<u16>,
    base_binding: String,
    is_hrm: bool,
    mod_class: Option<String>,
}

impl<'de> Deserialize<'de> for Positions {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PositionsVisitor;

        impl<'de> Visitor<'de> for PositionsVisitor {
            type Value = Positions;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an array containing exactly 80 keymap positions")
            }

            fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut positions = HashMap::with_capacity(80);
                while let Some(position) = sequence.next_element::<Position>()? {
                    let pos = position.pos;
                    if positions.insert(pos, position).is_some() {
                        return Err(A::Error::custom("duplicate keymap position"));
                    }
                }
                if positions.len() != 80 {
                    return Err(A::Error::custom("keymap must contain exactly 80 positions"));
                }
                Ok(Positions(positions))
            }
        }

        deserializer.deserialize_seq(PositionsVisitor)
    }
}

impl Keymap {
    pub fn load(path: &Path) -> Result<Self> {
        let source = fs::read(path)
            .with_context(|| format!("failed to read keymap metadata at {}", path.display()))?;
        let file: KeymapFile =
            serde_json::from_slice(&source).context("invalid keymap metadata")?;
        if file.schema_version != 1 {
            bail!("unsupported keymap metadata schema version");
        }
        Self::from_file(file)
    }

    fn from_file(file: KeymapFile) -> Result<Self> {
        let mut by_keycode = HashMap::with_capacity(80);
        let mut ambiguous_keycodes = HashSet::new();
        let mut left_alt_codes = HashSet::new();
        let mut right_alt_codes = HashSet::new();

        for position in file.positions.0.into_values() {
            if position.pos > 79 || !(1..=6).contains(&position.row) || position.finger_id > 9 {
                bail!("keymap metadata contains an out-of-range position attribute");
            }
            let hand = match position.hand.as_str() {
                "L" => HAND_LEFT,
                "R" => HAND_RIGHT,
                _ => bail!("keymap metadata contains an invalid hand"),
            };
            let finger = match position.finger.rsplit_once('_').map(|(_, finger)| finger) {
                Some("index") => FINGER_INDEX,
                Some("middle") => FINGER_MIDDLE,
                Some("ring") => FINGER_RING,
                Some("pinky") => FINGER_PINKY,
                Some("thumb") => FINGER_THUMB,
                _ => bail!("keymap metadata contains an invalid finger"),
            };
            if position.finger_id != finger_id(hand, finger) {
                bail!("keymap metadata contains an inconsistent finger encoding");
            }

            if position.is_hrm {
                if let (Some(class), Some(code)) = (
                    position.mod_class.as_deref(),
                    modifier_keycode_from_binding(&position.base_binding),
                ) {
                    match class {
                        "L_ALT" => {
                            left_alt_codes.insert(code);
                        }
                        "R_ALT" => {
                            right_alt_codes.insert(code);
                        }
                        _ => {}
                    }
                }
            }

            let Some(code) = position.linux_keycode else {
                continue;
            };
            if ambiguous_keycodes.contains(&code) {
                continue;
            }
            let info = KeyInfo {
                pos: position.pos,
                hand,
                finger_id: position.finger_id,
                row_idx: position.row,
            };
            if by_keycode.insert(code, info).is_some() {
                by_keycode.remove(&code);
                ambiguous_keycodes.insert(code);
            }
        }

        let alt_hand_ambiguous = left_alt_codes
            .iter()
            .any(|code| right_alt_codes.contains(code));
        Ok(Self {
            hash: file.keymap_hash,
            git_commit: file.git_commit,
            alt_hand_ambiguous,
            by_keycode,
        })
    }

    pub fn resolve(&self, code: u16) -> Option<KeyInfo> {
        self.by_keycode.get(&code).copied()
    }
}

fn modifier_keycode_from_binding(binding: &str) -> Option<u16> {
    let mut fields = binding.split_ascii_whitespace();
    let behavior = fields.next()?;
    if behavior != "&hml" && behavior != "&hmr" {
        return None;
    }
    match fields.next()? {
        "LCTRL" => Some(29),
        "LALT" => Some(56),
        "LGUI" => Some(125),
        "LSHFT" => Some(42),
        "RCTRL" => Some(97),
        "RALT" => Some(100),
        "RGUI" => Some(126),
        "RSHFT" => Some(54),
        _ => None,
    }
}

#[cfg(test)]
impl Keymap {
    pub(crate) fn fixture(entries: &[(u16, KeyInfo)]) -> Self {
        Self {
            hash: "fixture".to_owned(),
            git_commit: "fixture".to_owned(),
            alt_hand_ambiguous: false,
            by_keycode: entries.iter().copied().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_generated_keymap_and_exposes_alt_collision() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/keymap-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(keymap.alt_hand_ambiguous);
        assert_eq!(keymap.resolve(30).map(|info| info.pos), Some(35));
    }

    #[test]
    fn modifier_binding_parser_uses_emitted_modifier_not_tap_key() {
        assert_eq!(modifier_keycode_from_binding("&hml LALT S"), Some(56));
        assert_eq!(modifier_keycode_from_binding("&hmr LALT L"), Some(56));
        assert_eq!(modifier_keycode_from_binding("&hmr RALT L"), Some(100));
        assert_eq!(modifier_keycode_from_binding("&kp A"), None);
    }
}
