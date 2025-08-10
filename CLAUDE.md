# Glove80 ZMK Configuration - Project Memory

## User Profile & Requirements

### Personal Context
- **System**: Arch Linux / Hyprland / Omarchy
- **Keyboard**: Glove80 (split ergonomic)
- **Job**: CTO / Tech Professional / Programmer / SysOps
- **Usage**: 12+ hours daily on computer
- **Language**: 75% English, native German (QWERTY layout)

### Health Considerations
- **Primary Issue**: RSI in right hand (fingers, hand, lower arm, elbow)
- **Body Type**: Small hands
- **Goal**: Eliminate pain while maximizing productivity

## Key Project Requirements

### 1. Build System
- **MUST** build locally (no GitHub Actions)
- Use Docker for consistent builds
- Support for community RGB fork

### 2. Keyboard Configuration Philosophy
- **Symmetric Home Row Mods** (NOT asymmetric)
  - Left hand: GUI, Alt, Shift, Ctrl
  - Right hand: Ctrl, Shift, Alt, GUI (mirrored)
  - Equal timing on both hands (~280-300ms)
- Web interface as primary configuration source
- Custom extensions via modular includes

### 3. Per-Key RGB
- Use community fork: `community.pr36.per-key-rgb`
- Individual LED control for visual feedback
- Layer indicators and modifier visualization

### 4. Web Interface Integration
- Keep web exports in `config/web_import/`
- Never modify web export files directly
- Use migration scripts for merging changes
- Track differences between web and custom configs

## Project Structure

```
glove80-zmk/
├── CLAUDE.md                   # This file
├── config/
│   ├── glove80.keymap          # Main keymap (imports web + custom)
│   ├── glove80.conf            # System configuration
│   ├── web_import/
│   │   ├── glove80_web.keymap  # Web interface export (DO NOT EDIT)
│   │   └── migration.sh        # Merge tool
│   ├── boards/shields/glove80/
│   │   └── glove80_rgb.dtsi    # RGB configuration
│   └── includes/
│       ├── behaviors.dtsi      # Custom behaviors
│       ├── combos.dtsi         # Combo definitions
│       └── macros.dtsi         # Macro definitions
├── scripts/
│   ├── build.sh                # Docker build script
│   ├── flash.sh                # Firmware flash helper
│   └── import_web.sh           # Web import tool
└── build.yaml                  # ZMK build configuration
```

## Build Commands

```bash
# Import from web interface
./scripts/import_web.sh

# Build firmware
./scripts/build.sh

# Flash to keyboard
./scripts/flash.sh
```

## Important Notes

### DO NOT:
- Use asymmetric home row mods
- Build with GitHub Actions
- Modify web export files directly
- Create complex configs before build system works

### ALWAYS:
- Keep web interface as primary source
- Use symmetric modifier placement
- Test builds before adding features
- Consider small hands in all decisions

## Technical Stack
- ZMK firmware
- Docker for builds
- Community RGB fork
- Glove80 web interface for base config

## Health Optimizations
1. Reduce right hand strain through smart key placement
2. Use combos to minimize finger travel
3. Leverage thumb clusters effectively
4. Visual feedback via RGB to reduce cognitive load

## Development Workflow
1. Export from Glove80 web interface
2. Save to `config/web_import/glove80_web.keymap`
3. Run import script to merge changes
4. Build with Docker
5. Flash and test
6. Iterate on custom behaviors

## Remember
This project prioritizes:
1. Health (reducing RSI)
2. Build reliability (local Docker builds)
3. Maintainability (web interface as source)
4. Performance (12+ hour daily use)