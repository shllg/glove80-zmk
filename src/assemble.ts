
import fs from "fs";

export function assembleDtsi(
  templatePath: string,
  devicetreeFrag: string,
  behaviorsFrag: string
) {
  let tpl = fs.readFileSync(templatePath, "utf8");
  tpl = tpl.replace(
    /\/\* >>> CUSTOM_DEVICE_TREE_START >>> \*\/[\s\S]*?\/\* <<< CUSTOM_DEVICE_TREE_END <<< \*\//,
    `/* >>> CUSTOM_DEVICE_TREE_START >>> */\n${devicetreeFrag}\n/* <<< CUSTOM_DEVICE_TREE_END <<< */`
  );
  tpl = tpl.replace(
    /\/\* >>> CUSTOM_BEHAVIORS_START >>> \*\/[\s\S]*?\/\* <<< CUSTOM_BEHAVIORS_END <<< \*\//,
    `/* >>> CUSTOM_BEHAVIORS_START >>> */\n${behaviorsFrag}\n/* <<< CUSTOM_BEHAVIORS_END <<< */`
  );
  return tpl;
}

