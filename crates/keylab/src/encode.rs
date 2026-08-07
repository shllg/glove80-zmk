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

/// The length of a Tier C correction-context n-gram.
pub const NGRAM_N: usize = 3;
/// A key that resolved to no physical position. This is the existing Tier B convention, which
/// was previously the bare literal `80` in the aggregator.
pub const POS_UNATTRIBUTED: u8 = 80;
/// Fewer than `NGRAM_N` keys preceded the correction, so this slot holds no position at all.
pub const POS_ABSENT: u8 = 81;
/// The finger-level counterpart of both `POS_UNATTRIBUTED` and `POS_ABSENT`: the finger-level
/// projection has one "no finger" value, because an unattributed key has no finger either.
pub const FINGER_ABSENT: u8 = 10;

/// Time from the last keydown to the start of a backspace run. Separates a fumble from an edit;
/// without it the table mixes mistyping with ordinary rewriting.
///
/// **Pinned to `packages/trainer/src/corrections.ts`.** The trainer splits its own corrections on
/// the same boundaries so the two instruments mean the same thing by "fumble". Rust and TypeScript
/// cannot share a constant, so both sides carry a test asserting these four boundaries; change one
/// and the other's test fails rather than the comparison silently drifting.
pub const fn latency_bucket(ms: u64) -> u8 {
    if ms < 150 {
        0
    } else if ms < 400 {
        1
    } else if ms < 1_000 {
        2
    } else {
        3
    }
}

// pos_a | pos_b | pos_c | mod_mask | latency | run  — 34 bits used of 64.
const NGRAM_RUN_SHIFT: u32 = 0;
const NGRAM_LATENCY_SHIFT: u32 = 3;
const NGRAM_MOD_SHIFT: u32 = 5;
const NGRAM_POS_C_SHIFT: u32 = 13;
const NGRAM_POS_B_SHIFT: u32 = 20;
const NGRAM_POS_A_SHIFT: u32 = 27;

// finger_a | finger_b | finger_c | mod_mask | latency | run  — 25 bits used of 64.
const FINGER_RUN_SHIFT: u32 = 0;
const FINGER_LATENCY_SHIFT: u32 = 3;
const FINGER_MOD_SHIFT: u32 = 5;
const FINGER_C_SHIFT: u32 = 13;
const FINGER_B_SHIFT: u32 = 17;
const FINGER_A_SHIFT: u32 = 21;

const POS_MASK: u64 = 0x7f;
const FINGER_MASK: u64 = 0x0f;
const MOD_MASK: u64 = 0xff;
const LATENCY_MASK: u64 = 0x03;
const RUN_MASK: u64 = 0x07;

pub const fn pack_ngram(pos: [u8; NGRAM_N], mod_mask: u8, latency: u8, run: u8) -> u64 {
    ((pos[0] as u64 & POS_MASK) << NGRAM_POS_A_SHIFT)
        | ((pos[1] as u64 & POS_MASK) << NGRAM_POS_B_SHIFT)
        | ((pos[2] as u64 & POS_MASK) << NGRAM_POS_C_SHIFT)
        | ((mod_mask as u64 & MOD_MASK) << NGRAM_MOD_SHIFT)
        | ((latency as u64 & LATENCY_MASK) << NGRAM_LATENCY_SHIFT)
        | ((run as u64 & RUN_MASK) << NGRAM_RUN_SHIFT)
}

pub const fn unpack_ngram(key: u64) -> ([u8; NGRAM_N], u8, u8, u8) {
    (
        [
            ((key >> NGRAM_POS_A_SHIFT) & POS_MASK) as u8,
            ((key >> NGRAM_POS_B_SHIFT) & POS_MASK) as u8,
            ((key >> NGRAM_POS_C_SHIFT) & POS_MASK) as u8,
        ],
        ((key >> NGRAM_MOD_SHIFT) & MOD_MASK) as u8,
        ((key >> NGRAM_LATENCY_SHIFT) & LATENCY_MASK) as u8,
        ((key >> NGRAM_RUN_SHIFT) & RUN_MASK) as u8,
    )
}

