# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Glove80 ZMK keyboard configuration generator written in TypeScript. It processes a JSON5 layout configuration and generates ZMK device tree files (.dtsi), YAML for keymap-drawer visualization, and visual diagrams (SVG/PDF).

## Architecture

The build pipeline:
1. **Input**: `config/layout.json5` defines keyboard layers, key mappings, LED colors, and profile indicators
2. **Processing**: TypeScript modules in `src/` validate, transform, and generate output
3. **Output**: Generated files in `out/` directory (keymap.dtsi, keymap.yaml, keymap.svg, keymap.pdf)

Key modules:
- `src/index.ts` - Main orchestrator that reads configs and coordinates the build
- `src/schema.ts` - Zod schema validation for layout configuration
- `src/generateDtsi.ts` - Generates the .dtsi keymap file from layout config. Handles profile indicator layer generation, macro/behavior injection into `config/glove80.keymap` template
- `src/drawer.ts` - Converts layout to keymap-drawer YAML format for SVG/PDF visualization
- `src/layout.ts` - Maps structured key/LED layouts (left/right/thumb) to physical row order
- `src/combos.ts` - Parses combo definitions from `config/combos.dtsi`

Config files consumed during build:
- `config/glove80.keymap` - ZMK template with `/* PLACEHOLDER_* */` markers for injection
- `config/behaviors.dtsi` - Custom ZMK behaviors (hold-taps, tap-dances)
- `config/macros.dtsi` - Custom ZMK macros
- `config/combos.dtsi` - Key combo definitions

## Profile Indicators

The `profileIndicators` config in `layout.json5` maps BT/USB profiles to LED colors for the F1-F10 key strip. The generator creates full-clone Base layers (one per BT profile) with different F1-F10 LED colors, inserted right after the Base layer (indices 1-4). This ensures overlay layers (Navigation, Magic, etc.) have higher indices and aren't shadowed.

**Important ZMK constraint**: `&trans` overlay layers do NOT work for this purpose because ZMK hold-tap behaviors don't propagate `ZMK_BEHAVIOR_TRANSPARENT` (see zmkfirmware/zmk#2368). Full clones are required.

**Layer references in `layout.json5` must use `LAYER_*` names** (e.g. `&thumb_left LAYER_Navigation SPACE`, `&mo LAYER_Special`) instead of numeric indices, because BT variant insertion shifts layer indices. These are resolved by the C preprocessor during firmware compilation.

## Commands

```bash
# Install dependencies
pnpm install

# Build everything: dtsi, yaml, svg, multi-page pdf (also copies pdf to ~/glove80-mapping.pdf)
pnpm build

# Compile firmware to UF2 files (requires Docker)
pnpm compile
```

## Dependencies

Required external tools (not in package.json):
- `keymap-drawer` - CLI tool for generating keyboard diagrams from YAML (install with: `pip install keymap-drawer`)
- `inkscape` - For converting SVG to PDF

## Custom Command: /prime

When starting work on this codebase, use `/prime` to get an overview of the current implementation status and next steps.