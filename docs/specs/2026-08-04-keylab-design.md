# keylab — local keystroke telemetry, design and implementation plan

Date: 2026-08-04
Status: approved design, not yet implemented

## Purpose

Measure what the hands actually do during a full working day, in order to answer:

1. **Per-finger and per-row load** — is the right ring/pinky/middle load coming from reach into the outer-upper quadrant, as hypothesised?
2. **Modifier hold burden** — how long and how often are GUI and ALT held, and on which fingers? Prime suspect for extensor-side forearm/elbow pain.
3. **Home row mod misfire rate** — how much throughput is lost to misfires and the corrections that follow.
4. **Daily dose and fatigue drift** — keystrokes and hold-hours per day; does hold duration or misfire rate degrade late in the day.

A typing trainer only ever measures prose sessions. The behaviour under suspicion — modifier holds during shortcuts, reaching for digits in a terminal — happens during work. Global capture is the only instrument that sees it.

Non-goals for v1: corpus building (that comes from files on disk, not from capture), layout comparison, drill generation, firmware codegen.

## Privacy model

The governing rule:

> **Joint distributions require dilution. Marginals do not.**

A per-key count over a 10-second window is the letter multiset of whatever was typed in that window. If that window contains only a password, the multiset is the password. Marginal counts (per-finger, per-row) do not carry that information at usable resolution.

This yields two storage tiers with different sealing rules.

### Tier A — fine, time-sealed

- Sealed every **10 seconds**.
- Contains only **marginals**: per-finger counts, per-row counts, per-hand counts, duration histograms, gap histograms, behavioural counters.
- Never contains key or position identity, and never contains the finger x row joint.
- **Seal floor: 25 keystrokes.** A bucket below the floor is carried into the next bucket rather than written. During active typing 25 keystrokes accumulate in about 3 seconds, so the live view stays live; during idle nothing is written anyway. This removes the isolated-bucket case.

### Tier B — coarse, count-sealed

- Sealed when **>= 2000 keystrokes** have accumulated, regardless of elapsed time.
- Contains **per-position counts** (physical positions 0-79, plus -1 for unattributed).
- Count-based sealing is the point: a 12-character password entered in an otherwise idle hour stays in memory until 2000 further keystrokes arrive, diluting it below 0.5% of an unordered histogram.
- Carries `start_ts` / `end_ts` for temporal analysis.

### In-memory state

Encrypting in-memory counters would be theater: the key would live in the same address space as the data it protects. The real control is that **no keystroke buffer exists to steal**.

Enforced invariant — maximum retained sequence context is **one event**:

```
held:                Map<keycode, down_ts>   // <= ~10, keys physically down right now
last_event_ts:       u64
last_was_alpha:      bool
keys_since_mod_down: Map<mod_class, u32>
bsp_run:             u32
tier_b_accum:        [u32; 81]               // unordered histogram, no ordering retained
counters:            aggregate structs
```

`tier_b_accum` is the only structure holding key identity across time, and it is an unordered histogram of at least 2000 keystrokes at flush.

Memory hardening:

- `mlockall(MCL_CURRENT | MCL_FUTURE)` — never swapped to disk
- `prctl(PR_SET_DUMPABLE, 0)` — no core dumps, no ptrace attach
- systemd `ProtectProc=invisible`, `LimitCORE=0`

Rejected: hashing or HMACing keycodes. The keyspace is about 100 values; any hash is brute-forced instantly. It would add complexity and no protection.

### Process isolation

Run as a systemd **system** service under the user's own account, with input access granted to the service only:

```ini
[Service]
User=sascha
SupplementaryGroups=input
NoNewPrivileges=yes
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/share/glove80-lab
ProtectProc=invisible
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX
MemoryDenyWriteExecute=yes
LockPersonality=yes
LimitCORE=0
SystemCallFilter=@system-service
```

`SupplementaryGroups=input` gives input-device access to this service alone. Adding the user account to the `input` group would instead grant every process running as that user the ability to read all keystrokes — a permanent, far larger exposure. This avoids that.

`PrivateNetwork=yes` is enforcement rather than promise: the daemon runs in an empty network namespace and cannot exfiltrate anything.

Because the daemon runs as the user, the database is user-owned and SQLite WAL readers work without any permission workaround. (WAL readers need write access to the `-shm` and `-wal` files; a root-owned database would deny this.)

### Pause

v1: the daemon watches for `~/.local/share/glove80-lab/PAUSED` and stops recording while it exists.

Known limitation, stated plainly: creating that file during a password prompt is impractical. The keyboard-bound pause toggle with LED indication is v2, alongside firmware layer signalling.

