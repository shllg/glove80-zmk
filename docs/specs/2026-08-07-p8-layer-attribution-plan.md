# P8 — spend the layer signal

Date: 2026-08-07
Status: implemented. Depends on the layer signal, which is deployed.
Design: `docs/keylab.md` — *Layer signalling and attribution*

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A key pressed on a layer is recorded as the key that was pressed.

## The defect (resolved)

Before this change, the firmware said which layer was active but nothing read that signal except `live_snapshot`, so the blind spot remained open: **5.41% of Tier B keystrokes — 757 of 14,000 in the last day — were recorded as position `-1`**, and the positional heatmap meant base-layer typing only.

Two attribution blind spots existed, and spending the layer signal fixes both:

- **A layer-shifted key.** `&kp LC(LA(E))` on Navigation emits `KEY_E`, which also exists on Base. The base-only resolver therefore assigned the press to Base E instead of the physical Navigation key at position 25. Positions are layer-independent, which is the whole reason this was fixable without a new position space.
- **A home row mod.** `&hml LCTRL F` emits `KEY_LEFTCTRL` on hold, which is not F's base keycode, so the modifier could not resolve to its emitting position. With the active layer known, `KEY_LEFTCTRL` on Base resolves to F's position.

**The important consequence: positional attribution needed no schema change.** Attribution is `(layer, keycode) → position`, and the position lands in the same 80-slot histogram it always did. The missing input was per-layer keycode tables in `keymap-meta.json`, which previously carried the base layer only. The separate per-layer usage split added later in this plan is the schema-v6 change.

## Global Constraints

- **Positions are layer-independent.** One position space per keyboard, as now. A layer is how a keycode is *resolved*, never a separate geometry.
- **No silent reattribution.** Presses that used to be unattributed will start landing on positions, so per-key totals jump at the boundary. That boundary must be recorded and stated, not discovered later in a chart.
- **The signal is advisory, never required.** A board that does not signal layers, or a signal that has not arrived yet, must behave exactly as today: base-layer resolution, unattributed otherwise.
- **Deploy-branch floor.** Never commit on the production branch; never push a branch that auto-deploys.
- **No AI attribution** in commits, comments, or docs.

## Definition of Done

A key pressed on any layer resolves to its physical position; the unattributed share falls to what genuinely has no position; the report says which layers the typing happened on; and a database recorded before the change still reads correctly.

---

## Task 1 — per-layer keycode tables in the metadata

In `packages/keymap/src/keymapMeta.ts`.

- [x] Emit `layers: [{ index, name, positions: [{ pos, linuxKeycode, binding }] }]` for every layer index the generated keymap defines, resolved the same way `layerSignal` resolves it.
- [x] Keep `positions` (the base layer) exactly as it is, so every existing consumer is untouched.
- [x] Include the layer tables in `keymapHash`.

**Requirements**
- `&none` emits nothing and contributes no entry. The layout has no `&trans`, and a `&trans` would need resolving down the layer stack — reject it with a clear error rather than guessing, and revisit if one is ever added.
- A home row mod contributes **two** entries for its position: the tap keycode and the modifier it emits on hold. That is what makes modifier holds attributable.
- A keycode appearing on two positions *within one layer* stays ambiguous and is dropped for that layer, exactly as the base layer does today.

**Tests**
- [x] `every_layer_index_has_a_keycode_table`
- [x] `a_home_row_mod_contributes_its_tap_and_its_modifier`
- [x] `a_none_binding_contributes_nothing`
- [x] `a_keycode_on_two_positions_of_one_layer_is_dropped`

## Task 2 — resolve against the active layer

In `crates/keylab/src/keymap.rs` and `aggregate.rs`.

- [x] `Keymap::resolve` takes the active layer and falls back to the base table when the layer is unknown or has no entry.
- [x] The aggregator resolves with the layer the last signal reported.

**Requirements**
- **Falling back is not the same as guessing.** No layer signal yet, a board that does not signal, or a layer outside the table: resolve against the base layer, which is today's behaviour and today's accuracy. Never attribute a key to a layer that was not reported.
- The lookup runs on every key event. Keep it a slice index plus one hash lookup; no allocation, no search.
- Tier C's position ring, `pos_count` and the hold histograms all inherit the improvement without changes of their own — verify rather than assume.

**Tests**
- [x] `a_key_pressed_on_a_layer_resolves_to_its_physical_position`
- [x] `a_modifier_hold_resolves_to_the_home_row_position_that_emitted_it`
- [x] `an_unknown_layer_falls_back_to_the_base_layer`
- [x] `a_board_without_layer_signals_is_unchanged`

## Task 3 — layer usage, which is a schema change

In `crates/keylab/src/store.rs` and `schema.sql`.

- [x] Schema v6: `layer_count(bucket_id, layer_id, presses)` as a child of `bucket`, following the six existing child tables exactly.
- [x] Count a press under the layer that resolved it.
- [x] Migration v5 → v6: create the table, backfill nothing.

**Requirements**
- Nothing is backfilled and the reason is stated in `docs/keylab.md`: no row recorded before today knows which layer it was typed on, and inventing `Base` for all of them would be a fabrication that reads as a measurement.
- The migration follows the v4 → v5 pattern, including the interrupted-migration test.
- `layer_id` indexes the same table the metadata publishes, so a renamed layer does not silently re-point old rows — the name lives in the metadata, the id in the database.

**Tests**
- [x] `v6_migrates_in_place_with_identical_totals`
- [x] `a_press_is_counted_under_the_layer_that_resolved_it`
- [x] `an_interrupted_migration_leaves_a_readable_database`

## Task 4 — say what changed

In `packages/analysis` and `docs/keylab.md`.

