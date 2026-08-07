# Training in Glove80 Lab

Training is part of the unified local Lab application. keylab measures what your hands do all day; the trainer domain measures whether you type the *right* thing, on text it generated and therefore knows the ground truth for.

```bash
bin/lab                            # prints http://127.0.0.1:4123; does not open it
```

Use **Train** for benchmarks and every drill family, **History** for completed results and correction attribution, and **Overview** for current weakness priorities. Diagnostic text commands remain available for scripts and investigation, but are not the daily interface:

```bash
pnpm trainer benchmark --corpus de-common --seed 7
pnpm trainer drill --family mechanic
pnpm trainer weakness
pnpm trainer history
pnpm trainer corrections            # per-word correction attribution
pnpm trainer corpora
```

## One application, two instruments

Lab coordinates two measurement instruments without merging their stores. The capture daemon remains a separate Rust application that writes privacy-reduced telemetry; the foreground Lab process serves the UI and stores completed practice results.

| | keylab | trainer |
|---|---|---|
| sees | raw evdev, pre-IBus | what the application receives |
| truth about | physical effort | correctness |
| a German `ä` | **8 keystrokes** (`Ctrl+Shift+U`, four hex digits, Space — `config/macros.dtsi:87`) | 1 character |

The trainer alone would report "typed ä, one keystroke" while the hand did eight. keylab is the only path that sees the real cost, and that cost *is* the German-versus-English finding.

Lab temporarily maps English, German, and code practice to `training-en`, `training-de`, and `training-code`. It writes a 60-second daemon-owned profile lease, waits for the daemon snapshot to confirm it, renews every ten seconds, and restores the previous profile on completion or cancellation. The daemon restores an expired lease after browser loss, Lab failure, or its own restart. An explicit external profile change wins immediately and ends the active training session without saving, so History can never claim that mixed-profile input was captured under the original training profile. Lab never resumes a paused daemon automatically. If keylab is unavailable, non-mechanic practice can run trainer-only with a visible warning; mechanic drills require live telemetry.

Train remembers mode, family, language, and length in both the URL and tab-local `sessionStorage`. History does the same for mode and language filters. The mechanic option is disabled while capture is stopped, stale, or paused, matching the server-side requirement rather than failing only after Start.

### The IBus question, answered continuously

An input method may deliver a composed character with no `keydown` behind it, in which case a browser cannot attribute that character to a physical key at all. Rather than settle this once with a manual probe, the trainer measures it on **every** session: a character that arrives without a preceding `keydown` is recorded with code `Composed` and an expected code of `null`, counted in the session result, and called out in the UI.

That is honest in both directions. If composition swallows the keys, the trainer still scores correctness correctly and keylab supplies effort. If it does not, the physical attribution is there and the `Composed` count stays at zero. The design survives either outcome, and you can read which one you are in.

## Benchmark

Running an existing tool remains a valid answer. The original complaint — "monkeytype produces a false statistic" — is solved by the profile tag, not by replacing monkeytype: with `training-en` active a monkeytype session no longer pollutes anything, and monkeytype's own history is a perfectly good WPM trend.

The built-in benchmark exists for the cases that need a frozen corpus and an exportable keystroke log. Against **memorisation** — the real threat, not sampling noise — it uses:

- a fixed pool with a version tag (`2026-08-05.1`),
- a random seed per run, so the text differs every time,
- a fixed word count, so every run shares a denominator and per-position error rates stay comparable,
- a rolling median over the last 5 runs rather than a raw last-run figure.

**The benchmark corpus is never fed by the weakness model.** The moment weakness data reaches it, the trend line stops meaning anything: you would be measuring improvement against a target moving toward your weaknesses. Drill pools are a separate, disjoint vocabulary, and a test enforces that no drill can ever emit a benchmark word.

The German pool is umlaut-dense on purpose. It will show a brutal WPM against English because of the eight-keystroke macro. That is the finding, not a bug — the two trend lines are only ever compared against their own history, which is why `rollingMedianWpm` is keyed by language.

## Drills

Four families:

- **position** — words weighted toward the positions the weakness model ranks worst, which once keylab has correction data means the keys you actually delete, per press rather than in total. Still real words: drilling letter salad trains a motion you never actually make.
- **bigram / transition** — the transitions your corrections landed after, the slowest transitions your own history recorded, or, before either exists, the same-finger bigrams this keymap admits. A degraded Tier C row names two fingers and no keys, so what it contributes is whatever pairs this keymap puts on those fingers.
- **mechanic** — hold/tap discrimination, layer-hold accuracy, thumb clusters, `LONELY_MOD` misfire rate. **This is the family nothing else can do.** The measured `R_GUI` hold — median ~750 ms, p95 ≥ 1000 ms, against 160–240 ms for every other modifier — is not a typing-accuracy problem, and no word-list drill will ever surface it. These are the mechanics of *this* firmware.
- **language** — umlaut macro sequences, German compounds, and code identifiers, which are a third language with their own shape.