## Architecture

```
crates/keylab/      Rust daemon. evdev -> aggregates -> SQLite.
packages/keymap/    existing generator, extended to emit out/keymap-meta.json
packages/analysis/  derived metrics, SQL queries, reports
packages/viewer/    Bun + SSE, heatmap on real Glove80 geometry
```

Data flow:

```
evdev --> bounded in-memory state --> 1s:    live_snapshot (REPLACE)
                                  |-> 10s:   Tier A rows   (append, >=25 keystrokes)
                                  |-> 2000k: Tier B rows   (append)
                                                  |
                                    packages/analysis --> packages/viewer
                                                  ^
                                    out/keymap-meta.json
```

### keymap-meta.json

The interface between firmware config and everything downstream. Emitted by `packages/keymap` during `pnpm build`, so it cannot drift from the actual keymap.

```json
{
  "keymapHash": "sha256:...",
  "gitCommit": "6f692cf",
  "positions": [
    { "pos": 53, "hand": "R", "row": 4, "col": 5, "finger": "R_pinky",
      "baseKeycode": "KEY_SEMICOLON", "baseBinding": "&hmr RGUI SEMI",
      "isHrm": true, "modClass": "R_GUI", "reachCost": 1.0 }
  ]
}
```

Column-to-finger mapping is derived from the existing physical map in `config/glove80.keymap`. `POS_LH_C1R2 = 15` and `POS_RH_C1R2 = 16` establish that C1 is the **inner** column on both hands, giving:

| Col | Finger |
|-----|--------|
| C1 | index (inner stretch) |
| C2 | index |
| C3 | middle |
| C4 | ring |
| C5 | pinky |
| C6 | pinky (outer stretch) |

Verified against the base layer: right home row `H J K L ; '` resolves to inner / index / middle / ring / pinky / outer. Note that `layout.json5` rows are stored in physical left-to-right order per hand, so left-hand arrays run C6..C1 and right-hand arrays run C1..C6.

### Design property: interpretation lives downstream where possible

The daemon resolves keycode to physical position, and from position to finger and row, using `keymap-meta.json` — it must, in order to write marginals rather than key identity. It does **not** compute reach costs, effort models, or any derived ergonomic metric. Those live in `packages/analysis`.

Consequence: the finger model and reach weights can be revised at any time and re-applied to all historical data. Only the keycode-to-position mapping is baked in at capture time, and that changes only when the keymap changes — at which point `keymapHash` marks the boundary and old data stays interpretable under its own mapping.

## Schema

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- schema_version, daemon_version, keymap_hash, git_commit, created_at

CREATE TABLE device (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  uniq      TEXT,
  first_ts  INTEGER NOT NULL
);

-- ---------- Tier A: marginals, 10s, >=25 keystrokes ----------

CREATE TABLE bucket (
  id          INTEGER PRIMARY KEY,   -- unix seconds, bucket start
  device_id   INTEGER NOT NULL REFERENCES device(id),
  span_ms     INTEGER NOT NULL,      -- >10000 when short buckets were carried
  active_ms   INTEGER NOT NULL,
  keystrokes  INTEGER NOT NULL,
  autorepeats INTEGER NOT NULL       -- EV_KEY value 2, counted but excluded from keystrokes
);

CREATE TABLE finger_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  finger_id INTEGER NOT NULL,        -- 0-9, hand+finger
  presses   INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, finger_id)
) WITHOUT ROWID;

CREATE TABLE row_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  hand      INTEGER NOT NULL,        -- 0=L 1=R
  row_idx   INTEGER NOT NULL,        -- 1-6 (named row_idx: ROW is a SQLite keyword)
  presses   INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, hand, row_idx)
) WITHOUT ROWID;

CREATE TABLE hold_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  finger_id  INTEGER NOT NULL,
  dur_bucket INTEGER NOT NULL,       -- 25ms steps to 500, then 500-1000, then 1000+
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, finger_id, dur_bucket)
) WITHOUT ROWID;

CREATE TABLE mod_hold_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  mod_class  INTEGER NOT NULL,       -- hand x {CTRL,ALT,GUI,SHIFT}
  dur_bucket INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, mod_class, dur_bucket)
) WITHOUT ROWID;

CREATE TABLE gap_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  hand       INTEGER NOT NULL,
  gap_bucket INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, hand, gap_bucket)
) WITHOUT ROWID;

CREATE TABLE event_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  kind      INTEGER NOT NULL,        -- see below
  subject   INTEGER NOT NULL,        -- mod_class, or run-length bucket
  n         INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, kind, subject)
) WITHOUT ROWID;

