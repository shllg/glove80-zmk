# Ergonomic Thumb Optimization Spec

**Status:** Draft
**Created:** 2026-02-09
**Goal:** Reduce left thumb workload by ~97% to resolve De Quervain's tenosynovitis while preserving overall layout quality.

---

## Background

Since switching to the current Glove80 layout (July/August 2024), right arm RSI resolved. However, the workload shifted heavily to the left thumb, which now handles SPACE (~3000+/day), BACKSPACE (~700+/day), DELETE (~200+/day), plus sustained layer-tap holds for Navigation and Special layers. This overloading caused De Quervain's tenosynovitis (inflamed APL/EPB thumb tendons) in the left hand, diagnosed end of December 2024.

Medical research confirms: thumb abduction, extension, and **sustained holds** are the worst movements for De Quervain's. The left thumb currently does all three, thousands of times per day.

**Goal:** Dramatically reduce left thumb workload while preserving the overall layout. Secondary: consider Go60 forward-compatibility.

---

## Current State

### Thumb Key Reachability (User Feedback)

- **Easy:** SPACE position (lower inner, T4) and ENTER position (lower outer, T6) -- these should hold the most-used keys
- **OK:** ESC (T1), BSPC (T5), TAB, SHIFT positions
- **Hard:** remaining positions (upper outer, etc.)

### Current Thumb Layout (Base Layer)

```
LEFT THUMB (AFFECTED)                    RIGHT THUMB (HEALTHY)
Upper: ESC   | tmux-N  | tmux-O         Upper: UP     | Magic  | RSHFT
Lower: SPACE*| BSPC**  | DEL            Lower: DOWN   | TAB*** | RET****

*    hold=Nav layer,     tap=SPACE       (~3000+/day taps + ~100 holds)
**   hold=Special layer, tap=BACKSPACE   (~700+/day taps + ~20 holds)
***  hold=Media layer,   tap=TAB
**** hold=Chars layer,   tap=RETURN
```

### Workload Imbalance

**Left thumb: ~4000+ presses/day. Right thumb: ~700 presses/day. Ratio 6:1.**

---

## Rollout Strategy

Phased approach: deploy Phase 1 (combos only) first to build muscle memory. After a few days of comfort, deploy Phase 2 (thumb changes). Phase 3 comes later once BSPC combo is habitual.

---

## Phase 1: Add Finger Combos (zero risk, immediate relief)

Populate the currently-empty `config/combos.dtsi` with combos that provide **alternatives** to left-thumb keys. No thumb layout changes yet -- just start building muscle memory.

All editing combos use `require-prior-idle-ms = <100>` to prevent false triggers during fast typing.

### 1.1 Editing Combos (Priority 1)

| Done | ID | Combo | Keys | Action | Why |
|------|----|-------|------|--------|-----|
| [x] | 1.1.1 | U+I | Right upper row | Backspace | Replaces left thumb BSPC |
| [x] | 1.1.2 | J+K | Right home row | Escape | Backup for left thumb ESC |
| [ ] | 1.1.3 | K+L | Right home row | Enter | Convenience (RET stays on right T6 too) |
| [x] | 1.1.4 | D+F | Left home row | Tab | Convenience (TAB stays on right T5 too) |
| ~~ | 1.1.5 | ~~F+J~~ | ~~Cross-hand home~~ | ~~Colon~~ | Superseded: moved to Chars layer U position |
| ~~ | 1.1.6 | ~~Q+A~~ | ~~Left vertical~~ | ~~@ sign~~ | Superseded: moved to Chars layer I position |

### 1.2 Coding Symbol Combos (Priority 2)

| Done | ID | Combo | Keys | Action |
|------|----|-------|------|--------|
| [ ] | 1.2.1 | E+D | Left vertical | `(` |
| [ ] | 1.2.2 | I+K | Right vertical | `)` |
| [ ] | 1.2.3 | W+S | Left vertical | `{` |
| [ ] | 1.2.4 | O+L | Right vertical | `}` |
| [ ] | 1.2.5 | R+F | Left vertical | `[` |
| [ ] | 1.2.6 | U+J | Right vertical | `]` |

