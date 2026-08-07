# P7 — viewer control plane versus view plane

Date: 2026-08-06
Status: implemented. Depends on nothing.
Design: `docs/specs/2026-08-06-field-hardening-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A control that changes what the daemon records never looks like a control that changes what the page shows.

## The defect

The header now carries **Capture as** and **View profile** side by side, identically styled and populated from the same list of names. The first person to see them asked whether they were redundant. They are opposites: one writes `control.json` and changes what is recorded from now on, machine-wide and persistently; the other filters what is already stored, in this tab only.

The same split runs through the rest of the header without being drawn: the chip and **Pause** are the daemon's state, while **Keyboard**, **Time range**, **Layer** and **Correction kind** are the view's. They are interleaved.

Separately, `packages/viewer/public/app.js` has roughly doubled and now holds real logic — the pending-switch state machine, the correction footnote, the rate scale — none of which is reachable from a test. The repository has an established answer to that (`packages/viewer/public/refresh-scheduler.js`, `packages/trainer/public/typing-session.js`): extract the logic to a module with a `.d.ts`, serve it as a static route, import it from both the page and the test.

## Global Constraints

- **The chip stays the daemon's word**, never the selection. That is what makes a rejected switch or an idle auto-revert visible instead of assumed.
- **The view defaults to everything.** No scoping that the interface does not show.
- **Local assets only.** The viewer's CSP is `default-src 'self'; connect-src 'self'` and a test asserts the page's whole module graph is served locally.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

The header reads as two groups; a control that writes to the daemon is visually distinct from one that filters the view; the extracted browser logic is covered by tests that run without a DOM.

---

## Task 1 — regroup the header

In `packages/viewer/public/index.html` and `styles.css`.

- [x] Put the chip, **Pause** and the capture selector in one group; keep the view filters in another, with a divider between them.
- [x] Label the groups so the axis is stated rather than implied — the daemon's state on one side, this page's filters on the other.
- [x] Rename to make the tense explicit: **Recording as** and **Showing**.

**Requirements**
- No behaviour change: same endpoints, same payloads, same persistence keys. This task is markup and CSS.
- The capture control must remain reachable and obvious. Making it quieter is not the goal — making it *different* is.
- Keep the existing element ids, or update `app.js` and the id cross-check together; a silently missing `querySelector` target fails at runtime and in no test.

**Tests**
- [x] `every_element_id_app_js_queries_exists_in_the_page` — mechanical, and the only thing that catches an id drift

## Task 2 — extract the browser logic

In `packages/viewer/public/`.

*Landed as `view-model.js` with `view-model.d.ts`, served at `/view-model.js`. `percentage` moved with it, because the footnote is a caller and a second copy in `app.js` is exactly the drift this extraction exists to prevent; `app.js` imports it back for the two places that still format a share.*

- [x] Move the pending-profile state machine, `liveStatus`, the correction footnote and `rateLevel` into a module with a `.d.ts`, following `refresh-scheduler.js`.
- [x] Serve it from `server.ts` as a static route and import it from both `app.js` and the test.

**Requirements**
- Same pattern as the two modules that already exist, not a new one. `allowJs` is off, so the `.d.ts` is what makes the import type-check.
- The extraction must not change behaviour; do it before any further UI work, not alongside it.

**Tests**
- [x] `a_pending_switch_survives_a_refresh_that_reports_the_old_profile`
- [x] `a_switch_the_daemon_never_confirms_is_reported_after_the_timeout`
- [x] `the_correction_footnote_states_the_floor_the_hidden_count_and_the_sentinel_share`
- [x] `the_rate_scale_is_linear_against_the_worst_rate_on_the_board`

## Task 3 — documentation

- [x] `docs/keylab.md`: state the two axes in one sentence in the profiles section, and that the viewer covers `keylabctl status`, `pause`, `resume` and `profile set` — the hard pause stays a deliberate filesystem action.
