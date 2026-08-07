# keylab — profiles, control, multi-device, and the training toolchain

Date: 2026-08-05
Status: implemented. All three projects shipped: control, profiles and the soft pause; multi-device; the training toolchain. The step checklists below are ticked to match the running system, verified per task rather than step by step.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let keylab segment its capture by *device* and by *activity profile*, so that typing practice, gaming, and German-versus-English drilling stop contaminating real-use statistics — and build a training toolchain that produces both repeatable benchmarks and adaptive drills aimed at weaknesses keylab measures.

**Architecture:** A user-writable control file (`control.json`) carries `paused` and `profile`; the daemon polls it, stamps a `profile_id` onto every sealed Tier A and Tier B row, and keeps one Tier B accumulator per profile so a profile switch never mislabels a sealed window. Devices are already segmented by the existing `device_id` foreign keys, so multi-keyboard support reduces to per-device keymaps. The training tool is a separate application with its own store, joined to keylab at analysis time on timestamp and profile.

**Tech Stack:** Rust (`rusqlite`, `serde`, `zeroize`, `tracing`, `anyhow`) for the daemon and `keylabctl`; TypeScript on Bun for `packages/analysis` and `packages/viewer`; SQLite in WAL mode.

## Global Constraints

Every task's requirements implicitly include this section.

- **Privacy floors are hard minimums.** `MIN_TIER_A_SEAL_FLOOR = 25`, `MIN_TIER_B_SEAL_COUNT = 2000` (`crates/keylab/src/config.rs:6-7`). Configuration below either value must be rejected by `Config::validate`.
- **Logging policy** (`crates/keylab/src/main.rs:1`): never log keycodes, positions, characters, or event `Debug` values. Counts only. Profile *names* are user-authored labels and may be logged; keystroke data may not.
- **Bounded in-memory footprint.** Maximum retained sequence context is one event. `Aggregator` state must stay bounded regardless of stream length and regardless of how long a profile is active.
- **No systemd hardening regression.** `crates/keylab/keylab.service` must not lose any directive, in particular `SocketBindDeny=any`, `RestrictAddressFamilies=AF_UNIX`, `CapabilityBoundingSet=`, `PrivateNetwork=yes`. If any line changes, `docs/keylab-security-score.txt` must be re-verified with `crates/keylab/verify-hardening.sh`.
- **Partial aggregates never persist.** Anything below its seal floor is zeroized, never written.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys. Commit locally only.
- **No AI attribution** in commits, comments, or docs. No `Co-Authored-By` trailer.
- **Profile cap.** `MAX_PROFILES = 8`. The cap exists to keep the per-profile Tier B accumulators bounded; it is a privacy invariant, not a preference.

---

# Design

## Problem

Three problems, one root cause: keylab has exactly one bucket for everything it sees.

1. **Practice pollutes real use.** A monkeytype session is lowercase prose at unnatural pace with no shortcuts, no code, no thinking pauses. Pooled with real work it produces a statistic that describes neither.
2. **No German/English differentiation.** keylab records marginals and positions, never content, so it cannot passively separate languages — by design.
3. **One host, three keyboards.** The Glove80 (via evsieve), the laptop built-in, and an occasional external QWERTY. Position 0-79 currently *means* Glove80 geometry.

## Settled decisions

| Decision | Choice | Reason |
|---|---|---|
| Control channel | User-writable `control.json` polled by the daemon | Daemon runs as `sascha` (`keylab.service:13`), not root. A control socket would force removal of `SocketBindDeny=any` and buy nothing. |
| Pause semantics | **Soft**: keep reading, count nothing, preserve the Tier B accumulator | A hard stop discards up to 1999 keystrokes of Tier B progress per pause. |
| Hard pause | Existing `PAUSED` marker file retained, unchanged | Already documented and shipped. Keeps the "device not read at all" guarantee available. |
| Profile axis | Activity only: `default`, `training-de`, `training-en`, `gaming` | Device is already a column. Fusing them duplicates data and makes "gaming across both keyboards" unanswerable. |
| Profile storage | `profile` table + `profile_id` FK | Mirrors the existing `device` table pattern. |
| Tier B on profile switch | One accumulator **per profile** | A single accumulator surviving a switch produces a sealed window whose label is a lie. |
| Tier A on profile switch | Seal if it clears the floor, else discard | A switch smears at most 10s. Per-profile accumulators are not worth it. |
| Benchmark corpus | Frozen and versioned; **never** fed by the weakness model | The moment weakness data reaches the benchmark corpus, the trend line stops meaning anything. |
| Trainer store | Separate database, full keystroke log | The text is self-generated, so there is no secret in it — and ground truth is what makes drills possible. |

## Project 1 — control, profiles, soft pause

### Control file

`~/.local/share/glove80-lab/control.json`, beside the database and the `PAUSED` marker.

```json
{
  "paused": false,
  "profile": "default",
  "updated_at": 1785900000
}
```

Rules:

- **Atomic writes only.** Write to `control.json.tmp` in the same directory, `fsync`, then `rename`. The daemon must never observe a half-written file.
- **mtime-gated reads.** `refresh_control_state` runs on every 10 ms loop iteration. It `stat`s the file and only re-reads and re-parses when `mtime` or size changed.
- **Fail-safe parsing.** A malformed or unreadable file logs a warning once and keeps the last known-good state. It never kills the daemon and never silently resumes capture.
- **Unknown profile name** is rejected the same way: warn, keep last known good.
- **Effective pause** is `PAUSED exists || control.paused`.

### Effect of a soft pause

| | Tier A | Tier B |
|---|---|---|
| soft pause (`control.paused`) | seal if `>= tier_a_seal_floor`, else discard | **preserved in RAM** |
| hard pause (`PAUSED` file) | discard | discard |
| device disconnect | discard | discard |
| shutdown | discard | discard |

Existing `Aggregator::discard_partials` stays exactly as it is and keeps serving disconnect, shutdown, and hard pause. Soft pause gets a new, narrower method.

### Effect of a profile switch

Seal-or-discard Tier A, then change which per-profile Tier B accumulator is active. No Tier B data is discarded. A profile that never reaches 2000 keystrokes never seals a window — correct behaviour, and the trainer's own store covers short drills anyway.

### Idle auto-revert

The failure mode that will actually bite: you forget to leave `gaming` and silently poison a day. After `auto_revert_idle_seconds` (default 900) with no keystrokes on any device, the daemon rewrites `control.json` back to `default`. Training profiles are set and cleared programmatically by the trainer and are unaffected in practice.

### `keylabctl`

A second binary in the same crate so the file format has exactly one implementation.

```
keylabctl status                 # prints paused, profile, per-device liveness
keylabctl pause | resume
keylabctl profile list
keylabctl profile set <name>
```

### Viewer

Displays the authoritative state — the daemon echoes `paused` and `profile` into the `live_snapshot` JSON, which already streams over SSE every second. Adds `POST /api/control` to set them.

**CSRF guard, required.** A localhost HTTP server accepts simple cross-origin POSTs from any web page the browser has open. `POST /api/control` must reject any request whose `Origin` header is present and is not `http://127.0.0.1:<port>`, and must require `Content-Type: application/json` (which forces a preflight the origin check then fails).

## Project 2 — multi-device

evsieve grabs only two devices:

```
--input .../Glove80...-event-kbd  grab persist=reopen domain=kb
--input .../Kensington_Expert_Mouse-event-mouse grab persist=reopen domain=tb
```

So `AT Translated Set 2 keyboard` (the laptop built-in) and any external QWERTY remain independent evdev devices. Separation is free at the kernel layer. `bucket.device_id` and `key_window.device_id` already exist.

