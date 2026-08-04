import fs from "fs";
import path from "path";

export interface Combo {
  name: string;
  keyPositions: number[];
  binding: string;
  layers?: number[];
}

export function parseCombos(): Combo[] {
  const combosPath = path.join(process.cwd(), "config", "combos.dtsi");
  if (!fs.existsSync(combosPath)) {
    return [];
  }

  const content = fs.readFileSync(combosPath, "utf8");
  const combos: Combo[] = [];

  // Match leaf-level blocks (no nested braces) containing key-positions
  const blockRegex = /(\w+)\s*\{([^{}]+)\}/g;
  let match;

  while ((match = blockRegex.exec(content)) !== null) {
    const body = match[2];
    const name = match[1];
    if (!body || !name) continue;

    const posMatch = body.match(/key-positions\s*=\s*<([^>]+)>/);
    const bindMatch = body.match(/bindings\s*=\s*<([^>]+)>/);
    if (!posMatch || !bindMatch) continue;

    const keyPositions = posMatch[1];
    const binding = bindMatch[1];
    if (!keyPositions || !binding) continue;

    const layerMatch = body.match(/layers\s*=\s*<([^>]+)>/);

    const combo: Combo = {
      name,
      keyPositions: keyPositions.trim().split(/\s+/).map(Number),
      binding: binding.trim(),
    };
    const layers = layerMatch?.[1];
    if (layers) {
      combo.layers = layers.trim().split(/\s+/).map(Number);
    }
    combos.push(combo);
  }

  return combos;
}
