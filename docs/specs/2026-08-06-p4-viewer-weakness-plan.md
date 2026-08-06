# P4 — viewer heatmap layer and weakness-model integration

Date: 2026-08-06
Status: planned to step level. Depends on P1 and P3.
Design: `docs/specs/2026-08-06-correction-context-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See corrected-key intensity on the keymap at a glance, and let drills target the keys and transitions you actually correct in real work.

## Global Constraints

- **The benchmark corpus is never fed by the weakness model.** `docs/trainer.md` states it and `packages/trainer/test/trainer.test.ts:114-128` enforces it. Correction data reaches drill pools only. This is the single constraint most likely to be violated by a well-meaning change here.
- **Position identity never pools across position spaces** (`packages/analysis/src/metrics.ts:352`). The viewer draws one keyboard's geometry and must scope its reads to one device.
- **Confidence must stay visible.** `weakness.ts` already reports which regime produced an entry so a frequency-derived drill is never mistaken for an error-derived one (`docs/trainer.md`, weakness model section). A new source needs a new confidence label, not a silent merge into an existing one.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

The viewer shows a correction layer with a fumble/edit toggle; `pnpm trainer weakness` reflects Tier C corrections with a distinct confidence label; the benchmark-disjointness test still passes.

---

## Task 1 — viewer correction layer

In `packages/viewer/src/server.ts` and `geometry.ts`.

- [x] Add a correction-intensity read: the marginal of `ngram.pos_c` — the key immediately before the correction — summed per position across windows in range, scoped to one device.
- [x] Add a layer toggle to the existing heatmap alongside the current press-frequency view.
- [x] Add a fumble/edit filter driven by `latency_bucket`.

**Requirements**
- Intensity is a *rate*, not a raw count: corrections at a position divided by presses at that position from `pos_count`. A raw count would simply redraw the frequency heatmap, since the most-pressed keys are also the most-corrected in absolute terms. This is the difference between "keys I use" and "keys I get wrong", and it is the entire point of the layer.
- Positions with too few presses to be meaningful must be rendered as no-data rather than as a high rate. Pick a floor, state it in the UI, and do not let a 1-of-2 position dominate the scale.
- `-1` (unattributed) and `-2` (absent) have no geometry. Exclude them from the drawing and report their share as a footnote.

**Tests**
- [x] `correction_intensity_is_a_rate_not_a_count`
- [x] `positions_below_the_press_floor_render_as_no_data`
- [x] `refuses_to_draw_across_position_spaces`

## Task 2 — weakness model source

In `packages/trainer/src/weakness.ts`.

- [x] Add Tier C as a fourth source alongside trainer history, keylab Tier B and keylab Tier A.
- [x] Add a distinct confidence label for entries derived from it.
- [x] Weight Tier C between Tier A/B frequency and trainer ground truth: it is real-use evidence of error, which frequency is not, but it lacks the trainer's certainty about intent.

**Requirements**
- Real-use correction data is genuinely different from the three existing sources: Tier B measures frequency, Tier A measures friction, trainer history measures error on generated text. Tier C measures error on real work. Do not fold it into an existing source's score.
- Fumbles and edits must be weighted differently, or edits will drag the model toward keys you rewrite for editorial reasons rather than keys you mistype. Default: weight the `<150` and `150-400` buckets fully, the `400-1000` bucket at reduced weight, and exclude `>1000` entirely. State the choice in the module comment.
- The finger-level degraded rows are usable for transition weakness but carry no position identity. Do not attribute them to positions.

**Tests**
- [x] `tier_c_entries_carry_their_own_confidence_label`
- [x] `edits_are_weighted_below_fumbles`
- [x] `degraded_finger_rows_never_produce_position_entries`
- [x] The existing `benchmark and drill pools are disjoint` test (`packages/trainer/test/trainer.test.ts:125`) must still pass — verify explicitly rather than assuming.

## Task 3 — drill generation

In `packages/trainer/src/drills.ts`.

- [x] Let the `position` family weight toward Tier C corrected keys.
- [x] Let the `bigram`/`transition` family weight toward corrected transitions, from both `ngram` and the degraded `ngram_finger` rows.

**Requirements**
- Drill words stay real words. `docs/trainer.md` is explicit: drilling letter salad trains a motion you never actually make.
- The disjointness rule applies here, not only in the weakness model — a corrected trigram that happens to appear in a benchmark word must not pull that word into a drill pool.

**Tests**
- [x] `position_drills_weight_toward_corrected_keys`
- [x] `transition_drills_weight_toward_corrected_transitions`
- [x] `a_corrected_trigram_never_pulls_a_benchmark_word_into_a_drill`

## Task 4 — documentation

- [x] `docs/keylab.md`: document the viewer's correction layer and its press floor.
- [x] `docs/trainer.md`: add Tier C to the weakness-model source table with its sharpness and confidence label, and restate the benchmark-corpus rule in that context.
