import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Layout } from "./schema";
import { toPhysicalRows } from "./layout";

const HandSchema = z.enum(["L", "R"]);
const FingerNameSchema = z.enum(["index", "middle", "ring", "pinky", "thumb"]);
const FingerSchema = z.enum([
  "L_index",
  "L_middle",
  "L_ring",
  "L_pinky",
  "L_thumb",
  "R_index",
  "R_middle",
  "R_ring",
  "R_pinky",
  "R_thumb",
]);
const ModClassSchema = z.enum([
  "L_CTRL",
  "L_ALT",
  "L_GUI",
  "L_SHIFT",
  "R_CTRL",
  "R_ALT",
  "R_GUI",
  "R_SHIFT",
]);

export const KeymapPositionSchema = z.object({
  pos: z.number().int().min(0).max(79),
  hand: HandSchema,
  row: z.number().int().min(1).max(6),
  col: z.number().int().min(1).max(6).nullable(),
  finger: FingerSchema,
  fingerId: z.number().int().min(0).max(9),
  baseKeycode: z.string().startsWith("KEY_").nullable(),
  linuxKeycode: z.number().int().nonnegative().nullable(),
  baseBinding: z.string().min(1),
  isHrm: z.boolean(),
  modClass: ModClassSchema.optional(),
}).strict();

export const KeymapMetaSchema = z.object({
  schemaVersion: z.literal(1),
  keymapHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  gitCommit: z.string().min(1),
  generatedAt: z.string().datetime(),
  positions: z.array(KeymapPositionSchema).length(80),
}).strict();

export type Hand = z.infer<typeof HandSchema>;
export type FingerName = z.infer<typeof FingerNameSchema>;
export type ModClass = z.infer<typeof ModClassSchema>;
export type KeymapPosition = z.infer<typeof KeymapPositionSchema>;
export type KeymapMeta = z.infer<typeof KeymapMetaSchema>;

export interface PositionDefinition {
  name: string;
  pos: number;
  hand: Hand;
  row: number;
  col: number | null;
  finger: FingerName;
  fingerId: number;
}

interface LinuxKeycode {
  baseKeycode: `KEY_${string}`;
  linuxKeycode: number;
}

export interface BindingResolution {
  baseKeycode: `KEY_${string}` | null;
  linuxKeycode: number | null;
  isHrm: boolean;
  modClass?: ModClass;
}

interface KeymapMetaOptions {
  generatedAt?: string;
  gitCommit?: string;
}

const COLUMN_FINGERS = ["index", "index", "middle", "ring", "pinky", "pinky"] as const;
const FINGER_INDEX: Record<FingerName, number> = {
  index: 0,
  middle: 1,
  ring: 2,
  pinky: 3,
  thumb: 4,
};

