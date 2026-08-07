# keylab

`keylab` is a local-only daemon that reads the Glove80's Linux evdev events and stores privacy-reduced ergonomic aggregates in SQLite. It is intended for measuring per-finger load, modifier burden, home-row-mod misfires, correction context, and typing dose without creating a keystroke log or a corpus of ordinary typing. It does record one narrow ordered fragment — the three positions preceding each correction — under its own privacy floor; see *Tier C* below and its residual risks.

## What is recorded

keylab has three persistent privacy tiers plus a replace-only live snapshot:

- **Tier A — fine, time-sealed:** nominal 10-second buckets containing start time, span, active time, total presses, autorepeats, per-finger and per-hand/row marginal counts, duration and gap histograms, modifier hold histograms, and content-free misfire/correction counters. It contains no keycode or physical-position identity and no finger-by-row joint distribution.
- **Tier B — coarse, count-sealed:** an unordered histogram of counts for physical positions 0–79 plus an unattributed position, with the window's start/end times and total press count. It contains position identity, but no ordering or per-press timestamp.
- **Tier C — correction context, count-sealed:** for each backspace *run*, the **ordered trigram** of physical positions that immediately preceded it, together with the held-modifier mask, a latency bucket (fumble vs. edit) and the existing backspace run bucket. Rows are counted per window, never timestamped individually. This is the only place in keylab where event order is recorded, and it is recorded only at a correction.
- **Live snapshot:** replace-only per-finger marginals and typing rate. It contains no positions.

The database also records device identity, schema/daemon versions, the generated keymap hash, and keymap-hash history so aggregate data remains attributable to the configuration that produced it.

keylab does **not** record characters, raw keycodes, a raw event log, word identity, clipboard contents, applications, windows, or focused fields. It never persists individual key timestamps. It **does** record, at each correction, an ordered trigram of physical positions — that is Tier C, and nothing outside Tier C carries event order. Its bounded in-memory state tracks only currently held keys, the immediately previous event context needed for timing/counters, Tier A aggregates, an unordered Tier B histogram, and Tier C's three-slot position ring plus its two capped per-profile count maps.

Tier A is not sealed until at least **25 keystrokes** have accumulated. A shorter bucket is carried into the next time bucket, preventing an isolated short burst such as a password from becoming a fine-grained stored sample. Tier B is not sealed until at least **2000 keystrokes** have accumulated. At the minimum floor, this limits a 12-character password to 0.6% of the unordered positional histogram on a normal workstation, and further typing dilutes it more. Tier C is not sealed until at least **500 corrections** have accumulated, where one correction is one completed backspace run whatever its length. All three values are enforced minimums, not merely configuration defaults.

Tier C additionally applies a **degradation rule** at seal: any trigram seen fewer than **3 times** in the window loses its position identity and is written instead as its finger-level projection — the ordered triple of fingers, with the same modifier, latency and run context. The counts move, they are never dropped: `sum(positions) + sum(fingers) + dropped == corrections` holds exactly for every window, and `dropped` reports what overflowed the bounded in-memory maps and lost even its finger identity. Nothing is silently capped.

Why record correction context at all: the pre-existing counters answer *how much* correcting happens but not *what* was being corrected, so they cannot tell a home-row-mod misfire from an ordinary typo from a deliberate rewrite — which is the whole question a layout experiment needs answered. Capture is on by default because a manually armed capture would systematically miss ordinary work, which is the only thing worth measuring; `ngram_capture = false` turns it off completely, and both pause channels already stop all counting.

Partial buckets and windows are discarded on shutdown, disconnect, or pause. The last few minutes are therefore intentionally lost rather than writing data below any privacy floor.

## Install

The system service is deliberately tied to the local `sascha` account and `/home/sascha`. On this machine, `sascha` remains in the `input` group because evsieve runs under that account and must read and grab input devices. This means every process running as `sascha` can read all input devices. The installer reports this as an informational note; `SupplementaryGroups=input` on the unit keeps keylab's own access explicitly scoped.

Generate current keymap metadata, review the example configuration, run the offline hardening checks, and then run the installer as root yourself:

