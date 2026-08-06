# keylab — correction context (Tier C) and trainer word-level corrections

Date: 2026-08-06
Status: approved design. Four projects, each planned to step level in its own plan file.

**Goal:** Answer "what was I typing when I had to hit backspace?" — at key, motion, mechanic, and (on known text) word level.

**Architecture:** A new persistent privacy tier in the keylab daemon records the ordered trigram of physical positions preceding each correction, together with the modifier mask, a latency bucket that separates fumbles from edits, and the existing backspace run bucket. Windows seal by correction count; rows below a minimum count degrade to their finger-level projection rather than being written as positions. In parallel, the trainer — which generates its own text and therefore owns ground truth — gains real correction capture and per-word attribution at no privacy cost.

**Tech Stack:** Rust (`rusqlite`, `serde`, `zeroize`, `tracing`, `anyhow`) for the daemon; TypeScript on Bun for `packages/analysis`, `packages/viewer`, `packages/trainer`; SQLite in WAL mode.

## Plan files

| | project | plan | depends on |
|---|---|---|---|
| **P1** | keylab Tier C capture, seal, schema v4, docs | `2026-08-06-p1-keylab-tier-c-plan.md` | — |
| **P2** | analysis report surface | `2026-08-06-p2-analysis-corrections-plan.md` | P1 |
| **P3** | trainer correction capture and word attribution | `2026-08-06-p3-trainer-corrections-plan.md` | — |
| **P4** | viewer heatmap layer and weakness-model integration | `2026-08-06-p4-viewer-weakness-plan.md` | P1, P3 |

**Recommended order: P3 → P1 → P2 → P4.** P3 depends on nothing, touches a different database, carries no privacy cost, and fixes a live bug. P1 is the largest and the one needing the most care.

---

# Design

## Problem

`docs/keylab.md:9` describes "content-free misfire/correction counters". What exists today (`crates/keylab/src/encode.rs:15-18`, `crates/keylab/src/aggregate.rs:344`) is two of them:

- `BSP_BURST` — a histogram of backspace *run length*, bucketed by `run_bucket` (`encode.rs:56`)
- `BSP_BURST_AFTER_MOD` — the run started within 500 ms of a modifier release, bucketed by mod class

Both answer *how much* correcting happens. Neither answers *what was being corrected*, because Tier A carries no keycode identity and nothing in keylab carries event order.

The trainer has the opposite shape: `keystroke(session_id, seq, ts_ms, code, expected_code, correct)` is a full ordered log against text the trainer generated. It could answer the word-level question already — except it discards backspaces entirely (`packages/trainer/public/app.js:138`).

## The privacy decision, and why it went this way

Ordered n-grams over keycodes are a corpus. That is a categorical change, not a quantitative one: Tier A currently holds no keycode identity at all, and `docs/keylab.md:15` states outright that keylab records no bigrams, no words, and no event order. That claim becomes false with this work, and the documentation change is part of the work, not a follow-up.

The alternatives were offered and declined in favour of resolving power:

| | shape | states | answers |
|---|---|---|---|
| L1 corrected-key histogram | unordered position counts, count-sealed | 81 | which keys get deleted |
| L2 finger-transition histogram | finger pair/triple | 100 / 1000 | which motion precedes corrections |
| L3 mechanic taxonomy | SFB, roll, stretch, layer-hold, chord | ~10 | why |
| **L4 ordered position trigram** | **ordered triple + context** | **~512,000** | **what was being typed** |

L4 was chosen. L1, L2 and L3 are not built separately — **all three marginalise out of the L4 row**, which is why this is one table rather than four.

Capture is **on by default with an opt-out**, because a manually-armed capture would systematically miss ordinary work, which is the only thing worth measuring. `ngram_capture = false` in `keylab.toml` disables it; both existing pause channels already stop all counting.

### Residual risks, stated plainly

These belong in `docs/keylab.md` under "What this does not protect against":

