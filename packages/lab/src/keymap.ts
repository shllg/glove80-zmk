import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface DeviceHashRow {
  id: number;
  keymapHash: string | null;
}

interface GeneratedMeta {
  generatedAt?: unknown;
  gitCommit?: unknown;
  keymapHash?: unknown;
  layers?: unknown;
}

function modifiedAt(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return null;
  }
}

export function keymapStatus(repoRoot: string, database: Database | null) {
  const metaPath = join(repoRoot, "out/keymap-meta.json");
  const svgPath = join(repoRoot, "out/keymap.svg");
  const pdfPath = join(repoRoot, "out/keymap.pdf");
  const sourcePath = join(repoRoot, "config/layout.json5");
  let meta: GeneratedMeta | null = null;
  let error: string | null = null;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as GeneratedMeta;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const generated = modifiedAt(metaPath);
  const svg = modifiedAt(svgPath);
  const pdf = modifiedAt(pdfPath);
  const source = modifiedAt(sourcePath);
  const devices = database
    ? (database.query(`
        SELECT id, keymap_hash AS keymapHash FROM device
        WHERE keymap_hash IS NOT NULL ORDER BY id
      `).all() as DeviceHashRow[]).map((device) => ({
        id: Number(device.id),
        keymapHash: device.keymapHash,
        matchesGenerated: typeof meta?.keymapHash === "string"
          ? device.keymapHash === meta.keymapHash
          : null,
      }))
    : [];
  return {
    available: meta !== null,
    error,
    generatedAt: typeof meta?.generatedAt === "string" ? meta.generatedAt : null,
    gitCommit: typeof meta?.gitCommit === "string" ? meta.gitCommit : null,
    keymapHash: typeof meta?.keymapHash === "string" ? meta.keymapHash : null,
    layers: Array.isArray(meta?.layers)
      ? meta.layers.map((layer) => {
        const value = layer as Record<string, unknown>;
        return { index: Number(value.index), name: String(value.name) };
      })
      : [],
    artifacts: {
      svg: { available: existsSync(svgPath), modifiedAt: svg },
      pdf: { available: existsSync(pdfPath), modifiedAt: pdf },
    },
    sourceModifiedAt: source,
    outputFresh: generated !== null && svg !== null && pdf !== null
      && (source === null || generated >= source)
      && svg >= generated
      && pdf >= generated,
    devices,
    hashMismatch: devices.some((device) => device.matchesGenerated === false),
  };
}

export function keymapArtifact(repoRoot: string, kind: "svg" | "pdf"): Uint8Array | null {
  const path = join(repoRoot, `out/keymap.${kind}`);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