```bash
pnpm build
bash crates/keylab/verify-hardening.sh
sudo crates/keylab/install.sh
```

The installer builds locked release binaries, installs them as `/usr/local/bin/keylab` and `/usr/local/bin/keylabctl` with mode `0755` and `root:root` ownership, installs the system unit, creates the private data/configuration directories, and installs the example configuration only when no configuration already exists. It never overwrites an existing configuration silently. It reloads systemd but only prints the enable/start commands; run them after reviewing the configuration:

```bash
systemctl enable keylab.service
systemctl start keylab.service
```

Check startup with:

```bash
systemctl status keylab.service
journalctl -u keylab.service
```

The unit uses an empty network namespace, an address-family allow-list, an IP deny policy, an empty capability set, a syscall allow-list, kernel/cgroup protections, and a device-cgroup allow-list limited to the input character-device class. `PrivateDevices=no` is intentional because a private `/dev` would hide evdev. Access instead comes from `SupplementaryGroups=input` and `DeviceAllow=char-input r`.

`ProtectProc=invisible` hides other processes from this service; more precisely, the service's procfs view hides processes owned by other users. It does **not** hide the keylab process from other processes running as `sascha`. That would require `hidepid=` on the host `/proc` mount. Any process running as this user can see that the daemon exists.

## Configure

The configuration is `/home/sascha/.config/glove80-lab/keylab.toml`:

```toml
device_name_contains = "Evsieve Virtual Device"
db_path = "~/.local/share/glove80-lab/keylab.db"
keymap_meta_path = "/home/sascha/src/glove80-zmk/out/keymap-meta.json"
bucket_seconds = 10
tier_a_seal_floor = 25
tier_b_seal_count = 2000
live_snapshot_seconds = 1
profiles = ["default", "training-de", "training-en", "gaming"]
auto_revert_idle_seconds = 900
ngram_capture = true
ngram_seal_count = 500
ngram_min_count = 3
```

`device_name_contains` selects evdev devices by a case-sensitive name fragment. `keymap_meta_path` must point to the metadata emitted by `pnpm build`. The daemon refuses bucket/floor settings below 10 seconds, 25 keystrokes, and 2000 keystrokes, and refuses more than 8 profiles or a list whose first entry is not `default`.

The three `ngram_*` keys control Tier C:

- `ngram_capture` (default `true`) turns correction-context capture on or off. When off, no position ring is maintained and no record is created — not "recorded and discarded".
- `ngram_seal_count` (default and enforced minimum **500**) is how many corrections a window needs before it is written. Below 500 is refused at load.
- `ngram_min_count` (default and enforced minimum **3**) is how many times a trigram must appear in a window to keep its position identity. Below 3 is refused at load.

All three keys are optional: a configuration written before Tier C existed keeps loading and picks up these defaults. Restart the service after configuration changes:

```bash
systemctl restart keylab.service
```

## Input remappers and exclusive grabs

Linux `EVIOCGRAB` gives one reader exclusive access to an input device. While the grab is held, that physical device delivers no events to any other reader, even though another process can still open it successfully.

On this machine, evsieve grabs `MoErgo Glove80 Keyboard` and emits the resulting typing through `Evsieve Virtual Device`, so `device_name_contains` must target `Evsieve Virtual Device`. Matching `Glove80` is correct only when no remapper is in the input path; it would also match `MoErgo Glove80 Mouse` here.

The evsieve command includes `--block key:f23@kb`, so F23 never reaches the virtual device. Consequently, **position 68 will always read zero presses**. This is an input-topology blind spot, not a finger-load finding.

At startup, keylab logs each matched device and event path plus the total match count. For each match, a passive watchdog warns after five unpaused minutes without any `EV_KEY` event and repeats no more than once every 30 minutes. The warning usually means another process holds an exclusive grab and capture points at the wrong device. When it fires, inspect the active remapper topology and set `device_name_contains` to the device that actually emits the remapped events. keylab does not probe with `EVIOCGRAB`, because even a brief probe could swallow a keystroke.

## Activity profiles

Every sealed Tier A bucket, Tier B window and Tier C window carries a `profile_id`. The profile is an *activity* label — practice, gaming, language drilling — and is orthogonal to `device_id`, so "gaming across both keyboards" stays answerable.

