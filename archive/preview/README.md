# Glove80 ZMK Keymap Viewer

A beautiful, dark-themed interactive web application for previewing your Glove80 ZMK keyboard configuration with white keycaps that match your physical Glove80.

## Features

- **Dark Theme Interface**: Elegant dark background that highlights your keyboard layout
- **White Keycaps**: Authentic-looking white keys that mirror your physical Glove80
- **Layer Switching**: Easy navigation between all configured layers
- **Color-Coded Keys**: Different key types are visually distinguished:
  - Regular keys: White keycaps
  - Home row mods: Amber accent
  - Layer keys: Purple accent
  - Bluetooth keys: Blue accent
  - Macros: Green accent
  - System keys: Red accent
- **Interactive Tooltips**: Hover over keys to see detailed binding information
- **Responsive Design**: Works on desktop and mobile devices
- **Keyboard Navigation**: Full accessibility support

## Quick Start

1. Make sure you have generated the keymap data:
   ```bash
   python3 scripts/export_keymap_json.py
   ```

2. Install dependencies:
   ```bash
   cd preview
   pnpm install
   ```

3. Start the development server:
   ```bash
   pnpm run dev
   ```

4. Open your browser to `http://localhost:5173`

## Build for Production

```bash
pnpm run build
```

The built files will be in the `dist` folder, ready for deployment to any static hosting service.

## Auto-Generation

The keymap preview is automatically updated when you run the main build script:

```bash
make build
```

This will export your latest keymap configuration and make it available to the preview application.

## Technology Stack

- **React 19** with TypeScript
- **Tailwind CSS 4** for styling
- **Vite** for fast development and building
- **pnpm** for package management

## File Structure

```
preview/
├── src/
│   ├── components/
│   │   ├── Key.tsx           # Individual key component
│   │   ├── KeyboardLayout.tsx # Main keyboard layout
│   │   └── LayerSelector.tsx  # Layer switching UI
│   ├── data/
│   │   └── keymap.json       # Auto-generated keymap data
│   ├── types/
│   │   └── keyboard.d.ts     # TypeScript definitions
│   ├── App.tsx               # Main application
│   ├── App.css               # Dark theme styles
│   └── main.tsx              # Application entry point
└── package.json              # Dependencies and scripts
```