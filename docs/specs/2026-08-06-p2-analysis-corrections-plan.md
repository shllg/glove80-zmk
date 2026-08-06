# P2 — analysis: correction context reporting

Date: 2026-08-06
Status: planned to step level. Depends on P1.
Design: `docs/specs/2026-08-06-correction-context-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Tier C in `pnpm analysis report` — top corrected trigrams as characters, split by fumble and edit, with the degraded and dropped shares visible.

## Global Constraints

- **Position identity never pools across position spaces.** `assertSinglePositionSpace` (`packages/analysis/src/metrics.ts:352`) exists because this is the invariant most likely to be violated silently. Tier C is positional and is subject to it.
- **No silent caps.** Degraded and dropped counts are reported, not hidden. A report that omits them reads as full coverage when it is not.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

`pnpm analysis report` on a database containing sealed Tier C windows prints a correction-context section; a cross-device read throws rather than pooling; tests pass.

---

## Task 1 — schema gate

- [ ] `packages/analysis/src/db.ts:3`: `SUPPORTED_SCHEMA_VERSION` → 4.
- [ ] Verify the existing mismatch message (`db.ts:25-28`) still names the correct fix for a v3 database. It tells the user to run the newer daemon; confirm that wording covers the v3→v4 case.

**Tests**
- [ ] `rejects_a_v3_database_with_an_actionable_message`

## Task 2 — position-space guard for Tier C

- [ ] Generalise `assertSinglePositionSpace` (`metrics.ts:352`) to accept the window table name, or add a Tier C sibling. It currently hard-codes `key_window kw`.
- [ ] Call it from every Tier C read path.

**Requirements**
- The error message must name Tier C rather than Tier B when it fires for an n-gram read — an operator following the message needs to know which read failed.
- Do not weaken the existing Tier B guard while generalising it. Its test must still pass unchanged.

**Tests**
- [ ] `refuses_to_pool_ngrams_across_position_spaces`
- [ ] `a_single_device_ngram_read_succeeds`

## Task 3 — metrics

In `packages/analysis/src/metrics.ts`.

- [ ] Add `getCorrectionContext(database, meta, range, profile, device)` returning:
  - `topNgrams`: trigram, rendered characters, count, latency class, run bucket, mod mask
  - `byLatency`: fumble / ambiguous / edit totals
  - `byFinger`: the degraded finger-triple aggregates
  - `corrections`, `degraded`, `dropped`, `degradedShare`, `droppedShare`
- [ ] Extend `RangeMetrics["correctionTax"]` (`metrics.ts:161`, built at `metrics.ts:621`) with the new block, rather than adding a parallel top-level key.

**Requirements**
- Render positions to characters through `AnalysisMeta.positions` — the same source `getCorrectionTax` already uses for `baseKeycode` at `metrics.ts:633-635`. `-1` renders as `?` (unattributed), `-2` renders as `·` (absent).
- A trigram's characters are the *base-layer* bindings. Where a position has no base binding, render `?` rather than guessing.
- Aggregate across windows by summing `n` per key. Windows are independent samples; do not average.

**Tests** (extend `packages/analysis/test/metrics.test.ts` and `fixture.ts`)
- [ ] `sums_ngram_counts_across_windows`
- [ ] `renders_unattributed_and_absent_positions_distinctly`
- [ ] `splits_corrections_into_fumbles_and_edits`
- [ ] `reports_the_degraded_and_dropped_shares`
- [ ] `an_empty_tier_c_produces_zeroes_not_a_crash`

## Task 4 — report

In `packages/analysis/src/report.ts`, extending the existing "Correction tax" block (`report.ts:79-88`).

- [ ] Add a correction-context section: top corrected trigrams with counts and fumble/edit class, the finger-transition rollup, and the degraded/dropped shares.
- [ ] Keep the existing `BSP_BURST` and Tier B lines. They remain the only correction signal for windows sealed before Tier C existed.

**Requirements**
- The section must state when it is empty, and why — no sealed Tier C window yet, capture disabled, or the range excludes them. A silently absent section reads as "no corrections".
- Follow the existing column-formatting helpers (`number`, `percent`) rather than introducing new ones.

**Tests**
- [ ] `prints_a_correction_context_section`
- [ ] `says_so_when_no_ngram_window_exists`
