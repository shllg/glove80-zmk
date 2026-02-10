# Glove80 ZMK Optimization Spec

## Overview

This specification targets combo additions, layer optimization, and timing tuning for a high-velocity developer workflow (Hyprland + tmux + Neovim) on the Glove80.

**Current State:** 6 layers (Base/Nav/Chars/Special/Media/Magic), home-row mods, paired bracket macros, tmux/Hyprland macros. `combos.dtsi` is **empty**.

---

## 1. Combo Recommendations

Combos are simultaneous keypresses — zero hold delay, pure speed. These are the highest-ROI additions to the keyboard.

> **Important:** Key position indices below are approximate for the Glove80 matrix. Verify against your `layout.json5` physical positions before implementing.

### Editing Essentials

| Combo | Keys | Action | Rationale |
|-------|------|--------|-----------|
| J+K | Home row right | `Escape` | Most popular ZMK combo. Eliminates reaching for Esc key. Critical for Neovim. |
| D+F | Home row left inner | `Tab` | Fast indentation, tab completion without leaving home row. |
| K+L | Home row right | `Enter` | Submit commands without thumb stretch. |
| U+I | Upper row right | `Backspace` | Quick corrections without thumb movement. |
| F+J | Cross-hand home row | `:` (colon) | Instant Neovim command mode without Shift. |

### Coding Symbols (Vertical Pairs)

| Combo | Keys | Action | Rationale |
|-------|------|--------|-----------|
| D+E | Left middle col vertical | `(` | Parentheses without layer switch |
| K+I | Right middle col vertical | `)` | Mirror of above |
| S+W | Left ring col vertical | `{` | Braces for code blocks |
| L+O | Right ring col vertical | `}` | Mirror of above |
| F+R | Left index col vertical | `[` | Brackets for arrays |
| J+U | Right index col vertical | `]` | Mirror of above |

### App-Specific Macros

| Combo | Keys | Action | Rationale |
|-------|------|--------|-----------|
| Left+Right inner thumb | Thumb keys | `Ctrl+E` (tmux prefix) | One-shot tmux prefix |
| X+C | Left bottom row | `Space` (Neovim leader) | Alternative leader key access |
| Comma+Dot | Right bottom row | `Caps Word` | Smart caps for CONSTANTS |
| W+E | Left upper adjacent | `Super+Q` (kill window) | Quick Hyprland window close |

### Utility

| Combo | Keys | Action | Rationale |
|-------|------|--------|-----------|
| S+D | Left home adjacent | `Ctrl+C` | Interrupt/cancel without Ctrl hold |
| A+S | Left home outer | `Ctrl+Z` | Quick undo |

### ZMK Code Template

```dts
/ {
    combos {
        compatible = "zmk,combos";

        /* --- EDITING ESSENTIALS --- */

        combo_esc {
            timeout-ms = <40>;
            key-positions = <POS_J POS_K>;
            bindings = <&kp ESC>;
            require-prior-idle-ms = <100>;
        };

        combo_tab {
            timeout-ms = <40>;
            key-positions = <POS_D POS_F>;
            bindings = <&kp TAB>;
            require-prior-idle-ms = <100>;
        };

        combo_enter {
            timeout-ms = <40>;
            key-positions = <POS_K POS_L>;
            bindings = <&kp RET>;
            require-prior-idle-ms = <100>;
        };

        combo_bspc {
            timeout-ms = <40>;
            key-positions = <POS_U POS_I>;
            bindings = <&kp BSPC>;
            require-prior-idle-ms = <100>;
        };

        combo_colon {
            timeout-ms = <40>;
            key-positions = <POS_F POS_J>;
            bindings = <&kp COLON>;
            require-prior-idle-ms = <100>;
        };

        /* --- CODING SYMBOLS (Vertical Pairs) --- */

        combo_lpar {
            timeout-ms = <40>;
            key-positions = <POS_D POS_E>;
            bindings = <&kp LPAR>;
        };

        combo_rpar {
            timeout-ms = <40>;
            key-positions = <POS_K POS_I>;
            bindings = <&kp RPAR>;
        };

        combo_lbrc {
            timeout-ms = <40>;
            key-positions = <POS_S POS_W>;
            bindings = <&kp LBRC>;
        };

        combo_rbrc {
            timeout-ms = <40>;
            key-positions = <POS_L POS_O>;
            bindings = <&kp RBRC>;
        };

        combo_lbkt {
            timeout-ms = <40>;
            key-positions = <POS_F POS_R>;
            bindings = <&kp LBKT>;
        };

        combo_rbkt {
            timeout-ms = <40>;
            key-positions = <POS_J POS_U>;
            bindings = <&kp RBKT>;
        };

        /* --- UTILITY --- */

        combo_capsword {
            timeout-ms = <50>;
            key-positions = <POS_COMMA POS_DOT>;
            bindings = <&caps_word>;
        };

        combo_interrupt {
            timeout-ms = <40>;
            key-positions = <POS_S POS_D>;
            bindings = <&kp LC(C)>;
        };

        combo_undo {
            timeout-ms = <40>;
            key-positions = <POS_A POS_S>;
            bindings = <&kp LC(Z)>;
        };
    };
};
```

