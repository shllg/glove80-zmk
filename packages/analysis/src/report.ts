import type { AnalysisMetrics, PositionalContext } from "./metrics";

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function number(value: number, digits = 2): string {
  return value.toFixed(digits).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function positionalLine(context: PositionalContext): string {
  const base = `Unattributed: ${percent(context.unattributedShare)} `
    + `(${context.unattributedPresses}/${context.tierBKeystrokes} Tier B keystrokes)`;
  return context.unreliable
    ? `${base} — WARNING: >25%; POSITIONAL METRICS ARE UNRELIABLE`
    : base;
}

export function renderReport(metrics: AnalysisMetrics): string {
  const lines: string[] = [
    "keylab analysis",
    `Range: ${metrics.range.label}`,
    `Profile: ${metrics.header.profile}`,
    `Keystrokes: ${metrics.header.totalKeystrokes}  Autorepeats: ${metrics.header.autorepeats}`,
    `Tier A buckets: ${metrics.header.bucketCount}  Tier B windows: ${metrics.header.tierBWindowCount}`,
  ];
  if (metrics.header.noData) lines.push("NO DATA IN RANGE");
  if (metrics.header.altHandAmbiguous) {
    lines.push(
      "ALT HAND AMBIGUITY: ALT is hand-unattributed because both home row ALT keys emit "
      + "KEY_LEFTALT; L_ALT figures conflate both hands.",
    );
  }

  lines.push("", "Per-finger load (Tier A)");
  for (const finger of metrics.perFinger) {
    lines.push(`  ${finger.label.padEnd(9)} ${String(finger.presses).padStart(7)}  ${percent(finger.share)}`);
  }

  lines.push("", "Per-row load (Tier A; overall share / within-hand share)");
  for (const hand of ["L", "R"] as const) {
    const values = metrics.perRow
      .filter((row) => row.hand === hand)
      .map((row) => `r${row.rowIdx} ${row.presses} (${percent(row.share)} / ${percent(row.handShare)})`);
    lines.push(`  ${hand}: ${values.join("  ")}`);
  }

  lines.push("", "Outer-upper quadrant (Tier B; rows 1-3, cols 4-6; excludes unattributed)");
  for (const hand of metrics.outerUpperQuadrant.byHand) {
    lines.push(
      `  ${hand.hand}: ${hand.presses}/${hand.attributedHandPresses} attributed hand presses `
      + `(${percent(hand.share)})`,
    );
  }
  lines.push(`  ${positionalLine(metrics.outerUpperQuadrant.positional)}`);

  lines.push("", "Modifier holds (bucket-resolution estimates, not exact)");
  for (const modifier of metrics.modifierHolds) {
    lines.push(
      `  ${modifier.label.padEnd(7)} n=${modifier.count}  total ${modifier.total.label}  `
      + `median ${modifier.median.label}  p95 ${modifier.p95.label}`,
    );
  }

  lines.push("", "Misfires per 1000 keystrokes");
  for (const kind of metrics.misfires.kinds) {
    const target = kind.kind === 0
      ? `  headline target <${metrics.misfires.targetPercent}%: `
        + `${metrics.misfires.lonelyModTargetMet ? "PASS" : "ABOVE TARGET"}`
      : "";
    lines.push(`  ${kind.label}: ${number(kind.per1000)} (${kind.count})${target}`);
    lines.push(`    ${kind.byModClass.map((item) => `${item.label} ${number(item.per1000)}`).join("  ")}`);
  }

  const correction = metrics.correctionTax;
  lines.push(
    "",
    "Correction tax",
    `  Tier B position-derived backspaces: ${correction.positionalBackspacePresses} `
      + `(${percent(correction.positionalShare)})`,
    `  Tier A BSP_BURST estimate: ${correction.burstEstimateOpenEnded ? ">=" : "~"}`
      + `${number(correction.burstEstimatedBackspacePresses)} presses `
      + `(${percent(correction.burstShare)})`,
    `  ${positionalLine(correction.positional)}`,
  );

  lines.push(
    "",
    "Daily dose",
    `  Active days: ${metrics.dailyDose.dayCount}  Keystrokes/day: ${number(metrics.dailyDose.keystrokesPerDay)}`,
    `  Hold-hours/day: ${number(metrics.dailyDose.holdHoursPerDay, 4)} `
      + "(hold_hist + mod_hold_hist midpoint estimates)",
  );
  for (const day of metrics.dailyDose.days) {
    lines.push(`  ${day.date}: ${day.keystrokes} keystrokes, ${number(day.holdHours, 4)} hold-hours`);
  }

  lines.push("", "Fatigue drift by local hour");
  const activeHours = metrics.fatigueDrift.filter(({ metrics: hourly }) => !hourly.header.noData);
  if (activeHours.length === 0) {
    lines.push("  no data in range");
  } else {
    lines.push("  hour  keys  hold-h/day  lonely/1k  bsp% TierB  outer L/R  unattributed");
    for (const { hour, metrics: hourly } of activeHours) {
      const outer = hourly.outerUpperQuadrant.byHand;
      lines.push(
        `  ${String(hour).padStart(2, "0")}:00  ${String(hourly.header.totalKeystrokes).padStart(5)}  `
        + `${number(hourly.dailyDose.holdHoursPerDay, 4).padStart(10)}  `
        + `${number(hourly.misfires.kinds[0]?.per1000 ?? 0).padStart(9)}  `
        + `${percent(hourly.correctionTax.positionalShare).padStart(10)}  `
        + `${percent(outer[0]?.share ?? 0)}/${percent(outer[1]?.share ?? 0)}  `
        + percent(hourly.outerUpperQuadrant.positional.unattributedShare),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
