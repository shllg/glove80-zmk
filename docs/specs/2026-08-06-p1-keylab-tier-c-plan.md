# P1 — keylab Tier C: correction context capture

Date: 2026-08-06
Status: implemented. Blocked P2 and P4, both now done.
Design: `docs/specs/2026-08-06-correction-context-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, for each backspace run, the ordered trigram of physical positions that preceded it, plus the modifier mask, a latency bucket and the run bucket — sealed by correction count, with low-count rows degraded to their finger-level projection.

## Global Constraints

Every task's requirements implicitly include this section.

- **Privacy floors are hard minimums**, enforced in `Config::validate`, not merely defaults: `MIN_TIER_A_SEAL_FLOOR = 25`, `MIN_TIER_B_SEAL_COUNT = 2000` (`crates/keylab/src/config.rs:6-7`), and the two added here.
- **Logging policy** (`crates/keylab/src/main.rs:1`): never log keycodes, positions, characters, n-grams, or event `Debug` values. Counts only.
- **Bounded in-memory footprint.** `Aggregator` state must stay bounded regardless of stream length and number of profile switches. `bounded_footprint()` and `footprint_bound()` (`crates/keylab/src/aggregate.rs:474-491`) are the mechanism and must be extended, not bypassed.
- **Partial aggregates never persist.** Anything below its seal floor is zeroized, never written.
- **Zeroize discipline.** Every new field holding position or timing data implements or participates in zeroization on `discard_partials`, on `Drop`, and after use — matching `HeldKeys` (`aggregate.rs:62-79`).
- **No systemd hardening regression.** This project does not change `crates/keylab/keylab.service`. If that file changes for any reason, re-run `crates/keylab/verify-hardening.sh` and update `docs/keylab-security-score.txt`.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys. Commit locally only.
- **No AI attribution** in commits, comments, or docs. No `Co-Authored-By` trailer.

## Definition of Done

`cargo test -p keylab` passes, `cargo clippy -p keylab -- -D warnings` is clean, a fresh database opens at schema version 4, a v1/v2/v3 database migrates in place, and `docs/keylab.md` describes Tier C accurately including its residual risks.

---

## Task 1 — encoding and constants

- [x] Add to `crates/keylab/src/encode.rs`:
  - `pub const NGRAM_N: usize = 3;`
  - `pub const POS_UNATTRIBUTED: u8 = 80;` — the existing Tier B convention, currently the bare literal `80` at `aggregate.rs:274`
  - `pub const POS_ABSENT: u8 = 81;` — fewer than three keys preceded the correction
  - `pub const FINGER_ABSENT: u8 = 10;`
  - `pub const fn latency_bucket(ms: u64) -> u8` — `<150 => 0`, `<400 => 1`, `<1000 => 2`, else `3`
- [x] Add key packing, with every shift named explicitly rather than inline:

```rust
// pos_a | pos_b | pos_c | mod_mask | latency | run  — 34 bits used of 64.
pub const fn pack_ngram(pos: [u8; NGRAM_N], mod_mask: u8, latency: u8, run: u8) -> u64
pub const fn unpack_ngram(key: u64) -> ([u8; NGRAM_N], u8, u8, u8)
pub const fn pack_finger(finger: [u8; NGRAM_N], mod_mask: u8, latency: u8, run: u8) -> u64
pub const fn unpack_finger(key: u64) -> ([u8; NGRAM_N], u8, u8, u8)
```

**Requirements**
- Positions occupy 7 bits each, fingers 4 bits each, `mod_mask` 8 bits, latency 2 bits, run 3 bits.
- `mod_mask` is a bitmask over the eight mod classes from `mod_class(hand, modifier)` (`encode.rs:24`), bit `n` = class `n`.

**Tests** (in `encode.rs`, matching the existing `pins_*` style)
- [x] `latency_boundaries_are_exact` — 0, 149, 150, 399, 400, 999, 1000, 60000
- [x] `ngram_packing_round_trips` — every combination of edge values, including `POS_ABSENT` and `POS_UNATTRIBUTED`
- [x] `pins_ngram_bit_layout` — asserts the packed value of one known tuple, so a shift change cannot pass silently

## Task 2 — configuration

- [x] Add to `crates/keylab/src/config.rs`:
  - `pub const MIN_NGRAM_SEAL_COUNT: u32 = 500;`
  - `pub const MIN_NGRAM_MIN_COUNT: u32 = 3;`
  - `pub const MAX_NGRAM_ENTRIES: usize = 4096;`
  - `pub const MAX_NGRAM_FINGER_ENTRIES: usize = 1024;`
- [x] Add `Config` fields: `ngram_capture: bool`, `ngram_seal_count: u32`, `ngram_min_count: u32`
- [x] `Default`: `true`, `MIN_NGRAM_SEAL_COUNT`, `MIN_NGRAM_MIN_COUNT`
- [x] `validate()`: reject `ngram_seal_count < MIN_NGRAM_SEAL_COUNT` and `ngram_min_count < MIN_NGRAM_MIN_COUNT`, with the same message shape as the existing floor checks (`config.rs:121-132`)

**Requirements**
- `Config` carries `#[serde(default, deny_unknown_fields)]` (`config.rs:35`), so an installed configuration without these keys must keep loading unchanged. Verify this rather than assuming it.