```bash
keylabctl profile list        # configured profiles; * marks the active one
keylabctl profile set gaming
keylabctl status
```

Rules that matter:

- **The configured list is a closed set.** `profiles` in `keylab.toml` must start with `default`, hold at most **8** entries, and use only `[a-z0-9-]`. A name outside the list is rejected by both `keylabctl` and the daemon, which keeps its last known-good state rather than guessing.
- **The cap is a privacy invariant, not a preference.** Each profile holds its own 81-slot Tier B histogram plus its own two capped Tier C maps (at most 4096 position rows and 1024 finger rows); `MAX_PROFILES = 8` is what keeps the daemon's in-memory footprint bounded.
- **Tier B and Tier C are preserved across a switch, per profile.** Switching profiles never discards positional or correction progress. It also means a profile you rarely use may take weeks to reach the 2000-keystroke or 500-correction floor and seal a window — correct behaviour, not a fault. A Tier C seal clears only the sealing profile's accumulator.
- **Tier A is sealed or discarded at the boundary.** A bucket that clears both floors (25 keystrokes, 10 seconds) is sealed under the outgoing profile; anything below is discarded. A switch therefore smears at most one bucket.
- **Idle auto-revert.** After `auto_revert_idle_seconds` (default 900) with no keystrokes on any device, the daemon rewrites `control.json` back to `default`, so a forgotten `gaming` profile cannot silently poison a working day. Set it to `0` to disable.
- **Recording and viewing are two different axes.** *Recording as* writes `control.json` and changes what the daemon records from now on, machine-wide and until changed; *Showing* filters what is already stored, in this tab only, and defaults to **all** profiles. The viewer's header draws that split — the two controls sit in separate, differently styled groups labelled with what they do — because side by side and identically styled they read as one redundant pair. Scoping the view to one profile is a filter you can see; a hidden default of `default` would drop everything typed under any other label while the totals still read as the whole picture. `pnpm analysis report` keeps its own default of `--profile default`, because it prints the scope it used at the top of the report.

The viewer's daemon group covers `keylabctl status`, `pause`, `resume` and `profile set`, and nothing else writes from the browser. The hard pause stays a deliberate filesystem action (see *Pause*): it discards every partial aggregate, and a control that costly should not be one click away from a dashboard.

Check the split:

```bash
sqlite3 -readonly "$HOME/.local/share/glove80-lab/keylab.db" \
  "SELECT p.name, SUM(b.keystrokes) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1 ORDER BY 2 DESC;"
```

`pnpm analysis report` reads the `default` profile unless told otherwise; `--profile gaming` selects one and `--profile '*'` pools them all. The report header always names the profile, so a filtered report is never mistaken for a full one.

## Multiple keyboards

`devices` in `keylab.toml` pairs an evdev name fragment with the *position space* that keyboard's Tier B counts belong to:

```toml
[[devices]]
name = "glove80"
name_contains = "Evsieve Virtual Device"
keymap_meta_path = "/home/sascha/src/glove80-zmk/out/keymap-meta.json"

[[devices]]
name = "qwerty-ansi"
name_contains = "AT Translated Set 2 keyboard"
keymap_meta_path = "/home/sascha/src/glove80-zmk/config/qwerty-ansi-meta.json"
```

Omit the table entirely and the single-keyboard `device_name_contains` above keeps working — an installed configuration does not break on upgrade.

Rules:

- **Fragments must be unambiguous.** No fragment may contain another. An ambiguous set would silently attribute one keyboard's keystrokes to another board's geometry, so it is rejected at load rather than at capture.
- **`name` is the position space, not the device.** The laptop keyboard and an external QWERTY are two devices that legitimately share one `qwerty-ansi` space. `config/qwerty-ansi-meta.json` is hand-written for exactly that: standard touch-typing finger assignment, and `KEY_102ND` included so a DE ISO laptop is covered.
- **Separation is free at the kernel layer.** evsieve grabs only the Glove80 and the Kensington; every other keyboard stays an independent evdev device.

The invariant that matters, and the one easiest to get silently wrong:

