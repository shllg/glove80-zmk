use crate::config::{MAX_PROFILES, MIN_BUCKET_SECONDS};
use crate::encode::{
    duration_bucket, gap_bucket, modifier_class_for_keycode, run_bucket, BSP_BURST,
    BSP_BURST_AFTER_MOD, LONELY_MOD, MOD_DURING_ALPHA,
};
use crate::keymap::Keymap;
use std::collections::HashMap;
use zeroize::Zeroize;

const NO_EVENT_TS: u64 = u64::MAX;
const KEY_BACKSPACE: u16 = 14;
const MAX_HELD_KEYS: usize = 16;
const TIER_A_FIXED_ENTRIES: usize = 10 + 12 + (10 * 22) + (8 * 22) + (2 * 22) + (4 * 8);

const ALPHA_KEYCODES: [u16; 26] = [
    30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45,
    21, 44,
];

#[derive(Default)]
struct HeldSlot {
    code: u16,
    down_ts: u64,
    occupied: bool,
}

#[derive(Default)]
struct HeldKeys {
    slots: [HeldSlot; MAX_HELD_KEYS],
}

impl HeldKeys {
    fn insert(&mut self, code: u16, down_ts: u64) {
        if let Some(slot) = self
            .slots
            .iter_mut()
            .find(|slot| slot.occupied && slot.code == code)
        {
            slot.down_ts.zeroize();
            slot.down_ts = down_ts;
            return;
        }
        if let Some(slot) = self.slots.iter_mut().find(|slot| !slot.occupied) {
            slot.code = code;
            slot.down_ts = down_ts;
            slot.occupied = true;
        }
    }

    fn remove(&mut self, code: u16) -> Option<u64> {
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| slot.occupied && slot.code == code)?;
        let down_ts = slot.down_ts;
        slot.code.zeroize();
        slot.down_ts.zeroize();
        slot.occupied = false;
        Some(down_ts)
    }

    fn zeroize(&mut self) {
        for slot in &mut self.slots {
            slot.code.zeroize();
            slot.down_ts.zeroize();
            slot.occupied = false;
        }
    }

    fn len(&self) -> usize {
        self.slots.iter().filter(|slot| slot.occupied).count()
    }
}

impl Drop for HeldKeys {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Default)]
pub struct TierAAccumulator {
    pub active_ms: u64,
    pub keystrokes: u32,
    pub autorepeats: u32,
    pub finger_count: [u32; 10],
    pub row_count: [u32; 12],
    pub hold_hist: [[u32; 22]; 10],
    pub mod_hold_hist: [[u32; 22]; 8],
    pub gap_hist: [[u32; 22]; 2],
    pub event_count: [[u32; 8]; 4],
}

impl TierAAccumulator {
    fn zeroize(&mut self) {
        self.active_ms.zeroize();
        self.keystrokes.zeroize();
        self.autorepeats.zeroize();
        self.finger_count.zeroize();
        self.row_count.zeroize();
        self.hold_hist.zeroize();
        self.mod_hold_hist.zeroize();
        self.gap_hist.zeroize();
        self.event_count.zeroize();
    }
}

pub struct TierASeal {
    pub bucket_id: i64,
    pub span_ms: u64,
    pub data: TierAAccumulator,
}

impl Drop for TierASeal {
    fn drop(&mut self) {
        self.bucket_id.zeroize();
        self.span_ms.zeroize();
        self.data.zeroize();
    }
}

pub struct TierBSeal {
    pub start_ts: u64,
    pub end_ts: u64,
    pub keystrokes: u32,
    pub pos_count: [u32; 81],
}

impl Drop for TierBSeal {
    fn drop(&mut self) {
        self.start_ts.zeroize();
        self.end_ts.zeroize();
        self.keystrokes.zeroize();
        self.pos_count.zeroize();
    }
}