- [x] Report the per-layer split under Tier A, and keep printing the unattributed share.
- [x] `docs/keylab.md`: the boundary this creates, that it is not backfilled, and that per-key totals step up at it because presses that were unattributed now land on positions.

**Requirements**
- The unattributed share must not be quietly redefined. It should fall because fewer presses lack a position, and the documentation must say when it fell, so a drop is never read as an improvement in typing.
- A database with no `layer_count` rows in range reports the split as absent rather than as zero.

**Tests**
- [x] `the_layer_split_is_absent_rather_than_zero_before_the_boundary`
- [x] `unattributed_share_counts_only_presses_with_no_position`

---

## Implementation notes

Findings from starting Task 1 before this was handed over. The code was reverted; the tree is clean at `d426eea`. These are facts about the repository, not suggestions.

### The defect is larger than "unattributed"

`&kp LC(LA(E))` on Navigation emitted `KEY_E` with modifiers held. `innermostKeycode` (`keymapMeta.ts`) unwrapped `LC(LA(E))` to `E`, and the base table resolved `KEY_E` to the **base E position**. So a Navigation press was not recorded as unattributed — it was recorded on a key the finger never touched. The 5.41% unattributed share understated the problem; some layer presses were counted as base-layer presses.

### Task 1 specifics

- `resolveLayerNames` in `generateDtsi.ts` already resolves the layer order with the Base clones inserted. Split it: add `resolveLayers(layout): Layout["layers"]` returning the expanded array, and define `resolveLayerNames` in terms of it. `layerSignal.ts` uses the names; the layer tables need the bindings.
- Per layer: `toPhysicalRows(layer.keys).flat()` gives 80 bindings indexed by position, exactly as `createKeymapMeta` does for Base.
- Every keycode a binding can emit, per position:
  - `resolveBaseBinding(binding).linuxKeycode` — the tap keycode, `null` for `&none`, `&mo`, `&magic`, `&bootloader`, `&sys_reset`, and bare `&behavior` bindings.
  - **plus**, for `&hml`/`&hmr`, the modifier itself: match `/^&(?:hml|hmr)\s+(\S+)\s+/` and look the name up in `ZMK_TO_LINUX`. All eight modifier names are in the table (`LCTRL` 29, `LSHFT` 42, `RSHFT` 54, `LALT` 56, `RCTRL` 97, `RALT` 100, `LGUI` 125, `RGUI` 126).
- **`&trans` does not appear in `config/layout.json5`** (0 occurrences; 241 `&none`). Throw on it rather than resolving down the stack, as the plan says.
- Suggested shape, additive and optional so no existing consumer changes:
  ```
  layers: [{ index, name, positions: [{ pos, linuxKeycode, binding }] }]
  ```
  `KeymapMetaSchema` is `.strict()`, so the field must be added there. Keep `positions` (base) untouched.
- `computeKeymapHash` already takes `layerSignals` as a second argument; extend the same way, and the existing test `keymapHash is stable for unchanged positions and changes with a binding` still holds.

### Task 2 specifics

- `Keymap` (`crates/keylab/src/keymap.rs`) holds `by_keycode: HashMap<u16, KeyInfo>`. Add the per-layer tables as `Vec<HashMap<u16, KeyInfo>>` indexed by layer index, with the base table as the fallback. `KeymapFile` deserialises with `#[serde(default)]`, as `layer_signals` does.
- The active layer is already tracked: `Aggregator::active_layer_code()` returns the keycode of the last signal, and `Keymap::layer_signal(code) -> Option<&str>` names it. For resolution you want the **index**, so either store the index alongside the name in the signal map or add `layer_index(code) -> Option<u8>`.
- `handle_event` in `aggregate.rs` calls `keymap.resolve(code)` in `key_down`/`key_up` and in the Tier C ring. Every call site needs the layer, so threading it through `Aggregator` state is cleaner than changing every signature.
- The layer signal is consumed at the top of `handle_event` before any counting; do not disturb that path.

### Task 3 specifics — the cross-cutting one

Adding a seventh child table to `bucket` touches code outside `store.rs`:

- **`crates/keylab/src/registry.rs` holds `BUCKET_CHILDREN`**, a hard-coded array of the six child tables used by `keylabctl devices merge`. A seventh table not added there means a merge silently drops layer counts. This is the single easiest thing to miss in this task.
- `crates/keylab/src/schema.sql` is shared by `store.rs` and `registry.rs` through `include_str!`, so the table is defined once.
- Follow the v4 → v5 migration for shape, including its interrupted-migration test.
- `packages/analysis/src/db.ts` pins the schema version (`openKeylabDatabase`) — v6 must be pinned there too, or every TypeScript reader refuses the migrated database.

### Verification

`pnpm test` (keymap, analysis, viewer, trainer, `scripts/verify-build.sh`), `pnpm typecheck`, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt`.

**No firmware work.** The signal is already flashed and running; this plan is entirely host-side. `pnpm build` regenerates `out/keymap-meta.json`, which the daemon reads on its next start — no `pnpm compile`, no reflash.

**Deploying the daemon needs a release build**, which cost a wasted install once. `bin/install-keylab` generates the metadata, runs `cargo build --release --locked`, installs the release binaries and unit through the root installer, and enables/restarts the service. `cargo build` alone leaves `target/release/` stale.

### Boundary in the live database

The current database has data recorded under three different attribution schemes: before 2026-08-07 (no layer signal, ALT hands pooled), between the 12:22 flash and the 12:41 daemon install (signals counted as keystrokes — a few hundred phantom presses on device 1), and after. `meta.keymap_hash_history` records the keymap boundaries as `{hash, from_ts}`; nothing reads it automatically.