const ZMK_TO_LINUX: Readonly<Record<string, LinuxKeycode>> = {
  ESC: { baseKeycode: "KEY_ESC", linuxKeycode: 1 },
  N1: { baseKeycode: "KEY_1", linuxKeycode: 2 },
  N2: { baseKeycode: "KEY_2", linuxKeycode: 3 },
  N3: { baseKeycode: "KEY_3", linuxKeycode: 4 },
  N4: { baseKeycode: "KEY_4", linuxKeycode: 5 },
  N5: { baseKeycode: "KEY_5", linuxKeycode: 6 },
  N6: { baseKeycode: "KEY_6", linuxKeycode: 7 },
  N7: { baseKeycode: "KEY_7", linuxKeycode: 8 },
  N8: { baseKeycode: "KEY_8", linuxKeycode: 9 },
  N9: { baseKeycode: "KEY_9", linuxKeycode: 10 },
  N0: { baseKeycode: "KEY_0", linuxKeycode: 11 },
  MINUS: { baseKeycode: "KEY_MINUS", linuxKeycode: 12 },
  EQUAL: { baseKeycode: "KEY_EQUAL", linuxKeycode: 13 },
  BSPC: { baseKeycode: "KEY_BACKSPACE", linuxKeycode: 14 },
  TAB: { baseKeycode: "KEY_TAB", linuxKeycode: 15 },
  Q: { baseKeycode: "KEY_Q", linuxKeycode: 16 },
  W: { baseKeycode: "KEY_W", linuxKeycode: 17 },
  E: { baseKeycode: "KEY_E", linuxKeycode: 18 },
  R: { baseKeycode: "KEY_R", linuxKeycode: 19 },
  T: { baseKeycode: "KEY_T", linuxKeycode: 20 },
  Y: { baseKeycode: "KEY_Y", linuxKeycode: 21 },
  U: { baseKeycode: "KEY_U", linuxKeycode: 22 },
  I: { baseKeycode: "KEY_I", linuxKeycode: 23 },
  O: { baseKeycode: "KEY_O", linuxKeycode: 24 },
  P: { baseKeycode: "KEY_P", linuxKeycode: 25 },
  LBKT: { baseKeycode: "KEY_LEFTBRACE", linuxKeycode: 26 },
  RBKT: { baseKeycode: "KEY_RIGHTBRACE", linuxKeycode: 27 },
  RET: { baseKeycode: "KEY_ENTER", linuxKeycode: 28 },
  LCTRL: { baseKeycode: "KEY_LEFTCTRL", linuxKeycode: 29 },
  A: { baseKeycode: "KEY_A", linuxKeycode: 30 },
  S: { baseKeycode: "KEY_S", linuxKeycode: 31 },
  D: { baseKeycode: "KEY_D", linuxKeycode: 32 },
  F: { baseKeycode: "KEY_F", linuxKeycode: 33 },
  G: { baseKeycode: "KEY_G", linuxKeycode: 34 },
  H: { baseKeycode: "KEY_H", linuxKeycode: 35 },
  J: { baseKeycode: "KEY_J", linuxKeycode: 36 },
  K: { baseKeycode: "KEY_K", linuxKeycode: 37 },
  L: { baseKeycode: "KEY_L", linuxKeycode: 38 },
  SEMI: { baseKeycode: "KEY_SEMICOLON", linuxKeycode: 39 },
  SQT: { baseKeycode: "KEY_APOSTROPHE", linuxKeycode: 40 },
  GRAVE: { baseKeycode: "KEY_GRAVE", linuxKeycode: 41 },
  LSHFT: { baseKeycode: "KEY_LEFTSHIFT", linuxKeycode: 42 },
  BSLH: { baseKeycode: "KEY_BACKSLASH", linuxKeycode: 43 },
  Z: { baseKeycode: "KEY_Z", linuxKeycode: 44 },
  X: { baseKeycode: "KEY_X", linuxKeycode: 45 },
  C: { baseKeycode: "KEY_C", linuxKeycode: 46 },
  V: { baseKeycode: "KEY_V", linuxKeycode: 47 },
  B: { baseKeycode: "KEY_B", linuxKeycode: 48 },
  N: { baseKeycode: "KEY_N", linuxKeycode: 49 },
  M: { baseKeycode: "KEY_M", linuxKeycode: 50 },
  COMMA: { baseKeycode: "KEY_COMMA", linuxKeycode: 51 },
  DOT: { baseKeycode: "KEY_DOT", linuxKeycode: 52 },
  FSLH: { baseKeycode: "KEY_SLASH", linuxKeycode: 53 },
  RSHFT: { baseKeycode: "KEY_RIGHTSHIFT", linuxKeycode: 54 },
  LALT: { baseKeycode: "KEY_LEFTALT", linuxKeycode: 56 },
  SPACE: { baseKeycode: "KEY_SPACE", linuxKeycode: 57 },
  CAPS: { baseKeycode: "KEY_CAPSLOCK", linuxKeycode: 58 },
  F1: { baseKeycode: "KEY_F1", linuxKeycode: 59 },
  F2: { baseKeycode: "KEY_F2", linuxKeycode: 60 },
  F3: { baseKeycode: "KEY_F3", linuxKeycode: 61 },
  F4: { baseKeycode: "KEY_F4", linuxKeycode: 62 },
  F5: { baseKeycode: "KEY_F5", linuxKeycode: 63 },
  F6: { baseKeycode: "KEY_F6", linuxKeycode: 64 },
  F7: { baseKeycode: "KEY_F7", linuxKeycode: 65 },
  F8: { baseKeycode: "KEY_F8", linuxKeycode: 66 },
  F9: { baseKeycode: "KEY_F9", linuxKeycode: 67 },
  F10: { baseKeycode: "KEY_F10", linuxKeycode: 68 },
  RCTRL: { baseKeycode: "KEY_RIGHTCTRL", linuxKeycode: 97 },
  RALT: { baseKeycode: "KEY_RIGHTALT", linuxKeycode: 100 },
  HOME: { baseKeycode: "KEY_HOME", linuxKeycode: 102 },
  UP: { baseKeycode: "KEY_UP", linuxKeycode: 103 },
  PG_UP: { baseKeycode: "KEY_PAGEUP", linuxKeycode: 104 },
  LEFT: { baseKeycode: "KEY_LEFT", linuxKeycode: 105 },
  RIGHT: { baseKeycode: "KEY_RIGHT", linuxKeycode: 106 },
  END: { baseKeycode: "KEY_END", linuxKeycode: 107 },
  DOWN: { baseKeycode: "KEY_DOWN", linuxKeycode: 108 },
  PG_DN: { baseKeycode: "KEY_PAGEDOWN", linuxKeycode: 109 },
  INS: { baseKeycode: "KEY_INSERT", linuxKeycode: 110 },
  DEL: { baseKeycode: "KEY_DELETE", linuxKeycode: 111 },
  LGUI: { baseKeycode: "KEY_LEFTMETA", linuxKeycode: 125 },
  RGUI: { baseKeycode: "KEY_RIGHTMETA", linuxKeycode: 126 },
  F13: { baseKeycode: "KEY_F13", linuxKeycode: 183 },
  F23: { baseKeycode: "KEY_F23", linuxKeycode: 193 },
};