Mechanic drills are guided steps and deliberately unscored. Fake zero WPM or accuracy would say nothing about the hold/release mechanic being practised; physical improvement remains visible in keylab telemetry.

## Corrections

Every backspace is recorded and attributed to the **word** being typed, the **character offset inside that word**, and the **digraph before the deleted character**. This is the thing keylab's Tier C cannot do: Tier C sees key positions and never knows which word was intended, because it never sees the text. The trainer generated the text, so it does.

```bash
pnpm trainer corrections --session 12
```

```
session 12  drill  en  en-drill
  3 corrections, 4 characters removed  (fumble 2, ambiguous 0, edit 1)
    cat                     2 in   1  offsets 1×1 2×1
    mat                     1 in   1  offsets 0×1
    transitions   ␣c 1  ca 1  e␣ 1
```

The fumble/edit split uses **the same latency thresholds as keylab's Tier C** — `<150`, `150–400`, `400–1000`, `>1000` ms since the previous keystroke. Rust and TypeScript cannot share a constant, so `LATENCY_BUCKET_BOUNDARIES_MS` in `packages/trainer/src/corrections.ts` and `latency_bucket` in `crates/keylab/src/encode.rs` each carry a comment naming the other, and each side carries a test asserting all four boundaries. If they ever drift, "fumble" means two different things in the two instruments and every cross-instrument comparison is silently wrong.

A correction whose character is a space belongs to the word that just ended — the space was typed as part of finishing that word, and blaming the word about to start would attribute a mistake to text the hand had not reached. Corrections past the end of the prompt are counted under `unattributed` rather than dropped, so the word table's total can be checked against the correction count instead of quietly disagreeing with it.

**Corrections are never keystrokes.** They live in their own table and are reported beside the score, never inside it: a backspace row in `keystroke` would move the WPM and accuracy denominators every past run was measured against.

## Weakness model

Four sources, four genuinely different weaknesses:

| source | measures | sharpness | confidence label |
|---|---|---|---|
| trainer history | per-position error rate, substitutions, digraph latency | ground truth, best | `trainer` |
| keylab Tier C | which key you corrected in real work, and how quickly | real-use *error*, but no ground truth about intent | `keylab-tier-c` |
| keylab Tier B | position frequency | frequency is not weakness; only useful combined | `bootstrap` |
| keylab Tier A | finger imbalance, hold outliers, correction runs, mod misfires | real-use friction | `bootstrap` |
| generated keymap | same-finger transitions and neutral drill pools | fallback only | `keymap` |

Day one there is no trainer history, so the model bootstraps off keylab and switches to trainer-derived scoring once enough attempts accumulate. If keylab is unavailable it can still use sufficient completed trainer evidence, then keymap-derived same-finger transitions and neutral drill pools. `confidence` reports which regime produced a given entry, so a drill built on fallback data is never mistaken for one built on measured error. Lab reads keylab **read-only**; the two databases cannot corrupt each other.

Tier C is its own source and not a second opinion about frequency. Tier B says a key is pressed often; Tier C says a key is *deleted* often, which is evidence of error that frequency can never be. It is still weaker than trainer history, because keylab never sees the text and so cannot know what the hand meant to type. The scoring says exactly that: frequency alone reaches at most 0.4, Tier C 0.8, and only measured error against generated text reaches 1. Frequency's weight falls as better evidence arrives — otherwise the most-pressed key tops every ranking whatever it measures.

Like Lab's correction layer, Tier C enters as a **rate**, weighted by latency class: fumbles count fully, ambiguous corrections half, and edits over a second not at all, because a deliberate rewrite is not a mistyped key. A key needs 50 presses in range before it is rated at all; below that its `correctionRate` is `null` rather than a number built from four presses. Degraded finger rows are used for transition weakness and are **never** attributed to a position — they identify a motion and no key.

**None of this reaches the benchmark corpus.** Correction data steers which drill words are picked; it never widens where they come from, and a corrected trigram that happens to appear in a benchmark word cannot pull that word into a drill pool. The pools stay disjoint, and the test at `packages/trainer/test/trainer.test.ts` enforces it — the moment weakness data reaches the benchmark, the trend line stops meaning anything.

## Own material

