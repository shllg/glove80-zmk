use crate::config::{
    Config, MAX_NGRAM_ENTRIES, MAX_NGRAM_FINGER_ENTRIES, MAX_PROFILES, MIN_BUCKET_SECONDS,
};
use crate::encode::{
    duration_bucket, gap_bucket, latency_bucket, modifier_class_for_keycode, pack_finger,
    pack_ngram, run_bucket, unpack_ngram, BSP_BURST, BSP_BURST_AFTER_MOD, FINGER_ABSENT,
    LONELY_MOD, MOD_DURING_ALPHA, NGRAM_N, POS_ABSENT, POS_UNATTRIBUTED,
};
use crate::keymap::Keymap;
use std::collections::HashMap;
use zeroize::Zeroize;

const NO_EVENT_TS: u64 = u64::MAX;
const KEY_BACKSPACE: u16 = 14;
const MAX_HELD_KEYS: usize = 16;
const TIER_A_FIXED_ENTRIES: usize = 10 + 12 + (10 * 22) + (8 * 22) + (2 * 22) + (4 * 8);
/// A correction with no preceding keystroke at all is not a fumble: it reads as the slowest
/// latency bucket, the same one an ordinary deliberate edit lands in.
const LATENCY_NO_PRECEDING_KEY: u8 = 3;
/// The empty ring. Position `0` is a real key, so the ring cannot simply be zeroed.
const EMPTY_NGRAM_RING: [u8; NGRAM_N] = [POS_ABSENT; NGRAM_N];

/// The sealing thresholds in force for one event. Bundled rather than passed as loose arguments so
/// adding a tier does not grow `handle_event`'s signature without bound.
#[derive(Clone, Copy)]
pub struct SealPolicy {
    pub tier_b_seal_count: u32,
    pub ngram_capture: bool,
    pub ngram_seal_count: u32,
    pub ngram_min_count: u32,
}

impl SealPolicy {
    pub fn from_config(config: &Config) -> Self {
        Self {
            tier_b_seal_count: config.tier_b_seal_count,
            ngram_capture: config.ngram_capture,
            ngram_seal_count: config.ngram_seal_count,
            ngram_min_count: config.ngram_min_count,
        }
    }
}

#[cfg(test)]
impl SealPolicy {
    pub(crate) fn fixture() -> Self {
        Self {
            tier_b_seal_count: 2_000,
            ngram_capture: true,
            ngram_seal_count: 500,
            ngram_min_count: 3,
        }
    }
}

/// What one event produced. A single event can close a Tier C window and a Tier B window at once,
/// and `finish_backspace_run` is reachable from two call sites, so both have to travel back to the
/// caller through one return value rather than a second channel or a queue.
#[derive(Default)]
pub struct SealBatch {
    pub tier_b: Option<TierBSeal>,
    pub tier_c: Option<TierCSeal>,
}

impl SealBatch {
    pub fn is_empty(&self) -> bool {
        self.tier_b.is_none() && self.tier_c.is_none()
    }
}

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

/// The correction context captured at the *start* of a backspace run and committed when the run
/// ends, because `run_bucket` is not known until then.
struct PendingNgram {
    ring: [u8; NGRAM_N],
    mod_mask: u8,
    latency: u8,
}

impl PendingNgram {
    fn zeroize(&mut self) {
        self.ring.zeroize();
        self.mod_mask.zeroize();
        self.latency.zeroize();
    }
}

impl Drop for PendingNgram {
    fn drop(&mut self) {
        self.zeroize();
    }
}

pub struct TierCSeal {
    pub start_ts: u64,
    pub end_ts: u64,
    pub corrections: u32,
    pub dropped: u32,
    /// Ordered position trigrams seen at least `ngram_min_count` times in this window.
    pub rows: Vec<(u64, u32)>,
    /// Everything that lost its position identity: rows suppressed at seal plus cap overflow.
    pub finger_rows: Vec<(u64, u32)>,
}

impl TierCSeal {
    pub fn degraded(&self) -> u32 {
        sum_counts(&self.finger_rows)
    }
}

impl Drop for TierCSeal {
    fn drop(&mut self) {
        self.start_ts.zeroize();
        self.end_ts.zeroize();
        self.corrections.zeroize();
        self.dropped.zeroize();
        zeroize_rows(&mut self.rows);
        zeroize_rows(&mut self.finger_rows);
    }
}

fn sum_counts(rows: &[(u64, u32)]) -> u32 {
    rows.iter()
        .map(|(_, count)| *count)
        .fold(0_u32, u32::saturating_add)
}

fn zeroize_rows(rows: &mut Vec<(u64, u32)>) {
    for (key, count) in rows.iter_mut() {
        key.zeroize();
        count.zeroize();
    }
    rows.clear();
    rows.shrink_to_fit();
}

/// A `HashMap`'s keys cannot be overwritten in place, so this is the closest equivalent to the
/// in-place scrub the fixed-size tiers get: every count is zeroed where it lies, then the map is
/// cleared and its allocation released.
fn zeroize_ngram_map(map: &mut HashMap<u64, u32>) {
    for count in map.values_mut() {
        count.zeroize();
    }
    map.clear();
    map.shrink_to_fit();
}