What must change:

- `device_name_contains: String` becomes a list of rules, each pairing a name substring with its own `keymap_meta_path`.
- `meta` holds one keymap today. It must hold one per device rule, and `Store::open` must key them by device.
- Laptop and external QWERTY **share** a position space (both row-staggered, evdev keycodes are physical). One hand-written `qwerty-ansi` keymap-meta covers both; add `KEY_102ND` if the laptop is DE ISO.

The analysis invariant that is easy to get silently wrong:

- **Tier A is semantic and crosses keyboards.** `finger_id`, `hand`, `row_idx`, hold and gap histograms mean the same thing on any board. "Am I slower and more pinky-loaded on the laptop?" is answerable.
- **Tier B is geometric and must never be pooled across devices.** `pos_count` only means something inside one keyboard's position space.

Incidental: evsieve merges the Kensington trackball into the same virtual device, and trackball buttons are `EV_KEY` (272+) absent from the Glove80 keymap. Some of the measured 3.2% unattributed is probably mouse clicks. Confirm with a query, then either filter them or count them deliberately.

## Project 3 — training toolchain

```
benchmark generator  (pool, seed, length) → text   ─┐
                                                    ├→ engine (capture + score) → trainer store
drill generator  (weakness model, length) → text   ─┘                                │
        ↑                                                                            │
        └───────────── weakness model ←── keylab + trainer history ←──────────────────┘
```

One field on the session record, `mode = benchmark | drill`. Only `benchmark` rows are plotted as a trend.

### Two measurement paths, not one

During any drill, both instruments run and they measure different things:

| | keylab | trainer |
|---|---|---|
| sees | raw evdev, pre-IBus | what the application receives |
| truth about | physical effort | correctness |
| a German `ä` | **8 keystrokes** (`Ctrl+Shift+U`, 4 hex digits, Space — `config/macros.dtsi:87`) | 1 character |

The trainer alone would report "typed ä, one keystroke" while the hand did eight. keylab is the only path that sees the real cost, and that cost *is* the German-versus-English finding.

**Open risk, must be probed before committing to a browser trainer:** IBus may deliver composed characters without per-key `keydown` events, so the browser's physical-key attribution for German is unverified. A five-minute probe settles it. If IBus does swallow them, the browser trainer still measures correctness correctly and keylab supplies effort — the design survives either way.

### Benchmark: running an existing tool is a valid answer

The original complaint — "monkeytype produces a false statistic" — is solved by the profile tag, not by replacing monkeytype. With `training-en` active, a monkeytype session no longer pollutes anything, and monkeytype's own history is a perfectly good WPM trend.

| Option | Cost | Trade-off |
|---|---|---|
| **B1. monkeytype.com as-is** | ~zero | Corpus is not frozen (they update word lists); no offline use; no keystroke export. **Recommended start.** |
| **B2. monkeytype self-hosted** | high — frontend, Mongo, Firebase auth, Redis | Freezes the corpus. Only worth it if drift demonstrably matters. |
| **B3. built into the drill tool** | medium | Full control and one store; duplicates something mature. |
| **B4. keybr** | low | Adaptive by design and multi-language; worth evaluating for part of 3b before building it. |
| **B5. terminal (`ttyper`, `tt`, `thokr`)** | low | Terminal gives characters, not scancodes — cannot attribute layered keys on a Glove80. Benchmark only, never drills. |

Start at B1. Revisit only if corpus drift shows up in the trend.

If a benchmark is ever built in-house, the real threat is **memorization**, not sampling noise: fixed pool with a frozen version tag, random seed per run, fixed word count (same denominator keeps per-position error rates comparable), and report a rolling median over the last *k* runs.

The German benchmark must contain umlauts or it is not measuring German, and it will show brutal WPM against English because of the 8-keystroke macro. That is the finding, not a bug. Two trend lines, each compared only against its own history.

### Weakness model — three sources, three different weaknesses

| source | measures | sharpness |
|---|---|---|
| trainer history | per-position error rate, substitution matrix, digraph latency | ground truth, best |
| keylab Tier B | position frequency | frequency is not weakness; only useful combined |
| keylab Tier A | finger imbalance, hold outliers, correction runs, mod misfires | real-use friction |

Day one there is no trainer history. Bootstrap off keylab, switch to trainer-derived once sessions accumulate.

### The drill family nothing else can do

The measured `R_GUI` hold — median ~750 ms, p95 >= 1000 ms, against 160-240 ms for every other modifier — is not a typing-accuracy problem. No word-list drill will ever surface it. **Mechanic drills** target hold/tap discrimination, layer-hold accuracy, thumb clusters, and `LONELY_MOD` misfire rate: the mechanics of *this* firmware. That is the differentiator and the reason to build rather than only fork.

Four drill families: **position**, **bigram/transition** (same-finger bigrams, awkward rolls), **mechanic**, **language** (umlaut macro sequences, German compounds, code identifiers).

### Trainer store

Separate database from keylab.

```sql
session(id, started_ts, ended_ts, mode, language, corpus_id, corpus_version, seed, device_label)
keystroke(session_id, seq, ts_ms, code, expected_code, correct)
```

A 60-second test is roughly 400 rows; 1000 sessions roughly 400k. Negligible.

**Hygiene rule:** once corpora are generated from your own commits and code, the keystroke log contains your source material, and a "type your own text" mode would make it genuinely sensitive. Same 0700 directory, same `CACHEDIR.TAG`, same backup exclusion as keylab. Do not create a second, laxer standard.

## Build order

**1 → 3a → 3b → 2 → 3c**

Project 1 is small and unblocks everything. 3a at option B1 is nearly free once profiles exist. Project 2 only pays off when actually mobile — and until it lands, **drills are Glove80-only**, because keylab matches a single device.

---

# Implementation plan — Project 1

Projects 2 and 3 get their own plan files when Project 1 has shipped. Planning them to step level now would be speculation: 3b's design depends on what Project 1's data actually shows.

## File structure

| File | Responsibility |
|---|---|
| `crates/keylab/src/control.rs` *(create)* | `ControlState` type, atomic write, mtime-gated read, validation. The single implementation of the file format. |
| `crates/keylab/src/bin/keylabctl.rs` *(create)* | CLI over `control.rs`. No format logic of its own. |
| `crates/keylab/src/config.rs` *(modify)* | `profiles` list, `auto_revert_idle_seconds`, cap validation. |
| `crates/keylab/src/store.rs` *(modify)* | `profile` table, `profile_id` columns, schema v1→v2 migration, profile-aware seals. |
| `crates/keylab/src/aggregate.rs` *(modify)* | Per-profile Tier B accumulators, `seal_or_discard_tier_a`. |
| `crates/keylab/src/main.rs` *(modify)* | Wire control state into the event loop; echo state into `live_snapshot`. |
| `packages/analysis/src/db.ts`, `metrics.ts` *(modify)* | Bump supported schema version; profile filter. |
| `packages/viewer/src/server.ts`, `public/app.js` *(modify)* | Show state, `POST /api/control` with CSRF guard. |

---

### Task 1: Config — profiles and the cap

