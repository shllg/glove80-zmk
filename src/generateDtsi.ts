import type { Layout } from "./schema";
import { toPhysicalRows } from "./layout";
import fs from "fs";
import path from "path";

type ProfileSlot = 0 | 1 | 2 | 3;

const PROFILE_SLOTS: ProfileSlot[] = [0, 1, 2, 3];
const DEFAULT_PROFILE_LAYER_MAP: Record<ProfileSlot, string> = {
  0: "Base",
  1: "Base",
  2: "Base",
  3: "Base",
};

function findNodeCloseBraceIndex(content: string, nodeName: "behaviors" | "macros"): number {
  const nodeRegex = new RegExp(`\\b${nodeName}\\b\\s*\\{`);
  const nodeMatch = nodeRegex.exec(content);
  if (!nodeMatch) {
    throw new Error(`Could not find '${nodeName}' block in config/${nodeName}.dtsi`);
  }

  const openBraceIndex = content.indexOf("{", nodeMatch.index);
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error(`Could not find closing brace for '${nodeName}' block`);
}

function injectIntoNode(content: string, nodeName: "behaviors" | "macros", snippet: string): string {
  const trimmedSnippet = snippet.trim();
  if (!trimmedSnippet) return content;

  const closeBraceIndex = findNodeCloseBraceIndex(content, nodeName);
  const before = content.slice(0, closeBraceIndex).trimEnd();
  const after = content.slice(closeBraceIndex);
  return `${before}\n\n${trimmedSnippet}\n${after}`;
}

function applyProfileIndicators(workingLayout: Layout): Record<ProfileSlot, string> {
  const profileLayerMap: Record<ProfileSlot, string> = { ...DEFAULT_PROFILE_LAYER_MAP };
  const indicators = workingLayout.profileIndicators;
  if (!indicators) return profileLayerMap;

  const baseLayer = workingLayout.layers[0];
  if (!baseLayer || baseLayer.name !== "Base") {
    throw new Error("profileIndicators requires the first layer to be 'Base'");
  }

  if (!workingLayout.colorDefinitions) {
    throw new Error("profileIndicators requires colorDefinitions");
  }
  const colorDefinitions = workingLayout.colorDefinitions;

  const paintFunctionRow = (layer: Layout["layers"][number], colorName: string) => {
    if (!layer.led) {
      throw new Error(`Layer '${layer.name}' is missing LED data required for profile indicators`);
    }
    const leftFunctionRow = layer.led.left[0];
    const rightFunctionRow = layer.led.right[0];
    if (!leftFunctionRow || !rightFunctionRow) {
      throw new Error(`Layer '${layer.name}' is missing F1-F10 LED rows required for profile indicators`);
    }

    layer.led.left[0] = leftFunctionRow.map(() => colorName);
    layer.led.right[0] = rightFunctionRow.map(() => colorName);
  };

  const resolveColor = (profile: "USB" | "BT1" | "BT2" | "BT3" | "BT4"): string | undefined => {
    const colorName = indicators[profile];
    if (!colorName) return undefined;
    if (!colorDefinitions[colorName]) {
      throw new Error(`Unknown color '${colorName}' in profileIndicators.${String(profile)}`);
    }
    return colorName;
  };

  const usbColor = resolveColor("USB");
  if (usbColor) {
    paintFunctionRow(baseLayer, usbColor);
  }

  const existingLayerNames = new Set(workingLayout.layers.map((layer) => layer.name));
  const btLayersToInsert: typeof workingLayout.layers = [];
  for (const slot of PROFILE_SLOTS) {
    const btProfile = `BT${slot + 1}` as const;
    const btColor = resolveColor(btProfile);
    if (!btColor) continue;

    const btLayerName = `Base_BT${slot + 1}`;
    if (existingLayerNames.has(btLayerName)) {
      throw new Error(`Cannot generate profile indicator layer '${btLayerName}' because it already exists`);
    }

    const btLayer = structuredClone(baseLayer);
    btLayer.name = btLayerName;
    paintFunctionRow(btLayer, btColor);
    btLayersToInsert.push(btLayer);
    existingLayerNames.add(btLayerName);
    profileLayerMap[slot] = btLayerName;
  }

  // Insert BT variant layers right after Base (index 0) so overlay layers
  // (Navigation, Magic, etc.) have higher indices and aren't shadowed.
  workingLayout.layers.splice(1, 0, ...btLayersToInsert);

  if (workingLayout.layers.length > 16) {
    throw new Error(
      `Profile indicator layers exceed ZMK limit: ${workingLayout.layers.length} layers (max 16)`
    );
  }

  return profileLayerMap;
}