/// Projects an ordered position trigram key onto its finger-level key. Both `POS_UNATTRIBUTED` and
/// `POS_ABSENT` collapse to `FINGER_ABSENT`: a key with no base-layer position has no finger
/// either, so the finger projection has exactly one "no finger" value.
fn degrade_ngram_key(key: u64, keymap: &Keymap) -> u64 {
    let (positions, mod_mask, latency, run) = unpack_ngram(key);
    let fingers = positions.map(|pos| {
        if pos == POS_UNATTRIBUTED || pos == POS_ABSENT {
            FINGER_ABSENT
        } else {
            keymap.finger_for_position(pos).unwrap_or(FINGER_ABSENT)
        }
    });
    pack_finger(fingers, mod_mask, latency, run)
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
    /// Oldest to newest, `POS_ABSENT` in every slot no key has reached yet.
    ngram_ring: [u8; NGRAM_N],
    pending_ngram: Option<PendingNgram>,
    ngram_accum: [HashMap<u64, u32>; MAX_PROFILES],
    ngram_finger_accum: [HashMap<u64, u32>; MAX_PROFILES],
    ngram_events: [u32; MAX_PROFILES],
    ngram_dropped: [u32; MAX_PROFILES],
    ngram_start_ts: [Option<u64>; MAX_PROFILES],
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
            ngram_ring: EMPTY_NGRAM_RING,
            pending_ngram: None,
            // `[HashMap<_, _>; MAX_PROFILES]` cannot be built by `Default`, so it is built
            // element-wise rather than by fighting the derive.
            ngram_accum: std::array::from_fn(|_| HashMap::new()),
            ngram_finger_accum: std::array::from_fn(|_| HashMap::new()),
            ngram_events: [0; MAX_PROFILES],
            ngram_dropped: [0; MAX_PROFILES],
            ngram_start_ts: [None; MAX_PROFILES],
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
        policy: &SealPolicy,
    ) -> SealBatch {
        let mut batch = SealBatch::default();
        if let Some(event_gap) = (self.last_event_ts != NO_EVENT_TS)
            .then(|| t_ms.checked_sub(self.last_event_ts))
            .flatten()
        {
            self.tier_a.active_ms = self.tier_a.active_ms.saturating_add(event_gap.min(2_000));
            if self.bsp_run > 0 && event_gap > 1_000 {
                batch.tier_c = self.finish_backspace_run(t_ms, keymap, policy);
            }
        }
        self.last_event_ts = t_ms;

        match value {
            2 => self.tier_a.autorepeats = self.tier_a.autorepeats.saturating_add(1),
            1 => self.key_down(t_ms, code, keymap, policy, &mut batch),
            0 => self.key_up(t_ms, code, keymap),
            _ => {}
        }
        batch
    }

    fn key_down(
        &mut self,
        t_ms: u64,
        code: u16,
        keymap: &Keymap,
        policy: &SealPolicy,
        batch: &mut SealBatch,
    ) {
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
            return;
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
                // Captured at run start, committed at run end: the latency has to be read before
                // this backspace overwrites `last_keydown_ts`, the run bucket only exists later.
                if policy.ngram_capture {
                    self.pending_ngram = Some(PendingNgram {
                        ring: self.ngram_ring,
                        mod_mask: self.active_mod_mask(),
                        latency: self
                            .last_keydown_ts
                            .and_then(|last| t_ms.checked_sub(last))
                            .map_or(LATENCY_NO_PRECEDING_KEY, latency_bucket),
                    });
                }
            }
            self.bsp_run = self.bsp_run.saturating_add(1);
        } else if let Some(seal) = self.finish_backspace_run(t_ms, keymap, policy) {
            batch.tier_c = Some(seal);
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
            info.pos
        } else {
            POS_UNATTRIBUTED
        };
        // Backspace is the correction, not the context, so it never enters the ring.
        if policy.ngram_capture && code != KEY_BACKSPACE {
            self.ngram_ring.rotate_left(1);
            self.ngram_ring[NGRAM_N - 1] = pos_index;
        }
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
        let slot = usize::from(pos_index);
        self.tier_b_accum[profile_index][slot] =
            self.tier_b_accum[profile_index][slot].saturating_add(1);
        let total = self.tier_b_total();
        if total < policy.tier_b_seal_count {
            return;
        }

        let mut counts = self.tier_b_accum[profile_index];
        self.tier_b_accum[profile_index].zeroize();
        let start_ts = self.tier_b_start_ts[profile_index].take().unwrap_or(t_ms);
        batch.tier_b = Some(TierBSeal {
            start_ts,
            end_ts: t_ms,
            keystrokes: total,
            pos_count: counts,
        });
        counts.zeroize();
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

    /// One completed backspace *run* is one correction event, whatever its length. The Tier C
    /// record is committed here rather than at run start because `run_bucket` is not known until
    /// the run ends.
    fn finish_backspace_run(
        &mut self,
        t_ms: u64,
        keymap: &Keymap,
        policy: &SealPolicy,
    ) -> Option<TierCSeal> {
        if self.bsp_run == 0 {
            return None;
        }
        let subject = run_bucket(self.bsp_run);
        self.increment_event(BSP_BURST, subject);
        if let Some(mod_class) = self.bsp_run_after_mod_class.take() {
            self.increment_event(BSP_BURST_AFTER_MOD, mod_class);
        }
        self.bsp_run.zeroize();
        self.commit_pending_ngram(t_ms, subject, keymap, policy)
    }

    /// The bitmask of mod classes currently held. `keys_since_mod_down` is keyed by exactly those
    /// classes: a class is inserted on press and removed on release.
    fn active_mod_mask(&self) -> u8 {
        self.keys_since_mod_down
            .keys()
            .fold(0_u8, |mask, class| mask | (1_u8 << (class & 0x07)))
    }

    fn commit_pending_ngram(
        &mut self,
        t_ms: u64,
        run: u8,
        keymap: &Keymap,
        policy: &SealPolicy,
    ) -> Option<TierCSeal> {
        let pending = self.pending_ngram.take()?;
        if !policy.ngram_capture {
            return None;
        }
        let profile = self.profile_index;
        let key = pack_ngram(pending.ring, pending.mod_mask, pending.latency, run);
        drop(pending);
        if self.ngram_start_ts[profile].is_none() {
            self.ngram_start_ts[profile] = Some(t_ms);
        }
        self.ngram_events[profile] = self.ngram_events[profile].saturating_add(1);
        self.record_ngram(key, keymap);
        (self.ngram_events[profile] >= policy.ngram_seal_count)
            .then(|| self.seal_tier_c(t_ms, keymap, policy.ngram_min_count))
    }

    /// Incrementing an existing key is always allowed. Only a *new* key can be refused, and it is
    /// refused by degrading rather than by discarding: totals stay exact either way.
    fn record_ngram(&mut self, key: u64, keymap: &Keymap) {
        let profile = self.profile_index;
        if let Some(count) = self.ngram_accum[profile].get_mut(&key) {
            *count = count.saturating_add(1);
            return;
        }
        if self.ngram_accum[profile].len() < MAX_NGRAM_ENTRIES {
            self.ngram_accum[profile].insert(key, 1);
            return;
        }
        self.record_finger_ngram(degrade_ngram_key(key, keymap), 1);
    }

    fn record_finger_ngram(&mut self, key: u64, count: u32) {
        let profile = self.profile_index;
        if let Some(existing) = self.ngram_finger_accum[profile].get_mut(&key) {
            *existing = existing.saturating_add(count);
            return;
        }
        if self.ngram_finger_accum[profile].len() < MAX_NGRAM_FINGER_ENTRIES {
            self.ngram_finger_accum[profile].insert(key, count);
            return;
        }
        // No silent caps: what lost even its finger identity is reported on the window.
        self.ngram_dropped[profile] = self.ngram_dropped[profile].saturating_add(count);
    }

    /// Seals the *active* profile's window. Every other profile's accumulators are preserved,
    /// exactly as Tier B preserves them across a switch.
    fn seal_tier_c(&mut self, t_ms: u64, keymap: &Keymap, min_count: u32) -> TierCSeal {
        let profile = self.profile_index;
        let corrections = self.ngram_events[profile];
        let start_ts = self.ngram_start_ts[profile].take().unwrap_or(t_ms);

        let mut rows: Vec<(u64, u32)> = Vec::new();
        let mut suppressed: Vec<(u64, u32)> = Vec::new();
        for (key, count) in &self.ngram_accum[profile] {
            if *count >= min_count {
                rows.push((*key, *count));
            } else {
                suppressed.push((*key, *count));
            }
        }
        zeroize_ngram_map(&mut self.ngram_accum[profile]);
        // A suppressed row keeps its count; only its position identity is dropped.
        for (key, count) in &suppressed {
            self.record_finger_ngram(degrade_ngram_key(*key, keymap), *count);
        }
        zeroize_rows(&mut suppressed);
        // Read after degradation: a suppressed row can itself overflow the finger cap, and a count
        // lost there still has to appear in this window's `dropped`.
        let dropped = self.ngram_dropped[profile];

        let finger_rows: Vec<(u64, u32)> = self.ngram_finger_accum[profile]
            .iter()
            .map(|(key, count)| (*key, *count))
            .collect();
        zeroize_ngram_map(&mut self.ngram_finger_accum[profile]);
        self.ngram_events[profile].zeroize();
        self.ngram_dropped[profile].zeroize();

        TierCSeal {
            start_ts,
            end_ts: t_ms,
            corrections,
            dropped,
            rows,
            finger_rows,
        }
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
        // The ring is cross-event ordering context, so it goes with the rest of it: a trigram
        // spanning a pause would be fiction. The Tier C accumulators are Tier B's shape and are
        // preserved for the same reason — resetting them would keep the floor out of reach.
        self.clear_ngram_context();
        seal
    }

    fn clear_ngram_context(&mut self) {
        self.ngram_ring.zeroize();
        self.ngram_ring = EMPTY_NGRAM_RING;
        if let Some(pending) = self.pending_ngram.as_mut() {
            pending.zeroize();
        }
        self.pending_ngram = None;
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
        self.clear_ngram_context();
        for accumulator in &mut self.ngram_accum {
            zeroize_ngram_map(accumulator);
        }
        for accumulator in &mut self.ngram_finger_accum {
            zeroize_ngram_map(accumulator);
        }
        self.ngram_events.zeroize();
        self.ngram_dropped.zeroize();
        self.ngram_start_ts.zeroize();
        self.tier_a_span_ms.zeroize();
        self.tier_a_bucket_id = next_bucket_id;
    }

    /// Recover from a `SYN_DROPPED`. The kernel overflowed this client's evdev buffer, so held-key
    /// state and every timing relationship spanning the gap are unreliable and are cleared.
    /// Already-counted Tier A, Tier B and Tier C totals remain valid and are deliberately kept: a
    /// buffer overflow is not a session boundary, and resetting `tier_b_accum` here would keep the
    /// Tier B privacy floor permanently out of reach. The n-gram ring goes the other way — it is
    /// an ordering relationship spanning the gap, and a trigram spanning a `SYN_DROPPED` would be
    /// fiction.
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
        self.clear_ngram_context();
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
            + self.ngram_accum.iter().map(HashMap::len).sum::<usize>()
            + self
                .ngram_finger_accum
                .iter()
                .map(HashMap::len)
                .sum::<usize>()
    }
}