function fingerId(hand: Hand, finger: FingerName): number {
  return (hand === "L" ? 0 : 1) * 5 + FINGER_INDEX[finger];
}

export function parsePositionDefines(source: string): PositionDefinition[] {
  const definitions: PositionDefinition[] = [];
  const seenPositions = new Set<number>();
  const definePattern = /^#define\s+(POS_(LH|RH)_(?:C([1-6])R([1-6])|T([1-6])))\s+(\d+)\s*$/gm;

  for (const match of source.matchAll(definePattern)) {
    const name = match[1];
    const rawHand = match[2];
    const rawPosition = match[6];
    if (!name || !rawHand || !rawPosition) {
      throw new Error(`Malformed position define: ${match[0]}`);
    }

    const hand: Hand = rawHand === "LH" ? "L" : "R";
    const pos = Number(rawPosition);
    if (seenPositions.has(pos)) {
      throw new Error(`Duplicate position ${pos} in ${name}`);
    }
    seenPositions.add(pos);

    const rawThumb = match[5];
    if (rawThumb) {
      const thumb = Number(rawThumb);
      definitions.push({
        name,
        pos,
        hand,
        row: thumb <= 3 ? 5 : 6,
        col: null,
        finger: "thumb",
        fingerId: fingerId(hand, "thumb"),
      });
      continue;
    }

    const rawColumn = match[3];
    const rawRow = match[4];
    if (!rawColumn || !rawRow) {
      throw new Error(`Malformed column position define: ${match[0]}`);
    }
    const col = Number(rawColumn);
    const finger = COLUMN_FINGERS[col - 1];
    if (!finger) {
      throw new Error(`Invalid column ${col} in ${name}`);
    }
    definitions.push({
      name,
      pos,
      hand,
      row: Number(rawRow),
      col,
      finger,
      fingerId: fingerId(hand, finger),
    });
  }

  const missingPositions = Array.from({ length: 80 }, (_, pos) => pos)
    .filter((pos) => !seenPositions.has(pos));
  if (definitions.length !== 80 || missingPositions.length > 0) {
    throw new Error(
      `Expected exactly 80 unique positions covering 0..79; found ${definitions.length}`
      + (missingPositions.length > 0 ? `; missing ${missingPositions.join(", ")}` : ""),
    );
  }

  return definitions.sort((left, right) => left.pos - right.pos);
}

function innermostKeycode(expression: string): string {
  let keycode = expression.trim();
  const modifierWrapper = /^(?:L|R)(?:C|S|A|G)\((.+)\)$/;
  let match = keycode.match(modifierWrapper);
  while (match) {
    const inner = match[1];
    if (!inner) {
      throw new Error(`Malformed ZMK keycode expression '${expression}'`);
    }
    keycode = inner.trim();
    match = keycode.match(modifierWrapper);
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(keycode)) {
    throw new Error(`Malformed ZMK keycode expression '${expression}'`);
  }
  return keycode;
}