| | crosses keyboards? | why |
|---|---|---|
| **Tier A** | yes | `finger_id`, `hand`, `row_idx`, hold and gap histograms mean the same thing on any board. "Am I slower and more pinky-loaded on the laptop?" is answerable. |
| **Tier B** | **never** | `pos` only means something inside one keyboard's geometry. Position 35 is `A` on the Glove80 and something else entirely on a row-staggered board. |

The analysis enforces this: a positional read spanning two position spaces **throws** rather than returning a pooled heatmap of nothing. Pick one keyboard with `--device <id>`; `--device '*'` is only legal when everything in range shares a space.

```bash
keylabctl devices list
pnpm analysis report --since all --device 1
```

### The device registry

`keylabctl devices list` is the read-only view of the `device` table: id, evdev name, position space, when the row was first seen, and how much each tier holds.

```
  id  name                          space        first seen           tier A  tier B  tier C
   1  Evsieve Virtual Device        glove80      2026-08-02 21:16      38157      17       0
   2  Evsieve Virtual Device        glove80      2026-08-02 21:16        223       0       0  no positional data
```

The figures are the ones the viewer's device menu shows, computed the same way; the listing differs from the menu in one respect only, that it also names rows holding nothing at all, because a merge has to be able to address them. It is safe to run while the daemon is capturing.

**One keyboard can hold several rows.** An older build minted a fresh `device_id` on every reconnect instead of reusing the row for that `(name, uniq)`, so a database that has been running a while may carry a dozen rows for one physical keyboard. Those rows keep their data. The marker in the listing is what makes an orphan recognisable: Tier B is the only tier carrying position identity, so a row with real keystrokes and no Tier B window has history that cannot be drawn on a keyboard.

`keylabctl devices merge <from>[,<from>…] --into <id>` puts them back together:

```bash
sudo systemctl stop keylab.service
keylabctl devices merge 2,3,4,5,6,7,8,9,10,11 --into 1
sudo systemctl start keylab.service
```

It repoints `bucket`, `key_window` and `ngram_window` onto the target, then deletes the emptied device rows in the same transaction, and prints a per-table count of what moved. In order, and every step before the last leaves the database exactly as it was found:

- **It refuses a merge across position spaces**, naming both, before opening a transaction or taking a backup. `pos` only means something inside one keyboard's geometry, so folding the laptop's `qwerty-ansi` counts into the Glove80's `glove80` row is the same violation as a pooled read, and it fails the same way. This is the guard the command exists for: the obvious hand-written `UPDATE bucket SET device_id = 1 WHERE device_id <> 1` has no such guard and silently does exactly that the moment a second keyboard exists.
- **It requires the daemon stopped**, and takes the write lock itself as a backstop — a busy database fails cleanly rather than waiting.
- **It backs the database up first** with `VACUUM INTO`, which writes one self-contained file with the write-ahead log already folded in, so the backup needs no `-wal` companion to be complete. The path and the roll-back command are printed. A merge is not reversible except from that file, which the command says before it writes rather than after.
- **A collision sums, it never drops.** Since schema v5 a bucket is unique on `(ts, device_id, profile_id)`, so repointing can land on an identity the target already holds — both rows sealed in the same second under the same profile. The counts add, across the bucket and all six of its child tables, and the number of combined buckets is reported. Dropping one would be the defect v5 exists to remove, reintroduced by the back door. The merged row's `span_ms` and `active_ms` add too, so a combined bucket can cover more typing time than one second of wall clock — which is what happened.

### Device scan tests

The device scan's skip path — a matched keyboard that cannot be switched to the monotonic clock is skipped and counted rather than taking the daemon down — is covered by tests that create a real virtual evdev device. They are behind a cargo feature, off by default, because `/dev/uinput` and the `/dev/input/event*` node udev then creates need permissions no test suite can assume:

```bash
cd crates/keylab && cargo test --features uinput-tests
```

A test that silently skipped itself would be worse than one that is absent, which is why this is a flag rather than a runtime check. Each test destroys its virtual device when it ends, including when it fails.

### Trackball buttons