/// The ceiling `bounded_footprint` may never exceed, for any stream length and any number of
/// profile switches. Every profile carries its own 81-slot histogram and its own two capped Tier C
/// maps; `MAX_PROFILES` is what keeps those products finite.
pub fn footprint_bound(profile_count: usize) -> usize {
    let profiles = profile_count.clamp(1, MAX_PROFILES);
    TIER_A_FIXED_ENTRIES
        + 81 * profiles
        + MAX_HELD_KEYS
        + 16
        + (MAX_NGRAM_ENTRIES + MAX_NGRAM_FINGER_ENTRIES) * profiles
}

impl Drop for Aggregator {
    fn drop(&mut self) {
        self.discard_partials(self.tier_a_bucket_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::{
        mod_class, BSP_BURST, BSP_BURST_AFTER_MOD, HAND_LEFT, LONELY_MOD, MOD_CTRL,
        MOD_DURING_ALPHA,
    };
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

    fn policy() -> SealPolicy {
        SealPolicy::fixture()
    }

    fn event(aggregate: &mut Aggregator, t: u64, code: u16, value: i32) {
        let batch = aggregate.handle_event(t, code, value, &keymap(), &policy());
        assert!(batch.is_empty());
    }

    /// A keymap wide enough to build distinct trigrams from: physical position `p` is reachable as
    /// keycode `300 + p`, which collides with no modifier, no alpha keycode and not with backspace.
    fn wide_code(pos: u8) -> u16 {
        300 + u16::from(pos)
    }

    fn wide_finger(pos: u8) -> u8 {
        (pos / 40) * 5 + pos % 5
    }

    /// The inverse of `wide_finger`, so a test can ask for a position on a chosen finger.
    fn position_on_finger(finger: u8) -> u8 {
        if finger < 5 {
            finger
        } else {
            40 + finger - 5
        }
    }

    fn wide_keymap() -> Keymap {
        let entries: Vec<(u16, KeyInfo)> = (0_u8..80)
            .map(|pos| {
                (
                    wide_code(pos),
                    KeyInfo {
                        pos,
                        hand: pos / 40,
                        finger_id: wide_finger(pos),
                        row_idx: pos % 6 + 1,
                    },
                )
            })
            .collect();
        Keymap::fixture(&entries)
    }

    /// Drives a synthetic event stream over `wide_keymap`, collecting whatever it seals.
    struct Stream {
        aggregate: Aggregator,
        keymap: Keymap,
        policy: SealPolicy,
        t: u64,
        seals: Vec<TierCSeal>,
    }

    impl Stream {
        fn new(ngram_seal_count: u32, ngram_min_count: u32) -> Self {
            Self {
                aggregate: Aggregator::new(0, MAX_PROFILES),
                keymap: wide_keymap(),
                // Tier B is out of scope here; a seal of its own would only add noise.
                policy: SealPolicy {
                    tier_b_seal_count: u32::MAX,
                    ngram_capture: true,
                    ngram_seal_count,
                    ngram_min_count,
                },
                t: 0,
                seals: Vec::new(),
            }
        }

        fn without_capture(mut self) -> Self {
            self.policy.ngram_capture = false;
            self
        }

        fn press_at(&mut self, t: u64, code: u16) {
            let batch = self
                .aggregate
                .handle_event(t, code, 1, &self.keymap, &self.policy);
            self.collect(batch);
            let batch = self
                .aggregate
                .handle_event(t + 1, code, 0, &self.keymap, &self.policy);
            self.collect(batch);
            self.t = t + 2;
        }

        fn press(&mut self, code: u16) {
            let t = self.t;
            self.press_at(t, code);
        }

        fn key(&mut self, pos: u8) {
            self.press(wide_code(pos));
        }

        fn backspace(&mut self) {
            self.press(KEY_BACKSPACE);
        }

        /// One correction: the three keys that become the trigram, then `presses` backspaces. The
        /// run stays open until the next non-backspace key, exactly as it does in real typing.
        fn correction(&mut self, trigram: [u8; NGRAM_N], presses: u32) {
            for pos in trigram {
                self.key(pos);
            }
            for _ in 0..presses {
                self.backspace();
            }
        }

        fn close_run(&mut self) {
            self.key(0);
        }

        fn collect(&mut self, mut batch: SealBatch) {
            if let Some(seal) = batch.tier_c.take() {
                self.seals.push(seal);
            }
        }

        fn accum(&self) -> &HashMap<u64, u32> {
            &self.aggregate.ngram_accum[self.aggregate.profile_index]
        }

        fn finger_accum(&self) -> &HashMap<u64, u32> {
            &self.aggregate.ngram_finger_accum[self.aggregate.profile_index]
        }
    }

    fn sum_map(map: &HashMap<u64, u32>) -> u32 {
        map.values().copied().fold(0_u32, u32::saturating_add)
    }

    #[test]
    fn ngram_ring_holds_the_three_preceding_positions() {
        let mut stream = Stream::new(500, 3);
        for pos in [1_u8, 2, 3, 4] {
            stream.key(pos);
        }
        stream.backspace();
        assert_eq!(stream.aggregate.ngram_ring, [2, 3, 4]);
        let pending = stream
            .aggregate
            .pending_ngram
            .as_ref()
            .unwrap_or_else(|| unreachable!("a backspace must arm a pending record"));
        assert_eq!(pending.ring, [2, 3, 4]);
    }

    #[test]
    fn backspace_never_enters_the_ring() {
        let mut stream = Stream::new(500, 3);
        for pos in [1_u8, 2, 3] {
            stream.key(pos);
        }
        stream.backspace();
        stream.backspace();
        assert_eq!(
            stream.aggregate.ngram_ring,
            [1, 2, 3],
            "backspace is the correction, not the context"
        );
    }

    #[test]
    fn run_bucket_is_resolved_at_run_end_not_start() {
        let mut stream = Stream::new(u32::MAX, 3);
        stream.correction([1, 2, 3], 3);
        stream.close_run();
        assert_eq!(stream.accum().len(), 1);
        let key = *stream
            .accum()
            .keys()
            .next()
            .unwrap_or_else(|| unreachable!());
        let (positions, _, _, run) = unpack_ngram(key);
        assert_eq!(positions, [1, 2, 3]);
        assert_eq!(run, run_bucket(3));
        assert_ne!(run, run_bucket(1));
    }

    #[test]
    fn latency_uses_the_gap_before_the_backspace() {
        for (gap, expected) in [(149_u64, 0_u8), (150, 1), (999, 2), (1_000, 3)] {
            let mut stream = Stream::new(u32::MAX, 3);
            stream.press_at(0, wide_code(1));
            stream.press_at(gap, KEY_BACKSPACE);
            let pending = stream
                .aggregate
                .pending_ngram
                .as_ref()
                .unwrap_or_else(|| unreachable!());
            assert_eq!(
                pending.latency, expected,
                "a {gap} ms gap must land in bucket {expected}"
            );
        }
    }

    #[test]
    fn a_short_stream_records_absent_positions() {
        let mut stream = Stream::new(u32::MAX, 3);
        stream.key(7);
        stream.backspace();
        stream.close_run();
        let key = *stream
            .accum()
            .keys()
            .next()
            .unwrap_or_else(|| unreachable!());
        let (positions, _, _, _) = unpack_ngram(key);
        assert_eq!(positions, [POS_ABSENT, POS_ABSENT, 7]);
    }

    #[test]
    fn a_held_modifier_lands_in_the_modifier_mask() {
        let mut stream = Stream::new(u32::MAX, 3);
        stream.press(wide_code(1));
        let t = stream.t;
        // Left CTRL down, a key, then backspace while CTRL is still held.
        let batch = stream
            .aggregate
            .handle_event(t, 29, 1, &stream.keymap, &stream.policy);
        stream.collect(batch);
        stream.press_at(t + 1, wide_code(2));
        stream.backspace();
        let pending = stream
            .aggregate
            .pending_ngram
            .as_ref()
            .unwrap_or_else(|| unreachable!());
        assert_eq!(pending.mod_mask, 1 << mod_class(HAND_LEFT, MOD_CTRL));
    }

    #[test]
    fn capture_disabled_records_nothing() {
        let mut stream = Stream::new(u32::MAX, 3).without_capture();
        for index in 0..50_u8 {
            stream.correction([index % 20, index % 17, index % 13], 2);
        }
        stream.close_run();
        assert_eq!(stream.aggregate.ngram_ring, EMPTY_NGRAM_RING);
        assert!(stream.aggregate.pending_ngram.is_none());
        assert!(stream.accum().is_empty());
        assert!(stream.finger_accum().is_empty());
        assert_eq!(stream.aggregate.ngram_events[0], 0);
        assert!(stream.seals.is_empty());
    }

    #[test]
    fn ngram_footprint_stays_within_the_bound() {
        let mut stream = Stream::new(u32::MAX, 3);
        let mut state = 12_345_u64;
        for _ in 0..20_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let pick = |shift: u32| ((state >> shift) % 80) as u8;
            stream.correction([pick(16), pick(24), pick(32)], 1 + (state >> 40) as u32 % 4);
        }
        stream.close_run();
        assert!(
            stream.aggregate.bounded_footprint() <= footprint_bound(MAX_PROFILES),
            "footprint {} exceeded the bound {}",
            stream.aggregate.bounded_footprint(),
            footprint_bound(MAX_PROFILES)
        );
        assert!(stream.accum().len() <= MAX_NGRAM_ENTRIES);
        assert!(stream.finger_accum().len() <= MAX_NGRAM_FINGER_ENTRIES);
    }

    #[test]
    fn overflowing_the_position_map_degrades_to_fingers() {
        let mut stream = Stream::new(u32::MAX, 3);
        for index in 0..MAX_NGRAM_ENTRIES {
            let a = (index % 80) as u8;
            let b = ((index / 80) % 80) as u8;
            stream.correction([a, b, 0], 1);
        }
        stream.close_run();
        assert_eq!(stream.accum().len(), MAX_NGRAM_ENTRIES);
        assert!(stream.finger_accum().is_empty());

        // A trigram whose third position is not 0 cannot already be in the map.
        stream.correction([1, 2, 3], 1);
        stream.close_run();
        assert_eq!(
            stream.accum().len(),
            MAX_NGRAM_ENTRIES,
            "the cap must hold for a new key"
        );
        let expected = pack_finger(
            [wide_finger(1), wide_finger(2), wide_finger(3)],
            0,
            0,
            run_bucket(1),
        );
        assert_eq!(stream.finger_accum().get(&expected), Some(&1));
        assert_eq!(stream.aggregate.ngram_dropped[0], 0);

        // Incrementing an existing key is always allowed, at any map size.
        let existing = pack_ngram([0, 0, 0], 0, 0, run_bucket(1));
        let before = *stream.accum().get(&existing).unwrap_or(&0);
        stream.correction([0, 0, 0], 1);
        stream.close_run();
        assert_eq!(stream.accum().get(&existing), Some(&(before + 1)));
    }

    #[test]
    fn overflowing_the_finger_map_counts_as_dropped() {
        let mut stream = Stream::new(u32::MAX, 3);
        for index in 0..MAX_NGRAM_ENTRIES {
            let a = (index % 80) as u8;
            let b = ((index / 80) % 80) as u8;
            stream.correction([a, b, 0], 1);
        }
        stream.close_run();
        assert_eq!(stream.accum().len(), MAX_NGRAM_ENTRIES);

        // Every trigram below is new (its third position is never 0), so all of them degrade. The
        // run length varies so the finger key space is wide enough to reach its own cap.
        let mut fed = 0_usize;
        'outer: for presses in [1_u32, 2] {
            for first in 0..10_u8 {
                for second in 0..10_u8 {
                    for third in 1..10_u8 {
                        stream.correction(
                            [
                                position_on_finger(first),
                                position_on_finger(second),
                                position_on_finger(third),
                            ],
                            presses,
                        );
                        stream.close_run();
                        fed += 1;
                        if fed > MAX_NGRAM_FINGER_ENTRIES + 16 {
                            break 'outer;
                        }
                    }
                }
            }
        }
        assert_eq!(stream.finger_accum().len(), MAX_NGRAM_FINGER_ENTRIES);
        assert!(
            stream.aggregate.ngram_dropped[0] > 0,
            "overflowing the finger map must be reported, never silently capped"
        );
    }