**Tests**
- [x] `rejects_lower_ngram_seal_count`
- [x] `rejects_lower_ngram_min_count`
- [x] `defaults_match_the_privacy_spec` — extend the existing test at `config.rs:229`
- [x] `a_config_without_ngram_keys_still_loads` — parse a TOML string with no `ngram_*` keys and assert the defaults

## Task 3 — aggregator state and capture

All in `crates/keylab/src/aggregate.rs`.

- [x] Add a `PendingNgram` struct: `ring: [u8; NGRAM_N]`, `mod_mask: u8`, `latency: u8`. Implement `zeroize` and `Drop`.
- [x] Add `Aggregator` fields:

```rust
ngram_ring: [u8; NGRAM_N],                       // oldest -> newest, POS_ABSENT when unfilled
pending_ngram: Option<PendingNgram>,
ngram_accum: [HashMap<u64, u32>; MAX_PROFILES],
ngram_finger_accum: [HashMap<u64, u32>; MAX_PROFILES],
ngram_events: [u32; MAX_PROFILES],
ngram_dropped: [u32; MAX_PROFILES],
ngram_start_ts: [Option<u64>; MAX_PROFILES],
```

- [x] In `key_down` (`aggregate.rs:220`), after `pos_index` is computed and **only when `code != KEY_BACKSPACE`**, shift `ngram_ring` left and append `pos_index as u8`.
- [x] In `key_down`, inside the existing `if code == KEY_BACKSPACE { if self.bsp_run == 0 { … } }` block (`aggregate.rs:241-254`), set `pending_ngram` from the current ring, the active mod mask, and `latency_bucket(t_ms - last_keydown_ts)`.
- [x] Add `fn active_mod_mask(&self) -> u8` deriving the mask from the keys of `keys_since_mod_down`, which are exactly the mod classes currently held.
- [x] In `finish_backspace_run` (`aggregate.rs:344`), after the existing `BSP_BURST` / `BSP_BURST_AFTER_MOD` increments, commit the pending record when capture is enabled.

**Requirements**
- `[HashMap<u64, u32>; MAX_PROFILES]` has no derivable `Default`. Write an explicit `Default` impl for `Aggregator` using `std::array::from_fn(|_| HashMap::new())` rather than fighting the derive.
- The record is committed in `finish_backspace_run`, **not** at run start: `run_bucket` is not known until the run ends.
- `latency` is measured from `last_keydown_ts` *before* the backspace updates it. Read it before the existing `self.last_keydown_ts = Some(t_ms)` assignment at `aggregate.rs:276`.
- When the ring holds fewer than three real positions, the unfilled slots stay `POS_ABSENT`.
- Capture is gated by a flag threaded from `Config::ngram_capture`. When off, no ring is maintained and no pending record is created — not merely "recorded and discarded".

**Tests**
- [x] `ngram_ring_holds_the_three_preceding_positions` — type four keys then backspace; assert the ring is keys 2,3,4
- [x] `backspace_never_enters_the_ring` — two backspaces in a run must not shift the ring
- [x] `run_bucket_is_resolved_at_run_end_not_start` — a three-press run records `run_bucket(3)`, not `run_bucket(1)`
- [x] `latency_uses_the_gap_before_the_backspace` — assert bucket boundaries at 149/150 and 999/1000 ms
- [x] `a_short_stream_records_absent_positions` — one key then backspace yields two `POS_ABSENT` slots
- [x] `capture_disabled_records_nothing`

## Task 4 — bounds, discard, and resync

- [x] Extend `bounded_footprint()` (`aggregate.rs:474`) to include both new maps.
- [x] Extend `footprint_bound()` (`aggregate.rs:489`) by `(MAX_NGRAM_ENTRIES + MAX_NGRAM_FINGER_ENTRIES) * profile_count.clamp(1, MAX_PROFILES)`.
- [x] On insert into `ngram_accum` when the map is at `MAX_NGRAM_ENTRIES` and the key is new: insert into `ngram_finger_accum` instead, projecting positions through the keymap.
- [x] On insert into `ngram_finger_accum` when *that* map is at `MAX_NGRAM_FINGER_ENTRIES` and the key is new: increment `ngram_dropped[profile]`.
- [x] Extend `discard_partials` (`aggregate.rs:434`) to zeroize the ring, `pending_ngram`, both maps, `ngram_events`, `ngram_dropped`, and `ngram_start_ts`.
- [x] Extend `resync_after_sequence_loss` (`aggregate.rs:461`) to clear the ring and `pending_ngram` **but not** the accumulators.

