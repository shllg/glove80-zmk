export function makeLedDtsi(plan: any) {
  if (plan?.mode !== "per-key") return "";
  // You can emit your &rgb_ug sequences for ZMK here.
  // For now just a placeholder behavior you already use.
  return `// LED plan injected here\n// TODO: generate &rgb_ug RGB_* based on led.json\n`;
}

