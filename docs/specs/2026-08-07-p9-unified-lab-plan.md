# P9 — unified Glove80 Lab suite

Date: 2026-08-07
Status: approved for implementation
Dependency: complete P8 layer attribution and restore its green baseline first.

## Goal

Replace the viewer and trainer web applications with one extensible local application started by
`bin/lab`. The keylab capture daemon remains the independent telemetry writer. Lab reads and
explains its data, exposes safe pause/profile controls, conducts typing sessions, stores completed
trainer results, and visualises already-generated keymap artifacts.

Firmware generation, compilation, flashing, recovery, and source editing remain deliberate
repository/`make` workflows and are not exposed through Lab.

## Definition of done

- `bin/lab` starts one foreground Bun server on `127.0.0.1:4123`, prints the URL, and does not open
  a browser.
- Overview, Insights, Train, History, and Keymap are navigable within one application.
- Lab reports service state, snapshot freshness, capture state, profile, layer, devices, and data
  compatibility without owning the daemon lifecycle.
- All metrics printed by `analysis report` have a UI representation.
- Benchmarks, all drill families, weaknesses, correction history, and trends require no CLI.
- Training uses daemon-enforced expiring profiles and restores the previous profile after finish,
  cancel, browser loss, or Lab failure.
- Active-session keystrokes remain in memory and a completed result is stored atomically.
- `keylab.db` and `trainer.db` remain separate and existing history migrates in place.
- Generated SVG/PDF/metadata are viewable read-only; Lab runs no build or flash commands.
- The old viewer and trainer HTTP servers no longer exist as separate implementations.
- `cargo test -p keylab`, Lab/trainer/analysis tests, typecheck, `pnpm build`, and `pnpm test` pass;
  a fresh reviewer reports zero findings.

## Architecture

### Unified application boundary

- Rename `packages/viewer` to `packages/lab`, retaining geometry, analysis, control, SSE, security,
  and their tests. `@glove80/lab` depends on `@glove80/analysis` and `@glove80/trainer`.
- Keep trainer corpora, drills, scoring, corrections, weakness analysis, history, and SQLite storage
  in `packages/trainer`; move HTTP composition into Lab.
- Move benchmark history out of the trainer server into a trainer domain module.
- Remove `trainer serve` and the root `viewer` server script. Diagnostic non-server CLIs may remain.
- Add `bin/lab` as the canonical executable and `pnpm lab` as an alias. Resolve repository paths
  relative to the executable and close databases/SSE/session state on signals.
- Use modular browser ES modules and the existing no-framework approach. Do not add a frontend
  framework, bundler process, chart dependency, external service, or arbitrary subprocess API.

### Resilient backend

Lab starts even if keylab is stopped, absent, stale, unreadable, or schema-incompatible.

- `GET /api/health`: systemd state, fresh/stale/absent capture state, snapshot age, soft/hard pause,
  profile list/current profile, layer, live rate, and database compatibility.
- `GET /api/devices`: identity, position space, first seen, counts, Tier B windows, and keymap hash.
- `GET /api/summary`: complete `AnalysisMetrics`, preserving range/profile/device/correction filters
  and refusal to pool positional data across position spaces.
- `POST /api/control`: soft pause/resume and configured manual profile selection.
- `GET /events`: existing snapshot-driven SSE semantics and cleanup guarantees.
- `GET /api/keymap`, `/assets/keymap.svg`, and `/assets/keymap.pdf`: generated metadata/artifacts,
  source/output freshness, and daemon-hash comparison; no source writes or command execution.
- `/api/training/*`: corpora, weakness, start, heartbeat, finish, cancel, history, and session detail.

All mutations keep the localhost Host guard, same-origin CSRF check, JSON content-type requirement,
restrictive CSP, and `Cache-Control: no-store`. Telemetry failures disable only dependent views;
history and benchmark functionality remain available.

## Crash-safe training profiles

Extend `control.json` compatibly with an optional lease:

```json
{
  "paused": false,
  "profile": "training-en",
  "updated_at": 1785900000,
  "profile_lease": {
    "id": "<opaque-session-id>",
    "restore_profile": "default",
    "expires_at": 1785900060
  }
}
```

Daemon rules:

- Validate active and restore profiles; echo the lease in `live_snapshot`.
- Suppress idle auto-revert while a lease is valid.
- Restore and clear an expired lease regardless of continued typing, including immediately after a
  daemon restart.
- Pause/resume preserves a lease; explicit profile changes clear it.
- Existing control files remain valid through optional/defaulted fields.

Lab rules:

- Map `de` to `training-de`, `en` to `training-en`, and `code` to `training-code`; add
  `training-code` to repository defaults/example without modifying installed user config.
