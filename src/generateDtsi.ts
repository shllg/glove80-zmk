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

  // Generate color defines from layout.colorDefinitions
  let colorDefines = "";
  if (layout.colorDefinitions) {
    colorDefines = "/* Custom color defines */\n";
    for (const [name, rgb] of Object.entries(layout.colorDefinitions)) {
      // Convert RGB array [r,g,b] to hex value 0xRRGGBB
      const r = (rgb as number[])[0];
      const g = (rgb as number[])[1]; 
      const b = (rgb as number[])[2];
      const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
      colorDefines += `#define ${name} 0x${hex}\n`;
    }
  }


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

  // Generate LED underglow layers
  let underglowLayers = "";
  const layersWithLED = layout.layers.filter(l => l.led);
  
  if (layersWithLED.length > 0) {
    underglowLayers = "    underglow-layer {\n";
    underglowLayers += '        compatible = "zmk,underglow-layer";\n\n';
    
    for (const [layerIndex, layer] of layout.layers.entries()) {
      if (!layer.led) continue;
      
      underglowLayers += `        layer_${layer.name} {\n`;
      underglowLayers += `            bindings = <\n`;
      
      // Build the LED array in the same physical order as keys
    const ledRows = [
      layer.led.left[0].concat(layer.led.right[0]),
      layer.led.left[1].concat(layer.led.right[1]),
      layer.led.left[2].concat(layer.led.right[2]),
      layer.led.left[3].concat(layer.led.right[3]),
      layer.led.left[4].concat(layer.led.thumb_left[0]).concat(layer.led.thumb_right[0]).concat(layer.led.right[4]),
      layer.led.left[5].concat(layer.led.thumb_left[1]).concat(layer.led.thumb_right[1]).concat(layer.led.right[5])
    ];
    
    // Flatten and ensure we have exactly 80 LEDs
    const leds = ledRows.flat();
    while (leds.length < 80) {
      leds.push("___"); // Use blanc (white) as default
    }
    
    // Format the LED array matching the keyboard physical layout
    for (const row of [
      ledRows[0],
      ledRows[1], 
      ledRows[2],
      ledRows[3],
      ledRows[4],
      ledRows[5]
    ]) {
      // Format colors as &ug COLOR references - use the exact names from layout
      const formattedRow = row.map(color => {
        return `&ug ${color}`;
      });
      underglowLayers += "                " + formattedRow.join(" ") + "\n";
    }
    
    underglowLayers += "            >;\n";
    underglowLayers += `            layer-id = <${layerIndex}>;\n`;
    underglowLayers += "        };\n\n";
    }
    
    // Close the underglow-layer node if we added any layers
    underglowLayers = underglowLayers.trimEnd() + "\n    };";
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
  dtsi = dtsi.replace("/* PLACEHOLDER_COLOR_DEFINES */", colorDefines.trimEnd());
  dtsi = dtsi.replace("/* PLACEHOLDER_BEHAVIORS */", behaviors);
  dtsi = dtsi.replace("/* PLACEHOLDER_MACROS */", macros);
  dtsi = dtsi.replace("/* PLACEHOLDER_COMBOS */", combos);
  dtsi = dtsi.replace("/* PLACEHOLDER_UNDERGLOW */", underglowLayers.trimEnd());
  dtsi = dtsi.replace("/* PLACEHOLDER_KEYMAP */", keymap);

  return dtsi;
}

