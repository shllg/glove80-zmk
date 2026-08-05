# trainer

The trainer is a local practice tool that sits beside keylab. keylab measures what your hands do all day; the trainer measures whether you type the *right* thing, on text it generated and therefore knows the ground truth for.

```bash
pnpm trainer serve                 # http://127.0.0.1:4124
pnpm trainer benchmark --corpus de-common --seed 7
pnpm trainer drill --family mechanic
pnpm trainer weakness
pnpm trainer history
pnpm trainer corpora
```

## Two instruments, not one

During any drill both instruments run, and they measure different things:

| | keylab | trainer |
|---|---|---|
| sees | raw evdev, pre-IBus | what the application receives |
| truth about | physical effort | correctness |
| a German `ä` | **8 keystrokes** (`Ctrl+Shift+U`, four hex digits, Space — `config/macros.dtsi:87`) | 1 character |

The trainer alone would report "typed ä, one keystroke" while the hand did eight. keylab is the only path that sees the real cost, and that cost *is* the German-versus-English finding.

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

- **position** — words weighted toward the positions the weakness model ranks worst. Still real words: drilling letter salad trains a motion you never actually make.
- **bigram / transition** — the slowest transitions your own history recorded, or, before any history exists, the same-finger bigrams this keymap admits.
- **mechanic** — hold/tap discrimination, layer-hold accuracy, thumb clusters, `LONELY_MOD` misfire rate. **This is the family nothing else can do.** The measured `R_GUI` hold — median ~750 ms, p95 ≥ 1000 ms, against 160–240 ms for every other modifier — is not a typing-accuracy problem, and no word-list drill will ever surface it. These are the mechanics of *this* firmware.
- **language** — umlaut macro sequences, German compounds, and code identifiers, which are a third language with their own shape.

## Weakness model

Three sources, three genuinely different weaknesses:

| source | measures | sharpness |
|---|---|---|
| trainer history | per-position error rate, substitutions, digraph latency | ground truth, best |
| keylab Tier B | position frequency | frequency is not weakness; only useful combined |
| keylab Tier A | finger imbalance, hold outliers, correction runs, mod misfires | real-use friction |

Day one there is no trainer history, so the model bootstraps off keylab and switches to trainer-derived scoring once enough attempts accumulate. `confidence` reports which regime produced a given entry, so a drill built on frequency alone is never mistaken for one built on error data. The trainer reads keylab **read-only**; the two instruments cannot corrupt each other.

## Own material

Generic word lists drill generic text. `packages/trainer/src/ownMaterial.ts` builds pools from this repository instead: commit subjects, multi-word code identifiers, and prose extracted from both. It reads the repository only — never user documents — and nothing leaves the machine.

## Storage and hygiene

The trainer database is `~/.local/share/glove80-lab/trainer.db`, separate from keylab's.

```sql
session(id, started_ts, ended_ts, mode, language, corpus_id, corpus_version, seed, device_label, keylab_profile)
keystroke(session_id, seq, ts_ms, code, expected_code, correct)
```

Only `mode = benchmark` rows are plotted as a trend. A 60-second test is roughly 400 rows; 1000 sessions roughly 400k. Negligible.

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