1. **Suppression is per-window, not lifetime.** A fragment fumbled three or more times inside one window is written verbatim as an ordered position triple. Across windows it degrades each time, but within one window it can survive.
2. **The trigger is mistake-correlated.** Corrections cluster where typing is hardest, and password entry is exactly that. The capture condition is adversarially aligned with the sensitive case.
3. **Positions are characters.** On a fixed base layer, position 35 *is* `a` (`crates/keylab/src/keymap.rs:221`). Storing positions rather than keycodes is a schema convenience and buys no privacy. The docs must not imply otherwise.
4. **Pause reachability is now load-bearing.** `docs/keylab.md:181` already admits reaching a pause during a password prompt is impractical. That was a tolerable cost for diluted aggregates; for ordered sequences it is the primary residual risk. The firmware-bound pause toggle should be prioritised — it is out of scope here but its priority changes because of this work.

## Settled decisions

| Decision | Choice | Reason |
|---|---|---|
| n | 3 | Enough context to recognise a word stem; two is rarely enough to be actionable. |
| Alphabet | Physical positions, not keycodes | Consistent with Tier B, and the daemon already resolves positions in `key_down`. No privacy difference. |
| Extra dimensions | modifier mask, latency bucket, run bucket | Latency separates a fumble from an edit; without it the table mixes mistyping with ordinary rewriting and the answer is polluted. |
| Window seal | Count-based, 500 corrections | Mirrors Tier B's count-sealed shape. Start/end times only, never per-event timestamps. |
| Rare rows | Degrade to finger-level projection, do not discard | Totals stay exact and the mechanic-level signal survives; only rare identity is dropped. |
| Suppression threshold | count < 3 | Targets the long tail where a repeated fumble lives, rather than the average case. |
| Per-profile accumulators | Yes, mirroring Tier B | A single accumulator surviving a profile switch produces a window whose label is a lie. |
| Position-space scoping | Structural | One `RuntimeDevice` per evdev path, each with its own aggregator and `device_id` (`crates/keylab/src/main.rs:312`, `:508`). Trigrams cannot cross keyboards. |
| Map caps | 4096 position entries, 1024 finger entries per profile | `docs/keylab.md:15` promises bounded in-memory state. An unbounded `HashMap` would break that promise. |
| Cap overflow | Degrade to finger map; if that is full too, count as dropped and report it | No silent caps: what was lost must be visible in the report. |
| Trainer corrections | Separate `correction` table, not rows in `keystroke` | Adding backspaces to `keystroke` would silently change the WPM and accuracy denominators in `packages/trainer/src/scoring.ts:28-37`. |

## Data model

One row per distinct (trigram, mod mask, latency bucket, run bucket) within a window.

```
ngram_window(id, device_id, profile_id, start_ts, end_ts, corrections, degraded, dropped)
ngram(window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket, n)
ngram_finger(window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket, n)
```

Position encoding follows `pos_count`'s existing convention and extends it:

| value | meaning |
|---|---|
| `0..79` | physical position |
| `-1` | unattributed (layer-shifted key, no base-layer position) — same as `pos_count` |
| `-2` | absent (fewer than three keys preceded this correction, e.g. at window start) |

Finger encoding: `0..9` per `finger_id(hand, finger)` (`encode.rs:20`), `-1` absent.

Latency buckets, measured from the last non-backspace keydown to the start of the backspace run:

| bucket | range | reading |
|---|---|---|
| 0 | < 150 ms | fumble |
| 1 | 150–400 ms | fumble |
| 2 | 400–1000 ms | ambiguous |
| 3 | > 1000 ms | edit |

`run_bucket` reuses `encode.rs:56` unchanged.

## Invariants

Every one of these gets a test.

- `sum(ngram.n) + sum(ngram_finger.n) + dropped == ngram_window.corrections`, exactly.
- No row with `n < ngram_min_count` exists in `ngram`.
- `bounded_footprint()` never exceeds `footprint_bound(profile_count)` for any stream length or number of profile switches.
- A partial window is never persisted. Shutdown, disconnect, hard pause, and soft pause all discard it.
- The ring is cleared on `SYN_DROPPED`: after a kernel buffer overflow, event order across the gap is unreliable and a trigram spanning it would be fiction.
- Backspace itself never enters the ring. It is the correction, not the context.
- A positional read spanning two position spaces throws rather than pooling (`packages/analysis/src/metrics.ts:352`).
