
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
    const flatKeys = layer.rows.flat();
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