-- ---------- Tier B: positional, count-sealed at >=2000 ----------

CREATE TABLE key_window (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  keystrokes  INTEGER NOT NULL
);

CREATE TABLE pos_count (
  window_id INTEGER NOT NULL REFERENCES key_window(id),
  pos       INTEGER NOT NULL,        -- 0-79, or -1 unattributed
  presses   INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos)
) WITHOUT ROWID;

-- ---------- live ----------

CREATE TABLE live_snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL,
  json       TEXT NOT NULL           -- finger marginals + rates only, no positions
);
```

`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`

Nothing in this schema is a sequence. There are no bigrams, no ordering, and no sub-bucket timestamps.

### Integer encodings

Fixed at schema version 1. Changing any of them requires a schema version bump.

```
hand:      0 = left, 1 = right

finger_id: hand * 5 + finger
           finger: 0 = index, 1 = middle, 2 = ring, 3 = pinky, 4 = thumb
           (C1 and C2 both map to index; C5 and C6 both map to pinky)

mod_class: hand * 4 + mod
           mod: 0 = CTRL, 1 = ALT, 2 = GUI, 3 = SHIFT

kind:      0 = LONELY_MOD
           1 = MOD_DURING_ALPHA
           2 = BSP_BURST_AFTER_MOD
           3 = BSP_BURST

dur_bucket:  0..19 = 25ms steps covering 0-500ms
             20    = 500-1000ms
             21    = 1000ms and above

