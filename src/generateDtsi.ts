import type { Layout } from "./schema";
import fs from "fs";
import path from "path";

export function generateKeymapDtsi(layout: Layout): string {
  // Read the template
  const templatePath = path.join(process.cwd(), "config", "glove80.keymap");
  if (!fs.existsSync(templatePath)) {
    throw new Error("Template file config/glove80.keymap not found!");
  }

  let dtsi = fs.readFileSync(templatePath, "utf8");

  // Generate layer defines
  let layerDefines = "/* Layer defines */\n";
  layout.layers.forEach((layer, index) => {
    layerDefines += `#define LAYER_${layer.name} ${index}\n`;
  });

  // Read behaviors if exists
  let behaviors = "";
  const behaviorsPath = path.join(process.cwd(), "config", "behaviors.dtsi");
  if (fs.existsSync(behaviorsPath)) {
    const content = fs.readFileSync(behaviorsPath, "utf8");
    // Extract just the content inside the / { ... } block
    const match = content.match(/\/\s*\{([\s\S]*)\}/);
    if (match) {
      behaviors = match[1].trim();
    }
  }

  // Read macros if exists
  let macros = "";
  const macrosPath = path.join(process.cwd(), "config", "macros.dtsi");
  if (fs.existsSync(macrosPath)) {
    const content = fs.readFileSync(macrosPath, "utf8");
    const match = content.match(/\/\s*\{([\s\S]*)\}/);
    if (match) {
      macros = match[1].trim();
    }
  }

  // Read combos if exists
  let combos = "";
  const combosPath = path.join(process.cwd(), "config", "combos.dtsi");
  if (fs.existsSync(combosPath)) {
    const content = fs.readFileSync(combosPath, "utf8");
    const match = content.match(/\/\s*\{([\s\S]*)\}/);
    if (match) {
      combos = match[1].trim();
    }
  }

  // Read LED config if exists
  let ledConfig = "";
  const ledConfigPath = path.join(process.cwd(), "config", "led-config.dtsi");
  if (fs.existsSync(ledConfigPath)) {
    const content = fs.readFileSync(ledConfigPath, "utf8");
    // LED config might not have the / { } wrapper, so check both formats
    const match = content.match(/\/\s*\{([\s\S]*)\}/);
    if (match) {
      ledConfig = match[1].trim();
    } else if (content.includes("underglow-layer")) {
      // If it's just the raw underglow-layer content
      ledConfig = content.trim();
    }
  }

  // Generate keymap
  let keymap = "keymap {\n";
  keymap += '        compatible = "zmk,keymap";\n\n';

  // Generate each layer
  for (const layer of layout.layers) {
    keymap += `        layer_${layer.name} {\n`;
    keymap += "            bindings = <\n";

    // Format keys to match physical keyboard rows
    // Each line represents a complete physical row across the keyboard
    const rows = [
      layer.keys.left[0].concat(layer.keys.right[0]),
      layer.keys.left[1].concat(layer.keys.right[1]),
      layer.keys.left[2].concat(layer.keys.right[2]),
      layer.keys.left[3].concat(layer.keys.right[3]),
      layer.keys.left[4].concat(layer.keys.thumb_left[0]).concat(layer.keys.thumb_right[0]).concat(layer.keys.right[4]),
      layer.keys.left[5].concat(layer.keys.thumb_left[1]).concat(layer.keys.thumb_right[1]).concat(layer.keys.right[5])
    ];

    for (const row of rows) {
      keymap += "                " + row.join(" ") + "\n";
    }

    keymap += "            >;\n";
    keymap += "        };\n\n";
  }

  keymap = keymap.trimEnd() + "\n    };";

  // Replace all placeholders
  dtsi = dtsi.replace("/* PLACEHOLDER_LAYER_DEFINES */", layerDefines.trimEnd());
  dtsi = dtsi.replace("/* PLACEHOLDER_BEHAVIORS */", behaviors);
  dtsi = dtsi.replace("/* PLACEHOLDER_MACROS */", macros);
  dtsi = dtsi.replace("/* PLACEHOLDER_COMBOS */", combos);
  dtsi = dtsi.replace("/* PLACEHOLDER_LED_CONFIG */", ledConfig);
  dtsi = dtsi.replace("/* PLACEHOLDER_KEYMAP */", keymap);

  return dtsi;
}

