# Glove80 ZMK Configuration

Personal ZMK firmware configuration for Glove80 keyboard with per-key RGB support.

## ✅ Features

- 🎨 Per-key RGB lighting control (community fork)
- 🔧 Local Docker-based builds (no GitHub Actions)
- 🌐 Web interface integration with custom extensions
- ⚡ Symmetric home row mods optimized for small hands
- 🩹 RSI-conscious layout design
- 🚀 Persistent Docker container for fast rebuilds

## Quick Start

### Prerequisites

- Docker installed and running
- Glove80 keyboard
- USB-C cable
- ~2GB disk space for build environment

### Setup

1. **Install Docker (if needed):**
   ```bash
   sudo pacman -S docker
   sudo systemctl start docker
   sudo usermod -aG docker $USER
   # Log out and back in
   ```

2. **Export layout from web interface:**
   - Go to https://my.glove80.com
   - Configure your layout
   - Export and save to `config/web_import/glove80_web.keymap`

3. **Import and build:**
   ```bash
   make import    # Import web configuration
   make build     # Build firmware (10-15 min first time, ~1 min after)
   ```

4. **Flash to keyboard:**
   ```bash
   make flash     # Follow prompts for each half
   ```

## Project Structure

```
.
├── config/
│   ├── glove80.keymap          # Main keymap (auto-generated)
│   ├── glove80.conf            # System configuration
│   ├── web_import/             # Web interface exports
│   └── includes/               # Custom behaviors and macros
├── scripts/
│   ├── build.sh                # Docker build script
│   ├── flash.sh                # Firmware flashing tool
│   └── import_web.sh           # Web import tool
├── CLAUDE.md                   # Project requirements
└── build.yaml                  # ZMK build configuration
```

## Key Features

### Symmetric Home Row Mods
- Left hand: GUI, Alt, Shift, Ctrl
- Right hand: Ctrl, Shift, Alt, GUI (mirrored)
- Equal timing: ~280ms tapping term

### Combos for Small Hands
- Vertical combos to reduce finger stretch
- Home row combos for common actions
- Emergency bootloader combos

### Per-Key RGB
Using community fork for individual LED control:
- Layer-based color schemes
- Modifier activation indicators
- Visual feedback for better ergonomics

## Build System

### Docker Container
The project uses a persistent Docker container (`glove80-zmk-builder`):
- **First build:** Downloads dependencies (~10-15 minutes)
- **Subsequent builds:** Uses cached workspace (~1 minute)
- **No GitHub Actions:** Everything runs locally

### Common Commands
```bash
make build             # Build firmware
make clean             # Clean outputs
make clean-all         # Full clean (removes container)
make container-status  # Check Docker container
make container-stop    # Stop container
make keymap            # Show visual keymap
make monitor           # Monitor USB devices
```

## Troubleshooting

### Build Issues
```bash
make clean-all  # Full reset
make build      # Rebuild from scratch
```

### Container Management
The container persists between builds. To manage:
```bash
docker ps -a | grep glove80  # Check status
docker logs glove80-zmk-builder  # View logs
docker stop glove80-zmk-builder  # Stop
docker rm glove80-zmk-builder    # Remove
```

## Health Considerations

This configuration is optimized for:
- Small hands
- RSI prevention (especially right hand)
- 12+ hour daily usage
- Reduced finger travel and strain

## License

Personal configuration - feel free to adapt for your needs.