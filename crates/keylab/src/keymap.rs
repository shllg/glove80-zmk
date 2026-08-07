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
    /// Keycode to layer name, for the spare keys the firmware taps when the active layer changes.
    /// Several indices share one code — the Base clones the BT profile indicators generate are
    /// Base — so the mapping is to the name, which is what attribution cares about.
    layer_signals: HashMap<u16, String>,
    by_keycode: HashMap<u16, KeyInfo>,
    /// Position to `finger_id`, indexed by physical position. Tier C degrades a rare ordered
    /// position trigram to its finger-level projection, which needs this direction of the map.
    finger_by_position: [Option<u8>; 80],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeymapFile {
    schema_version: u32,
    keymap_hash: String,
    git_commit: String,
    positions: Positions,
    /// Absent for every keymap generated before 2026-08-07, and for any board whose firmware does
    /// not signal layers at all — the laptop keyboard, for one.
    #[serde(default)]
    layer_signals: Vec<LayerSignalEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerSignalEntry {
    layer: String,
    index: u8,
    linux_keycode: u16,
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
                formatter.write_str("an array containing 1 to 80 keymap positions")
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
                // A board smaller than the Glove80 is legitimate — the laptop QWERTY has fewer
                // keys — but the Tier B accumulator has exactly 81 slots, so 80 is a hard ceiling.
                if positions.is_empty() || positions.len() > 80 {
                    return Err(A::Error::custom("keymap must contain 1 to 80 positions"));
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
        let mut layer_signals: HashMap<u16, String> = HashMap::new();
        for entry in file.layer_signals {
            if entry.index > 15 {
                bail!("keymap metadata contains a layer signal above the ZMK layer limit");
            }
            match layer_signals.get(&entry.linux_keycode) {
                // The Base clones the profile indicators generate share Base's code, which is
                // correct. Two *different* layers behind one code is not: it would attribute
                // whatever follows to whichever name happened to be read last.
                Some(existing) if existing != &entry.layer => bail!(
                    "keymap metadata maps keycode {} to both '{}' and '{}'",
                    entry.linux_keycode,
                    existing,
                    entry.layer
                ),
                Some(_) => {}
                None => {
                    layer_signals.insert(entry.linux_keycode, entry.layer);
                }
            }
        }

        let mut by_keycode = HashMap::with_capacity(80);
        let mut finger_by_position: [Option<u8>; 80] = [None; 80];
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
            // Recorded before the `linux_keycode` check below, so the projection covers every
            // declared position rather than only the ones reachable from the base layer.
            finger_by_position[usize::from(position.pos)] = Some(position.finger_id);

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
        // A signal code that the board also types would make a real keystroke look like a layer
        // change, and the keystroke would then go uncounted. The generator refuses to emit one;
        // this is the second lock, because the metadata can also be hand-written.
        if let Some(code) = layer_signals
            .keys()
            .find(|code| by_keycode.contains_key(code))
        {
            bail!("keycode {code} is both a layer signal and a typed key");
        }

        Ok(Self {
            hash: file.keymap_hash,
            git_commit: file.git_commit,
            alt_hand_ambiguous,
            layer_signals,
            by_keycode,
            finger_by_position,
        })
    }

    pub fn resolve(&self, code: u16) -> Option<KeyInfo> {
        self.by_keycode.get(&code).copied()
    }

    /// The layer a keycode reports, for the spare keys the firmware taps on a layer change. `None`
    /// for every ordinary key, which is the answer for every board that does not signal layers.
    pub fn layer_signal(&self, code: u16) -> Option<&str> {
        self.layer_signals.get(&code).map(String::as_str)
    }

    pub fn signals_layers(&self) -> bool {
        !self.layer_signals.is_empty()
    }

    /// The finger that owns a physical position, or `None` for a position this board does not
    /// declare. Tier C uses it to degrade a rare position trigram to its finger projection.
    pub fn finger_for_position(&self, pos: u8) -> Option<u8> {
        self.finger_by_position.get(usize::from(pos)).copied()?
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
        let mut finger_by_position: [Option<u8>; 80] = [None; 80];
        for (_, info) in entries {
            finger_by_position[usize::from(info.pos)] = Some(info.finger_id);
        }
        Self {
            hash: "fixture".to_owned(),
            git_commit: "fixture".to_owned(),
            alt_hand_ambiguous: false,
            layer_signals: HashMap::new(),
            by_keycode: entries.iter().copied().collect(),
            finger_by_position,
        }
    }

    pub(crate) fn with_layer_signals(mut self, signals: &[(u16, &str)]) -> Self {
        self.layer_signals = signals
            .iter()
            .map(|(code, layer)| (*code, (*layer).to_owned()))
            .collect();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_generated_keymap_which_no_longer_collides_on_alt() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/keymap-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(
            !keymap.alt_hand_ambiguous,
            "the right home row mod binds RALT since 2026-08-07, so the hands are distinguishable"
        );
        assert_eq!(keymap.resolve(30).map(|info| info.pos), Some(35));
    }

    #[test]
    fn the_generated_keymap_names_a_layer_for_every_signal_code() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/keymap-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(keymap.signals_layers());
        // KEY_F14 through KEY_F19. The five Base layers the BT profile indicators generate share
        // one code, which is the point: a profile indicator is not a different layer to type on.
        assert_eq!(keymap.layer_signal(184), Some("Base"));
        assert_eq!(keymap.layer_signal(185), Some("Navigation"));
        assert_eq!(keymap.layer_signal(189), Some("Magic"));
        // An ordinary key is never a signal, and a signal is never an ordinary key.
        assert_eq!(keymap.layer_signal(30), None);
        assert!(keymap.resolve(184).is_none());
    }

    #[test]
    fn a_board_that_does_not_signal_layers_loads_unchanged() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/qwerty-ansi-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(!keymap.signals_layers());
        assert_eq!(keymap.layer_signal(184), None);
    }

    #[test]
    fn a_signal_code_the_board_also_types_is_refused() {
        // Both directions of this are corruption rather than an error: the keystroke would go
        // uncounted, and the layer would change on a key the user merely typed.
        let file: KeymapFile = serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "keymapHash": "sha256:0",
                "gitCommit": "test",
                "positions": [
                    {"pos": 0, "hand": "L", "row": 1, "finger": "L_pinky", "fingerId": 3,
                     "linuxKeycode": 184, "baseBinding": "&kp F14", "isHrm": false}
                ],
                "layerSignals": [{"layer": "Base", "index": 0, "code": "F14", "linuxKeycode": 184}]
            }"#,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        // `Keymap` has no `Debug`, so the refusal is matched rather than unwrapped.
        let error = match Keymap::from_file(file) {
            Ok(_) => panic!("a typed signal code must be refused"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("both a layer signal and a typed key"));
    }

    #[test]
    fn one_signal_code_reporting_two_layers_is_refused() {
        let file: KeymapFile = serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "keymapHash": "sha256:0",
                "gitCommit": "test",
                "positions": [
                    {"pos": 0, "hand": "L", "row": 1, "finger": "L_pinky", "fingerId": 3,
                     "linuxKeycode": 30, "baseBinding": "&kp A", "isHrm": false}
                ],
                "layerSignals": [
                    {"layer": "Base", "index": 0, "code": "F14", "linuxKeycode": 184},
                    {"layer": "Magic", "index": 1, "code": "F14", "linuxKeycode": 184}
                ]
            }"#,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        let error = match Keymap::from_file(file) {
            Ok(_) => panic!("an ambiguous signal code must be refused"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("both 'Base' and 'Magic'"));
    }

    #[test]
    fn one_alt_keycode_on_both_hands_is_reported_as_ambiguous() {
        // The state this keymap was in until 2026-08-07: `&hml LALT S` and `&hmr LALT L` both emit
        // KEY_LEFTALT, so evdev cannot tell the hands apart. The generated file no longer contains
        // it, which is exactly why the detection needs a case of its own — otherwise the fix would
        // have deleted the only coverage the check had.
        let file: KeymapFile = serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "keymapHash": "sha256:0",
                "gitCommit": "test",
                "positions": [
                    {"pos": 36, "hand": "L", "row": 4, "finger": "L_ring", "fingerId": 2,
                     "linuxKeycode": 31, "baseBinding": "&hml LALT S", "isHrm": true,
                     "modClass": "L_ALT"},
                    {"pos": 43, "hand": "R", "row": 4, "finger": "R_ring", "fingerId": 7,
                     "linuxKeycode": 38, "baseBinding": "&hmr LALT L", "isHrm": true,
                     "modClass": "R_ALT"}
                ]
            }"#,
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        let keymap = Keymap::from_file(file).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(keymap.alt_hand_ambiguous);
    }

    #[test]
    fn loads_the_hand_written_qwerty_keymap() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/qwerty-ansi-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(
            !keymap.alt_hand_ambiguous,
            "a plain QWERTY board has no home row mods, so ALT is unambiguous"
        );
        // KEY_F is the right index home key; KEY_102ND exists for a DE ISO laptop.
        let f = keymap
            .resolve(33)
            .unwrap_or_else(|| unreachable!("KEY_F must resolve"));
        assert_eq!((f.hand, f.finger_id, f.row_idx), (HAND_LEFT, 0, 3));
        let j = keymap
            .resolve(36)
            .unwrap_or_else(|| unreachable!("KEY_J must resolve"));
        assert_eq!((j.hand, j.finger_id, j.row_idx), (HAND_RIGHT, 5, 3));
        assert!(keymap.resolve(86).is_some(), "KEY_102ND must be mapped");
        // Nothing from the Glove80's F-row exists on this board.
        assert!(keymap.resolve(59).is_none());
    }

    #[test]
    fn projects_a_physical_position_back_to_its_finger() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/keymap-meta.json");
        let keymap = Keymap::load(&path).unwrap_or_else(|error| panic!("{error:#}"));
        let a = keymap
            .resolve(30)
            .unwrap_or_else(|| unreachable!("KEY_A must resolve"));
        assert_eq!(keymap.finger_for_position(a.pos), Some(a.finger_id));
        assert_eq!(keymap.finger_for_position(200), None);
    }

    #[test]
    fn modifier_binding_parser_uses_emitted_modifier_not_tap_key() {
        assert_eq!(modifier_keycode_from_binding("&hml LALT S"), Some(56));
        assert_eq!(modifier_keycode_from_binding("&hmr LALT L"), Some(56));
        assert_eq!(modifier_keycode_from_binding("&hmr RALT L"), Some(100));
        assert_eq!(modifier_keycode_from_binding("&kp A"), None);
    }
}