function linuxKeycodeFor(zmkName: string): LinuxKeycode {
  const keycode = ZMK_TO_LINUX[zmkName];
  if (!keycode) {
    throw new Error(`Unknown ZMK keycode '${zmkName}'`);
  }
  return keycode;
}

function nullBinding(): BindingResolution {
  return {
    baseKeycode: null,
    linuxKeycode: null,
    isHrm: false,
  };
}

export function resolveBaseBinding(binding: string): BindingResolution {
  if (
    binding === "&none"
    || binding === "&bootloader"
    || binding === "&sys_reset"
    || /^&(mo|magic)(?:\s|$)/.test(binding)
  ) {
    return nullBinding();
  }

  const hrmMatch = binding.match(/^&(hml|hmr)\s+(\S+)\s+(.+)$/);
  if (hrmMatch) {
    const behavior = hrmMatch[1];
    const modifier = hrmMatch[2];
    const tapExpression = hrmMatch[3];
    if (!behavior || !modifier || !tapExpression) {
      throw new Error(`Malformed home-row-mod binding '${binding}'`);
    }
    const modifierName = modifier.replace(/^[LR]/, "");
    if (!/^(CTRL|ALT|GUI|SHIFT)$/.test(modifierName)) {
      throw new Error(`Unknown home-row modifier '${modifier}' in '${binding}'`);
    }
    const hand: Hand = behavior === "hml" ? "L" : "R";
    const keycode = linuxKeycodeFor(innermostKeycode(tapExpression));
    return {
      ...keycode,
      isHrm: true,
      modClass: `${hand}_${modifierName}` as ModClass,
    };
  }

  const tapMatch = binding.match(/^&kp\s+(.+)$/)
    ?? binding.match(/^&lt\s+\S+\s+(.+)$/)
    ?? binding.match(/^&thumb_(?:left|right)\s+\S+\s+(.+)$/);
  if (tapMatch) {
    const tapExpression = tapMatch[1];
    if (!tapExpression) {
      throw new Error(`Malformed tap binding '${binding}'`);
    }
    return {
      ...linuxKeycodeFor(innermostKeycode(tapExpression)),
      isHrm: false,
    };
  }

  if (/^&[A-Za-z][A-Za-z0-9_]*$/.test(binding)) {
    return nullBinding();
  }

  throw new Error(`Unsupported base binding '${binding}'`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeKeymapHash(positions: KeymapPosition[]): string {
  const digest = createHash("sha256").update(canonicalJson(positions)).digest("hex");
  return `sha256:${digest}`;
}

function currentGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function createKeymapMeta(
  layout: Layout,
  positionDefineSource: string,
  options: KeymapMetaOptions = {},
): KeymapMeta {
  const baseLayers = layout.layers.filter((layer) => layer.name === "Base");
  if (baseLayers.length !== 1) {
    throw new Error(`Expected exactly one layer named 'Base'; found ${baseLayers.length}`);
  }
  const baseLayer = baseLayers[0];
  if (!baseLayer) {
    throw new Error("Base layer disappeared after validation");
  }

  const bindings = toPhysicalRows(baseLayer.keys).flat();
  if (bindings.length !== 80) {
    throw new Error(`Expected Base layer to flatten to 80 bindings; found ${bindings.length}`);
  }

  const positions = parsePositionDefines(positionDefineSource).map((definition): KeymapPosition => {
    const baseBinding = bindings[definition.pos];
    if (!baseBinding) {
      throw new Error(`Missing Base binding for position ${definition.pos}`);
    }
    const resolved = resolveBaseBinding(baseBinding);
    const position: KeymapPosition = {
      pos: definition.pos,
      hand: definition.hand,
      row: definition.row,
      col: definition.col,
      finger: `${definition.hand}_${definition.finger}`,
      fingerId: definition.fingerId,
      baseKeycode: resolved.baseKeycode,
      linuxKeycode: resolved.linuxKeycode,
      baseBinding,
      isHrm: resolved.isHrm,
    };
    if (resolved.modClass) {
      position.modClass = resolved.modClass;
    }
    return position;
  });

  return KeymapMetaSchema.parse({
    schemaVersion: 1,
    keymapHash: computeKeymapHash(positions),
    gitCommit: options.gitCommit ?? currentGitCommit(),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    positions,
  });
}

export function serializeKeymapMeta(meta: KeymapMeta): string {
  return `${JSON.stringify(KeymapMetaSchema.parse(meta), null, 2)}\n`;
}
