---
name: g80-work
description: Pick up any work source — a plan, a task description, or pasted intent — analyse it against this ZMK keyboard-config generator, agree the implementation mode (how to co-work with Codex and sub-agents), state a Definition of Done, then drive the change to a verified finish, looping until the build and tests pass and a fresh reviewer confirms zero findings. Use when the user says "work this", "/g80-work", "do this", "implement this", or hands over a keymap/layer/RGB/generator change and wants it actually done and building.
---

# Work a glove80-zmk Change to Done

Take a task and drive it to a verified finish in this TypeScript ZMK config generator (turns
`config/layout.json5` into device-tree, keymap-drawer YAML, and diagrams; `pnpm compile` builds
firmware). Lean by design — solo repo, no issue tracker, no PR flow. The bar is: it generates and
builds correctly, the tests pass, and a fresh review found nothing wrong.

## 1. Ingest the source

A plan, a described task, or pasted intent. Read any referenced files (especially
`config/layout.json5`, `src/`, and the relevant generator step). Print a one-paragraph hypothesis
read of what is being asked and which part of the pipeline it touches (layout → dtsi → keymap →
diagram → firmware).

> **ZMK gotchas to keep in mind** (see `CLAUDE.md`): inserting/removing a layer shifts every layer
> index — fix all references; `&trans` does not propagate through layers; per-key RGB and
> `global-quick-tap-ms` rely on darknao's fork. Flag any change that perturbs layer indices.

## 2. Goal / Definition of Done

State a one-line **Definition of Done**, and name the completion gate:

```bash
pnpm test     # ./scripts/verify-build.sh
pnpm build    # tsx src/index.ts — generation succeeds
# and, when firmware output matters: pnpm compile (Docker UF2 build)
```

## 3. Implementation-mode interview — pick once, ask `AskUserQuestion`

Agree how we co-work before building. Session-scoped, never persisted. **Always ask — never skip
this and never silently assume a default.** Ask:

- **Builder mode** — Mode 1 (Claude builds, Codex reviews — recommended) or Mode 2 (Codex builds
  via the Codex MCP, Claude reviews, final fresh Codex confirms).
- **Parallelism** — serial single-writer (recommended) vs fan-out to parallel subagents, one
  writer per file/pass.
- **Autonomy** — how hands-off, and when to surface (always surface before a change that shifts
  layer indices or alters the firmware output).

Codex-call rules: shortest possible prompt; review returns a terse verdict + one line per finding
(`file:line`) from a subagent that returns only the distilled verdict; never override model/effort;
one writer per pass.

## 4. Loop to completion

Build → generate → verify → review until **the Definition of Done is met AND a fresh reviewer
confirms zero findings**. Prefer regenerating outputs over hand-editing generated files. **Guards:**
never treat a missing/errored review as clean; stop and ask on oscillation or ~3 rounds of no
progress; run the build + tests and observe them green before claiming done.

## 5. Endgame / handoff

On terminal clean: summarise what changed in the generator/config, confirm the build + tests, and
note whether a firmware recompile (`pnpm compile`) is needed. Hand off to commit-message
suggestion. **Never auto-commit and never push.**

## Rules

- Prefer editing the generator/config source over hand-editing generated `.dtsi`/`.keymap` output.
- **Always run the §3 mode interview** — never skip it or assume a default.
- One writer per pass; two agents never edit the tree at once.
- Treat any layer-index shift as a change that touches every downstream reference — fix all instances.
- Never auto-commit; the user controls commit timing.

## Cross-references

- `CLAUDE.md` — the ZMK constraints and pipeline overview this skill relies on.
- `tdd` (superpowers) — when the change has real generator logic.