pub struct Aggregator {
    held: HeldKeys,
    last_event_ts: u64,
    last_alpha_ts: Option<u64>,
    last_keydown_ts: Option<u64>,
    bsp_run: u32,
    last_mod_release_ts: Option<u64>,
    keys_since_mod_down: HashMap<u8, u32>,
    pub tier_b_accum: Vec<[u32; 81]>,
    pub tier_a: TierAAccumulator,
    tier_a_bucket_id: i64,
    tier_a_span_ms: u64,
    tier_b_start_ts: Vec<Option<u64>>,
    profile_index: usize,
    last_mod_release_class: Option<u8>,
    bsp_run_after_mod_class: Option<u8>,
}

impl Aggregator {
    pub fn new(bucket_id: i64, profile_count: usize) -> Self {
        let profile_count = profile_count.clamp(1, MAX_PROFILES);
        Self {
            held: HeldKeys::default(),
            last_event_ts: NO_EVENT_TS,
            last_alpha_ts: None,
            last_keydown_ts: None,
            bsp_run: 0,
            last_mod_release_ts: None,
            keys_since_mod_down: HashMap::with_capacity(8),
            tier_b_accum: vec![[0; 81]; profile_count],
            tier_a: TierAAccumulator::default(),
            tier_a_bucket_id: bucket_id,
            tier_a_span_ms: 0,
            tier_b_start_ts: vec![None; profile_count],
            profile_index: 0,
            last_mod_release_class: None,
            bsp_run_after_mod_class: None,
        }
    }

    /// A profile switch changes which Tier B histogram receives events. Nothing is discarded: a
    /// window sealed under one profile must contain only that profile's keystrokes, and resetting
    /// on every switch would keep the 2000-keystroke floor permanently out of reach.
    pub fn set_profile(&mut self, profile_index: usize) {
        if profile_index < self.tier_b_accum.len() {
            self.profile_index = profile_index;
        }
    }

    pub fn handle_event(
        &mut self,
        t_ms: u64,
        code: u16,
        value: i32,
        keymap: &Keymap,
        tier_b_seal_count: u32,
    ) -> Option<TierBSeal> {
        if let Some(event_gap) = (self.last_event_ts != NO_EVENT_TS)
            .then(|| t_ms.checked_sub(self.last_event_ts))
            .flatten()
        {
            self.tier_a.active_ms = self.tier_a.active_ms.saturating_add(event_gap.min(2_000));
            if self.bsp_run > 0 && event_gap > 1_000 {
                self.finish_backspace_run();
            }
        }
        self.last_event_ts = t_ms;

        match value {
            2 => {
                self.tier_a.autorepeats = self.tier_a.autorepeats.saturating_add(1);
                None
            }
            1 => self.key_down(t_ms, code, keymap, tier_b_seal_count),
            0 => {
                self.key_up(t_ms, code, keymap);
                None
            }
            _ => None,
        }
    }