evsieve merges the Kensington trackball into the same virtual device as the Glove80, and its buttons arrive as `EV_KEY` codes in the `BTN_*` range. They are **not** keystrokes: the daemon now drops them before counting. Previously they inflated the keystroke total and landed in the unattributed Tier B slot, because no keyboard keymap contains a `BTN_*` code — part of the historical 3.2% unattributed share was mouse clicks. Windows sealed before this change keep the old behaviour; the share should fall for new ones.

## Pause

There are three separate mechanisms with three different guarantees. Do not conflate them.

| | command | guarantee | Tier B and Tier C |
|---|---|---|---|
| soft | `keylabctl pause` | events read, nothing counted | preserved |
| hard | `touch ~/.local/share/glove80-lab/PAUSED` | device still open, all partials discarded | discarded |
| stop | `sudo systemctl stop keylab.service` | device closed, nothing read | discarded |

The **soft pause** lives in `control.json` and exists so a pause does not throw away up to 1999 keystrokes of Tier B progress or 499 corrections of Tier C progress. The daemon keeps reading the device and counts nothing. Tier C's position ring is cleared either way — a trigram spanning a pause, or spanning a kernel event-buffer overflow, would be fiction — while the counted totals stay:

```bash
keylabctl pause
keylabctl resume
```

The **hard pause** is the original marker file and keeps its v1 meaning exactly:

```bash
touch "$HOME/.local/share/glove80-lab/PAUSED"
rm -- "$HOME/.local/share/glove80-lab/PAUSED"
```

Creating or removing the marker discards all partial Tier A, Tier B and Tier C aggregates; they are never flushed below their floors. The effective pause is `PAUSED exists || control.paused`, so either channel alone stops counting.

A soft pause is **"not counted", not "not read"** — the device stays open. Only `systemctl stop` closes it.

Known limitation, stated plainly: reaching for either control during a password prompt is impractical. The keyboard-bound pause toggle with LED indication is v2, alongside firmware layer signalling.

## Control file

`~/.local/share/glove80-lab/control.json`, beside the database and the `PAUSED` marker:

```json
{
  "paused": false,
  "profile": "default",
  "updated_at": 1785900000
}
```