    #[test]
    fn resync_clears_the_ring_but_keeps_accumulators() {
        let mut stream = Stream::new(u32::MAX, 3);
        for index in 0..10_u8 {
            stream.correction([index, index + 1, index + 2], 1);
        }
        stream.close_run();
        let before = sum_map(stream.accum());
        assert_eq!(before, 10);

        for pos in [1_u8, 2, 3] {
            stream.key(pos);
        }
        stream.backspace();
        stream.aggregate.resync_after_sequence_loss();
        assert_eq!(stream.aggregate.ngram_ring, EMPTY_NGRAM_RING);
        assert!(stream.aggregate.pending_ngram.is_none());
        assert_eq!(
            sum_map(stream.accum()),
            before,
            "a buffer overflow is not a session boundary"
        );
        assert_eq!(stream.aggregate.ngram_events[0], 10);
    }

    #[test]
    fn a_soft_pause_clears_the_ring_but_keeps_accumulators() {
        let mut stream = Stream::new(u32::MAX, 3);
        for index in 0..10_u8 {
            stream.correction([index, index + 1, index + 2], 1);
        }
        stream.close_run();
        for pos in [1_u8, 2, 3] {
            stream.key(pos);
        }
        stream.backspace();
        stream.aggregate.seal_or_discard_tier_a(1, 10_000, 25);
        assert_eq!(stream.aggregate.ngram_ring, EMPTY_NGRAM_RING);
        assert!(stream.aggregate.pending_ngram.is_none());
        assert_eq!(sum_map(stream.accum()), 10);
    }

