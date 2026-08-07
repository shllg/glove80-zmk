# keylab — field hardening after the first two-keyboard deployment

Date: 2026-08-06
Status: implemented. All three projects (P5, P6, P7) are done.

**Goal:** Keep the instrument trustworthy on a machine with two keyboards, several device rows per keyboard, and a user who switches activity profiles from the browser rather than a terminal.

**Context:** everything here came out of one afternoon of running the daemon and viewer against real hardware rather than fixtures. Four defects were found and fixed the same day (commits `5d956e1`, `fbc0a71`, `06237e8`); three structural weaknesses were found that need real work and are planned below.

## What the field found and what was already fixed

| symptom | root cause | fixed in |
|---|---|---|
| every profile switch from the browser returned 403 | the control POST accepted only `http://127.0.0.1:<port>` as its own origin, while the router had always answered to `localhost` too | `fbc0a71` |
| totals silently omitted everything typed under a non-`default` profile | the viewer passed no profile, and `resolveProfileScope` reads absent as `default` rather than as "pool" | `fbc0a71` |
| an accepted profile switch snapped back and read as a rejection | the viewer re-read `live_snapshot` immediately, inside the daemon's ≤1 s publication lag | `fbc0a71` |
| the daemon restart-looped for 35 minutes, five seconds apart | a matched device whose `EVIOCSCLOCKID` failed was fatal for the whole daemon, and the message named no device, path or errno | `06237e8` |

The common shape of the first three: **a filter or a lag that the interface did not admit to.** None of them produced a wrong-looking number — they produced a plausible one. That is the failure mode this instrument exists to avoid, so each fix makes the scope visible rather than merely correct: the view profile is a control, the pending switch is a status line, the press floor is a footnote.

## The three that remain

### 1. Bucket identity is global, and the collision is silent

`bucket.id` is the seal second and the table's only primary key (`crates/keylab/src/store.rs:33-41`). `current_bucket_id()` returns the wall-clock second (`crates/keylab/src/main.rs:842`). When two devices seal in the same second, `seal_tier_a` finds the row already present and **returns success having written nothing** (`store.rs:269-282`).

That was a defensible trade for one keyboard, and the comment says so. With two keyboards configured it becomes a live data-loss path: each device seals on its own phase, and whenever those phases coincide one device's entire Tier A bucket — keystrokes, per-finger counts, hold and gap histograms — is dropped without a log line, a counter, or any difference in the numbers that would let you notice.

**P5** rebuilds bucket identity so the collision cannot occur.

### 2. Device identity fragments, and nothing can put it back together

`register_device` reuses a row by `(name, uniq)` (`store.rs:211-239`), which is correct. But this database carries eleven rows for one keyboard, minted by an older build, six of them holding data. The viewer now labels them well enough to tell apart, and that is all anyone can do: there is no supported operation that merges them, so the fix is hand-written SQL against a live database.

Hand-written SQL is exactly the wrong tool here. The obvious form of it — `device_id <> 1` — silently folds a second keyboard's `qwerty-ansi` counts into a `glove80` row, which is the one invariant the rest of the codebase refuses everywhere. That mistake was made and caught during this session, by inspection rather than by any guard.

**P6** makes merging a supported, guarded operation, and adds the test seam the device scan has never had.

### 3. The daemon's device scan has no test seam at all

`device.rs` tests are pure functions only. Nothing exercises `for_each_matching`, because making an evdev ioctl fail needs a real device node. The skip-on-failure fix in `06237e8` is therefore verified by inspection and a manual smoke test, which is weaker than everything around it.

**P6** carries this too: a `uinput`-backed integration test behind a feature flag, so the suite stays runnable where `/dev/uinput` is not.

## Plan files

| | project | plan | depends on |
|---|---|---|---|
| **P5** | bucket identity at schema v5 | `2026-08-06-p5-bucket-identity-plan.md` | — |
| **P6** | device identity, merge, and a scan test seam | `2026-08-06-p6-device-identity-plan.md` | P5 for the merge task only |
| **P7** | viewer control plane versus view plane | `2026-08-06-p7-viewer-control-plane-plan.md` | — |

**Recommended order: P5 → P6 → P7.** P5 is losing data right now on a two-keyboard machine, and every day it runs is buckets that cannot be recovered. P6's merge task has to know what bucket identity is before it can repoint rows onto it. P7 is a clarity fix with no data at stake.

## Settled decisions

| Decision | Choice | Reason |
|---|---|---|
| Bucket identity | Surrogate key, `ts` demoted to a column with `UNIQUE (ts, device_id, profile_id)` | Child tables reference `bucket(id)` in six places; a composite key would have to be threaded through all of them, while a surrogate leaves every child table untouched. |
| Existing bucket ids | Kept verbatim as the surrogate id, copied into `ts` | Child rows keep pointing at the same parent, so the migration rewrites one table rather than seven. |
| A genuine duplicate seal | Refuse, log, and count it | Same device, same profile, same second should be impossible; if it happens it is a bug, and a bug that returns `Ok` is how the current one hid. |
| Merging devices | A `keylabctl` subcommand, never documented SQL | The guard belongs where the operation is, not in a paragraph the operator has to remember. |
| Merging across position spaces | Refused outright | `pos` means nothing across geometries; this is the same invariant `assertSinglePositionSpace` enforces on every read. |
| uinput test | Behind a cargo feature, off by default | The suite must stay runnable without `/dev/uinput`; a test that is skipped silently is worse than one that is absent loudly. |
| Capture versus view | Two controls, visually separated | They are opposite ends of the pipeline and were adjacent, identically styled and identically populated. The confusion was reported by the first person to use them. |

## Global constraints, inherited

- **Position identity never pools across position spaces** (`packages/analysis/src/metrics.ts:476`). Every task here touches device rows or bucket rows; none may weaken that guard.
- **No silent caps and no silent drops.** Whatever is discarded is counted and reported. P5 exists because this was violated.
- **Privacy floors are enforced minimums, not defaults.** 25 keystrokes for Tier A, 2000 for Tier B, 500 corrections for Tier C. No migration or merge may resurrect data below a floor or lower one.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or documentation.