    fn key_down(
        &mut self,
        t_ms: u64,
        code: u16,
        keymap: &Keymap,
        tier_b_seal_count: u32,
    ) -> Option<TierBSeal> {
        self.remember_hold(code, t_ms);

        if let Some(mod_class) = modifier_class_for_keycode(code) {
            self.keys_since_mod_down.insert(mod_class, 0);
            if self
                .last_alpha_ts
                .and_then(|last| t_ms.checked_sub(last))
                .is_some_and(|elapsed| elapsed < 250)
            {
                self.increment_event(MOD_DURING_ALPHA, mod_class);
            }
            return None;
        }

        if code == KEY_BACKSPACE {
            if self.bsp_run == 0 {
                self.bsp_run_after_mod_class =
                    match (self.last_mod_release_ts, self.last_mod_release_class) {
                        (Some(release_ts), Some(class))
                            if t_ms
                                .checked_sub(release_ts)
                                .is_some_and(|elapsed| elapsed <= 500) =>
                        {
                            Some(class)
                        }
                        _ => None,
                    };
            }
            self.bsp_run = self.bsp_run.saturating_add(1);
        } else {
            self.finish_backspace_run();
        }

        self.tier_a.keystrokes = self.tier_a.keystrokes.saturating_add(1);
        let resolved = keymap.resolve(code);
        let pos_index = if let Some(info) = resolved {
            self.tier_a.finger_count[usize::from(info.finger_id)] =
                self.tier_a.finger_count[usize::from(info.finger_id)].saturating_add(1);
            let row_index = usize::from(info.hand) * 6 + usize::from(info.row_idx - 1);
            self.tier_a.row_count[row_index] = self.tier_a.row_count[row_index].saturating_add(1);
            if let Some(gap) = self.last_keydown_ts.and_then(|last| t_ms.checked_sub(last)) {
                let bucket = usize::from(gap_bucket(gap));
                self.tier_a.gap_hist[usize::from(info.hand)][bucket] =
                    self.tier_a.gap_hist[usize::from(info.hand)][bucket].saturating_add(1);
            }
            usize::from(info.pos)
        } else {
            80
        };
        self.last_keydown_ts = Some(t_ms);

        if ALPHA_KEYCODES.contains(&code) {
            self.last_alpha_ts = Some(t_ms);
        }
        for count in self.keys_since_mod_down.values_mut() {
            *count = count.saturating_add(1);
        }

        let profile_index = self.profile_index;
        let tier_b_was_empty = self.tier_b_total() == 0;
        if tier_b_was_empty {
            self.tier_b_start_ts[profile_index] = Some(t_ms);
        }
        self.tier_b_accum[profile_index][pos_index] =
            self.tier_b_accum[profile_index][pos_index].saturating_add(1);
        let total = self.tier_b_total();
        if total < tier_b_seal_count {
            return None;
        }

        let mut counts = self.tier_b_accum[profile_index];
        self.tier_b_accum[profile_index].zeroize();
        let start_ts = self.tier_b_start_ts[profile_index].take().unwrap_or(t_ms);
        let seal = TierBSeal {
            start_ts,
            end_ts: t_ms,
            keystrokes: total,
            pos_count: counts,
        };
        counts.zeroize();
        Some(seal)
    }

    fn key_up(&mut self, t_ms: u64, code: u16, keymap: &Keymap) {
        let Some(down_ts) = self.forget_hold(code) else {
            return;
        };
        let Some(elapsed) = t_ms.checked_sub(down_ts) else {
            if let Some(mod_class) = modifier_class_for_keycode(code) {
                self.keys_since_mod_down.remove(&mod_class);
            }
            return;
        };
        let bucket = usize::from(duration_bucket(elapsed));
        if let Some(mod_class) = modifier_class_for_keycode(code) {
            self.tier_a.mod_hold_hist[usize::from(mod_class)][bucket] =
                self.tier_a.mod_hold_hist[usize::from(mod_class)][bucket].saturating_add(1);
            if self.keys_since_mod_down.get(&mod_class) == Some(&0) {
                self.increment_event(LONELY_MOD, mod_class);
            }
            self.keys_since_mod_down.remove(&mod_class);
            self.last_mod_release_ts = Some(t_ms);
            self.last_mod_release_class = Some(mod_class);
        } else if let Some(info) = keymap.resolve(code) {
            self.tier_a.hold_hist[usize::from(info.finger_id)][bucket] =
                self.tier_a.hold_hist[usize::from(info.finger_id)][bucket].saturating_add(1);
        }
    }

    fn remember_hold(&mut self, code: u16, t_ms: u64) {
        self.held.insert(code, t_ms);
    }

    fn forget_hold(&mut self, code: u16) -> Option<u64> {
        self.held.remove(code)
    }

    fn finish_backspace_run(&mut self) {
        if self.bsp_run == 0 {
            return;
        }
        let subject = run_bucket(self.bsp_run);
        self.increment_event(BSP_BURST, subject);
        if let Some(mod_class) = self.bsp_run_after_mod_class.take() {
            self.increment_event(BSP_BURST_AFTER_MOD, mod_class);
        }
        self.bsp_run.zeroize();
    }