**Requirements**
- The `resync` split mirrors the existing rationale documented at `aggregate.rs:456-460`: a buffer overflow is not a session boundary, so already-counted totals stay, but any timing or ordering relationship spanning the gap is unreliable and is cleared. A trigram spanning a `SYN_DROPPED` would be fiction.
- Incrementing an *existing* key is always allowed, at any map size. Only new keys are capped.

**Tests**
- [x] `ngram_footprint_stays_within_the_bound` — extend the existing 200k-event test at `aggregate.rs:922-935`
- [x] `overflowing_the_position_map_degrades_to_fingers`
- [x] `overflowing_the_finger_map_counts_as_dropped`
- [x] `discard_clears_the_ring_and_pending_record` — extend `discard_zeroes_both_partial_tiers_and_context` (`aggregate.rs:731`)
- [x] `resync_clears_the_ring_but_keeps_accumulators`

## Task 5 — seal

- [x] Add `TierCSeal` with `Drop`-based zeroization, mirroring `TierBSeal` (`aggregate.rs:108-120`):

```rust
pub struct TierCSeal {
    pub start_ts: u64,
    pub end_ts: u64,
    pub corrections: u32,
    pub dropped: u32,
    pub rows: Vec<(u64, u32)>,         // n >= ngram_min_count
    pub finger_rows: Vec<(u64, u32)>,  // degraded + cap overflow
}
```

- [x] Seal when `ngram_events[profile] >= ngram_seal_count`. At seal, partition `ngram_accum[profile]`: entries with `n >= ngram_min_count` become `rows`; the rest are projected through the keymap to finger triples and merged into `finger_rows` together with `ngram_finger_accum[profile]`.
- [x] Change `handle_event` to return a `SealBatch { tier_b: Option<TierBSeal>, tier_c: Option<TierCSeal> }` instead of `Option<TierBSeal>`.

**Requirements**
- A **correction event** is one completed backspace *run*, not one backspace press. A five-press run is one event that records `run_bucket(5)`. `ngram_events` therefore counts runs, and the 500 floor is 500 runs.
- `finish_backspace_run` is reachable from two call sites (`aggregate.rs:201` on a >1000 ms gap, `aggregate.rs:257` on a non-backspace key). Both must be able to propagate a Tier C seal to the caller. Do not add a second return channel or a queue — thread it through `SealBatch`.
- `sum(rows) + sum(finger_rows) + dropped == corrections` must hold exactly. Degradation moves counts, it never loses them.
- After sealing, zeroize both maps and reset the counters for that profile only. Other profiles' accumulators are preserved, exactly as Tier B preserves them across a switch (`aggregate.rs:178-185`).

**Tests**
- [x] `seal_preserves_the_correction_total` — the exact-sum invariant, over a randomised stream
- [x] `seal_suppresses_rows_below_the_minimum_count`
- [x] `suppressed_rows_appear_in_the_finger_projection`
- [x] `seal_clears_only_the_sealing_profile`
- [x] `no_seal_below_the_configured_count`

## Task 6 — persistence and schema v4

All in `crates/keylab/src/store.rs`.

- [x] Add the three tables to `SCHEMA` (`store.rs:13`), following the existing `WITHOUT ROWID` style used by `pos_count` (`store.rs:96`):

```sql
CREATE TABLE IF NOT EXISTS ngram_window (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  profile_id  INTEGER REFERENCES profile(id),
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  corrections INTEGER NOT NULL,
  degraded    INTEGER NOT NULL,
  dropped     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ngram (
  window_id      INTEGER NOT NULL REFERENCES ngram_window(id),
  pos_a          INTEGER NOT NULL,
  pos_b          INTEGER NOT NULL,
  pos_c          INTEGER NOT NULL,
  mod_mask       INTEGER NOT NULL,
  latency_bucket INTEGER NOT NULL,
  run_bucket     INTEGER NOT NULL,
  n              INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ngram_finger (
  window_id      INTEGER NOT NULL REFERENCES ngram_window(id),
  finger_a       INTEGER NOT NULL,
  finger_b       INTEGER NOT NULL,
  finger_c       INTEGER NOT NULL,
  mod_mask       INTEGER NOT NULL,
  latency_bucket INTEGER NOT NULL,
  run_bucket     INTEGER NOT NULL,
  n              INTEGER NOT NULL,
  PRIMARY KEY (window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;
```

