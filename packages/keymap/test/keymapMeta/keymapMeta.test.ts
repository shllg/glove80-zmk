import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import JSON5 from "json5";
import { Layout } from "../../src/schema";
import {
  KeymapMetaSchema,
  createKeymapMeta,
  parsePositionDefines,
  resolveBaseBinding,
  serializeKeymapMeta,
} from "../../src/keymapMeta";
import type { FingerName, KeymapMeta, KeymapPosition } from "../../src/keymapMeta";

const repositoryRoot = process.cwd();
const layoutSource = fs.readFileSync(path.join(repositoryRoot, "config/layout.json5"), "utf8");
const positionDefineSource = fs.readFileSync(
  path.join(repositoryRoot, "config/glove80.keymap"),
  "utf8",
);
const layout = Layout.parse(JSON5.parse(layoutSource));
const definitions = parsePositionDefines(positionDefineSource);

function generateMeta(): KeymapMeta {
  return createKeymapMeta(layout, positionDefineSource, {
    generatedAt: "2026-08-04T00:00:00.000Z",
    gitCommit: "test",
  });
}

function positionForDefinition(meta: KeymapMeta, definitionName: string): KeymapPosition {
  const definition = definitions.find(({ name }) => name === definitionName);
  assert.ok(definition, `missing parsed definition ${definitionName}`);
  const position = meta.positions.find(({ pos }) => pos === definition.pos);
  assert.ok(position, `missing metadata position for ${definitionName}`);
  return position;
}

const columnFinger = (col: number): FingerName => {
  const fingers = ["index", "index", "middle", "ring", "pinky", "pinky"] as const;
  const finger = fingers[col - 1];
  assert.ok(finger, `invalid test column ${col}`);
  return finger;
};

test("all 80 positions are present exactly once in order", () => {
  const { positions } = generateMeta();
  assert.equal(positions.length, 80);
  assert.deepEqual(positions.map(({ pos }) => pos), Array.from({ length: 80 }, (_, pos) => pos));
  assert.equal(new Set(positions.map(({ pos }) => pos)).size, 80);
});

test("every position has exactly one finger and the fixed fingerId encoding", () => {
  const { positions } = generateMeta();
  const fingerIndex: Record<FingerName, number> = {
    index: 0,
    middle: 1,
    ring: 2,
    pinky: 3,
    thumb: 4,
  };

  for (const position of positions) {
    const finger = position.col === null ? "thumb" : columnFinger(position.col);
    assert.equal(position.finger, `${position.hand}_${finger}`);
    assert.equal(position.fingerId, (position.hand === "L" ? 0 : 1) * 5 + fingerIndex[finger]);
  }
});

test("all Base-layer alpha keys map to distinct Linux keycodes", () => {
  const alphaNames = Array.from(
    { length: 26 },
    (_, offset) => `KEY_${String.fromCharCode("A".charCodeAt(0) + offset)}`,
  );
  const alphaNameSet = new Set(alphaNames);
  const alphaPositions = generateMeta().positions.filter(
    ({ baseKeycode }) => baseKeycode !== null && alphaNameSet.has(baseKeycode),
  );

  assert.deepEqual(
    alphaPositions.map(({ baseKeycode }) => baseKeycode).sort(),
    alphaNames.sort(),
  );
  const linuxKeycodes = alphaPositions.map(({ linuxKeycode }) => {
    assert.notEqual(linuxKeycode, null);
    return linuxKeycode;
  });
  assert.equal(new Set(linuxKeycodes).size, 26);
});

test("the six Base home-row mods use behavior-hand mod classes", () => {
  const meta = generateMeta();
  const expected = [
    ["POS_LH_C5R4", "KEY_A", "L_GUI"],
    ["POS_LH_C4R4", "KEY_S", "L_ALT"],
    ["POS_LH_C2R4", "KEY_F", "L_CTRL"],
    ["POS_RH_C2R4", "KEY_J", "R_CTRL"],
    ["POS_RH_C4R4", "KEY_L", "R_ALT"],
    ["POS_RH_C5R4", "KEY_SEMICOLON", "R_GUI"],
  ] as const;

  assert.equal(meta.positions.filter(({ isHrm }) => isHrm).length, expected.length);
  for (const [definitionName, baseKeycode, modClass] of expected) {
    const position = positionForDefinition(meta, definitionName);
    assert.equal(position.baseKeycode, baseKeycode);
    assert.equal(position.isHrm, true);
    assert.equal(position.modClass, modClass);
  }
});

test("right home row pins C1..C6 to inner-index through outer-pinky", () => {
  const meta = generateMeta();
  const expected = [
    ["KEY_H", "index"],
    ["KEY_J", "index"],
    ["KEY_K", "middle"],
    ["KEY_L", "ring"],
    ["KEY_SEMICOLON", "pinky"],
    ["KEY_APOSTROPHE", "pinky"],
  ] as const;

  for (const [index, [baseKeycode, finger]] of expected.entries()) {
    const col = index + 1;
    const position = positionForDefinition(meta, `POS_RH_C${col}R4`);
    assert.equal(position.col, col);
    assert.equal(position.finger, `R_${finger}`);
    assert.equal(position.baseKeycode, baseKeycode);
  }
});

test("keymapHash is stable for unchanged positions and changes with a binding", () => {
  const first = createKeymapMeta(layout, positionDefineSource, {
    generatedAt: "2026-08-04T00:00:00.000Z",
    gitCommit: "first",
  });
  const second = createKeymapMeta(layout, positionDefineSource, {
    generatedAt: "2026-08-05T00:00:00.000Z",
    gitCommit: "second",
  });
  assert.equal(first.keymapHash, second.keymapHash);

  const changedLayout = structuredClone(layout);
  const changedBase = changedLayout.layers.find(({ name }) => name === "Base");
  assert.ok(changedBase);
  const changedHomeRow = changedBase.keys.left[3];
  assert.ok(changedHomeRow);
  changedHomeRow[3] = "&kp E";
  const changed = createKeymapMeta(changedLayout, positionDefineSource, {
    generatedAt: "2026-08-04T00:00:00.000Z",
    gitCommit: "first",
  });
  assert.notEqual(first.keymapHash, changed.keymapHash);
});

test("unknown ZMK keycodes fail loudly with the offending name", () => {
  assert.throws(
    () => resolveBaseBinding("&kp DEFINITELY_UNKNOWN"),
    /Unknown ZMK keycode 'DEFINITELY_UNKNOWN'/,
  );
  assert.deepEqual(resolveBaseBinding("&kp LC(LA(E))"), {
    baseKeycode: "KEY_E",
    linuxKeycode: 18,
    isHrm: false,
  });
});

test("serialized keymap metadata round-trips through the zod schema", () => {
  const meta = generateMeta();
  const roundTripped = KeymapMetaSchema.parse(JSON.parse(serializeKeymapMeta(meta)));
  assert.deepEqual(roundTripped, meta);
});