### 1.3 Utility Combos (Priority 3)

| Done | ID | Combo | Keys | Action |
|------|----|-------|------|--------|
| [ ] | 1.3.1 | S+D | Left home adjacent | Ctrl+C (interrupt) |
| [ ] | 1.3.2 | A+S | Left home outer | Ctrl+Z (undo) |
| [ ] | 1.3.3 | Comma+Dot | Right bottom row | Caps Word |

### Files Changed

- `config/combos.dtsi` -- currently empty, populate with all combo definitions above

---

## Phase 2: Move SPACE to Right Thumb (biggest single impact)

This eliminates ~3000+ presses/day from the left thumb.

### Target Thumb Layout (After Phase 2)

```
LEFT THUMB (AFTER)                       RIGHT THUMB (AFTER)
Upper: ESC   | (none)  | (none)          Upper: DEL    | Magic  | RSHFT
Lower: mo(Nav)| BSPC** | (none)          Lower: SPACE  | TAB*** | RET****

** keep BSPC with layer-tap to Special for now (fallback while learning U+I combo)
*** hold=Media, tap=TAB (UNCHANGED)
**** hold=Chars, tap=RET (UNCHANGED)
```

### 2.1 Base Layer Thumb Changes

| Done | ID | Position | Old | New | Reason |
|------|----|----------|-----|-----|--------|
| [ ] | 2.1.1 | `thumb_left[1][0]` | `&thumb_left 1 SPACE` | `&mo 1` | Nav layer hold only, no SPACE tap |
| [ ] | 2.1.2 | `thumb_left[0][1]` | `&macro_tmux_ctrl_b_n` | `&none` | Tmux moves to Nav layer |
| [ ] | 2.1.3 | `thumb_left[0][2]` | `&macro_tmux_ctrl_b_o` | `&none` | Tmux moves to Nav layer |
| [ ] | 2.1.4 | `thumb_left[1][2]` | `&kp DEL` | `&none` | DEL moves to right T1 |
| [ ] | 2.1.5 | `thumb_right[1][0]` | `&kp DOWN` | `&kp SPACE` | SPACE lands here (pure tap, no hold) |
| [ ] | 2.1.6 | `thumb_right[0][0]` | `&kp UP` | `&kp DEL` | DEL moves here (UP/DOWN barely used, Nav has arrows) |

**Reachability check:** SPACE goes to right T4 (easy-reach position, matches left T4 feel). RET stays on right T6 (easy-reach). DEL goes to right T1 (OK-reach). This matches reported comfort zones.

### 2.2 Navigation Layer Additions

Tmux macros move here (and get fixed to use Ctrl+E prefix).

| Done | ID | Position | Layer | Old | New | Reason |
|------|----|----------|-------|-----|-----|--------|
| [ ] | 2.2.1 | `left[2][1]` (Q pos) | Nav | `&none` | `&macro_tmux_prefix_n` | Hold Nav + Q = tmux next window |
| [ ] | 2.2.2 | `left[2][2]` (W pos) | Nav | `&none` | `&macro_tmux_prefix_o` | Hold Nav + W = tmux other pane |
| [ ] | 2.2.3 | `thumb_right[1][0]` | Nav | `&none` | `&kp SPACE` | SPACE available while navigating |

### 2.3 Non-Base Layer Updates

Update all non-base layers to put SPACE on right T4 and clear left thumb positions.

| Done | ID | Layer | Left thumb lower | Right thumb lower |
|------|----|-------|-----------------|-------------------|
| [ ] | 2.3.1 | Chars (2) | `[&none, &none, &none]` | `[&kp SPACE, &kp BSPC, &mo 2]` |
| [ ] | 2.3.2 | Special (3) | `[&none, &mo 3, &none]` | `[&kp SPACE, &none, &none]` |
| [ ] | 2.3.3 | Media (4) | `[&none, &none, &none]` | `[&kp SPACE, &mo 4, &kp RET]` |