    fn increment_event(&mut self, kind: u8, subject: u8) {
        let count = &mut self.tier_a.event_count[usize::from(kind)][usize::from(subject)];
        *count = count.saturating_add(1);
    }

    pub fn tick(
        &mut self,
        next_bucket_id: i64,
        elapsed_ms: u64,
        seal_floor: u32,
    ) -> Option<TierASeal> {
        self.tier_a_span_ms = self.tier_a_span_ms.saturating_add(elapsed_ms);
        if self.tier_a.keystrokes < seal_floor
            || self.tier_a_span_ms < MIN_BUCKET_SECONDS.saturating_mul(1_000)
        {
            return None;
        }
        let data = std::mem::take(&mut self.tier_a);
        let seal = TierASeal {
            bucket_id: self.tier_a_bucket_id,
            span_ms: self.tier_a_span_ms,
            data,
        };
        self.tier_a_bucket_id = next_bucket_id;
        self.tier_a_span_ms = 0;
        Some(seal)
    }

    /// Soft pause: stop counting without losing Tier B progress. The Tier A bucket is sealed when
    /// it clears the floor and discarded otherwise, and all cross-event timing context is dropped
    /// because the gap across a pause is wall-clock, not typing behaviour.
    pub fn seal_or_discard_tier_a(
        &mut self,
        next_bucket_id: i64,
        elapsed_ms: u64,
        floor: u32,
    ) -> Option<TierASeal> {
        let seal = self.tick(next_bucket_id, elapsed_ms, floor);
        if seal.is_none() {
            self.tier_a.zeroize();
            self.tier_a_span_ms.zeroize();
            self.tier_a_bucket_id = next_bucket_id;
        }
        self.held.zeroize();
        self.keys_since_mod_down.clear();
        self.last_event_ts.zeroize();
        self.last_event_ts = NO_EVENT_TS;
        self.last_alpha_ts.zeroize();
        self.last_keydown_ts.zeroize();
        self.bsp_run.zeroize();
        self.last_mod_release_ts.zeroize();
        self.last_mod_release_class.zeroize();
        self.bsp_run_after_mod_class.zeroize();
        seal
    }

    pub fn live_finger_counts(&self) -> &[u32; 10] {
        &self.tier_a.finger_count
    }

    pub fn live_keystrokes(&self) -> u32 {
        self.tier_a.keystrokes
    }

    pub fn live_span_ms(&self, current_bucket_elapsed_ms: u64) -> u64 {
        self.tier_a_span_ms
            .saturating_add(current_bucket_elapsed_ms)
    }

    /// The active profile's total only. A window is sealed per profile, so pooling here would make
    /// one profile's traffic seal another profile's window.
    pub fn tier_b_total(&self) -> u32 {
        self.tier_b_accum[self.profile_index]
            .iter()
            .copied()
            .fold(0_u32, u32::saturating_add)
    }

    pub fn discard_partials(&mut self, next_bucket_id: i64) {
        self.tier_a.zeroize();
        for accumulator in &mut self.tier_b_accum {
            accumulator.zeroize();
        }
        self.held.zeroize();
        self.keys_since_mod_down.clear();
        self.last_event_ts.zeroize();
        self.last_event_ts = NO_EVENT_TS;
        self.last_alpha_ts.zeroize();
        self.last_keydown_ts.zeroize();
        self.bsp_run.zeroize();
        self.last_mod_release_ts.zeroize();
        self.last_mod_release_class.zeroize();
        self.bsp_run_after_mod_class.zeroize();
        for start_ts in &mut self.tier_b_start_ts {
            start_ts.zeroize();
        }
        self.tier_a_span_ms.zeroize();
        self.tier_a_bucket_id = next_bucket_id;
    }