**Files:**
- Modify: `crates/keylab/src/config.rs:6-35` (constants, `Config`, `Default`)
- Modify: `crates/keylab/keylab.example.toml`
- Test: `crates/keylab/src/config.rs` (existing inline `mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.profiles: Vec<String>`, `Config.auto_revert_idle_seconds: u64`, `config::MAX_PROFILES: usize`, `config::DEFAULT_PROFILE: &str`.

- [x] **Step 1: Write the failing tests**

Add to the `mod tests` block in `crates/keylab/src/config.rs`:

```rust
    #[test]
    fn rejects_more_profiles_than_the_cap() {
        let mut config = Config::default();
        config.profiles = (0..MAX_PROFILES + 1).map(|index| format!("p{index}")).collect();
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_a_profile_list_without_the_default_profile() {
        let mut config = Config::default();
        config.profiles = vec!["gaming".to_owned()];
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_duplicate_and_malformed_profile_names() {
        let mut config = Config::default();
        config.profiles = vec![DEFAULT_PROFILE.to_owned(), "gaming".to_owned(), "gaming".to_owned()];
        assert!(config.validate().is_err());

        config.profiles = vec![DEFAULT_PROFILE.to_owned(), "Training DE".to_owned()];
        assert!(config.validate().is_err());
    }

    #[test]
    fn default_profiles_are_valid_and_start_with_default() {
        let config = Config::default();
        assert_eq!(config.profiles.first().map(String::as_str), Some(DEFAULT_PROFILE));
        config.validate().unwrap_or_else(|error| panic!("{error:#}"));
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p keylab config:: -- --nocapture`
Expected: FAIL — `no field 'profiles' on type 'Config'`, `cannot find value 'MAX_PROFILES'`.

- [x] **Step 3: Implement**

In `crates/keylab/src/config.rs`, beside the existing floor constants:

```rust
/// Bounds the per-profile Tier B accumulators. This is a privacy invariant, not a preference:
/// each profile holds its own 81-slot histogram and the total footprint must stay bounded.
pub const MAX_PROFILES: usize = 8;
pub const DEFAULT_PROFILE: &str = "default";
```

Add to `Config`:

```rust
    pub profiles: Vec<String>,
    pub auto_revert_idle_seconds: u64,
```

Add to `Default::default`:

```rust
            profiles: vec![
                DEFAULT_PROFILE.to_owned(),
                "training-de".to_owned(),
                "training-en".to_owned(),
                "gaming".to_owned(),
            ],
            auto_revert_idle_seconds: 900,
```

Add to `Config::validate`:

```rust
        if self.profiles.len() > MAX_PROFILES {
            bail!("at most {MAX_PROFILES} profiles are supported");
        }
        if self.profiles.first().map(String::as_str) != Some(DEFAULT_PROFILE) {
            bail!("the first profile must be \"{DEFAULT_PROFILE}\"");
        }
        for name in &self.profiles {
            if name.is_empty()
                || name.len() > 32
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                bail!("profile names must be 1-32 chars of [a-z0-9-]");
            }
        }
        let mut seen = self.profiles.clone();
        seen.sort();
        seen.dedup();
        if seen.len() != self.profiles.len() {
            bail!("profile names must be unique");
        }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p keylab config::`
Expected: PASS.

- [x] **Step 5: Update the example config**

Append to `crates/keylab/keylab.example.toml`:

```toml
# The first entry must be "default". At most 8, names limited to [a-z0-9-].
# The cap keeps the per-profile Tier B accumulators bounded.
profiles = ["default", "training-de", "training-en", "gaming"]
# Revert to "default" after this many seconds with no keystrokes on any device.
auto_revert_idle_seconds = 900
```

- [x] **Step 6: Commit**

```bash
git add crates/keylab/src/config.rs crates/keylab/keylab.example.toml
git commit -m "feat(keylab): add capped activity profile configuration"
```

---

### Task 2: Control file format

**Files:**
- Create: `crates/keylab/src/control.rs`
- Modify: `crates/keylab/src/main.rs` (add `mod control;` beside the existing module declarations)

**Interfaces:**
- Consumes: `config::DEFAULT_PROFILE` (Task 1).
- Produces:
  - `pub struct ControlState { pub paused: bool, pub profile: String }`
  - `pub struct ControlWatcher` with `ControlWatcher::new(path: PathBuf, profiles: Vec<String>) -> Self` and `ControlWatcher::poll(&mut self) -> ControlState`
  - `pub fn write_control(path: &Path, state: &ControlState) -> Result<()>`

- [x] **Step 1: Write the failing tests**

Create `crates/keylab/src/control.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn watcher(directory: &Path) -> (PathBuf, ControlWatcher) {
        let path = directory.join("control.json");
        let profiles = vec!["default".to_owned(), "gaming".to_owned()];
        (path.clone(), ControlWatcher::new(path, profiles))
    }

    #[test]
    fn missing_file_yields_the_default_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (_path, mut watcher) = watcher(temp.path());
        let state = watcher.poll();
        assert!(!state.paused);
        assert_eq!(state.profile, "default");
    }

    #[test]
    fn round_trips_through_an_atomic_write() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState { paused: true, profile: "gaming".to_owned() },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(!path.with_extension("json.tmp").exists());
        let state = watcher.poll();
        assert!(state.paused);
        assert_eq!(state.profile, "gaming");
    }

    #[test]
    fn malformed_content_keeps_the_last_known_good_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState { paused: true, profile: "gaming".to_owned() },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(watcher.poll().paused);

        fs::write(&path, b"{ not json").unwrap_or_else(|error| panic!("{error}"));
        let state = watcher.poll();
        assert!(state.paused, "a parse failure must not silently resume capture");
        assert_eq!(state.profile, "gaming");
    }

    #[test]
    fn an_unknown_profile_is_rejected_and_does_not_change_state() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        fs::write(&path, br#"{"paused":false,"profile":"nope","updated_at":0}"#)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(watcher.poll().profile, "default");
    }

    #[test]
    fn an_unchanged_file_is_not_reparsed() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let (path, mut watcher) = watcher(temp.path());
        write_control(
            &path,
            &ControlState { paused: true, profile: "gaming".to_owned() },
        )
        .unwrap_or_else(|error| panic!("{error:#}"));
        assert!(watcher.poll().paused);
        let before = watcher.parse_count();
        watcher.poll();
        watcher.poll();
        assert_eq!(watcher.parse_count(), before, "mtime-gated reads must not reparse");
    }
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p keylab control::`
Expected: FAIL — `cannot find type 'ControlState'`.

- [x] **Step 3: Add the dev-dependency**

`tempfile` is needed by the tests. Check `crates/keylab/Cargo.toml` for an existing `[dev-dependencies]` entry; add it only if absent:

```bash
cargo add --package keylab --dev tempfile
```

- [x] **Step 4: Implement**

Prepend to `crates/keylab/src/control.rs`, above the test module:

```rust
use crate::config::DEFAULT_PROFILE;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::warn;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlState {
    pub paused: bool,
    pub profile: String,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            paused: false,
            profile: DEFAULT_PROFILE.to_owned(),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct ControlFile {
    paused: bool,
    profile: String,
    updated_at: i64,
}

/// Reads the control file at most once per change. `poll` runs on every 10 ms loop iteration, so
/// it stats the file and only re-parses when the modification time or length moved.
pub struct ControlWatcher {
    path: PathBuf,
    profiles: Vec<String>,
    state: ControlState,
    signature: Option<(SystemTime, u64)>,
    parse_count: u64,
    warned: bool,
}

impl ControlWatcher {
    pub fn new(path: PathBuf, profiles: Vec<String>) -> Self {
        Self {
            path,
            profiles,
            state: ControlState::default(),
            signature: None,
            parse_count: 0,
            warned: false,
        }
    }

    pub fn parse_count(&self) -> u64 {
        self.parse_count
    }

    pub fn poll(&mut self) -> ControlState {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(_) => {
                // No control file is the documented default, not a fault.
                self.signature = None;
                return self.state.clone();
            }
        };
        let signature = metadata.modified().ok().map(|mtime| (mtime, metadata.len()));
        if signature.is_some() && signature == self.signature {
            return self.state.clone();
        }
        self.signature = signature;
        self.parse_count += 1;
        match self.parse() {
            Ok(state) => {
                self.warned = false;
                self.state = state;
            }
            Err(error) => {
                if !self.warned {
                    warn!(error = %error, "unusable control file; keeping the last known state");
                    self.warned = true;
                }
            }
        }
        self.state.clone()
    }

    fn parse(&self) -> Result<ControlState> {
        let source = fs::read_to_string(&self.path).context("failed to read the control file")?;
        let parsed: ControlFile =
            serde_json::from_str(&source).context("invalid control file contents")?;
        if !self.profiles.iter().any(|name| *name == parsed.profile) {
            anyhow::bail!("control file names a profile that is not configured");
        }
        Ok(ControlState {
            paused: parsed.paused,
            profile: parsed.profile,
        })
    }
}

/// Writes via a sibling temporary file and `rename`, so a reader never observes a partial write.
pub fn write_control(path: &Path, state: &ControlState) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(&ControlFile {
        paused: state.paused,
        profile: state.profile.clone(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default(),
    })
    .context("failed to encode the control file")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .context("failed to open the temporary control file")?;
    file.write_all(&payload)
        .context("failed to write the temporary control file")?;
    file.sync_all()
        .context("failed to flush the temporary control file")?;
    drop(file);
    fs::rename(&temporary, path).context("failed to install the control file")?;
    Ok(())
}
```

Add `mod control;` to the module declarations at the top of `crates/keylab/src/main.rs`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p keylab control::`
Expected: PASS, 5 tests.

- [x] **Step 6: Commit**

```bash
git add crates/keylab/src/control.rs crates/keylab/src/main.rs crates/keylab/Cargo.toml
git commit -m "feat(keylab): add an atomically written control file"
```

---

### Task 3: Schema v2 — profile table, columns, backfill

**Files:**
- Modify: `crates/keylab/src/store.rs:12-98` (`SCHEMA`), `:165` (`seal_tier_a`), `:218` (`seal_tier_b`), `:371` (`initialize_meta`)
- Test: `crates/keylab/src/store.rs` (existing inline `mod tests`)

**Interfaces:**
- Consumes: `config::DEFAULT_PROFILE` (Task 1).
- Produces:
  - `Store::register_profile(&mut self, name: &str) -> Result<i64>`
  - `Store::seal_tier_a(&mut self, device_id: i64, profile_id: i64, seal: &TierASeal) -> Result<()>`
  - `Store::seal_tier_b(&mut self, device_id: i64, profile_id: i64, seal: &TierBSeal) -> Result<()>`

- [x] **Step 1: Write the failing tests**

Add to the `mod tests` block in `crates/keylab/src/store.rs`:

```rust
    #[test]
    fn registering_a_profile_twice_reuses_the_row() {
        let (_temp, _path, mut store, _device_id) = open_store();
        let first = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        let second = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(first, second);
        let other = store
            .register_profile("training-de")
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_ne!(other, first);
    }

    #[test]
    fn the_default_profile_exists_with_id_one_after_open() {
        let (_temp, _path, store, _device_id) = open_store();
        let name: String = store
            .connection()
            .query_row("SELECT name FROM profile WHERE id = 1", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(name, crate::config::DEFAULT_PROFILE);
    }

    #[test]
    fn migrating_a_v1_database_backfills_every_row_to_default() {
        let (_temp, path, mut store, device_id) = open_store();
        let profile_id = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(device_id, profile_id, &sample_tier_a_seal())
            .unwrap_or_else(|error| panic!("{error:#}"));
        // Simulate a database written before the migration existed.
        store
            .connection()
            .execute_batch(
                "UPDATE bucket SET profile_id = NULL;
                 UPDATE meta SET value = '1' WHERE key = 'schema_version';",
            )
            .unwrap_or_else(|error| panic!("{error}"));
        drop(store);

        let reopened = Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        let orphaned: i64 = reopened
            .connection()
            .query_row("SELECT COUNT(*) FROM bucket WHERE profile_id IS NULL", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(orphaned, 0);
        let version: String = reopened
            .connection()
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(version, "2");
    }
```

If `sample_tier_a_seal()` does not already exist in the test module, add it, mirroring whatever the existing seal tests construct:

```rust
    fn sample_tier_a_seal() -> TierASeal {
        let mut data = TierAAccumulator::default();
        data.keystrokes = 30;
        data.active_ms = 1_000;
        TierASeal { bucket_id: 1_000, span_ms: 10_000, data }
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p keylab store::`
Expected: FAIL — `no such table: profile`, and `seal_tier_a` arity mismatch.

- [x] **Step 3: Implement the schema and migration**

Add to `SCHEMA` in `crates/keylab/src/store.rs`, after the `device` table:

```sql
CREATE TABLE IF NOT EXISTS profile (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
```

Add `profile_id INTEGER REFERENCES profile(id)` to both `bucket` and `key_window` in `SCHEMA` so fresh databases get it directly. The column is nullable in the DDL because `ALTER TABLE ADD COLUMN` on an existing database cannot add a `NOT NULL` column without a default; the migration below fills it and the write path never inserts `NULL`.

Replace the version check in `initialize_meta` with a migration:

```rust
    let schema_version: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read schema version")?;
    match schema_version.as_deref() {
        None | Some("2") => {}
        Some("1") => migrate_v1_to_v2(connection)?,
        Some(_) => bail!("unsupported database schema version"),
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '2')",
            [],
        )
        .context("failed to initialize schema version")?;
```

Add the migration and the default-profile seed:

```rust
/// v1 databases predate activity profiles. Every row they hold was captured on the Glove80 during
/// ordinary use, so backfilling them to the default profile is accurate, not a guess.
fn migrate_v1_to_v2(connection: &Connection) -> Result<()> {
    for statement in [
        "ALTER TABLE bucket ADD COLUMN profile_id INTEGER REFERENCES profile(id)",
        "ALTER TABLE key_window ADD COLUMN profile_id INTEGER REFERENCES profile(id)",
    ] {
        match connection.execute(statement, []) {
            Ok(_) => {}
            // Re-running the migration after a partial failure must not abort the daemon.
            Err(rusqlite::Error::SqliteFailure(_, Some(ref message)))
                if message.contains("duplicate column name") => {}
            Err(error) => {
                return Err(error).context("failed to add the profile column");
            }
        }
    }
    connection
        .execute_batch(
            "UPDATE bucket SET profile_id = 1 WHERE profile_id IS NULL;
             UPDATE key_window SET profile_id = 1 WHERE profile_id IS NULL;
             UPDATE meta SET value = '2' WHERE key = 'schema_version';",
        )
        .context("failed to backfill the default profile")?;
    info!("migrated database schema from version 1 to 2");
    Ok(())
}
```

Seed the default profile inside `initialize_meta`, before the migration call, so id 1 is always the default:

```rust
    connection
        .execute(
            "INSERT OR IGNORE INTO profile(id, name) VALUES (1, ?1)",
            [crate::config::DEFAULT_PROFILE],
        )
        .context("failed to seed the default profile")?;
```

Add `register_profile`, mirroring the `register_device` lookup-then-insert shape:

```rust
    pub fn register_profile(&mut self, name: &str) -> Result<i64> {
        let existing: Option<i64> = self
            .connection
            .query_row("SELECT id FROM profile WHERE name = ?1", params![name], |row| {
                row.get(0)
            })
            .optional()
            .context("failed to look up a profile")?;
        if let Some(profile_id) = existing {
            return Ok(profile_id);
        }
        self.connection
            .execute("INSERT INTO profile(name) VALUES (?1)", params![name])
            .context("failed to register a profile")?;
        Ok(self.connection.last_insert_rowid())
    }
```

Add `profile_id: i64` as the second parameter of `seal_tier_a` and `seal_tier_b`, and include the column in both `INSERT INTO bucket(...)` and `INSERT INTO key_window(...)` statements.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p keylab store::`
Expected: PASS. Existing seal tests need the new argument — pass `1` for the default profile.

- [x] **Step 5: Commit**

```bash
git add crates/keylab/src/store.rs
git commit -m "feat(keylab): add activity profiles to the schema with a v1 backfill"
```

---

### Task 4: Per-profile Tier B accumulators

**Files:**
- Modify: `crates/keylab/src/aggregate.rs:138-170` (`Aggregator`), `handle_event`, `bounded_footprint`
- Test: `crates/keylab/src/aggregate.rs` (existing inline `mod tests`)

**Interfaces:**
- Consumes: `config::MAX_PROFILES` (Task 1).
- Produces:
  - `Aggregator::new(bucket_id: i64, profile_count: usize) -> Self`
  - `Aggregator::set_profile(&mut self, profile_index: usize)`
  - `Aggregator::handle_event(&mut self, t_ms: u64, code: u16, value: i32, keymap: &Keymap, tier_b_seal_count: u32) -> Option<TierBSeal>` — unchanged signature; the active profile is held on the aggregator
  - `pub fn footprint_bound(profile_count: usize) -> usize`

- [x] **Step 1: Write the failing tests**

Add `use crate::config::MAX_PROFILES;` to the imports at the top of `crates/keylab/src/aggregate.rs` (it already imports `MIN_BUCKET_SECONDS` from that module). Then add to the `mod tests` block:

```rust
    #[test]
    fn each_profile_accumulates_tier_b_independently() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..1_500 {
            assert!(aggregate.handle_event(index, 30, 1, &keymap(), 2_000).is_none());
        }
        aggregate.set_profile(1);
        for index in 1_500..3_000 {
            assert!(
                aggregate.handle_event(index, 30, 1, &keymap(), 2_000).is_none(),
                "the second profile must start from zero, not inherit 1500"
            );
        }
        aggregate.set_profile(0);
        for index in 3_000..3_499 {
            assert!(aggregate.handle_event(index, 30, 1, &keymap(), 2_000).is_none());
        }
        let seal = aggregate.handle_event(3_499, 30, 1, &keymap(), 2_000);
        let seal = seal.unwrap_or_else(|| unreachable!("the first profile should reach 2000"));
        assert_eq!(seal.keystrokes, 2_000);
    }

    #[test]
    fn switching_profiles_does_not_discard_tier_b_progress() {
        let mut aggregate = Aggregator::new(0, 2);
        for index in 0..1_000 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        aggregate.set_profile(1);
        aggregate.set_profile(0);
        assert_eq!(aggregate.tier_b_total(), 1_000);
    }

    #[test]
    fn footprint_stays_bounded_across_every_profile() {
        let mut aggregate = Aggregator::new(0, MAX_PROFILES);
        for index in 0..20_000_u64 {
            aggregate.set_profile((index as usize) % MAX_PROFILES);
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(aggregate.bounded_footprint() <= footprint_bound(MAX_PROFILES));
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p keylab aggregate::`
Expected: FAIL — `Aggregator::new` takes 1 argument, `set_profile` not found.

- [x] **Step 3: Implement**

In `crates/keylab/src/aggregate.rs`, replace the single accumulator field:

```rust
    pub tier_b_accum: Vec<[u32; 81]>,
    tier_b_start_ts: Vec<Option<u64>>,
    profile_index: usize,
```

`Aggregator::new` takes `profile_count: usize`, clamps it to `1..=MAX_PROFILES`, and sizes both vectors to it. Add:

```rust
    /// A profile switch changes which Tier B histogram receives events. Nothing is discarded: a
    /// window sealed under one profile must contain only that profile's keystrokes, and resetting
    /// on every switch would keep the 2000-keystroke floor permanently out of reach.
    pub fn set_profile(&mut self, profile_index: usize) {
        if profile_index < self.tier_b_accum.len() {
            self.profile_index = profile_index;
        }
    }
```

Every existing `self.tier_b_accum[...]` becomes `self.tier_b_accum[self.profile_index][...]`, and `tier_b_start_ts` likewise. The seal check compares only the active profile's total against `tier_b_seal_count`, and on seal zeroizes only that profile's slot. `tier_b_total()` returns the active profile's sum.

`discard_partials` and `resync_after_sequence_loss` keep their current semantics — `discard_partials` zeroizes **all** profiles, `resync_after_sequence_loss` zeroizes none.

Add the bound helper:

```rust
pub fn footprint_bound(profile_count: usize) -> usize {
    TIER_A_FIXED_ENTRIES + 81 * profile_count.clamp(1, MAX_PROFILES) + MAX_HELD_KEYS + 16
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p keylab aggregate::`
Expected: PASS. Existing `Aggregator::new(0)` call sites in tests become `Aggregator::new(0, 1)`.

- [x] **Step 5: Update the debug assertion**

In `crates/keylab/src/main.rs:443`, replace the literal bound:

```rust
            debug_assert!(
                runtime.aggregate.bounded_footprint()
                    <= aggregate::footprint_bound(config.profiles.len())
            );
```

- [x] **Step 6: Run the full suite and commit**

```bash
cargo test -p keylab
git add crates/keylab/src/aggregate.rs crates/keylab/src/main.rs
git commit -m "feat(keylab): give every profile its own Tier B accumulator"
```

---

### Task 5: Soft pause

**Files:**
- Modify: `crates/keylab/src/aggregate.rs` (add `seal_or_discard_tier_a`)
- Test: `crates/keylab/src/aggregate.rs` (existing inline `mod tests`)

**Interfaces:**
- Consumes: Task 4's `Aggregator`.
- Produces: `Aggregator::seal_or_discard_tier_a(&mut self, next_bucket_id: i64, elapsed_ms: u64, floor: u32) -> Option<TierASeal>`

- [x] **Step 1: Write the failing tests**

```rust
    #[test]
    fn soft_pause_preserves_tier_b_and_seals_a_qualifying_tier_a_bucket() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..40 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        let seal = aggregate.seal_or_discard_tier_a(1, 5_000, 25);
        assert!(seal.is_some(), "40 keystrokes clears the floor of 25");
        assert_eq!(aggregate.tier_b_total(), 40, "soft pause must keep Tier B");
        assert_eq!(aggregate.tier_a.keystrokes, 0, "Tier A must restart empty");
    }

    #[test]
    fn soft_pause_discards_a_tier_a_bucket_below_the_floor() {
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..10 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(aggregate.seal_or_discard_tier_a(1, 5_000, 25).is_none());
        assert_eq!(aggregate.tier_a.keystrokes, 0);
        assert_eq!(aggregate.tier_b_total(), 10, "Tier B survives even a discarded Tier A");
    }

    #[test]
    fn soft_pause_clears_held_key_and_timing_context() {
        let mut aggregate = Aggregator::new(0, 1);
        aggregate.handle_event(0, 30, 1, &keymap(), 2_000);
        aggregate.seal_or_discard_tier_a(1, 5_000, 25);
        assert_eq!(aggregate.held.len(), 0, "a key held across a pause must not be timed");
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p keylab aggregate::soft_pause`
Expected: FAIL — `no method named 'seal_or_discard_tier_a'`.

- [x] **Step 3: Implement**

```rust
    /// Soft pause: stop counting without losing Tier B progress. The Tier A bucket is sealed when
    /// it clears the floor and discarded otherwise, and all cross-event timing context is dropped
    /// because the gap across a pause is wall-clock, not typing behaviour.
    pub fn seal_or_discard_tier_a(
        &mut self,
        next_bucket_id: i64,
        elapsed_ms: u64,
        floor: u32,
    ) -> Option<TierASeal> {
        let seal = self.tick(next_bucket_id, elapsed_ms, floor);
        if seal.is_none() {
            self.tier_a.zeroize();
            self.tier_a_span_ms.zeroize();
            self.tier_a_bucket_id = next_bucket_id;
        }
        self.held.zeroize();
        self.keys_since_mod_down.clear();
        self.last_event_ts.zeroize();
        self.last_event_ts = NO_EVENT_TS;
        self.last_alpha_ts.zeroize();
        self.last_keydown_ts.zeroize();
        self.bsp_run.zeroize();
        self.last_mod_release_ts.zeroize();
        self.last_mod_release_class.zeroize();
        self.bsp_run_after_mod_class.zeroize();
        seal
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p keylab aggregate::`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/keylab/src/aggregate.rs
git commit -m "feat(keylab): add soft pause that preserves Tier B progress"
```

---

### Task 6: Wire the control state into the event loop

**Files:**
- Modify: `crates/keylab/src/main.rs:231-320` (`event_loop`), `:449` (`refresh_pause_state`), `:506` (`replace_live_snapshot`), `:71` (`RuntimeDevice`)
- Test: `crates/keylab/src/main.rs` (existing inline `mod tests`), plus a manual verification step

**Interfaces:**
- Consumes: `ControlWatcher` (Task 2), `Store::register_profile` (Task 3), `Aggregator::set_profile` (Task 4), `Aggregator::seal_or_discard_tier_a` (Task 5).
- Produces: nothing consumed by later tasks except the `live_snapshot` JSON keys `paused` and `profile`.

- [x] **Step 1: Write the failing test**

Add to the `mod tests` block in `crates/keylab/src/store.rs`, beside the existing `live_snapshot_has_only_finger_marginals_and_rate` test:

```rust
    #[test]
    fn live_snapshot_reports_the_control_state() {
        let (_temp, _path, mut store, _device_id) = open_store();
        store
            .replace_live_snapshot(1_000, &[0; 10], 0, 0, true, "gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        let json: String = store
            .connection()
            .query_row("SELECT json FROM live_snapshot WHERE id = 1", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(json.contains("\"paused\":true"));
        assert!(json.contains("\"profile\":\"gaming\""));
    }
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cargo test -p keylab live_snapshot_reports`
Expected: FAIL — `replace_live_snapshot` takes 4 arguments, 6 supplied.

- [x] **Step 3: Extend the snapshot writer**

There is exactly one snapshot writer and it keeps one shape. In `crates/keylab/src/store.rs:265`, append `paused: bool` and `profile: &str` to `replace_live_snapshot` and add both to the `json!` object. Update its two call sites: `main.rs:132` (startup, pass `false` and `config.profiles[0]`) and `main.rs:527` (inside `replace_live_snapshot`, pass the resolved control state through). The existing `live_snapshot_has_only_finger_marginals_and_rate` test needs the two new arguments.

- [x] **Step 4: Replace pause handling in the event loop**

In `crates/keylab/src/main.rs`, delete `refresh_pause_state` and `pause_requested` in favour of a single resolver. `RuntimeDevice` gains `profile_id: i64`.

```rust
/// Resolves effective state from both channels. The `PAUSED` marker is the hard pause and keeps
/// its documented meaning: it discards partial aggregates. The control file is the soft pause and
/// preserves the Tier B accumulators.
fn refresh_control(
    watcher: &mut control::ControlWatcher,
    pause_path: &Path,
    config: &Config,
    store: &mut Store,
    devices: &mut HashMap<PathBuf, RuntimeDevice>,
    state: &mut ResolvedControl,
) -> Result<()> {
    let desired = watcher.poll();
    let hard_paused = pause_path.exists();

    if hard_paused != state.hard_paused {
        if hard_paused {
            discard_all_partials(devices)?;
        }
        state.hard_paused = hard_paused;
    }

    if desired.profile != state.profile {
        let next_bucket_id = current_bucket_id()?;
        let now = Instant::now();
        for runtime in devices.values_mut() {
            let elapsed_ms = duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
            if let Some(seal) = runtime.aggregate.seal_or_discard_tier_a(
                next_bucket_id,
                elapsed_ms,
                config.tier_a_seal_floor,
            ) {
                store.seal_tier_a(runtime.device_id, runtime.profile_id, &seal)?;
            }
            runtime.last_tier_a_tick = now;
        }
        let profile_id = store.register_profile(&desired.profile)?;
        let profile_index = config
            .profiles
            .iter()
            .position(|name| *name == desired.profile)
            .unwrap_or(0);
        for runtime in devices.values_mut() {
            runtime.profile_id = profile_id;
            runtime.aggregate.set_profile(profile_index);
        }
        info!(profile = %desired.profile, "activity profile changed");
        state.profile = desired.profile.clone();
        state.profile_id = profile_id;
        state.profile_index = profile_index;
    }

    if desired.paused != state.soft_paused {
        if desired.paused {
            let next_bucket_id = current_bucket_id()?;
            let now = Instant::now();
            for runtime in devices.values_mut() {
                let elapsed_ms =
                    duration_millis(now.saturating_duration_since(runtime.last_tier_a_tick));
                if let Some(seal) = runtime.aggregate.seal_or_discard_tier_a(
                    next_bucket_id,
                    elapsed_ms,
                    config.tier_a_seal_floor,
                ) {
                    store.seal_tier_a(runtime.device_id, runtime.profile_id, &seal)?;
                }
                runtime.last_tier_a_tick = now;
            }
        } else {
            let now = Instant::now();
            for runtime in devices.values_mut() {
                runtime.capture_watchdog.resume(now);
                runtime.last_tier_a_tick = now;
            }
        }
        state.soft_paused = desired.paused;
    }
    Ok(())
}
```

Add the resolver state type beside `RuntimeDevice`:

```rust
struct ResolvedControl {
    hard_paused: bool,
    soft_paused: bool,
    profile: String,
    profile_id: i64,
    profile_index: usize,
}

impl ResolvedControl {
    fn paused(&self) -> bool {
        self.hard_paused || self.soft_paused
    }
}
```

Replace all three `refresh_pause_state(...)` call sites in `event_loop` with `refresh_control(...)`, and every `if paused` / `if !paused` test with `state.paused()`. New devices created in `discover_devices` must be constructed with the current `profile_id` and `Aggregator::new(bucket_id, config.profiles.len())` followed by `set_profile(state.profile_index)`.

- [x] **Step 5: Add the idle auto-revert**

Track the last keystroke instant on `ResolvedControl`. Inside the bucket tick, when not paused and the elapsed idle exceeds `config.auto_revert_idle_seconds` and `state.profile != DEFAULT_PROFILE`, call `control::write_control` with `{ paused: state.soft_paused, profile: DEFAULT_PROFILE }`. The next `watcher.poll()` picks the change up through the normal path, so there is exactly one code path that applies a profile change.

- [x] **Step 6: Run the full suite**

Run: `cargo test -p keylab && cargo build --release --locked`
Expected: PASS, clean build.

- [x] **Step 7: Verify live**

```bash
sudo crates/keylab/install.sh && sudo systemctl restart keylab.service
printf '{"paused":false,"profile":"gaming","updated_at":0}\n' > ~/.local/share/glove80-lab/control.json
sleep 15 && type a few words
sqlite3 -readonly ~/.local/share/glove80-lab/keylab.db \
  "SELECT p.name, COUNT(*) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1;"
```

Expected: a `gaming` row appears, and existing rows still report `default`.

- [x] **Step 8: Commit**

```bash
git add crates/keylab/src/main.rs crates/keylab/src/store.rs
git commit -m "feat(keylab): apply control-file pause and profile state"
```

---

### Task 7: `keylabctl`

**Files:**
- Create: `crates/keylab/src/bin/keylabctl.rs`
- Modify: `crates/keylab/install.sh` (install the second binary), `crates/keylab/uninstall.sh` (remove it)

**Interfaces:**
- Consumes: `control::{ControlState, ControlWatcher, write_control}` (Task 2), `Config::load` (Task 1).
- Produces: the user-facing CLI. Nothing else depends on it.

- [x] **Step 1: Write the failing test**

Add to `crates/keylab/src/bin/keylabctl.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_supported_command() {
        assert_eq!(parse_command(&["status".into()]).unwrap(), Command::Status);
        assert_eq!(parse_command(&["pause".into()]).unwrap(), Command::Pause);
        assert_eq!(parse_command(&["resume".into()]).unwrap(), Command::Resume);
        assert_eq!(
            parse_command(&["profile".into(), "set".into(), "gaming".into()]).unwrap(),
            Command::SetProfile("gaming".to_owned())
        );
        assert_eq!(parse_command(&["profile".into(), "list".into()]).unwrap(), Command::ListProfiles);
        assert!(parse_command(&["nonsense".into()]).is_err());
        assert!(parse_command(&["profile".into(), "set".into()]).is_err());
    }
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cargo test -p keylab --bin keylabctl`
Expected: FAIL — `cannot find function 'parse_command'`.

- [x] **Step 3: Implement**

```rust
use anyhow::{bail, Result};

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status,
    Pause,
    Resume,
    ListProfiles,
    SetProfile(String),
}

fn parse_command(args: &[String]) -> Result<Command> {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["status"] => Ok(Command::Status),
        ["pause"] => Ok(Command::Pause),
        ["resume"] => Ok(Command::Resume),
        ["profile", "list"] => Ok(Command::ListProfiles),
        ["profile", "set", name] => Ok(Command::SetProfile((*name).to_owned())),
        _ => bail!("usage: keylabctl status|pause|resume|profile list|profile set <name>"),
    }
}
```

`main` loads the config to learn the profile list and the data directory, reads the current state through `ControlWatcher::poll`, applies the command, and writes with `write_control`. `SetProfile` rejects a name absent from `config.profiles` before writing. `Status` additionally prints `systemctl is-active keylab.service` output and the `live_snapshot.updated_at` age so a stale daemon is visible.

- [x] **Step 4: Run the test to verify it passes**

Run: `cargo test -p keylab --bin keylabctl`
Expected: PASS.

- [x] **Step 5: Install it**

In `crates/keylab/install.sh`, beside the existing binary install, add the same 0755 root-owned install for `target/release/keylabctl` to `/usr/local/bin/keylabctl`. Mirror the removal in `uninstall.sh`.

- [x] **Step 6: Commit**

```bash
git add crates/keylab/src/bin/keylabctl.rs crates/keylab/install.sh crates/keylab/uninstall.sh
git commit -m "feat(keylab): add the keylabctl control CLI"
```

---

### Task 8: Viewer state display and control endpoint

**Files:**
- Modify: `packages/viewer/src/server.ts:162-255` (`createViewerServer`), `packages/viewer/public/app.js`
- Modify: `packages/analysis/src/db.ts:3` (`SUPPORTED_SCHEMA_VERSION`)
- Test: `packages/viewer/test/viewer.test.ts`

**Interfaces:**
- Consumes: the `live_snapshot` JSON keys `paused` and `profile` (Task 6); `control.json` (Task 2).
- Produces: `POST /api/control`.

- [x] **Step 1: Write the failing tests**

Add to `packages/viewer/test/viewer.test.ts`:

```typescript
test("rejects a control POST from a foreign origin", async () => {
  const app = createViewerServer(testOptions());
  const response = await app.fetch(
    new Request(`http://127.0.0.1:${app.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ profile: "gaming" }),
    }),
  );
  expect(response.status).toBe(403);
  app.stop();
});

test("rejects a control POST without a JSON content type", async () => {
  const app = createViewerServer(testOptions());
  const response = await app.fetch(
    new Request(`http://127.0.0.1:${app.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "profile=gaming",
    }),
  );
  expect(response.status).toBe(415);
  app.stop();
});

test("rejects an unconfigured profile name", async () => {
  const app = createViewerServer(testOptions());
  const response = await app.fetch(
    new Request(`http://127.0.0.1:${app.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "not-a-profile" }),
    }),
  );
  expect(response.status).toBe(400);
  app.stop();
});
```

`packages/viewer/test/viewer.test.ts` already constructs `createViewerServer` options inline. Extract that literal into a `testOptions()` helper at the top of the file and add the two new fields:

```typescript
function testOptions() {
  return {
    ...existingInlineOptions,
    profiles: ["default", "training-de", "training-en", "gaming"],
    controlPath: `${import.meta.dir}/../../../.test-control.json`,
  };
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/viewer`
Expected: FAIL — 404 rather than 403/415/400.

- [x] **Step 3: Implement the endpoint**

In `packages/viewer/src/server.ts`, inside the request handler:

```typescript
if (url.pathname === "/api/control" && request.method === "POST") {
  // A localhost server accepts simple cross-origin POSTs from any page the browser has open.
  // Requiring a JSON content type forces a preflight, which the origin check then rejects.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== `http://${HOST}:${options.port}`) {
    return new Response("forbidden", { status: 403, headers: responseHeaders("text/plain") });
  }
  if (request.headers.get("content-type") !== "application/json") {
    return new Response("unsupported media type", {
      status: 415,
      headers: responseHeaders("text/plain"),
    });
  }
  const body = (await request.json()) as { paused?: boolean; profile?: string };
  if (body.profile !== undefined && !options.profiles.includes(body.profile)) {
    return new Response("unknown profile", { status: 400, headers: responseHeaders("text/plain") });
  }
  writeControlFile(options.controlPath, {
    paused: body.paused ?? currentControl(options.controlPath).paused,
    profile: body.profile ?? currentControl(options.controlPath).profile,
  });
  return new Response(null, { status: 204, headers: responseHeaders("text/plain") });
}
```

`writeControlFile` writes to `<path>.tmp` and renames, matching Task 2's contract. `options.profiles` and `options.controlPath` are new fields on `ViewerServerOptions`, defaulted in `parseViewerArgs` from the same config the daemon reads.

Bump `SUPPORTED_SCHEMA_VERSION` in `packages/analysis/src/db.ts:3` from `1` to `2`.

- [x] **Step 4: Render the state**

In `packages/viewer/public/app.js`, read `paused` and `profile` from the snapshot payload the SSE stream already delivers and render a header chip. Add a profile `<select>` and a pause toggle that `POST` to `/api/control` with `content-type: application/json`. The chip must reflect the **snapshot**, never the local selection, so the daemon stays authoritative.

- [x] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/viewer && bun test packages/analysis`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/viewer packages/analysis/src/db.ts
git commit -m "feat(viewer): show and set the keylab control state"
```

---

### Task 9: Profile-aware analysis

**Files:**
- Modify: `packages/analysis/src/metrics.ts:21-27` (`TimeRange`), `:614` (`calculateMetrics`)
- Modify: `packages/analysis/bin/analysis.ts` (add `--profile`)
- Test: `packages/analysis/test/metrics.test.ts`, `packages/analysis/test/fixture.ts`

**Interfaces:**
- Consumes: schema v2 (Task 3).
- Produces: `calculateMetrics(database, range, options?: { profile?: string })`.

- [x] **Step 1: Write the failing tests**

```typescript
test("defaults to the default profile only", () => {
  const database = fixtureWithProfiles();
  const metrics = calculateMetrics(database, parseSince("all"));
  expect(metrics.keystrokes).toBe(100);
});

test("selects a single named profile", () => {
  const database = fixtureWithProfiles();
  const metrics = calculateMetrics(database, parseSince("all"), { profile: "gaming" });
  expect(metrics.keystrokes).toBe(40);
});

test("pools every profile when asked", () => {
  const database = fixtureWithProfiles();
  const metrics = calculateMetrics(database, parseSince("all"), { profile: "*" });
  expect(metrics.keystrokes).toBe(140);
});
```

Extend `packages/analysis/test/fixture.ts` with `fixtureWithProfiles()` inserting a `profile` table with `default` (id 1) and `gaming` (id 2), 100 keystrokes of buckets on profile 1 and 40 on profile 2.

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/analysis`
Expected: FAIL — totals come back as 140 for every case.

- [x] **Step 3: Implement**

Add a `profile` clause to every bucket-scoped and window-scoped query in `metrics.ts`. Default is `profile_id = 1`; `"*"` omits the clause; a name resolves through `SELECT id FROM profile WHERE name = ?`. Add `--profile <name|*>` to `packages/analysis/bin/analysis.ts` and print the active profile in the report header so a filtered report is never mistaken for a full one.

**Do not add a device-pooling option for Tier B here.** That belongs to Project 2, which introduces the second position space.

- [x] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/analysis && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/analysis
git commit -m "feat(analysis): filter metrics by activity profile"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md` (the `## keylab -- Keystroke Telemetry` section)
- Modify: `docs/keylab.md`
- Modify: `docs/specs/2026-08-04-keylab-design.md` (the `### Pause` section at line 97)

- [x] **Step 1: Document the two pauses**

In `docs/keylab.md`, replace the single pause description with both mechanisms and their different guarantees:

| | command | guarantee | Tier B |
|---|---|---|---|
| soft | `keylabctl pause` | events read, nothing counted | preserved |
| hard | `touch ~/.local/share/glove80-lab/PAUSED` | device still open, all partials discarded | discarded |
| stop | `sudo systemctl stop keylab.service` | device closed, nothing read | discarded |

- [x] **Step 2: Document profiles**

Add a profiles subsection to `README.md` covering `keylabctl profile list|set`, the auto-revert, the fact that unlisted names are rejected, and this check:

```bash
sqlite3 -readonly "$HOME/.local/share/glove80-lab/keylab.db" \
  "SELECT p.name, SUM(b.keystrokes) FROM bucket b JOIN profile p ON p.id = b.profile_id GROUP BY 1 ORDER BY 2 DESC;"
```

- [x] **Step 3: Correct the superseded spec section**

`docs/specs/2026-08-04-keylab-design.md:97` describes the `PAUSED` marker as the only pause. Add a line pointing at this document and note that the v1 marker keeps its meaning as the hard pause.

- [x] **Step 4: Commit**

```bash
git add README.md docs/keylab.md docs/specs/2026-08-04-keylab-design.md
git commit -m "docs(keylab): document activity profiles and both pause modes"
```

---

# Implementation plan — Project 2 (phase level)

Gets its own step-level plan file when Project 1 has shipped.

- **Phase 2.1 — device rules.** Replace `device_name_contains: String` with `Vec<DeviceRule { name_contains, keymap_meta_path }>`; validate that names are unambiguous. Keep single-string configs loading via a serde alias so the running install does not break on upgrade.
- **Phase 2.2 — per-device keymaps.** `Store` holds a keymap per device rule; `meta` stores one `keymap_hash` per device. `discover_devices` resolves the rule that matched and hands the right keymap to that device's aggregator.
- **Phase 2.3 — QWERTY keymap-meta.** Hand-write `config/qwerty-ansi-meta.json` in the `keymap-meta.json` shape: standard touch-typing finger assignment, row indices, `KEY_102ND` included for DE ISO. No `isHrm`, no `modClass`.
- **Phase 2.4 — analysis guard.** Tier B queries must reject a request that spans more than one device. Tier A queries gain an optional device filter and may pool. This is the invariant most likely to be violated silently — it needs a test that fails loudly.
- **Phase 2.5 — viewer.** Device selector; render the geometry belonging to the selected device.
- **Phase 2.6 — trackball triage.** Query how much of the unattributed share is `EV_KEY` 272-279 from the Kensington, then decide filter-or-count.

# Implementation plan — Project 3 (phase level)

- **Phase 3a.1 — IBus probe.** Five minutes: open a text field, type `ä` through the Chars layer, log `keydown` events. Settles whether a browser trainer can attribute German physically. Do this **before** choosing a trainer form factor.
- **Phase 3a.2 — benchmark at option B1.** No code. Run monkeytype with `training-en` / `training-de` active. Confirm the keylab side segregates correctly and that the German window shows the umlaut-macro cost.
- **Phase 3b.1 — trainer store and engine.** New `crates/` or `packages/` unit with `session` and `keystroke` tables, in a 0700 directory carrying `CACHEDIR.TAG`. Capture, score against ground truth, persist.
- **Phase 3b.2 — weakness model.** Read keylab Tier A and Tier B plus trainer history; emit a ranked position and bigram weakness list.
- **Phase 3b.3 — position and bigram drills.** Generate weighted text from a word pool; never from the benchmark pool.
- **Phase 3c — mechanic drills.** Hold/tap discrimination, layer-hold accuracy, thumb clusters, `LONELY_MOD` misfire rate. Needs firmware-aware corpus generation from `config/layout.json5`.
- **Phase 3d — own-material corpus builder.** Commit bodies, code identifiers, German prose.

# Effort

| Project | Estimate |
|---|---|
| 1 — control, profiles, soft pause | Tasks 1-10, roughly one focused day |
| 2 — multi-device | 2-3 days, most of it the QWERTY keymap and the analysis guard |
| 3a — benchmark at B1 | under an hour once Project 1 ships |
| 3b — drills | 2-3 days |
| 3c — mechanic drills | open; depends on what Project 1's data shows |

# Known limitations

- **Manual profiles are forgettable.** Idle auto-revert mitigates but does not eliminate. A profile left active through a working day silently mislabels that day. The viewer chip is the second line of defence.
- **A soft pause is "not counted", not "not read".** The device stays open. Only `systemctl stop` closes it. Both are documented; do not conflate them.
- **Tier B rarely seals for short drills.** A 60-second test at 80 WPM is roughly 400 keystrokes against a floor of 2000, so a training profile may accumulate for weeks before sealing a window. This is correct behaviour, and the trainer's own store is the instrument for short sessions.
- **Position 68 is permanently zero** — evsieve `--block key:f23@kb`. Unchanged by this work.
- **`LALT` remains hand-ambiguous** (`docs/specs/2026-08-04-keylab-design.md:303`). Unchanged by this work.
- **Browser trainers may not see German physically.** Unresolved until Phase 3a.1 runs.