function renderProfileMacros(profileLayerMap: Record<ProfileSlot, string>): string {
  const lines: string[] = [];

  lines.push("#ifdef BT_DISC_CMD");
  for (const slot of PROFILE_SLOTS) {
    lines.push(
      `    profile_bt_select_${slot}: profile_bt_select_${slot} {`,
      `        label = "PROFILE_BT_SELECT_${slot}";`,
      '        compatible = "zmk,behavior-macro";',
      "        #binding-cells = <0>;",
      "        bindings",
      `            = <&to LAYER_${profileLayerMap[slot]}>,`,
      "              <&out OUT_BLE>,",
      `              <&bt BT_SEL ${slot}>;`,
      "    };",
    );
  }

  lines.push("#else");
  for (const slot of PROFILE_SLOTS) {
    lines.push(
      `    profile_bt_${slot}: profile_bt_${slot} {`,
      `        label = "PROFILE_BT_${slot}";`,
      '        compatible = "zmk,behavior-macro";',
      "        #binding-cells = <0>;",
      "        bindings",
      `            = <&to LAYER_${profileLayerMap[slot]}>,`,
      "              <&out OUT_BLE>,",
      `              <&bt BT_SEL ${slot}>;`,
      "    };",
    );
  }
  lines.push("#endif");
  lines.push("");

  lines.push(
    "    profile_usb: profile_usb {",
    '        label = "PROFILE_USB";',
    '        compatible = "zmk,behavior-macro";',
    "        #binding-cells = <0>;",
    "        bindings",
    "            = <&to LAYER_Base>,",
    "              <&out OUT_USB>;",
    "    };",
  );

  return lines.join("\n");
}

function renderProfileBehaviors(): string {
  const lines: string[] = [];

  lines.push("#ifdef BT_DISC_CMD");
  for (const slot of PROFILE_SLOTS) {
    lines.push(
      `    profile_bt_${slot}: profile_bt_${slot} {`,
      '        compatible = "zmk,behavior-tap-dance";',
      `        label = "PROFILE_BT_${slot}";`,
      "        #binding-cells = <0>;",
      "        tapping-term-ms = <200>;",
      `        bindings = <&profile_bt_select_${slot}>, <&bt BT_DISC ${slot}>;`,
      "    };",
    );
  }
  lines.push("#endif");

  return lines.join("\n");
}

export function generateKeymapDtsi(layout: Layout): string {
  // Read the template
  const templatePath = path.join(process.cwd(), "config", "glove80.keymap");
  if (!fs.existsSync(templatePath)) {
    throw new Error("Template file config/glove80.keymap not found!");
  }

  let dtsi = fs.readFileSync(templatePath, "utf8");
  const workingLayout = structuredClone(layout);
  const profileLayerMap = applyProfileIndicators(workingLayout);
  const generatedProfileMacros = renderProfileMacros(profileLayerMap);
  const generatedProfileBehaviors = renderProfileBehaviors();

  // Generate layer defines
  let layerDefines = "/* Layer defines */\n";
  workingLayout.layers.forEach((layer, index) => {
    layerDefines += `#define LAYER_${layer.name} ${index}\n`;
  });

  // Generate color defines from layout.colorDefinitions
  let colorDefines = "";
  if (workingLayout.colorDefinitions) {
    colorDefines = "/* Custom color defines */\n";
    for (const [name, rgb] of Object.entries(workingLayout.colorDefinitions)) {
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
  if (!behaviors) {
    throw new Error("config/behaviors.dtsi is required to inject profile behaviors");
  }
  behaviors = injectIntoNode(behaviors, "behaviors", generatedProfileBehaviors);

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
  if (!macros) {
    throw new Error("config/macros.dtsi is required to inject profile macros");
  }
  macros = injectIntoNode(macros, "macros", generatedProfileMacros);

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
  const layersWithLED = workingLayout.layers.filter(l => l.led);
  
  if (layersWithLED.length > 0) {
    underglowLayers = "    underglow-layer {\n";
    underglowLayers += '        compatible = "zmk,underglow-layer";\n\n';
    
    for (const [layerIndex, layer] of workingLayout.layers.entries()) {
      if (!layer.led) continue;
      
      underglowLayers += `        layer_${layer.name} {\n`;
      underglowLayers += `            bindings = <\n`;
      
      // Build the LED array in the same physical order as keys
    const ledRows = toPhysicalRows(layer.led);

    // Format the LED array matching the keyboard physical layout
    for (const row of ledRows) {
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
  for (const layer of workingLayout.layers) {
    keymap += `        layer_${layer.name} {\n`;
    keymap += "            bindings = <\n";

    // Format keys to match physical keyboard rows
    const rows = toPhysicalRows(layer.keys);

    for (const row of rows) {
      keymap += "                " + row.join(" ") + "\n";
    }

    keymap += "            >;\n";
    keymap += "        };\n\n";
  }

  keymap = keymap.trimEnd() + "\n    };";

  // Replace all placeholders (using replaceAll to catch any accidental duplicates)
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_LAYER_DEFINES */", layerDefines.trimEnd());
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_COLOR_DEFINES */", colorDefines.trimEnd());
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_BEHAVIORS */", behaviors);
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_MACROS */", macros);
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_COMBOS */", combos);
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_UNDERGLOW */", underglowLayers.trimEnd());
  dtsi = dtsi.replaceAll("/* PLACEHOLDER_KEYMAP */", keymap);

  return dtsi;
}
