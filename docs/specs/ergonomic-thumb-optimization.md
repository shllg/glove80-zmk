# Ergonomic Thumb Optimization Spec

**Status:** In Progress
**Created:** 2026-02-09
**Goal:** Reduce left thumb strain (especially thumb spreading) to manage De Quervain's tenosynovitis while preserving overall layout quality.

---

## Background

Since switching to the current Glove80 layout (July/August 2024), right arm RSI resolved. However, the workload shifted heavily to the left thumb, which now handles SPACE (~3000+/day), BACKSPACE (~700+/day), DELETE (~200+/day), plus sustained layer-tap holds for Navigation and Special layers. This overloading caused De Quervain's tenosynovitis (inflamed APL/EPB thumb tendons) in the left hand, diagnosed end of December 2024.

Medical research confirms: thumb abduction, extension, and **sustained holds** are the worst movements for De Quervain's. The key insight is that **thumb spreading** (reaching for outer keys like left T6) is worse than high-frequency tapping on comfortable positions.

**Goal:** Reduce left thumb spread and provide finger-based alternatives for common editing keys. Secondary: consider Glove60 forward-compatibility.

---

## Original Thumb Layout (Before Optimization)

```
LEFT THUMB                               RIGHT THUMB
Upper: ESC(T1)  | tmux-N(T2)| tmux-O(T3) Upper: UP(T1)    | Magic(T2) | RSHFT(T3)
Lower: SPACE*(T4)| BSPC**(T5)| DEL(T6)    Lower: DOWN(T4)  | TAB***(T5)| RET****(T6)

*    hold=Nav layer,     tap=SPACE       (~3000+/day taps + ~100 holds)
**   hold=Special layer, tap=BACKSPACE   (~700+/day taps + ~20 holds)
***  hold=Media layer,   tap=TAB
**** hold=Chars layer,   tap=RETURN
```

**Problem areas:** Left T6 (DEL) requires painful thumb spread. Left T2/T3 (tmux macros) are not worth dedicated keys.

---

## Phase 1: Finger Combos (DONE)

Combos in `config/combos.dtsi` provide finger-based alternatives to left-thumb keys. All use `require-prior-idle-ms = <100>` to prevent false triggers during fast typing.

### 1.1 Editing Combos

| Done | ID | Combo | Keys | Action | Why |
|------|----|-------|------|--------|-----|
| [x] | 1.1.1 | U+I | Right upper row | Backspace | Replaces left thumb BSPC spread |
| [x] | 1.1.2 | J+K | Right home row | Escape | Backup for left thumb ESC |
| [x] | 1.1.4 | D+F | Left home row | Tab | Convenience (TAB stays on right T5 too) |

#### Won't Do

| ID | Combo | Keys | Action | Reason |
|----|-------|------|--------|--------|
| ~~1.1.3~~ | ~~K+L~~ | ~~Right home row~~ | ~~Enter~~ | RET on right T6 is comfortable, no need for combo |
| ~~1.1.5~~ | ~~F+J~~ | ~~Cross-hand home~~ | ~~Colon~~ | Superseded: moved to Chars layer U position |
| ~~1.1.6~~ | ~~Q+A~~ | ~~Left vertical~~ | ~~@ sign~~ | Superseded: moved to Chars layer I position |

### 1.2 Coding Symbol Combos — WON'T DO

> The current symbol layer already provides excellent access to all bracket pairs and coding symbols. Adding combos would be redundant.

### 1.3 Utility Combos

| Done | ID | Combo | Keys | Action |
|------|----|-------|------|--------|
| [x] | 1.3.3 | Comma+Dot | Right bottom row | Caps Word |

#### Won't Do

| ID | Combo | Keys | Action | Reason |
|----|-------|------|--------|--------|
| ~~1.3.1~~ | ~~S+D~~ | ~~Left home adjacent~~ | ~~Ctrl+C~~ | Unclear benefit over existing shortcut |
| ~~1.3.2~~ | ~~A+S~~ | ~~Left home outer~~ | ~~Ctrl+Z~~ | Unclear benefit over existing shortcut |

---

## Phase 2: Thumb Cluster Reorganization (DONE)

Complete thumb cluster rework: moved arrows to left thumb upper row, ESC to left T6, DEL to right T4, added speech-to-text shortcut on right T1, relocated Magic layer to left T3, removed tmux macros (user prefers remembering actual tmux combos).

### Changes Applied (from original layout)

