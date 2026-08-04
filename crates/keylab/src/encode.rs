pub const HAND_LEFT: u8 = 0;
pub const HAND_RIGHT: u8 = 1;

pub const FINGER_INDEX: u8 = 0;
pub const FINGER_MIDDLE: u8 = 1;
pub const FINGER_RING: u8 = 2;
pub const FINGER_PINKY: u8 = 3;
pub const FINGER_THUMB: u8 = 4;

pub const MOD_CTRL: u8 = 0;
pub const MOD_ALT: u8 = 1;
pub const MOD_GUI: u8 = 2;
pub const MOD_SHIFT: u8 = 3;

pub const LONELY_MOD: u8 = 0;
pub const MOD_DURING_ALPHA: u8 = 1;
pub const BSP_BURST_AFTER_MOD: u8 = 2;
pub const BSP_BURST: u8 = 3;

pub const fn finger_id(hand: u8, finger: u8) -> u8 {
    hand * 5 + finger
}

pub const fn mod_class(hand: u8, modifier: u8) -> u8 {
    hand * 4 + modifier
}

pub const fn modifier_class_for_keycode(code: u16) -> Option<u8> {
    match code {
        29 => Some(mod_class(HAND_LEFT, MOD_CTRL)),
        56 => Some(mod_class(HAND_LEFT, MOD_ALT)),
        125 => Some(mod_class(HAND_LEFT, MOD_GUI)),
        42 => Some(mod_class(HAND_LEFT, MOD_SHIFT)),
        97 => Some(mod_class(HAND_RIGHT, MOD_CTRL)),
        100 => Some(mod_class(HAND_RIGHT, MOD_ALT)),
        126 => Some(mod_class(HAND_RIGHT, MOD_GUI)),
        54 => Some(mod_class(HAND_RIGHT, MOD_SHIFT)),
        _ => None,
    }
}

pub const fn duration_bucket(ms: u64) -> u8 {
    if ms < 500 {
        (ms / 25) as u8
    } else if ms < 1_000 {
        20
    } else {
        21
    }
}

pub const fn gap_bucket(ms: u64) -> u8 {
    duration_bucket(ms)
}

pub const fn run_bucket(run_length: u32) -> u8 {
    match run_length {
        0 | 1 => 0,
        2 => 1,
        3 => 2,
        4 => 3,
        5..=8 => 4,
        9..=16 => 5,
        _ => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_hand_and_finger_encodings() {
        assert_eq!(HAND_LEFT, 0);
        assert_eq!(HAND_RIGHT, 1);
        assert_eq!(FINGER_INDEX, 0);
        assert_eq!(FINGER_MIDDLE, 1);
        assert_eq!(FINGER_RING, 2);
        assert_eq!(FINGER_PINKY, 3);
        assert_eq!(FINGER_THUMB, 4);
        assert_eq!(finger_id(HAND_LEFT, FINGER_INDEX), 0);
        assert_eq!(finger_id(HAND_LEFT, FINGER_THUMB), 4);
        assert_eq!(finger_id(HAND_RIGHT, FINGER_INDEX), 5);
        assert_eq!(finger_id(HAND_RIGHT, FINGER_THUMB), 9);
    }

    #[test]
    fn pins_modifier_encodings_and_keycodes() {
        assert_eq!(MOD_CTRL, 0);
        assert_eq!(MOD_ALT, 1);
        assert_eq!(MOD_GUI, 2);
        assert_eq!(MOD_SHIFT, 3);
        assert_eq!(modifier_class_for_keycode(29), Some(0));
        assert_eq!(modifier_class_for_keycode(56), Some(1));
        assert_eq!(modifier_class_for_keycode(125), Some(2));
        assert_eq!(modifier_class_for_keycode(42), Some(3));
        assert_eq!(modifier_class_for_keycode(97), Some(4));
        assert_eq!(modifier_class_for_keycode(100), Some(5));
        assert_eq!(modifier_class_for_keycode(126), Some(6));
        assert_eq!(modifier_class_for_keycode(54), Some(7));
        assert_eq!(modifier_class_for_keycode(30), None);
    }

    #[test]
    fn pins_event_kind_encodings() {
        assert_eq!(LONELY_MOD, 0);
        assert_eq!(MOD_DURING_ALPHA, 1);
        assert_eq!(BSP_BURST_AFTER_MOD, 2);
        assert_eq!(BSP_BURST, 3);
    }

    #[test]
    fn duration_and_gap_boundaries_are_exact() {
        let cases = [
            (0, 0),
            (24, 0),
            (25, 1),
            (499, 19),
            (500, 20),
            (999, 20),
            (1_000, 21),
            (60_000, 21),
        ];
        for (ms, expected) in cases {
            assert_eq!(duration_bucket(ms), expected);
            assert_eq!(gap_bucket(ms), expected);
        }
    }

    #[test]
    fn pins_run_buckets() {
        let cases = [
            (1, 0),
            (2, 1),
            (3, 2),
            (4, 3),
            (5, 4),
            (8, 4),
            (9, 5),
            (16, 5),
            (17, 6),
            (10_000, 6),
        ];
        for (run, expected) in cases {
            assert_eq!(run_bucket(run), expected);
        }
    }
}