---

## 2. Timing Tuning for Fast Typists

### Combo Settings (`glove80.conf`)

```ini
# Allow multiple combos sharing keys
CONFIG_ZMK_COMBO_MAX_COMBOS_PER_KEY=5
CONFIG_ZMK_COMBO_MAX_KEYS_PER_COMBO=4
```

### Combo Timeout

- **30-40ms** for horizontal neighbors (J+K, D+F) — fast typists press these within 30ms
- **40-50ms** for vertical pairs (D+E, K+I) — slightly more time needed for vertical stretch
- **50ms** for cross-hand combos — more forgiving since no roll risk

### `require-prior-idle-ms` on Combos

Set `require-prior-idle-ms = <100>` on editing combos (Esc, Tab, Enter, Backspace) to prevent false triggers during fast typing. This means the combo only fires if you haven't pressed any other key in the last 100ms.

For symbol combos (brackets, braces), you can omit this since you typically pause briefly before typing a symbol.

### Home Row Mod Tuning

Current settings are good. Consider:
- If getting false triggers during fast prose typing: bump `require-prior-idle-ms` from 75ms to 100ms
- If mods feel sluggish when intentionally holding: reduce `tapping-term-ms` from 200ms to 180ms
- `quick-tap-ms: 150ms` is correct for fast double-taps

---

## 3. Navigation Layer Improvements

### Right Hand (Keep Cursor Movement)
Current layout is solid. Consider adding:

| Key | Current | Suggested Addition |
|-----|---------|-------------------|
| Y | - | `Ctrl+O` (Neovim jump back) |
| P | - | `Ctrl+I` (Neovim jump forward) |
| ; | - | `Ctrl+]` (go to definition) |

### Left Hand (Add Tool Control)

| Key | Suggested | Action |
|-----|-----------|--------|
| A | `Ctrl+E, p` | tmux: previous window |
| S | `Ctrl+E, n` | tmux: next window |
| D | `Ctrl+E, z` | tmux: zoom pane toggle |
| F | `Ctrl+E, [` | tmux: copy mode |
| Q | `Super+Q` | Hyprland: close window |
| W | `Super+Shift+H` | Hyprland: move focus left |
| E | `Super+Shift+L` | Hyprland: move focus right |

---

## 4. Layer Architecture Suggestions

### Current (Good)
0. Base (QWERTY + HRM)
1. Navigation (numbers + arrows + macros)
2. Chars/Symbols
3. Special/International (German)
4. Media
5. Magic/System

### Optimization Ideas

1. **Consolidate Special into Chars**: German characters (umlauts) could live on the Chars layer using a modifier, freeing up Layer 3 for a dedicated "App Control" layer

2. **App Control Layer (if freed):**
   - Left hand: Hyprland window management (focus, move, resize, workspace switch)
   - Right hand: tmux control (split, zoom, session switch, window navigation)
   - This eliminates needing macros on other layers

3. **Mouse Layer**: Your firmware fork supports pointing — consider adding a mouse emulation layer for rare cases when you need cursor control without reaching for a mouse

---

## 5. RGB Per-Layer Refinements

Current color scheme is excellent. Consider:
- **Combos layer indicator**: Since combos don't change layers, use a brief RGB flash (if supported by firmware) when a combo triggers
- **App Control layer** (if added): Use orange/amber to distinguish from navigation (yellow)

---

## Implementation Priority

1. **Combos** (30 min) — biggest immediate impact, zero downside risk
2. **Nav layer left-hand improvements** (15 min) — tmux macros on nav layer
3. **Timing tuning** (10 min) — `require-prior-idle-ms` on combos
4. **Layer consolidation** (1-2 hrs) — bigger refactor, do when ready

---

## Notes

- All key position indices (`POS_J`, etc.) need to be replaced with actual Glove80 matrix indices from your `layout.json5`
- Test combos one at a time — add 3-4, use for a day, then add more
- The `require-prior-idle-ms` on combos is critical for avoiding false triggers during fast typing
- Vertical combos (D+E, S+W) are generally safer than horizontal combos for fast typists
