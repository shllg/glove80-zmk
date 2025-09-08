
import fs from "fs";
import path from "path";
import { execa } from "execa";
import JSON5 from "json5";
import { Layout } from "./schema";
import { generateKeymapDtsi } from "./generateDtsi";
import { assembleDtsi } from "./assemble";
import { toDrawerYaml } from "./drawer";

const root = (...p: string[]) => path.join(process.cwd(), ...p);

async function main() {
  // Try JSON5 first, fall back to JSON
  const configPath = fs.existsSync(root("config/layout.json5")) 
    ? root("config/layout.json5") 
    : root("config/layout.json");
  
  const layoutContent = fs.readFileSync(configPath, "utf8");
  const layoutJson = configPath.endsWith(".json5") 
    ? JSON5.parse(layoutContent)
    : JSON.parse(layoutContent);
  
  const layout = Layout.parse(layoutJson);

  // Always use the new generator - we've removed the template approach
  console.log("🔨 Generating keymap from JSON...");
  const dtsi = generateKeymapDtsi(layout);
  
  fs.mkdirSync(root("out"), { recursive: true });
  fs.writeFileSync(root("out/keymap.dtsi"), dtsi);

  const yaml = toDrawerYaml(layout);
  fs.writeFileSync(root("out/keymap.yaml"), yaml);

  // Try to render SVG via keymap-drawer CLI (optional, may fail)
  try {
    await execa("keymap", ["draw", "out/keymap.yaml", "--output", "out/keymap.svg"], { stdio: "inherit" });
    console.log("✅ Built: out/keymap.dtsi, out/keymap.yaml, out/keymap.svg");
  } catch (e) {
    console.log("✅ Built: out/keymap.dtsi, out/keymap.yaml");
    console.log("⚠️  keymap-drawer failed - SVG/PDF generation skipped");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

