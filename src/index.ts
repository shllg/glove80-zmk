
import fs from "fs";
import os from "os";
import path from "path";
import { execa } from "execa";
import JSON5 from "json5";
import { Layout } from "./schema";
import { generateKeymapDtsi } from "./generateDtsi";
import { toDrawerYaml } from "./drawer";
import { parseCombos } from "./combos";
import type { Combo } from "./combos";

const root = (...p: string[]) => path.join(process.cwd(), ...p);

const LAYERS_PER_PAGE = 3;

async function generatePdf(layout: Layout, combos: Combo[]) {
  const tempDir = root("out/temp_pdf");
  fs.mkdirSync(tempDir, { recursive: true });
  // Clean previous temp files
  for (const f of fs.readdirSync(tempDir)) fs.unlinkSync(path.join(tempDir, f));

  // Split layers into pages of LAYERS_PER_PAGE
  const pages: Layout["layers"][] = [];
  for (let i = 0; i < layout.layers.length; i += LAYERS_PER_PAGE) {
    pages.push(layout.layers.slice(i, i + LAYERS_PER_PAGE));
  }

  const pagePdfs: string[] = [];

  for (const [i, pageLayers] of pages.entries()) {
    const pageLayout = { ...layout, layers: pageLayers };
    const yaml = toDrawerYaml(pageLayout, combos);
    const yamlPath = path.join(tempDir, `page${i + 1}.yaml`);
    const svgPath = path.join(tempDir, `page${i + 1}.svg`);
    const pdfPath = path.join(tempDir, `page${i + 1}.pdf`);

    fs.writeFileSync(yamlPath, yaml);
    await execa("keymap", ["draw", yamlPath, "--output", svgPath]);
    await execa("inkscape", [svgPath, "--export-type=pdf", `--export-filename=${pdfPath}`], {
      stderr: "ignore",
    });
    pagePdfs.push(pdfPath);
  }

  const outputPdf = root("out/keymap.pdf");
  await execa("pdfunite", [...pagePdfs, outputPdf]);

  // Copy to home directory for easy access
  fs.copyFileSync(outputPdf, path.join(os.homedir(), "glove80-mapping.pdf"));
  console.log("✅ PDF: out/keymap.pdf (copied to ~/glove80-mapping.pdf)");
}

async function main() {
  const configPath = fs.existsSync(root("config/layout.json5"))
    ? root("config/layout.json5")
    : root("config/layout.json");

  const layoutContent = fs.readFileSync(configPath, "utf8");
  const layoutJson = configPath.endsWith(".json5")
    ? JSON5.parse(layoutContent)
    : JSON.parse(layoutContent);

  const layout = Layout.parse(layoutJson);
  const combos = parseCombos();

  console.log("🔨 Generating keymap...");

  // Generate .dtsi
  const dtsi = generateKeymapDtsi(layout);
  fs.mkdirSync(root("out"), { recursive: true });
  fs.writeFileSync(root("out/keymap.dtsi"), dtsi);

  // Generate YAML + SVG
  const yaml = toDrawerYaml(layout, combos);
  fs.writeFileSync(root("out/keymap.yaml"), yaml);
  await execa("keymap", ["draw", "out/keymap.yaml", "--output", "out/keymap.svg"], { stdio: "inherit" });
  console.log("✅ Built: out/keymap.dtsi, out/keymap.yaml, out/keymap.svg");

  // Generate multi-page PDF
  await generatePdf(layout, combos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
