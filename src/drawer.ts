
import type { Layout } from "./schema";
import type { Combo } from "./combos";
import { flattenToPositions } from "./layout";

export function toDrawerYaml(layout: Layout, combos: Combo[] = []) {
  // Map ZMK key codes to actual characters
  const keyCharMap: Record<string, string> = {
    // Numbers and their shifts
    "N1": "1", "LS(N1)": "!",
    "N2": "2", "LS(N2)": "@",
    "N3": "3", "LS(N3)": "#",
    "N4": "4", "LS(N4)": "$",
    "N5": "5", "LS(N5)": "%",
    "N6": "6", "LS(N6)": "^",
    "N7": "7", "LS(N7)": "&",
    "N8": "8", "LS(N8)": "*",
    "N9": "9", "LS(N9)": "(",
    "N0": "0", "LS(N0)": ")",

    // Special characters
    "GRAVE": "`", "LS(GRAVE)": "~",
    "MINUS": "-", "LS(MINUS)": "_",
    "EQUAL": "=", "LS(EQUAL)": "+",
    "LBKT": "[", "LS(LBKT)": "{",
    "RBKT": "]", "LS(RBKT)": "}",
    "BSLH": "\\", "LS(BSLH)": "|",
    "SEMI": ";", "LS(SEMI)": ":",
    "SQT": "'", "LS(SQT)": "\"",
    "COMMA": ",", "LS(COMMA)": "<",
    "DOT": ".", "LS(DOT)": ">",
    "FSLH": "/", "LS(FSLH)": "?",
    "EXCL": "!",
    "AT": "@",
    "HASH": "#",
    "DLLR": "$",
    "PRCNT": "%",
    "CARET": "^",
    "AMPS": "&",
    "ASTRK": "*",
    "LPAR": "(",
    "RPAR": ")",
    "UNDER": "_",
    "PLUS": "+",
    "LBRC": "{",
    "RBRC": "}",
    "PIPE": "|",
    "COLON": ":",
    "DQT": '"',
    "LT": "<",
    "GT": ">",
    "QMARK": "?",
    "TILDE": "tilde",

    // Keep some common ones as-is for clarity
    "SPACE": "Space",
    "TAB": "Tab",
    "RET": "Enter",
    "BSPC": "Bksp",
    "DEL": "Del",
    "ESC": "Esc",
    "ESCAPE": "Esc",

    // Arrow keys
    "UP": "↑",
    "DOWN": "↓",
    "LEFT": "←",
    "RIGHT": "→",

    // Home/End/PageUp/PageDown
    "HOME": "Home",
    "END": "End",
    "PG_UP": "PgUp",
    "PG_DN": "PgDn",

    // Function keys - keep as is
    "F1": "F1", "F2": "F2", "F3": "F3", "F4": "F4", "F5": "F5",
    "F6": "F6", "F7": "F7", "F8": "F8", "F9": "F9", "F10": "F10",
    "F11": "F11", "F12": "F12",

    // Modifiers - keep for visibility when alone
    "LSHFT": "Shift", "RSHFT": "Shift",
    "LCTRL": "Ctrl", "RCTRL": "Ctrl",
    "LALT": "Alt", "RALT": "AltGr",
    "LGUI": "Cmd", "RGUI": "Cmd",

    // Media keys
    "C_PP": "⏯",
    "C_PREV": "⏮",
    "C_NEXT": "⏭",
    "C_VOL_UP": "Vol+",
    "C_VOL_DN": "Vol-",
    "C_MUTE": "Mute",
    "C_BRI_UP": "Bri+",
    "C_BRI_DN": "Bri-",

    // Other common keys
    "CAPS": "Caps",
    "PSCRN": "PrtSc",
    "INS": "Ins",

    // Special key combos
    "LS(LG(EQUAL))": "Zoom+",
    "LG(EQUAL)": "Cmd+=",
    "LS(LG(MINUS))": "Zoom-",
    "LG(MINUS)": "Cmd+-",

    // Letters - keep as is
    "A": "A", "B": "B", "C": "C", "D": "D", "E": "E", "F": "F", "G": "G",
    "H": "H", "I": "I", "J": "J", "K": "K", "L": "L", "M": "M", "N": "N",
    "O": "O", "P": "P", "Q": "Q", "R": "R", "S": "S", "T": "T", "U": "U",
    "V": "V", "W": "W", "X": "X", "Y": "Y", "Z": "Z"
  };

  // Helper to map key binding to display character
  const mapKeyToChar = (binding: string): string => {
    // Handle &none -> empty string
    if (binding === "&none") {
      return "";
    }

    // Handle home row mods (hml/hmr) - extract both modifier and key
    const hmlMatch = binding.match(/^&hml\w*\s+(\w+)\s+(.+)$/);
    if (hmlMatch) {
      const mod = hmlMatch[1];
      const key = hmlMatch[2];
      const modLabel = keyCharMap[mod] || mod;
      const keyLabel = keyCharMap[key] || key;
      return `${keyLabel}\n${modLabel}`;  // Two-line format for keymap-drawer
    }

    const hmrMatch = binding.match(/^&hmr\w*\s+(\w+)\s+(.+)$/);
    if (hmrMatch) {
      const mod = hmrMatch[1];
      const key = hmrMatch[2];
      const modLabel = keyCharMap[mod] || mod;
      const keyLabel = keyCharMap[key] || key;
      return `${keyLabel}\n${modLabel}`;  // Two-line format for keymap-drawer
    }

    // Handle thumb keys with layer info
    const thumbMatch = binding.match(/^&thumb_(left|right)\s+(\d+)\s+(.+)$/);
    if (thumbMatch) {
      const layer = thumbMatch[2];
      const key = thumbMatch[3];
      const keyLabel = keyCharMap[key] || key;
      return `${keyLabel}\nL${layer}`;  // Show key with layer number
    }

    // Handle layer tap (lt)
    const ltMatch = binding.match(/^&lt\s+(\d+)\s+(.+)$/);
    if (ltMatch) {
      const layer = ltMatch[1];
      const key = ltMatch[2];
      const keyLabel = keyCharMap[key] || key;
      return `${keyLabel}\nL${layer}`;
    }

    // Handle mo (momentary layer)
    const moMatch = binding.match(/^&mo\s+(\d+)$/);
    if (moMatch) {
      return `Layer ${moMatch[1]}`;
    }

    // Handle magic layer
    const magicMatch = binding.match(/^&magic\s+LAYER_(\w+)\s+(\d+)$/);
    if (magicMatch) {
      return `Magic\n${magicMatch[1]}`;
    }

    // Handle macros - show simplified names
    if (binding.includes("&macro_")) {
      // Special formatting for common macros
      if (binding === "&macro_super_space") return "⌘Space";
      if (binding === "&macro_super_shift_space") return "⌘⇧Space";
      if (binding === "&macro_super_alt_b") return "⌘⌥B";
      if (binding === "&macro_super_print") return "⌘Print";
      if (binding === "&macro_tmux_ctrl_b_n") return "Tmux N";
      if (binding === "&macro_tmux_ctrl_b_o") return "Tmux O";
      if (binding === "&macro_parenthesis_open_close") return "()";
      if (binding === "&macro_brace_open_close") return "{}";
      if (binding === "&macro_lt_gt") return "<>";
      if (binding === "&macro_equal_gt") return "=>";
      if (binding === "&macro_double_single_quotes") return "''";
      if (binding === "&macro_double_double_quotes") return '""';

      // Default formatting for unknown macros
      const macroName = binding.replace(/&macro_/, "").replace(/_/g, " ");
      return `[${macroName}]`;
    }

    // Remove the &kp prefix if present
    const keyMatch = binding.match(/^&kp\s+(.+)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      return keyCharMap[key] || key;
    }

    return binding;
  };

  // Helper to properly quote YAML values that need it
  const yamlQuote = (str: string): string => {
    // Quote if string contains special YAML characters or starts with special chars
    if (/^[-?:,\[\]{}#&*!|>'"%@`=]|[:\[\]{}=]/.test(str) || str.includes('\n')) {
      return `"${str.replace(/"/g, '\\"')}"`;
    }
    return str;
  };

  // Glove80 has 80 keys total - we need to pad the layout to match
  // For now, fill with empty keys ("") for positions we don't define
  const padTo80Keys = (keys: string[]): string[] => {
    const result = [...keys];
    while (result.length < 80) {
      result.push("");
    }
    return result;
  };

  // Convert layers to keymap-drawer format (dictionary with layer names as keys)
  const layersObj: Record<string, string[]> = {};

  for (const layer of layout.layers) {
    const flatKeys = flattenToPositions(layer.keys);
    const paddedKeys = padTo80Keys(flatKeys);
    // Apply character mapping to each key
    layersObj[layer.name] = paddedKeys.map(k => {
      if (!k) return "''";
      return mapKeyToChar(k);
    });
  }

  // Build YAML string
  let yaml = `layout:\n  zmk_keyboard: glove80\n`;

  // Add draw_config for styling
  yaml += `draw_config:\n`;

  // Set columns to 1 for vertical layout (layers stacked)
  yaml += `  n_columns: 1\n`;

  // Add footer text if we have LED configuration
  const hasLED = layout.layers.some(l => l.led);
  if (hasLED) {
    yaml += `  footer_text: "LED colors configured for underglow"\n`;
  }

  // Always add custom CSS for better visualization
  yaml += `  svg_extra_style: |\n`;

  // Add CSS for layer-specific key coloring based on LED configuration
  if (hasLED) {
    yaml += `    /* LED underglow color visualization */\n`;

    // For each layer with LED config, create CSS to color the keys
    for (const [layerIndex, layer] of layout.layers.entries()) {
      if (!layer.led) continue;

      // Flatten the LED configuration to match key order
      const led = layer.led;
      const ledFlat: string[] = [
        ...led.left[0], ...led.right[0],             // F-keys
        ...led.left[1], ...led.right[1],             // Numbers
        ...led.left[2], ...led.right[2],             // QWERTY top
        ...led.left[3], ...led.right[3],             // Home row
        ...led.left[4],                              // Left bottom row
        ...led.thumb_left[0], ...led.thumb_right[0], // Upper thumb
        ...led.right[4],                             // Right bottom row
        ...led.left[5],                              // Left bottom corner
        ...led.thumb_left[1], ...led.thumb_right[1], // Lower thumb
        ...led.right[5],                             // Right bottom corner
      ];

      // Create CSS rules for each key position with an LED color
      for (let i = 0; i < ledFlat.length && i < 80; i++) {
        const ledColor = ledFlat[i];
        if (ledColor && ledColor !== "___" && layout.colorDefinitions?.[ledColor]) {
          const rgb = layout.colorDefinitions[ledColor] as number[];
          const r = rgb[0];
          const g = rgb[1];
          const b = rgb[2];
          const hex = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

          // Target the specific key in the specific layer
          // keymap-drawer uses svg groups with classes like "layer-Base" and "keypos-0"
          yaml += `    .layer-${layer.name} .keypos-${i} rect.key { fill: ${hex}; fill-opacity: 0.25; stroke: ${hex}; stroke-width: 2; }\n`;
          yaml += `    .layer-${layer.name} .keypos-${i} text { font-weight: bold; }\n`;
        }
      }
    }
    yaml += `\n`;
  }

  // Add combos section for keymap-drawer
  if (combos.length > 0) {
    yaml += `combos:\n`;
    for (const combo of combos) {
      const label = mapKeyToChar(combo.binding);
      yaml += `  - p: [${combo.keyPositions.join(", ")}]\n`;
      yaml += `    k: ${yamlQuote(label)}\n`;
      if (combo.layers) {
        const layerNames = combo.layers
          .map(i => layout.layers[i]?.name)
          .filter(Boolean);
        if (layerNames.length > 0) {
          yaml += `    l: [${layerNames.map(n => `"${n}"`).join(", ")}]\n`;
        }
      }
    }
  }

  yaml += `layers:\n`;

  for (const [name, keys] of Object.entries(layersObj)) {
    yaml += `  ${name}:\n`;
    for (const key of keys as string[]) {
      yaml += `    - ${key === "''" ? key : yamlQuote(key)}\n`;
    }
  }

  // Add LED layout as comments for documentation
  if (hasLED) {
    yaml += `\n# LED Underglow Configuration\n`;
    for (const layer of layout.layers) {
      if (!layer.led) continue;
      yaml += `# Layer: ${layer.name}\n`;

      // Convert structured LED format to readable grid
      const led = layer.led;
      yaml += `#   Left side:\n`;
      for (let row = 0; row < led.left.length; row++) {
        yaml += `#     Row ${row}: ${led.left[row].join(' ')}\n`;
      }
      yaml += `#   Right side:\n`;
      for (let row = 0; row < led.right.length; row++) {
        yaml += `#     Row ${row}: ${led.right[row].join(' ')}\n`;
      }
      yaml += `#   Thumb left: ${led.thumb_left[0].join(' ')} | ${led.thumb_left[1].join(' ')}\n`;
      yaml += `#   Thumb right: ${led.thumb_right[0].join(' ')} | ${led.thumb_right[1].join(' ')}\n`;
      yaml += `#\n`;
    }
  }

  return yaml;
}

