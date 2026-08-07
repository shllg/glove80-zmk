# P6 — device identity, a guarded merge, and a scan test seam

Date: 2026-08-06
Status: implemented. Task 2 depended on P5, which is done.
Design: `docs/specs/2026-08-06-field-hardening-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** One physical keyboard reads as one device, and putting a fragmented history back together is an operation with a guard rather than a paragraph of SQL.

## The defect

`register_device` reuses a row by `(name, uniq)` (`crates/keylab/src/store.rs:211-239`) and is correct today. An older build was not: this database holds eleven rows for one keyboard, six with data, all named `Evsieve Virtual Device` with a null `uniq` and an identical keymap hash. The viewer now labels them by id, keystroke count and first-seen date, which makes them distinguishable and nothing more.

There is no supported way to merge them. The obvious hand-written form — `UPDATE bucket SET device_id = 1 WHERE device_id <> 1` — folds a second keyboard's `qwerty-ansi` counts into a `glove80` row the moment a second keyboard exists, which happened between writing that SQL and running it during this session. It was caught by reading, not by a guard.

## Global Constraints

- **Position identity never pools across position spaces** (`packages/analysis/src/metrics.ts:476`). A merge across `keymap_kind` is the same violation as a pooled read, and must fail the same way: loudly, before touching anything.
- **The database is privacy-sensitive.** Any operation that rewrites it takes a backup first and says where it put it.
- **No silent drops.** A merge reports exactly what moved and what it refused to move.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

`keylabctl devices list` shows what the viewer shows; `keylabctl devices merge` moves one device's history onto another with a position-space guard, a backup, and a report; a `uinput`-backed test exercises the device scan's skip path; the eleven rows on this machine become one.

---

## Task 1 — `keylabctl devices list`

In `crates/keylab/src/bin/keylabctl.rs`.

- [x] Add a `devices` command listing id, name, position space, first seen, Tier A keystrokes, Tier B windows and Tier C windows.
- [x] Mark rows that hold no positional data, which is what makes an orphan recognisable.

**Requirements**
- Same figures as `/api/devices` (`packages/viewer/src/server.ts`). Two tools that count the same thing differently are worse than one tool.
- Read-only, and safe to run while the daemon is capturing — the database is WAL and every other reader already assumes it.

**Tests**
- [x] `devices_list_reports_every_row_that_holds_data`
- [x] `devices_list_marks_a_row_with_no_positional_data`

## Task 2 — `keylabctl devices merge`

In `crates/keylab/src/bin/keylabctl.rs` and `crates/keylab/src/store.rs`. **Depends on P5**, because repointing rows onto a device changes which bucket identities can collide.

*Landed in `crates/keylab/src/registry.rs` rather than `store.rs`. `keylabctl` is a separate binary target that pulls modules in with `#[path]`, and including `store.rs` there would drag `aggregate`, `encode` and `keymap` along with it — every item of those the CLI does not call is a `dead_code` warning under `-D warnings`. The schema moved to `src/schema.sql`, which both `store.rs` and `registry.rs` include, so the tables a merge is tested against cannot drift from the ones the daemon writes.*

- [x] `keylabctl devices merge <from>[,<from>…] --into <id>`, repointing `bucket`, `key_window` and `ngram_window`, then deleting the emptied rows.
- [x] Refuse when any source and the target differ in `keymap_kind`, naming both spaces.
- [x] Take a backup before writing, print its path, and print a per-table count of what moved.
- [x] Require the daemon to be stopped, or take the write lock and fail cleanly if it cannot.

**Requirements**
- **The position-space guard is the point of this task.** It refuses before opening a transaction, and its message says which device belongs to which space rather than only that the merge was rejected.
- After P5 a bucket is unique on `(ts, device_id, profile_id)`, so repointing can collide where it previously could not. A collision means both keyboards sealed in the same second under the same profile: sum the counts rather than dropping either, and report how many rows were combined. Dropping one is the defect P5 exists to remove, reintroduced by the back door.
- A merge is not reversible except from the backup. Say so before doing it, not after.
- Deleting a device row with data still pointing at it must be impossible; delete only after the repoint, in the same transaction.

**Tests**
- [x] `merging_across_position_spaces_is_refused_before_anything_is_written`
- [x] `a_merge_moves_every_tier_and_leaves_no_orphan_rows`
- [x] `colliding_buckets_are_summed_and_the_count_is_reported`
- [x] `a_failed_merge_leaves_the_database_exactly_as_it_was`

## Task 3 — a test seam for the device scan

In `crates/keylab/src/device.rs`.

- [x] Add a `uinput` integration test behind a cargo feature (default off) that creates a virtual evdev device, points a rule at it, and asserts the scan captures it.
- [x] Assert the skip path: a matched device that fails preparation is skipped, counted in `skipped_count`, and does not abort the scan of the others.
- [x] Document the feature and how to run it in `docs/keylab.md`.

**Requirements**
- Default-off, because `/dev/uinput` needs permissions the suite cannot assume. A test that silently skips is worse than one that is absent: the flag makes its absence visible.
- The skip path is the behaviour `06237e8` introduced and could not test. It is the reason this task exists, so it is not optional scope.
- The test must destroy its virtual device even when it fails, or a failed run leaves a fake keyboard on the machine.

**Tests**
- [x] `a_virtual_device_matching_a_rule_is_captured` (feature-gated)
- [x] `a_matched_device_that_cannot_be_prepared_is_skipped_not_fatal` (feature-gated)

## Task 4 — this machine, and the documentation

- [x] Merge the eleven Glove80 rows into one with the new command, keeping the backup.
- [x] `docs/keylab.md`: document `devices list` and `devices merge`, the position-space refusal, and the fact that an older build minted a row per reconnect so an existing database may carry several rows for one keyboard.