    /// Recover from a `SYN_DROPPED`. The kernel overflowed this client's evdev buffer, so held-key
    /// state and every timing relationship spanning the gap are unreliable and are cleared.
    /// Already-counted Tier A and Tier B totals remain valid and are deliberately kept: a buffer
    /// overflow is not a session boundary, and resetting `tier_b_accum` here would keep the Tier B
    /// privacy floor permanently out of reach.
    pub fn resync_after_sequence_loss(&mut self) {
        self.held.zeroize();
        self.keys_since_mod_down.clear();
        self.last_event_ts.zeroize();
        self.last_event_ts = NO_EVENT_TS;
        self.last_alpha_ts.zeroize();
        self.last_keydown_ts.zeroize();
        self.bsp_run.zeroize();
        self.last_mod_release_ts.zeroize();
        self.last_mod_release_class.zeroize();
        self.bsp_run_after_mod_class.zeroize();
    }

    pub fn bounded_footprint(&self) -> usize {
        TIER_A_FIXED_ENTRIES
            + self
                .tier_b_accum
                .iter()
                .map(|accumulator| accumulator.len())
                .sum::<usize>()
            + self.held.len()
            + self.keys_since_mod_down.len()
    }
}

/// The ceiling `bounded_footprint` may never exceed, for any stream length and any number of
/// profile switches. Every profile carries its own 81-slot histogram; `MAX_PROFILES` is what keeps
/// that product finite.
pub fn footprint_bound(profile_count: usize) -> usize {
    TIER_A_FIXED_ENTRIES + 81 * profile_count.clamp(1, MAX_PROFILES) + MAX_HELD_KEYS + 16
}

