# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Glove80 ZMK keyboard configuration generator written in TypeScript. It processes JSON layout configurations and generates ZMK device tree files (.dtsi), YAML for keymap-drawer visualization, and visual diagrams (SVG/PDF).

## Architecture

The build pipeline:
1. **Input**: `config/layout.json` defines keyboard layers and key mappings
2. **Processing**: TypeScript modules in `src/` transform the layout
3. **Output**: Generated files in `out/` directory (keymap.dtsi, keymap.yaml, keymap.svg, keymap.pdf)

Key modules:
- `src/index.ts` - Main orchestrator that reads configs and coordinates the build
- `src/schema.ts` - Zod schema validation for layout configuration
- `src/assemble.ts` - Assembles the final .dtsi file by injecting fragments into template
- `src/drawer.ts` - Converts layout to keymap-drawer YAML format
- `src/led.ts` - Handles LED configuration for per-key RGB

The system uses a template-based approach where `templates/keymap.template.dtsi` contains the base ZMK configuration with placeholder sections for custom device tree and behaviors that get injected during build.

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