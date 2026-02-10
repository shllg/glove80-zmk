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

    const posMatch = body.match(/key-positions\s*=\s*<([^>]+)>/);
    const bindMatch = body.match(/bindings\s*=\s*<([^>]+)>/);
    if (!posMatch || !bindMatch) continue;

    const layerMatch = body.match(/layers\s*=\s*<([^>]+)>/);

    combos.push({
      name: match[1],
      keyPositions: posMatch[1].trim().split(/\s+/).map(Number),
      binding: bindMatch[1].trim(),
      layers: layerMatch
        ? layerMatch[1].trim().split(/\s+/).map(Number)
        : undefined,
    });
  }

  return combos;
}
