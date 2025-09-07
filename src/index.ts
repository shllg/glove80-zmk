
import fs from "fs";
import path from "path";
import { execa } from "execa";
import { Layout } from "./schema";
import { assembleDtsi } from "./assemble";
import { toDrawerYaml } from "./drawer";
import { makeLedDtsi } from "./led";

const root = (...p: string[]) => path.join(process.cwd(), ...p);

async function main() {
  const layoutJson = JSON.parse(fs.readFileSync(root("config/layout.json"), "utf8"));
  const layout = Layout.parse(layoutJson);

  const devicetreeFrag = fs.readFileSync(root("templates/fragments/custom-device-tree.dtsi"), "utf8");
  const behaviorsFragBase = fs.readFileSync(root("templates/fragments/custom-behaviors.dtsi"), "utf8");
  const behaviorsFrag = behaviorsFragBase + "\n" + makeLedDtsi(JSON.parse(fs.readFileSync(root("config/led.json"), "utf8")));

  const dtsi = assembleDtsi(
    root("templates/keymap.template.dtsi"),
    devicetreeFrag,
    behaviorsFrag
  );
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