gap_bucket:  same scheme as dur_bucket
```

## Behavioural counters

Three content-free signals that triangulate home row mod misfires:

| `kind` | Definition | Reads as |
|---|---|---|
| `LONELY_MOD` | modifier down then up with **zero other keydowns in between** | strongest misfire signal — the hold fired, a letter went missing |
| `MOD_DURING_ALPHA` | modifier down while the previous alpha keystroke was < 250 ms ago | suspicious hold during a typing run |
| `BSP_BURST_AFTER_MOD` | backspace run starting within 500 ms of a modifier release | the correction that follows a misfire |
| `BSP_BURST` | backspace run length, bucketed | total correction tax |

`subject` carries `mod_class` (hand x modifier) or the run-length bucket. Modifier identity is retained because modifiers are not password content in any useful sense, and modifier identity is precisely what the pain analysis needs.

`LONELY_MOD` is the highest-value metric here: on a board with home row mods, a modifier pressed and released with nothing in between is nearly always a misfire, and it reduces to a single integer.

## Known limitations

### LALT is hand-ambiguous

`config/layout.json5` has `&hml LALT S` (left ring) and `&hmr LALT L` (right ring). Both emit `KEY_LEFTALT`. evdev cannot distinguish them, so **right-hand ALT load — one of the two prime pain suspects — is unmeasurable as currently configured**.

`LCTRL`/`RCTRL` (F / J) and `LGUI`/`RGUI` (A / SEMI) are already distinct. ALT is the only collision.

Options:
1. Change the right binding to `RALT`. One word. Risk: `RALT` is AltGr and some applications treat it differently.
2. Accept the ambiguity in v1 and report ALT as hand-unattributed.
3. Wait for firmware layer signalling (v2), which resolves it fully.

**Decision pending — user's call.** The plan below implements option 2 and leaves option 1 as a one-line config change that can be made at any time.

### Layer-shifted keys are unattributed in v1

`9` typed from base row 2 and `9` produced from a layer emit the same keycode. v1 attributes to the base-layer position where one exists and records everything else as position `-1`. The unattributed share is reported so the size of the blind spot is always visible.

Adequate for v1 because the reach and modifier questions are base-layer phenomena. Firmware layer signalling (v2) removes this limitation.

### Home row mod tap durations are not measurable host-side

ZMK's hold-tap emits press and release back-to-back on tap resolution, so a tapped home row mod appears with a hold duration near 0 ms regardless of the true physical hold. Only plain `&kp` keys yield true durations.

Modifier **hold** durations are measurable — the mod press is emitted at resolution and released at physical release — so the primary pain metric is unaffected. Tap-duration calibration requires the no-HRM layer (v2).

### Sample sizes

Faster flush intervals make the tool feel alive; they do not accelerate inference.

| Question | Needs | Wall time |
|---|---|---|
| per-finger load share | ~5k keystrokes | ~1 hour |
| mod hold distribution per finger | ~200 holds per finger | 1-3 days |
| misfire rate (target < 0.5%) | ~20k keystrokes | 2-4 days |
| fatigue drift, morning vs evening | paired days | 2+ weeks |

The live view is for verification and motivation. Its real value is catching a mis-mapped keycode on day one instead of discovering on day five that a week of data is garbage.

---

# Implementation plan

## Phase 0 — workspace scaffolding

Constraint: `src/generateDtsi.ts` resolves `config/` via `process.cwd()`. All package scripts must continue to run from the repository root.

- [ ] Add `pnpm-workspace.yaml` with `packages/*`
- [ ] Move `src/` to `packages/keymap/src/`, add `packages/keymap/package.json`
- [ ] Keep root `pnpm build` delegating to the keymap package **with cwd unchanged at root**
- [ ] Verify `pnpm build` produces byte-identical `out/keymap.dtsi` to the pre-move output
- [ ] Create empty `packages/analysis/` and `packages/viewer/` with package.json
- [ ] Create `crates/keylab/` with `Cargo.toml` (edition 2021, `evdev`, `rusqlite` with `bundled`, `libc`, `serde`, `serde_json`, `anyhow`, `tracing`)
- [ ] Add `crates/` and Rust build artifacts to `.gitignore` as appropriate
- [ ] Leave `archive/`, `glove80_export/`, `Makefile`, `Rakefile` untouched (deliberate — cleanup deferred)

**Acceptance:** `pnpm build` and `make build` behave exactly as before the move.

## Phase 1 — keymap-meta emission

- [ ] Add `packages/keymap/src/keymapMeta.ts`
- [ ] Build the column-to-finger table (C1 index-inner, C2 index, C3 middle, C4 ring, C5 pinky, C6 pinky-outer)
- [ ] Parse base-layer bindings, extracting the tap keycode from `&kp X`, `&hml MOD X`, `&hmr MOD X`, `&lt L X`, `&thumb_* L X`
- [ ] Map ZMK keycode names to Linux `KEY_*` codes (table; fail loudly on unknown names rather than silently dropping)
- [ ] Emit `out/keymap-meta.json` including `keymapHash` (sha256 of the resolved mapping) and `gitCommit`
- [ ] Wire emission into `packages/keymap/src/index.ts`
- [ ] Test: all 80 positions present, each resolves to exactly one finger
- [ ] Test: every base-layer alpha maps to a distinct Linux keycode
- [ ] Test: `isHrm` and `modClass` correct for the six home row mod positions

**Acceptance:** `out/keymap-meta.json` regenerates on every build and round-trips through a schema check.

## Phase 2 — daemon core

- [ ] `main.rs`: config load, device discovery, event loop, signal handling
- [ ] Config file `~/.config/glove80-lab/keylab.toml`: device name match, db path, bucket seconds, tier A seal floor, tier B seal count, keymap-meta path
- [ ] Device discovery: enumerate `/dev/input/event*`, match by device name, poll every 2 s for reappearance (the Glove80 is Bluetooth and its node disappears on sleep)
- [ ] Register each matched device in the `device` table, tag all rows with `device_id`
- [ ] `EVIOCSCLOCKID` to `CLOCK_MONOTONIC` so NTP steps cannot corrupt hold durations; wall clock used only for bucket ids
- [ ] Apply `mlockall(MCL_CURRENT | MCL_FUTURE)`
- [ ] Apply `prctl(PR_SET_DUMPABLE, 0)`
- [ ] Load `keymap-meta.json`, build keycode-to-position lookup, store `keymapHash` in `meta`
- [ ] Implement the bounded state struct exactly as specified; **no growable sequence buffer anywhere**
- [ ] Implement `PAUSED` file watch (check on each bucket tick)
- [ ] Ignore `EV_KEY` value 2 (autorepeat) for press counts; count separately as `autorepeat`

**Acceptance:** daemon runs, discovers the Glove80, survives disconnect and reconnect, writes nothing yet.

## Phase 3 — aggregation and storage

- [ ] Duration bucketing helper (25 ms steps to 500, then 500-1000, then 1000+)
- [ ] Gap bucketing helper
- [ ] Tier A accumulators: finger, row, hand, hold hist, mod hold hist, gap hist
- [ ] Behavioural counters: `LONELY_MOD`, `MOD_DURING_ALPHA`, `BSP_BURST_AFTER_MOD`, `BSP_BURST`
- [ ] Implement the integer encodings exactly as specified in the schema section; add a unit test pinning each one
- [ ] Tier A seal on 10 s tick, **carry forward when below the 25-keystroke floor**, extend `span_ms` accordingly, record `autorepeats`
- [ ] Tier B accumulator `[u32; 81]`, seal at >= 2000 keystrokes, write `key_window` + `pos_count`
- [ ] `live_snapshot` REPLACE every 1 s, finger marginals and rates only
- [ ] Schema creation and migration on startup, `schema_version` in `meta`
- [ ] WAL mode, one transaction per seal
- [ ] Fail closed on any DB error: log and exit, never buffer events awaiting recovery
- [ ] Test: synthetic `(t, code, value)` fixtures drive the state machine with no device present
- [ ] Test: golden cases for each behavioural counter, especially `LONELY_MOD`
- [ ] Test: property — after processing any fixture stream, retained sequence context is at most one event
- [ ] Test: a bucket with fewer than 25 keystrokes is never written
- [ ] Test: a `key_window` is never written below 2000 keystrokes

**Acceptance:** a replayed fixture stream produces the expected rows in all tiers, and the two seal-floor tests pass.

## Phase 4 — packaging and hardening

- [ ] `keylab.service` unit with the full hardening block from the design
- [ ] Install target: binary to `/usr/local/bin`, unit to `/etc/systemd/system`
- [ ] Verify `systemd-analyze security keylab.service` and record the score in the repo
- [ ] Verify the daemon **cannot** open a network socket (assert `PrivateNetwork` is effective)
- [ ] Verify the DB is user-readable and WAL readers work concurrently
- [ ] Verify the user account is **not** in the `input` group and capture still works
- [ ] Document install, pause, and uninstall in `docs/keylab.md`

**Acceptance:** service starts on boot, writes data, and passes all four verification checks.

## Phase 5 — analysis package

- [ ] SQLite reader (`bun:sqlite`), opened read-only
- [ ] Load `keymap-meta.json`, join positions to fingers, rows, reach costs
- [ ] Metric: per-finger load share over an arbitrary time range
- [ ] Metric: per-row load share, and outer-upper quadrant share specifically
- [ ] Metric: modifier hold time per `mod_class` — total, median, p95
- [ ] Metric: misfire rate per 1000 keystrokes, from the three behavioural counters
- [ ] Metric: correction tax — backspaces as a share of total keystrokes
- [ ] Metric: daily dose — keystrokes/day, hold-hours/day
- [ ] Metric: fatigue drift — all of the above bucketed by hour of day
- [ ] Report: unattributed share (position `-1`), always shown alongside any positional metric
- [ ] Test: seeded database, snapshot the aggregation query outputs

**Acceptance:** `pnpm analysis report --since 7d` prints a readable summary with the unattributed share visible.

## Phase 6 — viewer

- [ ] Bun server, `bun:sqlite`, SSE endpoint pushing on each `live_snapshot` update
- [ ] Static page, no framework
- [ ] Per-key heatmap drawn on real Glove80 geometry, reusing `toPhysicalRows()` from `packages/keymap`
- [ ] Per-finger bar chart, split by hand
- [ ] Modifier hold-duration histograms per `mod_class`
- [ ] Time-range selector: live / today / 7d / all
- [ ] Unattributed share shown in the header, not buried
- [ ] Dark and light, following system preference

**Acceptance:** heatmap updates within about a second of typing, and the geometry matches the generated SVG diagram.

## Phase 7 — validation and first data run

- [ ] Run for one hour, confirm per-finger totals are plausible (right ring and pinky should be non-trivial)
- [ ] Cross-check: type a known 200-character passage, confirm counts match expectation
- [ ] Confirm the unattributed share is small enough for the positional metrics to mean anything
- [ ] Confirm `LONELY_MOD` fires by deliberately provoking a misfire
- [ ] Run for one week
- [ ] Produce the first report and review the pain hypotheses against it
- [ ] Decide on the `RALT` change based on whether ALT ambiguity actually obscures the answer

**Acceptance:** a week of data, and a defensible answer to "is the right ring/pinky reach hypothesis supported".

## Effort

| Piece | Size | Time |
|---|---|---|
| Phase 0 workspace | — | 2 h |
| Phase 1 keymap-meta | ~150 lines TS | 2 h |
| Phase 2 daemon core | ~350 lines Rust | 5 h |
| Phase 3 aggregation | ~350 lines Rust | 5 h |
| Phase 4 packaging | — | 2 h |
| Phase 5 analysis | ~300 lines TS | 4 h |
| Phase 6 viewer | ~300 lines TS | 4 h |

About **three days**, with data flowing at the end of Phase 4.

## Deferred to v2

- Firmware layer signalling (unused keycode emitted on layer change) — resolves layer ambiguity and the `LALT` hand collision
- Keyboard-bound pause toggle with LED indication
- No-HRM calibration layer
- Offline hold-tap replay simulator for `tapping-term-ms` / `require-prior-idle-ms` sweeps
- Typing trainer and drill generation
- Corpus building and layout comparison