impl Drop for Aggregator {
    fn drop(&mut self) {
        self.discard_partials(self.tier_a_bucket_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::{BSP_BURST, BSP_BURST_AFTER_MOD, LONELY_MOD, MOD_DURING_ALPHA};
    use crate::keymap::KeyInfo;

    fn keymap() -> Keymap {
        Keymap::fixture(&[
            (
                30,
                KeyInfo {
                    pos: 0,
                    hand: 0,
                    finger_id: 0,
                    row_idx: 4,
                },
            ),
            (
                48,
                KeyInfo {
                    pos: 1,
                    hand: 1,
                    finger_id: 7,
                    row_idx: 5,
                },
            ),
            (
                14,
                KeyInfo {
                    pos: 2,
                    hand: 1,
                    finger_id: 8,
                    row_idx: 3,
                },
            ),
        ])
    }

    fn event(aggregate: &mut Aggregator, t: u64, code: u16, value: i32) {
        let seal = aggregate.handle_event(t, code, value, &keymap(), 2_000);
        assert!(seal.is_none());
    }

    #[test]
    fn lonely_modifier_fires_with_nothing_between() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 0, 29, 1);
        event(&mut aggregate, 50, 29, 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][0], 1);
    }

    #[test]
    fn lonely_modifier_does_not_fire_with_alpha_between() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 0, 29, 1);
        event(&mut aggregate, 10, 30, 1);
        event(&mut aggregate, 20, 30, 0);
        event(&mut aggregate, 30, 29, 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][0], 0);
    }

    #[test]
    fn overlapping_modifiers_count_independently() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 0, 29, 1);
        event(&mut aggregate, 10, 42, 1);
        event(&mut aggregate, 20, 30, 1);
        event(&mut aggregate, 30, 30, 0);
        event(&mut aggregate, 40, 29, 0);
        event(&mut aggregate, 50, 42, 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][0], 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][3], 0);

        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 0, 29, 1);
        event(&mut aggregate, 10, 42, 1);
        event(&mut aggregate, 20, 42, 0);
        event(&mut aggregate, 30, 30, 1);
        event(&mut aggregate, 40, 30, 0);
        event(&mut aggregate, 50, 29, 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][0], 0);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][3], 1);
    }

    #[test]
    fn autorepeat_does_not_suppress_lonely_modifier() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 0, 29, 1);
        event(&mut aggregate, 20, 30, 2);
        event(&mut aggregate, 40, 29, 0);
        assert_eq!(aggregate.tier_a.autorepeats, 1);
        assert_eq!(aggregate.tier_a.event_count[usize::from(LONELY_MOD)][0], 1);
    }

    #[test]
    fn modifier_during_alpha_uses_strict_250ms_window() {
        let mut at_249 = Aggregator::new(0, 1);
        event(&mut at_249, 1, 30, 1);
        event(&mut at_249, 250, 29, 1);
        assert_eq!(
            at_249.tier_a.event_count[usize::from(MOD_DURING_ALPHA)][0],
            1
        );

        let mut at_251 = Aggregator::new(0, 1);
        event(&mut at_251, 1, 30, 1);
        event(&mut at_251, 252, 29, 1);
        assert_eq!(
            at_251.tier_a.event_count[usize::from(MOD_DURING_ALPHA)][0],
            0
        );
    }

    #[test]
    fn backspace_bursts_use_run_buckets() {
        for (length, expected_bucket) in [(1_u64, 0_u8), (2, 1), (4, 3), (6, 4), (12, 5), (17, 6)] {
            let mut aggregate = Aggregator::new(0, 1);
            for index in 0..length {
                event(&mut aggregate, 1 + index * 10, 14, 1);
                event(&mut aggregate, 2 + index * 10, 14, 0);
            }
            event(&mut aggregate, 500, 30, 1);
            assert_eq!(
                aggregate.tier_a.event_count[usize::from(BSP_BURST)][usize::from(expected_bucket)],
                1
            );
        }
    }

    #[test]
    fn backspace_after_modifier_uses_run_start_time() {
        let mut at_499 = Aggregator::new(0, 1);
        event(&mut at_499, 10, 29, 1);
        event(&mut at_499, 20, 29, 0);
        event(&mut at_499, 519, 14, 1);
        event(&mut at_499, 520, 14, 0);
        event(&mut at_499, 600, 30, 1);
        assert_eq!(
            at_499.tier_a.event_count[usize::from(BSP_BURST_AFTER_MOD)][0],
            1
        );

        let mut at_501 = Aggregator::new(0, 1);
        event(&mut at_501, 10, 29, 1);
        event(&mut at_501, 20, 29, 0);
        event(&mut at_501, 521, 14, 1);
        event(&mut at_501, 522, 14, 0);
        event(&mut at_501, 600, 30, 1);
        assert_eq!(
            at_501.tier_a.event_count[usize::from(BSP_BURST_AFTER_MOD)][0],
            0
        );
    }

    #[test]
    fn active_time_caps_each_inter_event_gap() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 100, 30, 1);
        event(&mut aggregate, 350, 30, 0);
        event(&mut aggregate, 10_000, 48, 1);
        assert_eq!(aggregate.tier_a.active_ms, 2_250);
    }

    #[test]
    fn autorepeat_only_changes_autorepeat_counter() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 100, 30, 2);
        assert_eq!(aggregate.tier_a.autorepeats, 1);
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(aggregate.tier_a.finger_count, [0; 10]);
        assert_eq!(aggregate.tier_a.row_count, [0; 12]);
        assert_eq!(aggregate.tier_b_total(), 0);
    }

    #[test]
    fn unknown_keycode_is_unattributed_only() {
        let mut aggregate = Aggregator::new(0, 1);
        event(&mut aggregate, 100, 200, 1);
        assert_eq!(aggregate.tier_a.keystrokes, 1);
        assert_eq!(aggregate.tier_a.finger_count, [0; 10]);
        assert_eq!(aggregate.tier_a.row_count, [0; 12]);
        assert_eq!(aggregate.tier_b_accum[0][80], 1);
    }

    #[test]
    fn tier_a_floor_carries_and_extends_span() {
        let mut aggregate = Aggregator::new(1_000, 1);
        for index in 0..24 {
            event(&mut aggregate, 1 + index * 2, 30, 1);
            event(&mut aggregate, 2 + index * 2, 30, 0);
        }
        assert!(aggregate.tick(1_010, 10_000, 25).is_none());
        for index in 24..30 {
            event(&mut aggregate, 1 + index * 2, 30, 1);
            event(&mut aggregate, 2 + index * 2, 30, 0);
        }
        let seal = aggregate.tick(1_020, 10_000, 25);
        assert!(seal.is_some());
        let seal = seal.unwrap_or_else(|| unreachable!());
        assert_eq!(seal.data.keystrokes, 30);
        assert_eq!(seal.span_ms, 20_000);
    }

    #[test]
    fn tier_a_never_seals_before_ten_real_seconds() {
        let mut aggregate = Aggregator::new(1_000, 1);
        for index in 0..25 {
            event(&mut aggregate, index, 30, 1);
        }
        assert!(aggregate.tick(1_001, 1_000, 25).is_none());
        let seal = aggregate.tick(1_010, 9_000, 25);
        assert!(seal.is_some());
        let seal = seal.unwrap_or_else(|| unreachable!());
        assert_eq!(seal.span_ms, 10_000);
    }

    #[test]
    fn tier_b_seals_only_at_2000_and_preserves_sum() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_999 {
            let seal = aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
            assert!(seal.is_none());
        }
        let seal = aggregate.handle_event(2_000, 30, 1, &keymap(), 2_000);
        assert!(seal.is_some());
        let seal = seal.unwrap_or_else(|| unreachable!());
        assert_eq!(seal.keystrokes, 2_000);
        assert_eq!(seal.pos_count.iter().sum::<u32>(), 2_000);
        assert_eq!(aggregate.tier_b_total(), 0);
    }

    #[test]
    fn discard_zeroes_both_partial_tiers_and_context() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_500 {
            let seal = aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
            assert!(seal.is_none());
        }
        aggregate.discard_partials(10);
        assert_eq!(aggregate.tier_b_total(), 0);
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(aggregate.held.len(), 0);
        assert_eq!(aggregate.keys_since_mod_down.len(), 0);
    }

    #[test]
    fn sequence_loss_resync_keeps_both_tiers_and_clears_context() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_500 {
            let seal = aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
            assert!(seal.is_none());
        }
        aggregate.resync_after_sequence_loss();
        assert_eq!(aggregate.tier_b_total(), 1_500);
        assert_eq!(aggregate.tier_a.keystrokes, 1_500);
        assert_eq!(aggregate.held.len(), 0);
        assert_eq!(aggregate.keys_since_mod_down.len(), 0);
        for index in 1_500..1_999 {
            let seal = aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
            assert!(seal.is_none());
        }
        let seal = aggregate.handle_event(2_000, 30, 1, &keymap(), 2_000);
        assert!(seal.is_some());
        assert_eq!(
            seal.unwrap_or_else(|| unreachable!()).keystrokes,
            2_000,
            "a dropped-event re-sync must not reset the Tier B privacy floor"
        );
    }

    #[test]
    fn soft_pause_preserves_tier_b_and_seals_a_qualifying_tier_a_bucket() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..40 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        let seal = aggregate.seal_or_discard_tier_a(1, 10_000, 25);
        assert!(seal.is_some(), "40 keystrokes clears the floor of 25");
        assert_eq!(aggregate.tier_b_total(), 40, "soft pause must keep Tier B");
        assert_eq!(aggregate.tier_a.keystrokes, 0, "Tier A must restart empty");
    }

    #[test]
    fn soft_pause_discards_a_tier_a_bucket_below_the_count_floor() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..10 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(aggregate.seal_or_discard_tier_a(1, 10_000, 25).is_none());
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(
            aggregate.tier_b_total(),
            10,
            "Tier B survives even a discarded Tier A"
        );
    }

    #[test]
    fn soft_pause_discards_a_tier_a_bucket_below_the_time_floor() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..40 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(
            aggregate.seal_or_discard_tier_a(1, 5_000, 25).is_none(),
            "the 10-second bucket floor is a privacy minimum a pause cannot bypass"
        );
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(aggregate.tier_b_total(), 40);
    }

    #[test]
    fn soft_pause_clears_held_key_and_timing_context() {
        let mut aggregate = Aggregator::new(0, 1);
        aggregate.handle_event(0, 30, 1, &keymap(), 2_000);
        aggregate.seal_or_discard_tier_a(1, 5_000, 25);
        assert_eq!(
            aggregate.held.len(),
            0,
            "a key held across a pause must not be timed"
        );
    }

    #[test]
    fn soft_pause_preserves_every_profile_not_only_the_active_one() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..30 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        aggregate.set_profile(1);
        for index in 30..70 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(aggregate.seal_or_discard_tier_a(1, 10_000, 25).is_some());
        assert_eq!(aggregate.tier_b_total(), 40);
        aggregate.set_profile(0);
        assert_eq!(aggregate.tier_b_total(), 30);
    }

    #[test]
    fn each_profile_accumulates_tier_b_independently() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..1_500 {
            assert!(aggregate
                .handle_event(index, 30, 1, &keymap(), 2_000)
                .is_none());
        }
        aggregate.set_profile(1);
        for index in 1_500..3_000 {
            assert!(
                aggregate
                    .handle_event(index, 30, 1, &keymap(), 2_000)
                    .is_none(),
                "the second profile must start from zero, not inherit 1500"
            );
        }
        aggregate.set_profile(0);
        for index in 3_000..3_499 {
            assert!(aggregate
                .handle_event(index, 30, 1, &keymap(), 2_000)
                .is_none());
        }
        let seal = aggregate.handle_event(3_499, 30, 1, &keymap(), 2_000);
        let seal = seal.unwrap_or_else(|| unreachable!("the first profile should reach 2000"));
        assert_eq!(seal.keystrokes, 2_000);
    }

    #[test]
    fn switching_profiles_does_not_discard_tier_b_progress() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..1_000 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        aggregate.set_profile(1);
        aggregate.set_profile(0);
        assert_eq!(aggregate.tier_b_total(), 1_000);
    }

    #[test]
    fn footprint_stays_bounded_across_every_profile() {
        let mut aggregate = Aggregator::new(0, MAX_PROFILES);
        for index in 0..20_000_u64 {
            aggregate.set_profile((index as usize) % MAX_PROFILES);
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(aggregate.bounded_footprint() <= footprint_bound(MAX_PROFILES));
    }

    #[test]
    fn a_profile_index_beyond_the_configured_count_is_ignored() {
        let mut aggregate = Aggregator::new(0, 2);
        aggregate.handle_event(0, 30, 1, &keymap(), 2_000);
        aggregate.set_profile(9);
        assert_eq!(
            aggregate.tier_b_total(),
            1,
            "an out-of-range profile must leave the active accumulator alone"
        );
    }

    #[test]
    fn discard_partials_clears_every_profile() {
        let mut aggregate = Aggregator::new(0, 2);
        aggregate.handle_event(0, 30, 1, &keymap(), 2_000);
        aggregate.set_profile(1);
        aggregate.handle_event(1, 30, 1, &keymap(), 2_000);
        aggregate.discard_partials(10);
        assert_eq!(aggregate.tier_b_total(), 0);
        aggregate.set_profile(0);
        assert_eq!(aggregate.tier_b_total(), 0);
    }

    #[test]
    fn footprint_does_not_scale_with_stream_length() {
        let mut after_100 = Aggregator::new(0, 1);
        for index in 0..100 {
            event(
                &mut after_100,
                index,
                30,
                if index % 2 == 0 { 1 } else { 0 },
            );
        }
        let small = after_100.bounded_footprint();

        let mut after_200k = Aggregator::new(0, 1);
        for index in 0..200_000 {
            let seal = after_200k.handle_event(
                index,
                30,
                if index % 2 == 0 { 1 } else { 0 },
                &keymap(),
                2_000,
            );
            drop(seal);
        }
        let large = after_200k.bounded_footprint();
        assert_eq!(small, large);
        assert!(large < 600);
    }
}