    #[test]
    fn no_seal_below_the_configured_count() {
        let mut stream = Stream::new(500, 3);
        for index in 0..499_u32 {
            stream.correction([(index % 80) as u8, ((index / 80) % 80) as u8, 0], 1);
        }
        stream.close_run();
        assert_eq!(stream.aggregate.ngram_events[0], 499);
        assert!(stream.seals.is_empty());

        stream.correction([5, 6, 7], 1);
        stream.close_run();
        assert_eq!(stream.seals.len(), 1);
    }

    #[test]
    fn seal_preserves_the_correction_total() {
        let mut stream = Stream::new(500, 3);
        let mut state = 987_654_321_u64;
        for _ in 0..5_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let pick = |shift: u32| ((state >> shift) % 80) as u8;
            stream.correction([pick(16), pick(24), pick(32)], 1 + (state >> 40) as u32 % 5);
        }
        stream.close_run();
        assert!(
            stream.seals.len() >= 8,
            "a 5000-correction stream must seal"
        );
        for seal in &stream.seals {
            let rows = sum_counts(&seal.rows);
            let fingers = seal.degraded();
            assert_eq!(
                rows + fingers + seal.dropped,
                seal.corrections,
                "degradation moves counts, it never loses them"
            );
            assert_eq!(seal.corrections, 500);
        }
    }

    #[test]
    fn seal_suppresses_rows_below_the_minimum_count() {
        let mut stream = Stream::new(500, 3);
        for index in 0..500_u32 {
            stream.correction([(index % 80) as u8, ((index / 80) % 80) as u8, 0], 1);
        }
        stream.close_run();
        let seal = stream
            .seals
            .first()
            .unwrap_or_else(|| unreachable!("500 corrections must seal"));
        assert!(
            seal.rows.is_empty(),
            "every trigram was seen once, so none may keep its position identity"
        );
        assert_eq!(seal.degraded(), 500);
        assert_eq!(seal.dropped, 0);
    }

    #[test]
    fn suppressed_rows_appear_in_the_finger_projection() {
        let mut stream = Stream::new(500, 3);
        // One trigram repeated well past the minimum count, plus a long tail of singletons.
        for _ in 0..400 {
            stream.correction([10, 20, 30], 1);
        }
        for index in 0..100_u32 {
            stream.correction([(index % 80) as u8, ((index / 80) % 80) as u8, 1], 1);
        }
        stream.close_run();
        let seal = stream
            .seals
            .first()
            .unwrap_or_else(|| unreachable!("500 corrections must seal"));
        let survivor = pack_ngram([10, 20, 30], 0, 0, run_bucket(1));
        assert_eq!(
            seal.rows.iter().find(|(key, _)| *key == survivor),
            Some(&(survivor, 400))
        );
        assert_eq!(seal.rows.len(), 1);
        assert_eq!(seal.degraded(), 100);
        assert_eq!(sum_counts(&seal.rows) + seal.degraded(), seal.corrections);

        let projected = pack_finger(
            [wide_finger(0), wide_finger(0), wide_finger(1)],
            0,
            0,
            run_bucket(1),
        );
        assert!(
            seal.finger_rows.iter().any(|(key, _)| *key == projected),
            "a suppressed trigram keeps its count as a finger triple"
        );
    }

    #[test]
    fn seal_clears_only_the_sealing_profile() {
        let mut stream = Stream::new(500, 3);
        stream.aggregate.set_profile(1);
        for index in 0..20_u8 {
            stream.correction([index, index + 1, index + 2], 1);
        }
        stream.close_run();
        let other_profile_total = sum_map(&stream.aggregate.ngram_accum[1]);
        assert_eq!(other_profile_total, 20);

        stream.aggregate.set_profile(0);
        for index in 0..500_u32 {
            stream.correction([(index % 80) as u8, ((index / 80) % 80) as u8, 0], 1);
        }
        stream.close_run();
        assert_eq!(stream.seals.len(), 1);
        assert!(stream.aggregate.ngram_accum[0].is_empty());
        assert_eq!(stream.aggregate.ngram_events[0], 0);
        assert_eq!(
            sum_map(&stream.aggregate.ngram_accum[1]),
            20,
            "another profile's accumulator must survive a seal"
        );
        assert_eq!(stream.aggregate.ngram_events[1], 20);
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
            let batch = aggregate.handle_event(index, 30, 1, &keymap(), &policy());
            assert!(batch.is_empty());
        }
        let seal = aggregate
            .handle_event(2_000, 30, 1, &keymap(), &policy())
            .tier_b
            .unwrap_or_else(|| unreachable!());
        assert_eq!(seal.keystrokes, 2_000);
        assert_eq!(seal.pos_count.iter().sum::<u32>(), 2_000);
        assert_eq!(aggregate.tier_b_total(), 0);
    }

    #[test]
    fn discard_zeroes_both_partial_tiers_and_context() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_500 {
            let batch = aggregate.handle_event(index, 30, 1, &keymap(), &policy());
            assert!(batch.is_empty());
        }
        aggregate.discard_partials(10);
        assert_eq!(aggregate.tier_b_total(), 0);
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(aggregate.held.len(), 0);
        assert_eq!(aggregate.keys_since_mod_down.len(), 0);
    }

    #[test]
    fn discard_clears_the_ring_and_pending_record() {
        let mut stream = Stream::new(u32::MAX, 3);
        for index in 0..10_u8 {
            stream.correction([index, index + 1, index + 2], 1);
        }
        stream.close_run();
        for pos in [1_u8, 2, 3] {
            stream.key(pos);
        }
        stream.backspace();
        assert!(stream.aggregate.pending_ngram.is_some());

        stream.aggregate.discard_partials(10);
        assert_eq!(stream.aggregate.ngram_ring, EMPTY_NGRAM_RING);
        assert!(stream.aggregate.pending_ngram.is_none());
        assert!(stream.accum().is_empty());
        assert!(stream.finger_accum().is_empty());
        assert_eq!(stream.aggregate.ngram_events, [0; MAX_PROFILES]);
        assert_eq!(stream.aggregate.ngram_dropped, [0; MAX_PROFILES]);
        assert_eq!(stream.aggregate.ngram_start_ts, [None; MAX_PROFILES]);
    }

    #[test]
    fn sequence_loss_resync_keeps_both_tiers_and_clears_context() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_500 {
            let batch = aggregate.handle_event(index, 30, 1, &keymap(), &policy());
            assert!(batch.is_empty());
        }
        aggregate.resync_after_sequence_loss();
        assert_eq!(aggregate.tier_b_total(), 1_500);
        assert_eq!(aggregate.tier_a.keystrokes, 1_500);
        assert_eq!(aggregate.held.len(), 0);
        assert_eq!(aggregate.keys_since_mod_down.len(), 0);
        for index in 1_500..1_999 {
            let batch = aggregate.handle_event(index, 30, 1, &keymap(), &policy());
            assert!(batch.is_empty());
        }
        let seal = aggregate.handle_event(2_000, 30, 1, &keymap(), &policy());
        assert_eq!(
            seal.tier_b.unwrap_or_else(|| unreachable!()).keystrokes,
            2_000,
            "a dropped-event re-sync must not reset the Tier B privacy floor"
        );
    }

    #[test]
    fn soft_pause_preserves_tier_b_and_seals_a_qualifying_tier_a_bucket() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..40 {
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
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
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
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
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
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
        aggregate.handle_event(0, 30, 1, &keymap(), &policy());
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
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
        }
        aggregate.set_profile(1);
        for index in 30..70 {
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
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
                .handle_event(index, 30, 1, &keymap(), &policy())
                .is_empty());
        }
        aggregate.set_profile(1);
        for index in 1_500..3_000 {
            assert!(
                aggregate
                    .handle_event(index, 30, 1, &keymap(), &policy())
                    .is_empty(),
                "the second profile must start from zero, not inherit 1500"
            );
        }
        aggregate.set_profile(0);
        for index in 3_000..3_499 {
            assert!(aggregate
                .handle_event(index, 30, 1, &keymap(), &policy())
                .is_empty());
        }
        let seal = aggregate
            .handle_event(3_499, 30, 1, &keymap(), &policy())
            .tier_b
            .unwrap_or_else(|| unreachable!("the first profile should reach 2000"));
        assert_eq!(seal.keystrokes, 2_000);
    }

    #[test]
    fn switching_profiles_does_not_discard_tier_b_progress() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..1_000 {
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
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
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
        }
        assert!(aggregate.bounded_footprint() <= footprint_bound(MAX_PROFILES));
    }

    #[test]
    fn a_profile_index_beyond_the_configured_count_is_ignored() {
        let mut aggregate = Aggregator::new(0, 2);
        aggregate.handle_event(0, 30, 1, &keymap(), &policy());
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
        aggregate.handle_event(0, 30, 1, &keymap(), &policy());
        aggregate.set_profile(1);
        aggregate.handle_event(1, 30, 1, &keymap(), &policy());
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
                &policy(),
            );
            drop(seal);
        }
        let large = after_200k.bounded_footprint();
        assert_eq!(small, large);
        assert!(large < 600);
        assert!(large <= footprint_bound(1));
    }
}