- [x] Add `pub fn seal_tier_c(&mut self, device_id, profile_id, seal: &TierCSeal) -> Result<()>`, modelled on `seal_tier_b` (`store.rs:278`), in one transaction.
- [x] Add `fn migrate_v3_to_v4(connection: &Connection) -> Result<()>` — pure `CREATE TABLE IF NOT EXISTS`, no backfill, then `UPDATE meta SET value = '4' WHERE key = 'schema_version'`, then `info!("migrated database schema from version 3 to 4")`.
- [x] Update the version match (`store.rs:459-467`) to `None | Some("4") => {}`, `Some("1")` → v1→v2→v3→v4, `Some("2")` → v2→v3→v4, `Some("3")` → v3→v4, and the seed literal at `store.rs:470` to `'4'`.

**Requirements**
- `ngram_window.degraded` is `sum(finger_rows)` — every count that lost its position identity, whether by low-count suppression at seal or by cap overflow during capture. `dropped` is `TierCSeal::dropped`, the counts that lost even their finger identity.
- `seal_tier_c` must refuse to persist a window below `MIN_NGRAM_SEAL_COUNT`, and refuse when `sum(rows) + sum(finger_rows) + dropped != corrections` — the same defensive posture as `seal_tier_b` (`store.rs:279-289`). These are `bail!`s, not assertions.
- On-disk encoding: `-1` for unattributed, `-2` for absent, mapping from the in-memory `POS_UNATTRIBUTED = 80` and `POS_ABSENT = 81`. `-1` matching `pos_count`'s existing convention (`store.rs:308-312`) is deliberate; document the `-2` extension in a comment.
- Migration must be re-runnable after a partial failure, like the existing two (`store.rs:543-551`).

**Tests**
- [x] `seals_a_tier_c_window`
- [x] `refuses_a_tier_c_window_below_the_floor`
- [x] `refuses_an_inconsistent_tier_c_window`
- [x] `migrates_v3_to_v4` — build a v3 database, open, assert version 4 and that the three tables exist
- [x] `migrates_v1_all_the_way_to_v4` — extend the existing v1 migration test (`store.rs:850`)

## Task 7 — daemon wiring

All in `crates/keylab/src/main.rs`.

- [x] Update the `handle_event` call site (`main.rs:599-612`) for `SealBatch`.
- [x] Add `translate_tier_c_timestamps`, mirroring `translate_tier_b_timestamps` (`main.rs:610`), so `start_ts`/`end_ts` are wall-clock.
- [x] Persist via `store.seal_tier_c(runtime.device_id, runtime.profile_id, &seal)`.
- [x] Thread `config.ngram_capture`, `config.ngram_seal_count` and `config.ngram_min_count` to the aggregator on the same path as `config.tier_b_seal_count`.
- [x] Update the footprint `debug_assert!` (`main.rs:613-616`) — it should need no change if `footprint_bound` was extended correctly. Confirm rather than assume.

**Requirements**
- The pause re-check before persisting (`main.rs:606-609`) applies to Tier C identically: if a pause arrived between sealing and writing, drop the seal rather than writing it.
- Log a count only on seal — never positions or n-grams.

**Tests**
- [x] Extend the existing daemon-level tests (`main.rs:897`, `:962`) to assert a Tier C window appears after enough corrections and that a hard pause mid-window discards it.

## Task 8 — documentation

- [x] `docs/keylab.md:5-19` "What is recorded": add Tier C with its floor and its degradation rule.
- [x] `docs/keylab.md:15`: the sentence claiming keylab records no bigrams, no words and no event order is now **false**. Replace it with an accurate statement — keylab records no characters, no raw keycodes, no raw event log and no word identity, but it does record an ordered trigram of physical positions at each correction.
- [x] `docs/keylab.md:217-224` schema table: add the `v3 → v4` row, backfill "none — new tables".
- [x] `docs/keylab.md:51-67` Configure: document `ngram_capture`, `ngram_seal_count`, `ngram_min_count` and their enforced minimums.
- [x] `docs/keylab.md:256-275` "What this does not protect against": add the four residual risks from the design document, in full.
- [x] Add a short rationale — why correction context is recorded at all, and why capture is on by default. Compact: a paragraph, not a section.
- [x] Check `crates/keylab/` for an example configuration installed by `install.sh` and add the new keys there if one exists.

**Requirements**
- The documentation change is part of this project, not a follow-up. A shipped daemon whose documentation misstates what it records is the specific failure this bullet exists to prevent.