| Done | Position | Original | New | Reason |
|------|----------|----------|-----|--------|
| [x] | Left T1 (`thumb_left[0][0]`) | `&kp ESC` | `&kp UP` | Arrow keys grouped on left upper thumb |
| [x] | Left T2 (`thumb_left[0][1]`) | `&macro_tmux_ctrl_b_n` | `&kp DOWN` | Arrow keys grouped on left upper thumb |
| [x] | Left T3 (`thumb_left[0][2]`) | `&macro_tmux_ctrl_b_o` | `&magic LAYER_Magic 0` | Magic moved here |
| [x] | Left T6 (`thumb_left[1][2]`) | `&kp DEL` | `&kp ESC` | ESC moved from T1, comfortable position |
| [x] | Right T1 (`thumb_right[0][0]`) | `&kp UP` | `&kp LG(LC(X))` | Speech-to-text shortcut (Super+Ctrl+X) |
| [x] | Right T2 (`thumb_right[0][1]`) | `&magic LAYER_Magic 0` | `&none` | Open slot (undecided) |
| [x] | Right T4 (`thumb_right[1][0]`) | `&kp DOWN` | `&kp DEL` | DEL moved here (comfortable, no spread) |

Also updated Chars and Media layers to match (DEL on right T4, ESC on left T6).

### Current Thumb Layout (After Phase 2)

```
LEFT THUMB                               RIGHT THUMB
Upper: UP(T1)   | DOWN(T2) | Magic(T3)   Upper: STT(T1)   | ???(T2)   | RSHFT(T3)
Lower: SPACE*(T4)| BSPC**(T5)| ESC(T6)    Lower: DEL(T4)   | TAB***(T5)| RET****(T6)

*    hold=Nav layer
**   hold=Special layer
***  hold=Media layer
**** hold=Chars layer
STT  = Speech-to-text (Super+Ctrl+X)
```

**Open slot:** Right T2 is available for future use.

---

## Phase 3: Future Improvements (TODO)

### 3.1 Sticky Special Layer

Once U+I combo for Backspace is habitual, convert left T5 from layer-tap to sticky layer:

| Done | ID | Position | Old | New | Reason |
|------|----|----------|-----|-----|--------|
| [ ] | 3.1.1 | `thumb_left[1][1]` Base | `&thumb_left 3 BSPC` | `&sl 3` | Sticky Special layer (tap once, type one umlaut, auto-returns). Removes BSPC from thumb entirely. |

### 3.2 Open Thumb Slot

Right T2 is available. Ideas under consideration:
- One-shot modifiers (sticky shift, hyper key)
- Media/system shortcuts (mute toggle)
- Leave as `&none` (minimal approach)

### 3.3 Combo Reference Page in PDF

The exported PDF (`out/keymap.pdf`) currently shows 2 pages: layers 1-3 and layers 4-6. Combos are invisible since they don't appear in any layer. A dedicated combo reference page would be useful.

#### Approach: Standalone SVG + concatenation

| Done | ID | Change |
|------|----|--------|
| [ ] | 3.3.1 | Add `combos` array to `config/layout.json5` (single source of truth) |
| [ ] | 3.3.2 | Update `src/schema.ts` Zod schema for combos validation |
| [ ] | 3.3.3 | Generate `combos.dtsi` content from layout.json5 (replace raw dtsi) |
| [ ] | 3.3.4 | Create `src/comboPage.ts` for combo reference SVG |
| [ ] | 3.3.5 | Wire into build pipeline and PDF generation |

---

## Glove60 Forward-Compatibility Note

The Glove60 has only 3 thumb keys per side (upper row only, no T4-T6). The current Glove80 layout keeps critical functions on the lower row (comfortable on Glove80). For Glove60 migration:
- SPACE, layer holds, TAB, RET would need to move to the 3 upper thumb keys per side
- This requires a separate Glove60-specific layout
- All finger combos (U+I, J+K, D+F, Comma+Dot) work identically on Glove60

---

## Verification Plan

1. **Build:** `make build` — verify keymap generates without errors
2. **Verify:** `make verify` — automated integrity checks
3. **Visual check:** Review `out/keymap.svg` — confirm thumb key labels match spec
4. **Compile:** `make compile` — build UF2 firmware files
5. **Flash:** `make flash` — flash to both halves
6. **Test combos:** Systematically test U+I (BSPC), J+K (ESC), D+F (TAB), Comma+Dot (Caps Word)
7. **Test DEL:** Verify DEL works on right T2
8. **Test Magic:** Verify Magic layer accessible from left T3
9. **Monitor symptoms:** Track left thumb pain over 1-2 weeks

---

## Critical Files

| File | Purpose |
|------|---------|
| `config/layout.json5` | All layer definitions and thumb cluster mappings |
| `config/combos.dtsi` | Combo definitions (raw dtsi, to be migrated to layout.json5) |
| `src/schema.ts` | Zod schema validation |
| `src/generateDtsi.ts` | Generates keymap .dtsi from layout config |
| `src/index.ts` | Build orchestrator |
| `out/keymap.dtsi` | Generated firmware output |
