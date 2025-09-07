# Glove80 ZMK Configuration Generator

This is my personal configuration system for my Glove80 keyboard. I built this to manage my own keymap and generate ZMK firmware with the features I need. Feel free to fork it or use it as inspiration for your own setup, but keep in mind it's tailored to my specific workflow and preferences. Your mileage may vary! 

I'm quite curious about your feedback - reach out to me here on GitHub or on Twitter [@shllg](https://twitter.com/shllg).

## Motivation

The [Glove80 Editor](https://my.glove80.com/#/edit) is awesome and definitely the right starting point when you customize your Glove80 keyboard - like I did. Along the way I found a couple of things that are not possible with the web editor but I wanted to have:

1. Per-key RGB for each layer to have a visual indicator when switching. Especially useful for my character layer.
2. Better home row mods by using the `global-quick-tap-ms` setting which didn't work for me in the editor


## Why darknao's ZMK Fork?

The compile script uses [darknao's ZMK fork](https://github.com/darknao/zmk) (branch `rgb-layer-24.12`) instead of the official ZMK firmware. This is necessary because the Glove80 web interface exports keymaps with advanced features that aren't available in standard ZMK:

- **RGB_STATUS and per-key RGB control**: The web interface generates RGB commands like `RGB_STATUS` that only this fork understands
- **Enhanced mouse support**: Smooth scrolling and advanced mouse key features
- **Layer-based RGB effects**: Change LED colors based on active layers
- **Community features**: Additional behaviors and macros from the Glove80 community

Without this fork, the firmware would fail to compile with syntax errors on RGB commands and missing mouse features.

## Overview

This TypeScript-based build system takes a JSON configuration and generates:
- ZMK firmware files (`.uf2`) ready to flash
- Visual keyboard diagrams (SVG/PDF)
- YAML for keymap-drawer visualization

## Quick Start

```bash
# Install dependencies
pnpm install

# Build keymap from config
pnpm build

# Compile firmware (requires Docker)
pnpm compile

# Flash the firmware files from firmware/ directory to your keyboard
```

## Project Structure

```
config/         # Layout configuration
  layout.json   # Define your layers and keys
  led.json      # LED settings

out/            # Generated files
  keymap.dtsi   # ZMK device tree
  keymap.yaml   # For visualization
  keymap.svg    # Visual diagram

firmware/       # Compiled firmware
  glove80_left.uf2
  glove80_right.uf2

templates/      # ZMK template from Glove80 web interface
src/            # TypeScript build system
```

## Workflow

(TODO: Update workflow and eventually opt out of editor export. I think that's not a good strategy. Maybe I can prepare a glove80 dtsi to json export to get an initial starting point based on existing config?)

1. Export your keymap from the [Glove80 Layout Editor](https://my.glove80.com)
2. Save as `templates/keymap.template.dtsi`
3. Edit `config/layout.json` with your layout
4. Run `pnpm build && pnpm compile`
5. Flash the `.uf2` files to your keyboard

## Requirements

- Node.js & pnpm
- Docker (for firmware compilation)
- keymap-drawer (optional, for diagrams): `pip install keymap-drawer`
- Inkscape (optional, for PDF): `sudo pacman -S inkscape`

## Configuration

The `config/layout.json` defines your keyboard layers:

(TODO: Update with full config)

```json
{
  "keyboard": "glove80",
  "layers": [
    {
      "name": "Base",
      "rows": [
        ["Q","W","E","R","T"],
        ["A","S","D","F","G"],
        ["Z","X","C","V","B"]
      ]
    }
  ]
}
```

## Building Firmware

The compile process uses Docker to ensure consistent builds:

(TODO: Prepare a Dockerfile which includes all the config and can be used for compilation. That would improve subsequent build times a lot)
 
```bash
pnpm compile
```

This will:
1. Create a Docker container with the ZMK build environment
2. Clone darknao's RGB-enabled ZMK fork
3. Build firmware for both keyboard halves
4. Output `.uf2` files to `firmware/`

## Flashing

1. Put keyboard in bootloader mode (Magic + F1+F3+F5)
2. Copy the appropriate `.uf2` file to the mounted drive
3. Repeat for the other half

## Credits

This project wouldn't exist without the amazing work of others:

- **[darknao](https://github.com/darknao/zmk)** for maintaining the enhanced ZMK fork with RGB and mouse support that makes all the advanced Glove80 features possible
- **[sunaku](https://github.com/sunaku/glove80-keymaps)** for showing the way with their incredible Glove80 keymap system - finding the right approach for building ZMK firmware locally would have been nearly impossible without their work as a reference

I'm deeply grateful to both of them for sharing their knowledge and code with the community. It's hard to figure out this path on your own, and their work made it possible for me to build exactly what I needed.

## License

MIT