Generic word lists drill generic text. `packages/trainer/src/ownMaterial.ts` builds pools from this repository instead: commit subjects, multi-word code identifiers, and prose extracted from both. It reads the repository only — never user documents — and nothing leaves the machine.

## Storage and hygiene

The trainer database is `~/.local/share/glove80-lab/trainer.db`, separate from keylab's.

```sql
session(id, started_ts, ended_ts, mode, language, corpus_id, corpus_version, seed, device_label, keylab_profile, text, drill_family)
keystroke(session_id, seq, ts_ms, code, expected_code, correct)
correction(session_id, seq, ts_ms, char_index, run_length, expected_code)
```

Schema version 2 added `correction` and `session.text`; version 3 adds nullable `drill_family`. The store migrates v1/v2 databases in place, preserving practice history. Pre-v3 drills appear with an unspecified family rather than one reverse-engineered from a corpus name. `char_index` is the index of the **first character removed**, so a correction attributes to the character that was wrong rather than to the cursor position left behind, and `run_length` carries the whole run — a held Backspace autorepeat or a Ctrl+Backspace removes several characters in one event. `correction.seq` is independent of `keystroke.seq`.

Starting a prompt creates no database row. The active prompt, keystrokes, and corrections remain in memory until the prompt is complete; a ten-second browser heartbeat keeps that in-memory session alive, and a lost browser is evicted after 60 seconds so it cannot block later practice. Completion validates and scores first, then inserts the session and every child row in one SQLite transaction. A failed completion remains retryable, a transaction failure leaves no partial row, and cancellation stores nothing. Old incomplete rows are ignored and never deleted automatically.

Paste, drop, browser-reported autofill/replacement, synthetic input, unkeyed non-composition input, and mid-text insertion are rejected in the typing field. Genuine input-method composition remains supported and is visibly counted as unattributed. The rejected inputs do not have a one-to-one physical key event, so accepting them would create a plausible-looking but corrupt WPM/accuracy record.

`session.text` is stored because a correction attributes to a word, and the word is only knowable from the text the corpus produced — a drill's text is not regenerable from `corpus_id` and `seed` alone. It adds no privacy surface: `keystroke` already holds the full ordered record of what was typed. Sessions recorded before v2 have `text = NULL` and cannot be attributed to words at all; `pnpm trainer corrections` says so rather than reporting them as clean.

Only `mode = benchmark` rows are plotted as a trend. A 60-second test is roughly 400 rows; 1000 sessions roughly 400k. Negligible.

### Two capture bugs fixed with correction capture

Both were silent, and both were in the old trainer page before the decision moved into `packages/trainer/src/typing-session.js`, where a test can drive it without a DOM and the unified Lab UI can reuse it:

1. **Backspace never reached `keydown`.** The handler returned on `event.key.length !== 1`, and `"Backspace"` is nine characters long.
2. **Every deletion was recorded as a composed character.** The `input` handler did not distinguish insertion from deletion, so a deletion appended a *second* keystroke row for a character already recorded, with no pending code behind it — which scored as an input-method composition.

**Historical `Composed` counts in existing databases are inflated, in exactly the sessions where mistakes were made, and are not retroactively correctable.** The inflation is roughly one per backspace. A `Composed` figure from before this fix is not comparable to one after it; treat the pre-fix trend as unusable rather than reading a drop as improved input-method behaviour.

**Unlike keylab's aggregates this is a full, ordered keystroke record.** The text is self-generated, so on day one there is no secret in it — but once corpora are built from your own commits and code the log contains your source material, and a "type your own text" mode would make it genuinely sensitive. It therefore gets the same 0700 directory, the same `CACHEDIR.TAG`, and the same backup exclusion as keylab **from the start**. Do not create a second, laxer standard.

Delete it the same way:

```bash
data_dir="$HOME/.local/share/glove80-lab"
[[ ! -e "$data_dir/trainer.db" ]] || shred -u -- "$data_dir/trainer.db"
```

## Known limitations

- **Tier B rarely seals for short drills.** A 60-second test at 80 WPM is roughly 400 keystrokes against keylab's floor of 2000, so a training profile may accumulate for weeks before sealing a window. That is correct behaviour, and the trainer's own store is the instrument for short sessions.
- **Drills are Glove80-only in practice** unless a `devices` rule covers the board you are actually typing on, because position identity is per position space.
- **The corpus pools are small.** They are large enough to defeat rote memorisation over a few dozen runs, not large enough to be a language model. Bump `BENCHMARK_CORPUS_VERSION` whenever a pool changes, or the trend silently compares different measurements.