Chars layer left thumb upper also clears: `[&none, &none, &none]` (colon/dot/@ now via combos).

### 2.4 Tmux Macro Fix

The keyboard macros currently send `Ctrl+B` but the actual tmux prefix is `Ctrl+E`. Fix by updating the macros in the generated dtsi:

| Done | ID | Change |
|------|----|--------|
| [ ] | 2.4.1 | Rename `macro_tmux_ctrl_b_n` to `macro_tmux_prefix_n`, change `&kp RCTRL` + `&kp B` to `&kp RCTRL` + `&kp E` |
| [ ] | 2.4.2 | Rename `macro_tmux_ctrl_b_o` to `macro_tmux_prefix_o`, change similarly |
| [ ] | 2.4.3 | Update all references in `config/layout.json5` to new names |

### Files Changed

- `config/layout.json5` -- All thumb cluster changes across all 6 layers, tmux macro renames
- `src/` (macro generation) -- Tmux macro rename and key fix

---

## Phase 3: Complete Left Thumb Unloading (after combo muscle memory settles)

Once U+I combo for Backspace is reliable, convert left T5 from layer-tap to sticky layer.

### 3.1 Sticky Special Layer

| Done | ID | Position | Layer | Old | New | Reason |
|------|----|----------|-------|-----|-----|--------|
| [ ] | 3.1.1 | `thumb_left[1][1]` | Base | `&thumb_left 3 BSPC` | `&sl 3` | Sticky Special layer (tap once, type one umlaut, auto-returns) |

### Final Left Thumb Layout (Phase 3)

```
Upper: ESC   | (none) | (none)     <-- only 1 active key in upper row
Lower: mo(Nav) | sl(Special) | (none)  <-- 2 keys: Nav hold + Special one-shot tap
```

### Files Changed

- `config/layout.json5` -- `thumb_left[1][1]` base layer change

---

## Workload Redistribution Summary

| Function | Before (left thumb) | After | Change ID |
|----------|-------------------|-------|-----------|
| SPACE | Left T4 (~3000/day) | Right T4 tap | 2.1.1, 2.1.5 |
| BACKSPACE | Left T5 (~700/day) | U+I combo (fingers) | 1.1.1, 3.1.1 |
| DELETE | Left T6 (~200/day) | Right T1 tap | 2.1.4, 2.1.6 |
| ESC | Left T1 (~100/day) | Left T1 (keep) + J+K combo backup | 1.1.2 |
| Tmux macros | Left T2/T3 (~80/day) | Nav layer Q/W keys | 2.1.2, 2.1.3, 2.2.1, 2.2.2 |
| Colon | Chars layer left T1 | F+J combo | 1.1.5 |
| @ sign | Chars layer left T3 | Q+A combo | 1.1.6 |
| Nav layer hold | Left T4 (~100 holds/day) | Left T4 (keep, but no SPACE dual-duty) | 2.1.1 |
| Special layer | Left T5 hold (~20/day) | Left T5 sticky tap (Phase 3) | 3.1.1 |

**Left thumb total after Phase 3: ~120 presses/day** (down from ~4000+). A **97% reduction**.

---

## Combo Reference Page in PDF

The exported PDF (`out/keymap.pdf`) currently shows 2 pages: layers 1-3 and layers 4-6. Combos are invisible since they don't appear in any layer. We need a dedicated combo reference page appended to the PDF.

### Approach: Standalone SVG + concatenation

Generate a separate combo reference SVG, convert to PDF, and merge it as the final page of `out/keymap.pdf` via `pdfunite`.

### 4.1 Combo Metadata in layout.json5

Add a `combos` array to `config/layout.json5` so combo definitions live alongside the layout (single source of truth for both firmware generation and visualization).