pub const fn pack_finger(finger: [u8; NGRAM_N], mod_mask: u8, latency: u8, run: u8) -> u64 {
    ((finger[0] as u64 & FINGER_MASK) << FINGER_A_SHIFT)
        | ((finger[1] as u64 & FINGER_MASK) << FINGER_B_SHIFT)
        | ((finger[2] as u64 & FINGER_MASK) << FINGER_C_SHIFT)
        | ((mod_mask as u64 & MOD_MASK) << FINGER_MOD_SHIFT)
        | ((latency as u64 & LATENCY_MASK) << FINGER_LATENCY_SHIFT)
        | ((run as u64 & RUN_MASK) << FINGER_RUN_SHIFT)
}

pub const fn unpack_finger(key: u64) -> ([u8; NGRAM_N], u8, u8, u8) {
    (
        [
            ((key >> FINGER_A_SHIFT) & FINGER_MASK) as u8,
            ((key >> FINGER_B_SHIFT) & FINGER_MASK) as u8,
            ((key >> FINGER_C_SHIFT) & FINGER_MASK) as u8,
        ],
        ((key >> FINGER_MOD_SHIFT) & MOD_MASK) as u8,
        ((key >> FINGER_LATENCY_SHIFT) & LATENCY_MASK) as u8,
        ((key >> FINGER_RUN_SHIFT) & RUN_MASK) as u8,
    )
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
    fn latency_boundaries_are_exact() {
        let cases = [
            (0, 0),
            (149, 0),
            (150, 1),
            (399, 1),
            (400, 2),
            (999, 2),
            (1_000, 3),
            (60_000, 3),
        ];
        for (ms, expected) in cases {
            assert_eq!(latency_bucket(ms), expected);
        }
    }

    #[test]
    fn ngram_packing_round_trips() {
        let positions = [0_u8, 1, 79, POS_UNATTRIBUTED, POS_ABSENT];
        let masks = [0_u8, 1, 0b1000_0000, 0xff];
        for a in positions {
            for b in positions {
                for c in positions {
                    for mask in masks {
                        for latency in 0..=3_u8 {
                            for run in 0..=6_u8 {
                                let key = pack_ngram([a, b, c], mask, latency, run);
                                assert_eq!(
                                    unpack_ngram(key),
                                    ([a, b, c], mask, latency, run),
                                    "position n-gram round trip"
                                );
                            }
                        }
                    }
                }
            }
        }

        let fingers = [0_u8, 1, 9, FINGER_ABSENT];
        for a in fingers {
            for b in fingers {
                for c in fingers {
                    for mask in masks {
                        for latency in 0..=3_u8 {
                            for run in 0..=6_u8 {
                                let key = pack_finger([a, b, c], mask, latency, run);
                                assert_eq!(
                                    unpack_finger(key),
                                    ([a, b, c], mask, latency, run),
                                    "finger n-gram round trip"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn pins_ngram_bit_layout() {
        // pos_a = 1, pos_b = 2, pos_c = 3, mod_mask = 0b0000_0101, latency = 2, run = 6.
        let key = pack_ngram([1, 2, 3], 0b0000_0101, 2, 6);
        assert_eq!(
            key,
            (1 << 27) | (2 << 20) | (3 << 13) | (0b0000_0101 << 5) | (2 << 3) | 6
        );
        assert_eq!(key, 0x0820_60B6);
        // The widest legal tuple must still fit the documented 34 bits.
        let widest = pack_ngram([POS_ABSENT; NGRAM_N], 0xff, 3, 7);
        assert!(widest < (1 << 34));

        let finger_key = pack_finger([1, 2, 3], 0b0000_0101, 2, 6);
        assert_eq!(
            finger_key,
            (1 << 21) | (2 << 17) | (3 << 13) | (0b0000_0101 << 5) | (2 << 3) | 6
        );
        assert_eq!(finger_key, 0x0024_60B6);
        let widest_finger = pack_finger([FINGER_ABSENT; NGRAM_N], 0xff, 3, 7);
        assert!(widest_finger < (1 << 25));
    }

    #[test]
    fn pins_ngram_sentinels() {
        assert_eq!(NGRAM_N, 3);
        assert_eq!(POS_UNATTRIBUTED, 80);
        assert_eq!(POS_ABSENT, 81);
        assert_eq!(FINGER_ABSENT, 10);
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
