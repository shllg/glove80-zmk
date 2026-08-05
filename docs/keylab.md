# keylab

`keylab` is a local-only daemon that reads the Glove80's Linux evdev events and stores privacy-reduced ergonomic aggregates in SQLite. It is intended for measuring per-finger load, modifier burden, home-row-mod misfires, and typing dose without creating a keystroke sequence or corpus.

## What is recorded

keylab has two persistent privacy tiers plus a replace-only live snapshot:

- **Tier A — fine, time-sealed:** nominal 10-second buckets containing start time, span, active time, total presses, autorepeats, per-finger and per-hand/row marginal counts, duration and gap histograms, modifier hold histograms, and content-free misfire/correction counters. It contains no keycode or physical-position identity and no finger-by-row joint distribution.
- **Tier B — coarse, count-sealed:** an unordered histogram of counts for physical positions 0–79 plus an unattributed position, with the window's start/end times and total press count. It contains position identity, but no ordering or per-press timestamp.
- **Live snapshot:** replace-only per-finger marginals and typing rate. It contains no positions.

The database also records device identity, schema/daemon versions, the generated keymap hash, and keymap-hash history so aggregate data remains attributable to the configuration that produced it.

keylab does **not** record characters, raw keycodes, a raw event log, event order, bigrams, words, clipboard contents, applications, windows, or focused fields. It never persists individual key timestamps. Its bounded in-memory state tracks only currently held keys, the immediately previous event context needed for timing/counters, Tier A aggregates, and an unordered Tier B histogram.

Tier A is not sealed until at least **25 keystrokes** have accumulated. A shorter bucket is carried into the next time bucket, preventing an isolated short burst such as a password from becoming a fine-grained stored sample. Tier B is not sealed until at least **2000 keystrokes** have accumulated. At the minimum floor, this limits a 12-character password to 0.6% of the unordered positional histogram on a normal workstation, and further typing dilutes it more. Both values are enforced minimums, not merely configuration defaults.

Partial buckets are discarded on shutdown, disconnect, or pause. The last few minutes are therefore intentionally lost rather than writing data below either privacy floor.

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
```

`device_name_contains` selects evdev devices by a case-sensitive name fragment. `keymap_meta_path` must point to the metadata emitted by `pnpm build`. The daemon refuses bucket/floor settings below 10 seconds, 25 keystrokes, and 2000 keystrokes, and refuses more than 8 profiles or a list whose first entry is not `default`. Restart the service after configuration changes:

```bash
systemctl restart keylab.service
```

## Input remappers and exclusive grabs

Linux `EVIOCGRAB` gives one reader exclusive access to an input device. While the grab is held, that physical device delivers no events to any other reader, even though another process can still open it successfully.

On this machine, evsieve grabs `MoErgo Glove80 Keyboard` and emits the resulting typing through `Evsieve Virtual Device`, so `device_name_contains` must target `Evsieve Virtual Device`. Matching `Glove80` is correct only when no remapper is in the input path; it would also match `MoErgo Glove80 Mouse` here.

The evsieve command includes `--block key:f23@kb`, so F23 never reaches the virtual device. Consequently, **position 68 will always read zero presses**. This is an input-topology blind spot, not a finger-load finding.

At startup, keylab logs each matched device and event path plus the total match count. For each match, a passive watchdog warns after five unpaused minutes without any `EV_KEY` event and repeats no more than once every 30 minutes. The warning usually means another process holds an exclusive grab and capture points at the wrong device. When it fires, inspect the active remapper topology and set `device_name_contains` to the device that actually emits the remapped events. keylab does not probe with `EVIOCGRAB`, because even a brief probe could swallow a keystroke.

## Activity profiles

Every sealed Tier A bucket and Tier B window carries a `profile_id`. The profile is an *activity* label — practice, gaming, language drilling — and is orthogonal to `device_id`, so "gaming across both keyboards" stays answerable.

```bash
keylabctl profile list        # configured profiles; * marks the active one
keylabctl profile set gaming
keylabctl status
```

Rules that matter:

- **The configured list is a closed set.** `profiles` in `keylab.toml` must start with `default`, hold at most **8** entries, and use only `[a-z0-9-]`. A name outside the list is rejected by both `keylabctl` and the daemon, which keeps its last known-good state rather than guessing.
- **The cap is a privacy invariant, not a preference.** Each profile holds its own 81-slot Tier B histogram; `MAX_PROFILES = 8` is what keeps the daemon's in-memory footprint bounded.
- **Tier B is preserved across a switch, per profile.** Switching profiles never discards positional progress. It also means a profile you rarely use may take weeks to reach the 2000-keystroke floor and seal a window — correct behaviour, not a fault.
- **Tier A is sealed or discarded at the boundary.** A bucket that clears both floors (25 keystrokes, 10 seconds) is sealed under the outgoing profile; anything below is discarded. A switch therefore smears at most one bucket.
- **Idle auto-revert.** After `auto_revert_idle_seconds` (default 900) with no keystrokes on any device, the daemon rewrites `control.json` back to `default`, so a forgotten `gaming` profile cannot silently poison a working day. Set it to `0` to disable.

Check the split:

```bash
sqlite3 -readonly "$HOME/.local/share/glove80-lab/keylab.db" \
  "SELECT p.name, SUM(b.keystrokes) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1 ORDER BY 2 DESC;"
```

`pnpm analysis report` reads the `default` profile unless told otherwise; `--profile gaming` selects one and `--profile '*'` pools them all. The report header always names the profile, so a filtered report is never mistaken for a full one.

## Pause

There are three separate mechanisms with three different guarantees. Do not conflate them.

| | command | guarantee | Tier B |
|---|---|---|---|
| soft | `keylabctl pause` | events read, nothing counted | preserved |
| hard | `touch ~/.local/share/glove80-lab/PAUSED` | device still open, all partials discarded | discarded |
| stop | `sudo systemctl stop keylab.service` | device closed, nothing read | discarded |

The **soft pause** lives in `control.json` and exists so a pause does not throw away up to 1999 keystrokes of Tier B progress. The daemon keeps reading the device and counts nothing:

```bash
keylabctl pause
keylabctl resume
```

The **hard pause** is the original marker file and keeps its v1 meaning exactly:

```bash
touch "$HOME/.local/share/glove80-lab/PAUSED"
rm -- "$HOME/.local/share/glove80-lab/PAUSED"
```

Creating or removing the marker discards all partial Tier A and Tier B aggregates; they are never flushed below their floors. The effective pause is `PAUSED exists || control.paused`, so either channel alone stops counting.

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
SELECT updated_at, json FROM live_snapshot;
SELECT p.name, SUM(b.keystrokes) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1;
```

The schema is at version 2. A version 1 database is migrated in place the first time the new daemon opens it: the `profile_id` columns are added and every existing row is backfilled to `default`. That backfill is accurate rather than a guess — every v1 row was captured on the Glove80 during ordinary use, before profiles existed. The analysis and viewer packages require version 2 and say so plainly if they meet an unmigrated database.

Tier B's `pos_count` table contains diluted physical-position histograms. Treat the entire database, including `keylab.db-wal` and `keylab.db-shm`, as privacy-sensitive.

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