| Done | ID | Change |
|------|----|--------|
| [ ] | 4.1.1 | Add `combos` array to `config/layout.json5` schema with fields: `name`, `keys` (pair of key labels like `["U", "I"]`), `action` (display label like `"Bksp"`), `category` (`"editing"` / `"symbol"` / `"utility"`), `timeout_ms`, `require_prior_idle_ms` (optional) |
| [ ] | 4.1.2 | Update `src/schema.ts` Zod schema to validate the `combos` array |
| [ ] | 4.1.3 | Update `src/generateDtsi.ts` to generate `combos.dtsi` content from `layout.json5` combos array (replacing the raw dtsi file approach) |

### 4.2 SVG Combo Reference Generator

New module `src/comboPage.ts` that generates a standalone SVG showing all combos as a formatted reference table, grouped by category.

| Done | ID | Change |
|------|----|--------|
| [ ] | 4.2.1 | Create `src/comboPage.ts` that takes parsed `Layout` and generates an SVG string containing a combo reference table |
| [ ] | 4.2.2 | Layout: grouped sections (Editing, Symbols, Utility), each combo shown as `Key1 + Key2 → Action` with consistent styling |
| [ ] | 4.2.3 | Match page dimensions / font style to the keymap-drawer output so it looks cohesive in the final PDF |

### 4.3 Build Pipeline Integration

Wire the combo page into the build + PDF pipeline.

| Done | ID | Change |
|------|----|--------|
| [ ] | 4.3.1 | Update `src/index.ts` to call `generateComboPageSvg()` and write `out/combos.svg` |
| [ ] | 4.3.2 | Update `scripts/generate-pdf.sh` to convert `out/combos.svg` to `out/temp_pdf/combos.pdf` via Inkscape |
| [ ] | 4.3.3 | Update `pdfunite` call to include `combos.pdf` as the final page: `pdfunite page1.pdf page2.pdf combos.pdf out/keymap.pdf` |

### Output

The final `out/keymap.pdf` becomes 3 pages:
1. Base + Navigation + Chars layers (existing)
2. Special + Media + Magic layers (existing)
3. **Combo Reference** (new) -- grouped table of all combos with key pairs and actions

---

## Go60 Forward-Compatibility Note

The Go60 has only 3 thumb keys per side (upper row only, no T4-T6). Our design puts all critical functions either on combos or the right thumb lower row. For Go60 migration:
- SPACE, TAB, RET would need to move to the 3 right upper thumb keys
- Nav layer access would need a combo (e.g., left T1+T2)
- All combos work identically on Go60

This is a future task but the combo-heavy approach makes Go60 migration straightforward.

---

## Verification Plan

1. **Build:** `pnpm build` to generate `out/keymap.dtsi` -- verify combos and thumb changes appear correctly
2. **Visual check:** `pnpm draw` to generate SVG diagram -- visually confirm thumb key labels
3. **Compile:** `pnpm compile` (requires Docker) to build UF2 firmware files
4. **Flash one half first:** Flash the left half, verify it works with the old right half
5. **Flash second half:** Flash the right half
6. **Test each combo:** Systematically test U+I, J+K, D+F, K+L, F+J, Q+A
7. **Test SPACE on right thumb:** Type normally, verify SPACE works reliably
8. **Test Nav layer:** Hold left T4, verify arrows and modifiers work
9. **Test Chars layer:** Hold right T6, verify symbols and combos work
10. **Monitor symptoms:** Track left thumb pain over 1-2 weeks

---

## Critical Files

| File | Purpose |
|------|---------|
| `config/layout.json5` | All thumb cluster changes across all 6 layers + combo definitions |
| `src/schema.ts` | Zod schema (needs `combos` array added) |
| `src/generateDtsi.ts` | Build system (generate combos from layout.json5) |
| `src/comboPage.ts` | New: generates combo reference SVG page |
| `src/index.ts` | Orchestrator (wire in combo page generation) |
| `scripts/generate-pdf.sh` | PDF pipeline (add combos.pdf to concatenation) |
| `templates/keymap.template.dtsi` | Has `PLACEHOLDER_COMBOS` marker |
| `out/keymap.dtsi` | Generated firmware output |
| `out/combos.svg` | Generated combo reference page |
| `out/keymap.pdf` | Final 3-page PDF |