It is user-writable by design — the daemon runs as `sascha`, not root, so a control socket would force removal of `SocketBindDeny=any` and buy nothing. Writers (`keylabctl`, the viewer, the daemon's own auto-revert) write to `control.json.tmp`, `fsync`, then `rename`, so a reader never sees a half-written file. The daemon `stat`s it on every 10 ms loop iteration and re-parses only when the modification time or size moved.

A malformed, unreadable, or unknown-profile file logs one warning and keeps the last known-good state. It never kills the daemon and never silently resumes capture.

## Inspect

The database is `/home/sascha/.local/share/glove80-lab/keylab.db`. It is owned by `sascha`, the directory is mode `0700`, and the database is mode `0600`. SQLite uses WAL mode, so a reader can inspect it while capture continues:

```bash
sqlite3 -readonly "$HOME/.local/share/glove80-lab/keylab.db"
```

Useful read-only commands at the SQLite prompt include:

```sql
.tables
SELECT COUNT(*), SUM(keystrokes) FROM bucket;
SELECT COUNT(*), SUM(keystrokes) FROM key_window;
SELECT COUNT(*), SUM(corrections), SUM(degraded), SUM(dropped) FROM ngram_window;
SELECT updated_at, json FROM live_snapshot;
SELECT p.name, SUM(b.keystrokes) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1;
```

The schema is at version 5 and is migrated in place the first time the new daemon opens an older database:

| from | adds | backfill |
|---|---|---|
| v1 → v2 | `bucket.profile_id`, `key_window.profile_id` | every existing row to `default` |
| v2 → v3 | `device.keymap_kind`, `device.keymap_hash` | every existing device to `glove80` |
| v3 → v4 | `ngram_window`, `ngram`, `ngram_finger` | none — new tables |
| v4 → v5 | `bucket.ts`, `UNIQUE (ts, device_id, profile_id)` | `ts = id` for every existing row |

The first two backfills are accurate rather than guesses: every pre-v3 row was captured on the Glove80 through evsieve during ordinary use, before profiles or multi-device support existed. v3 → v4 has nothing to backfill, because correction context that was never captured cannot be reconstructed. v4 → v5's backfill is accurate for the same kind of reason: under v4 the bucket id *was* the seal second, so copying it into `ts` restates what the row already meant.

**A bucket is identified by device and second, not by second alone.** Up to v4, `bucket.id` was the seal second and the whole primary key, so one second held one bucket for the entire machine. `id` is now a surrogate — the six child tables reference it and it is copied verbatim through the migration, so nothing is renumbered — and the seal second lives in `ts`. The unique index behind `(ts, device_id, profile_id)` leads with `ts`, which is what every range read filters on, so no separate index on `ts` is warranted.

**What that cost before the fix.** On a machine with two keyboards, whenever both sealed a Tier A bucket in the same second, one of them was discarded: `seal_tier_a` found the id present and returned success having written nothing. The whole bucket went — keystrokes, per-finger counts, hold, gap and modifier histograms — with no log line, no counter, and no visible difference in any number that would let you notice. Those buckets are not recoverable, and the loss leaves no trace in the stored data. A single-keyboard installation never reached it. From v5 the two buckets are two rows; a genuine duplicate for one device, profile and second is refused loudly, logged with the device and the second, and counted into `refused_tier_a_seals` on the daemon's device-scan log lines.

`packages/analysis`, `packages/viewer` and `packages/trainer` all open the database through `openKeylabDatabase`, which pins schema version 5. An older database is refused with a message that points at the daemon, which migrates it in place on its next start.

`pnpm analysis report` renders Tier C as a *correction context* block under "Correction tax": the top ordered trigrams with their base-layer characters, the fumble / ambiguous / edit split, the finger-transition rollup for whatever degraded, and the degraded and dropped shares. A trigram position renders as `?` when it is unattributed or has no base-layer binding and as `·` when the slot held no key at all — the two are never conflated. Ordered trigrams are geometric, so the read refuses to pool across position spaces exactly as Tier B does; select one device with `--device ID`. The block states when it is empty and why, because a silently absent section would read as "no corrections".

`pnpm viewer` draws the same data on the keyboard. The heatmap has two layers: **key presses**, the Tier B frequency map it always had, and **correction rate**, the marginal of Tier C's `pos_c` — the key immediately before each backspace — divided by that key's presses in range.

The division is the point. Corrections counted raw simply redraw the frequency map, because the keys pressed most are corrected most in absolute terms; the rate is the difference between "keys I use" and "keys I get wrong". A **press floor of 50 presses in range** goes with it: below that a key is drawn as no data rather than as a rate, because three corrections in four presses is the highest number on the board and four presses of evidence. The footnote says how many keys that hid.

A correction-kind filter switches between all corrections, fumbles (under 400 ms since the last keystroke) and edits (over a second), on keylab's own latency buckets. Ambiguous corrections — 400 to 1000 ms — count only under *all*, since they are neither. `-1` and `-2` have no geometry to draw on, so their share is footnoted rather than dropped, and the layer refuses to pool across position spaces exactly as the report does.

Tier C's on-disk position encoding extends `pos_count`'s convention: `0..79` is a physical position, `-1` is unattributed (deliberately the same value `pos_count` uses), and `-2` is *absent* — fewer than three keys preceded that correction, for example at the very start of a window. Finger columns use `0..9` and `-1` for absent, since a key with no base-layer position has no finger either.

Tier B's `pos_count` table contains diluted physical-position histograms, and Tier C's `ngram` table contains ordered position triples. Treat the entire database, including `keylab.db-wal` and `keylab.db-shm`, as privacy-sensitive.

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

## What this does not protect against

- **Host-wide input-device permissions:** keylab's process and service hardening cannot mitigate a permission grant made at the host level — if the device nodes are readable by everyone, every local process can log keystrokes regardless of how keylab is confined. This host previously carried `/etc/udev/rules.d/99-vibetyper-uinput.rules`, which set `KERNEL=="event*", SUBSYSTEM=="input", MODE="0666"` and made `/dev/uinput` world-writable. That file was removed on 2026-08-04; `/etc/udev/rules.d/99-uinput.rules` already grants uinput to the `input` group at `0660`, so vibetyper still injects, evsieve still reads through the `input` group, and Hyprland still receives devices through logind. Note that udev applies node permissions on `add`, not on `change`: after removing such a rule, trigger with `--action=add` or reboot, and reboot specifically for `/dev/uinput`, which is a static node whose mode is fixed at module load. Verify with `ls -l /dev/input/event* /dev/uinput` — both should read `crw-rw----` owned by `root:input`.
- **Hibernation:** suspend-to-disk writes `mlockall`ed pages into the resume image. Use an encrypted swap/resume device; `mlockall` protects only against normal swap while the daemon is running.
- **Privileged memory access:** root, or anything with `CAP_SYS_PTRACE`, can read the daemon's memory regardless of `PR_SET_DUMPABLE`. Same-user processes can see that keylab exists even though unprivileged memory access is blocked.
- **Backups and sync:** the database under `$HOME` is picked up by backup tools unless excluded. keylab writes `CACHEDIR.TAG` and `README.txt`; Borg and restic honour the tag only when their exclude-caches option is enabled. Timeshift, Dropbox, and Syncthing need explicit exclusion. Use these exact options/entry (the Syncthing entry assumes `$HOME` is the folder root):

  ```text
  # Borg create option
  --exclude-caches

  # restic backup option
  --exclude-caches

  # Syncthing .stignore entry
  /.local/share/glove80-lab
  ```

  Add `/home/sascha/.local/share/glove80-lab` to Timeshift and Dropbox exclusions explicitly as well.
- **Long carried Tier A spans:** `span_ms` on a carried bucket can be hours long. This reveals that an isolated burst of typing occurred at that time. Content is diluted; the fact that *something* was typed at 03:00 is not.
- **A password-only machine:** on a machine used almost exclusively to type one password, repeated entry can make that password's multiset dominant within a 2000-keystroke Tier B window. This is irrelevant for a daily-driver workstation, but remains a real limitation.

### Tier C residual risks

Recording an ordered trigram at each correction is a categorical change, not a quantitative one. These four risks are inherent to it, and no configuration setting removes them short of `ngram_capture = false`:

- **Suppression is per-window, not lifetime.** A fragment fumbled three or more times inside one window is written verbatim as an ordered position triple. Across windows it degrades to fingers each time, but within one window it can survive with its positions intact.
- **The trigger is mistake-correlated.** Corrections cluster where typing is hardest, and password entry is exactly that. The capture condition is adversarially aligned with the sensitive case: the harder something is to type, the more likely its context is recorded.
- **Positions are characters.** On a fixed base layer, position 35 *is* `a`. Storing physical positions rather than keycodes is a schema convenience and buys no privacy whatsoever. Do not read the position encoding as obfuscation.
- **Pause reachability is now load-bearing.** Reaching either pause control during a password prompt is impractical (see *Pause* above). That was a tolerable cost when everything stored was a diluted aggregate; for ordered sequences it is the primary residual risk. The firmware-bound pause toggle is out of scope here, but its priority rises because of this work.

## Uninstall

Run the repository's uninstaller as root yourself:

```bash
sudo crates/keylab/uninstall.sh
```

It stops and disables the unit, removes `/usr/local/bin/keylab` and `/etc/systemd/system/keylab.service`, and reloads systemd. It deliberately leaves the configuration and all captured data alone and prints the database path.

## Delete everything

Stop capture first. The WAL contains recent frames, so securely delete the database, `-wal`, and `-shm` files—not only the main file—then remove the data directory:

```bash
systemctl stop keylab.service
data_dir="$HOME/.local/share/glove80-lab"
for file in "$data_dir/keylab.db" "$data_dir/keylab.db-wal" "$data_dir/keylab.db-shm"; do
  [[ ! -e "$file" ]] || shred -u -- "$file"
done
rm -rf -- "$data_dir"
```

On copy-on-write filesystems, SSDs, snapshots, and prior backups, `shred` cannot guarantee physical erasure of every historical block. Delete snapshots/backups and use full-disk encryption to address those copies. The configuration at `$HOME/.config/glove80-lab/keylab.toml` contains no captured data; remove it separately if the goal is also to remove all keylab configuration.
