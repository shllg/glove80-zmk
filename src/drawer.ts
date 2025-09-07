
import type { Layout } from "./schema";

export function toDrawerYaml(layout: Layout) {
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
  const layersObj: any = {};

  for (const layer of layout.layers) {
    let flatKeys: string[];

    if (Array.isArray(layer.keys)) {
      // Flat array format
      flatKeys = layer.keys as string[];
    } else {
      // Structured format - convert to ZMK's 80-key order
      const structured = layer.keys as any;
      flatKeys = [];

      // Same mapping as in generateDtsi.ts
      // Row 0: F-keys (positions 0-9)
      flatKeys.push(...structured.left[0]); // 0-4
      flatKeys.push(...structured.right[0]); // 5-9

      // Row 1: Numbers (positions 10-21)
      flatKeys.push(...structured.left[1]); // 10-15
      flatKeys.push(...structured.right[1]); // 16-21

      // Row 2: QWERTY top (positions 22-33)
      flatKeys.push(...structured.left[2]); // 22-27
      flatKeys.push(...structured.right[2]); // 28-33

      // Row 3: Home row (positions 34-45)
      flatKeys.push(...structured.left[3]); // 34-39
      flatKeys.push(...structured.right[3]); // 40-45

      // Row 4: ZXCVB/NM... (positions 46-57)
      flatKeys.push(...structured.left[4]); // 46-51
      flatKeys.push(...structured.right[4]); // 52-57

      // Lower thumb row and row 5 (positions 58-79)
      flatKeys.push(...structured.thumb_left[0]); // 58-60
      flatKeys.push(...structured.thumb_right[0]); // 61-63
      flatKeys.push(...structured.left[5]); // 64-68 (only 5 keys)
      flatKeys.push(...structured.thumb_left[1]); // 69-71
      flatKeys.push(...structured.thumb_right[1]); // 72-74
      flatKeys.push(...structured.right[5]); // 75-79 (only 5 keys)
    }

    const paddedKeys = padTo80Keys(flatKeys);
    layersObj[layer.name] = paddedKeys.map(k => k || "''");
  }

  // Build YAML string
  let yaml = `layout:\n  zmk_keyboard: glove80\n`;
  yaml += `layers:\n`;

  for (const [name, keys] of Object.entries(layersObj)) {
    yaml += `  ${name}:\n`;
    for (const key of keys as string[]) {
      yaml += `    - ${key === "''" ? key : yamlQuote(key)}\n`;
    }
  }

  return yaml;
}

