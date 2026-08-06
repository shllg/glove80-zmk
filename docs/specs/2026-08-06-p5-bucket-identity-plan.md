# P5 — bucket identity at schema v5

Date: 2026-08-06
Status: planned to step level. Depends on nothing.
Design: `docs/specs/2026-08-06-field-hardening-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two keyboards can seal a Tier A bucket in the same second without either one being discarded.

## The defect

`bucket.id` is both the seal second and the primary key (`crates/keylab/src/store.rs:33-41`), and `current_bucket_id()` is the wall-clock second (`crates/keylab/src/main.rs:842`). `seal_tier_a` checks whether the id exists and, if it does, **returns `Ok(())` having written nothing** (`store.rs:269-282`). One device's entire bucket — keystrokes, per-finger counts, hold, gap and modifier histograms — disappears with no log line and no counter.

Single-keyboard installations never reached it. This machine now runs two, so it is live.

## Global Constraints

- **The privacy floors are enforced minimums.** 25 keystrokes and 10 seconds for a Tier A bucket. The migration may not resurrect anything below them, and the rebuilt table may not relax the checks in `seal_tier_a`.
- **A migration never costs history.** v1→v2→v3→v4 all migrated in place (`docs/keylab.md`, Inspect). v4→v5 must too, and must be re-runnable after an interrupted attempt.
- **No silent drops.** The whole point of this project. A seal that cannot be written must be logged and counted, never swallowed by an `Ok`.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

Two devices sealing in the same second both persist, with their child rows intact; an existing v4 database migrates in place with byte-identical totals; `pnpm analysis report` and the viewer read the new column; a duplicate seal for the same device, profile and second is refused loudly rather than silently.

---

## Task 1 — schema v5

In `crates/keylab/src/store.rs`.

- [ ] Rebuild `bucket` as `id INTEGER PRIMARY KEY` (surrogate), `ts INTEGER NOT NULL`, plus the existing columns, with `UNIQUE (ts, device_id, profile_id)`.
- [ ] Add an index on `ts` — every read filters by it and it is no longer the primary key.
- [ ] Write the v4 → v5 migration: create the new table, copy each existing row with `id` kept verbatim and `ts = id`, swap, and stamp `schema_version = 5`.
- [ ] Bump the pinned version in `packages/analysis/src/db.ts:3` to 5.

**Requirements**
- Existing `id` values are preserved exactly. Six child tables reference `bucket(id)` (`store.rs:44,51,59,67,75,83`); a renumbering would orphan every one of them, so the migration rewrites one table and touches no other.
- The migration runs inside one transaction and is re-runnable: an interrupted attempt must leave either v4 or v5, never a half-swapped pair.
- `keymap_hash_history` and every other `meta` row survive untouched.

**Tests**
- [ ] `v4_migrates_in_place_with_identical_totals`
- [ ] `child_rows_still_join_after_the_migration`
- [ ] `an_interrupted_migration_leaves_a_readable_database`

## Task 2 — seal without collision

In `crates/keylab/src/store.rs` and `crates/keylab/src/main.rs`.

- [ ] Insert with an explicit `ts`, letting SQLite allocate the surrogate id.
- [ ] Delete the `bucket_exists` early return and its comment; the unique constraint now expresses the invariant.
- [ ] A genuine `(ts, device_id, profile_id)` conflict returns an error, is logged with the device and second, and is counted.

**Requirements**
- Same device, same profile, same second is impossible by construction — the aggregator seals one bucket per device per tick. If it happens anyway it is a bug, and a bug that returns `Ok` is exactly how the current defect stayed invisible until a second keyboard was configured.
- The count of refused seals belongs where an operator will see it: the startup and periodic log lines that already carry `matched_count`.

**Tests**
- [ ] `two_devices_sealing_in_the_same_second_both_persist`
- [ ] `a_duplicate_seal_for_one_device_is_refused_and_counted`
- [ ] `sealing_still_refuses_a_bucket_below_either_privacy_floor`

## Task 3 — readers follow the column

In `packages/analysis/src/metrics.ts`.

- [ ] Replace the seven `timestampFilter("b.id", …)` call sites and the three `strftime('%Y-%m-%d', b.id, …)` day groupings with `b.ts`.
- [ ] Check every other `bucket` read in `packages/analysis`, `packages/viewer` and `packages/trainer` for the same assumption.

**Requirements**
- `timestampFilter` derives its profile and device aliases from the column name (`metrics.ts:520-539`). Renaming the column must not silently change which table those clauses land on — read that function before editing the call sites.
- The fixtures in `packages/analysis/test/fixture.ts` write `bucket(id, …)` directly and must move to `(id, ts, …)`; the four factories share one `SCHEMA` constant, so the change is one place and the assertions that hang off `recentBucketId` must keep meaning the same instant.

**Tests**
- [ ] `analysis_totals_are_unchanged_by_the_column_rename` (compare a v4 fixture migrated to v5 against the v4 numbers recorded today)
- [ ] `the_daily_dose_still_groups_by_local_day`

## Task 4 — documentation

- [ ] `docs/keylab.md`: add the v4 → v5 row to the migration table with its backfill (`ts = id`, accurate rather than a guess), and state that a bucket is now identified by device and second rather than by second alone.
- [ ] State plainly what was lost before the fix: on a two-keyboard machine, Tier A buckets whose seal seconds collided were dropped, they are not recoverable, and the loss is invisible in the stored data.
