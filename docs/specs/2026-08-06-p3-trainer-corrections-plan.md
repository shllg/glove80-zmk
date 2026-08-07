# P3 — trainer: correction capture and word-level attribution

Date: 2026-08-06
Status: implemented. Depended on nothing, and was built first.
Design: `docs/specs/2026-08-06-correction-context-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record corrections during practice sessions and attribute them to the word, character offset and transition being typed — using text the trainer generated and therefore knows the ground truth for. Fix the two existing bugs that make current correction behaviour wrong.

**Why this is independent:** different database (`~/.local/share/glove80-lab/trainer.db`), different instrument, no keylab schema dependency, and no privacy cost — the text is self-generated. It also fixes a live bug, so it earns its place regardless of what P1 does.

## Global Constraints

- **The benchmark corpus is never fed by weakness or correction data.** `docs/trainer.md` states the rule and `packages/trainer/test/trainer.test.ts:114-128` enforces it. Correction data may reach drill pools only.
- **Trainer storage hygiene matches keylab's**, per the comment at `packages/trainer/src/store.ts:8-16`: 0700 directory, `CACHEDIR.TAG`, backup exclusion. Do not create a second, laxer standard.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

`pnpm trainer` tests pass, a practice session with deliberate typos records corrections attributed to the right words, and the `Composed` counter no longer moves when you press Backspace.

---

## Task 1 — fix the capture bugs

Two defects in `packages/trainer/public/app.js`, both currently silent.

**Bug 1 — Backspace is dropped.** `app.js:138` reads `if (!session || event.key.length !== 1) return;`. `event.key` for Backspace is `"Backspace"`, length 9, so the keydown handler returns and `pendingCode` is never set.

**Bug 2 — deletions are recorded as composed characters.** The `input` handler (`app.js:142-165`) does not distinguish insertion from deletion. On a deletion `typed.length` shrinks, `index = typed.length - 1` points at a character that was already recorded, and a *second* keystroke row is written for it with `pendingCode === null`, so it falls back to `COMPOSED_CODE` (`app.js:153`). Every correction therefore inflates `unattributedCharacters` — the IBus-composition metric that `renderScore` reports as a measurement (`app.js:59-66`). The metric is currently wrong in exactly the sessions where the user made mistakes.

- [x] Track `session.lastLength` alongside `session.text`.
- [x] In the `keydown` handler, capture `event.key === "Backspace"` into `session.pendingDelete = true` before the length check.
- [x] In the `input` handler, branch on `typed.length < session.lastLength` first: record a **correction**, not a keystroke, and return without touching the keystroke array.
- [x] Update `session.lastLength` on every `input` event, in both branches.

**Requirements**
- A deletion must never append to `session.keystrokes`. That array feeds `scoring.ts`, whose accuracy and WPM denominators are `keystrokes.length` (`packages/trainer/src/scoring.ts:28-37`).
- Multi-character deletions (a held Backspace autorepeat, or Ctrl+Backspace deleting a word) shrink `typed` by more than one. Record the run length as `session.lastLength - typed.length`, not `1`.
- `renderPrompt` and `wrongIndices` behaviour must not regress: indices at or beyond the new `typed.length` are no longer "wrong", they are pending again.

**Tests** (`packages/trainer/test/`)
- [x] `a_deletion_does_not_count_as_a_composed_character` — the regression test for bug 2; assert `unattributedCharacters` is unchanged across a delete
- [x] `a_deletion_does_not_change_the_keystroke_count`
- [x] `a_multi_character_deletion_records_its_run_length`

## Task 2 — correction storage

In `packages/trainer/src/store.ts`.

- [x] Add to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS correction (
  session_id    INTEGER NOT NULL REFERENCES session(id),
  seq           INTEGER NOT NULL,
  ts_ms         INTEGER NOT NULL,
  char_index    INTEGER NOT NULL,
  run_length    INTEGER NOT NULL,
  expected_code TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
```

- [x] Add `CorrectionRecord` and `recordCorrections(sessionId, corrections)`, mirroring `recordKeystrokes` (`store.ts:144-156`).
- [x] Bump `SUPPORTED_TRAINER_SCHEMA_VERSION` (`store.ts:6`) to 2 and add the migration.

**Requirements**
- A separate table, not a `kind` column on `keystroke`. Adding backspace rows to `keystroke` would silently change the WPM and accuracy denominators for every historical comparison.
- `char_index` is the index in the session text of the **first character removed**, so attribution is to the character that was wrong, not the cursor position after deletion.
- `seq` is independent of `keystroke.seq` — corrections have their own sequence within a session.

**Tests**
- [x] `records_and_reads_back_corrections`
- [x] `migrates_a_v1_trainer_database`

## Task 3 — server endpoint

In `packages/trainer/src/server.ts`.

- [x] Accept a `corrections` array in the session-finish payload, validated the same way keystrokes are at `server.ts:85-88`.
- [x] Persist via `recordCorrections`.
- [x] Extend the session read query (`server.ts:310-316`) with a corrections read.

**Requirements**
- Validate defensively and reject malformed entries rather than coercing them, matching the existing style.

**Tests**
- [x] `rejects_a_malformed_correction_payload`
- [x] `a_finished_session_returns_its_corrections`

## Task 4 — word-level attribution

New module `packages/trainer/src/corrections.ts`.

- [x] `attributeCorrections(text, corrections, keystrokes)` returning per-word and per-transition aggregates:
  - word, occurrence count, correction count, correction rate
  - character offset within the word, so "always the third letter" is visible
  - the preceding character transition (the digraph before the deleted character)
  - the fumble/edit split, using the same latency thresholds as Tier C so the two instruments agree: `<150`, `150-400`, `400-1000`, `>1000` ms since the previous keystroke
- [x] Add a `pnpm trainer corrections` CLI subcommand alongside `weakness` and `history`.

**Requirements**
- The latency thresholds are shared with keylab's Tier C, and Rust and TypeScript cannot share a constant. Define them once here as a named export, and pin both sides: a comment on `latency_bucket` in `crates/keylab/src/encode.rs` naming this file, and a test on each side asserting the four boundaries. If the two ever disagree, the fumble/edit split means different things in the two instruments and every cross-instrument comparison is silently wrong.
- Words are the units the corpus generated. Split on whitespace against `session.text`; do not re-tokenise heuristically.
- A correction whose `char_index` falls on a space belongs to the word that just ended.

**Tests**
- [x] `attributes_a_correction_to_the_word_being_typed`
- [x] `attributes_a_correction_at_a_word_boundary_to_the_preceding_word`
- [x] `separates_fumbles_from_edits_by_latency`
- [x] `reports_the_character_offset_within_the_word`
- [x] `a_session_with_no_corrections_produces_empty_aggregates_not_a_crash`

## Task 5 — UI and documentation

- [x] Show a corrections count and the top corrected words in the session summary in `public/app.js` and `public/index.html`.
- [x] `docs/trainer.md`: document correction capture, the `corrections` subcommand, and the storage schema change. Note the two fixed bugs in the storage/hygiene section, since historical `Composed` counts in existing databases are inflated and are not retroactively correctable.

**Requirements**
- State plainly that pre-fix sessions have inflated `unattributedCharacters`. Silently changing the metric's meaning between sessions would corrupt the trend the metric exists to show.