- Write a 60-second lease and wait at most three seconds for authoritative snapshot confirmation.
- Renew every ten seconds only while the browser session remains active. A renewal may update only
  its own lease ID and must never override an external profile change.
- Clear/restore on completion, cancellation, or page exit; daemon expiry covers crashes.
- If keylab is active but the required profile cannot be confirmed, block captured training.
- If keylab is unavailable, allow benchmark and non-mechanic trainer-only practice with a persistent
  warning and a null keylab profile. Never resume a paused daemon automatically.
- Disable mechanic drills without keylab metrics.

## Trainer persistence and behavior

- Keep active prompt, keystrokes, corrections, and lease state in memory until completion.
- Migrate trainer schema to v3 by adding nullable `drill_family`, preserving v1/v2 history.
- Replace start/record/finish persistence with one `saveCompletedSession` transaction containing
  session, prompt, keystrokes, corrections, and `ended_ts`.
- Do not create a database row on start. Keep old incomplete rows ignored and never delete them
  automatically. Validate/score before the transaction and leave a failed completion retryable.
- Persist the actual confirmed keylab profile and return the persistent session ID after finish.
- Keep corrections outside WPM/accuracy denominators and trends benchmark-only/per-language.
- Permit weakness generation without live keylab: prefer sufficient trainer evidence, then keylab
  Tier C/B/A, then keymap-derived transitions and neutral drill pools. Keep confidence visible and
  benchmark/drill vocabularies disjoint.
- Mechanic drills are guided, unscored steps. Persist completion as a mechanic drill without fake
  WPM/accuracy; physical measurement remains keylab's responsibility.

## User interface

- `/` Overview: health, capture/profile/layer, recent totals, priority weaknesses, recommended drill,
  recent benchmark median, and shortcuts.
- `/insights`: shared range/profile/device filters; press/correction heatmaps; finger, row, layer and
  outer-quadrant load; modifier holds; misfires; correction tax/histograms/Tier C context; daily dose;
  and fatigue drift. Preserve reliability, sample-floor, ambiguity, and no-data explanations.
- `/train`: benchmark/drill/language/family/length controls, rationale/confidence, text capture,
  guided mechanic steps, and persistent lease/capture status. Navigation explicitly cancels active
  sessions.
- `/history`: completed benchmark/drill filters, five-run median trend, and session detail with score,
  prompt metadata, word/offset/transition corrections, and composition count. Pre-v3 drills show an
  unspecified family; raw ordered keys are not the default view.
- `/keymap`: safe zoomable generated SVG, PDF link, timestamps/hash/source commit/layers/current
  layer, and warnings for stale output or daemon hash mismatch. It explains that `make` owns builds.

Filters stay in `sessionStorage`; useful selection state also lives in the URL. An active trainer
session owns navigation until completion or explicit cancellation.

## Compatibility and documentation

- Update README and existing keylab/trainer docs to make `bin/lab` the daily workflow, describe
  leases and atomic completion, and remove the false claim that the old trainer switched profiles.
- State that `bin/lab` prints but does not open its URL.
- Keep daemon installation and every firmware `make` workflow unchanged.
- Never commit or push unless explicitly requested.

## Verification

Tests cover backward-compatible control parsing, lease confirmation/renewal/expiry/restoration,
late-heartbeat refusal, heartbeat and completion-boundary lease-loss termination,
abandoned-browser eviction, concurrent control writers,
stale-snapshot/manual override, idle-revert interaction, snapshot state, all health degradations,
HTTP security, non-object JSON rejection, SSE cleanup, filters/position-space guards, complete
report-field UI parity, keymap freshness and zoom, atomic completion/failure retry, post-commit
cleanup warnings, input provenance and paste/replacement/autofill rejection, trainer-only fallback,
mechanic availability and completion, history/corrections (including legacy incomplete rows),
schema migration, corpus disjointness, direct and Back/Forward navigation, active-session route
ownership, concrete drill recommendations, and persistent Train/History selections.

Run:

```bash
cargo test -p keylab
bun test packages/analysis packages/trainer packages/lab
pnpm typecheck
pnpm build
pnpm test
```

Then smoke-test against live data and obtain a fresh read-only review. Finish only with every gate
green and zero actionable review findings.

## Fixed assumptions

- Single-user, localhost-only, default port 4123, foreground process, URL printed only.
- Separate databases remain; partial sessions are intentionally not persisted.
- Safe pause/profile control is in scope; daemon lifecycle and firmware/keymap mutation are not.
- Existing diagnostic CLIs may remain, but normal daily use requires only `bin/lab`.
