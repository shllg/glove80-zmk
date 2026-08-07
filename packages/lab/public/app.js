import { createRefreshScheduler } from "/refresh-scheduler.js";
import {
  applyStatus,
  correctionContextSummary,
  correctionFootnote,
  createRouteTracker,
  fingerLabel,
  mechanicAvailable,
  misfireSummary,
  percentage,
  positionalSummary,
  rateLevel,
  recommendedDrill,
  trainingErrorIsTerminal,
} from "/view-model.js";
import { applyInput, createTypingSession, noteKeydown } from "/typing-session.js";

const byId = (id) => document.querySelector(`#${id}`);
const element = (tag, className = "", text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const number = (value, digits = 0) => Number(value ?? 0).toLocaleString(undefined, {
  maximumFractionDigits: digits,
  minimumFractionDigits: digits,
});
const visible = (text) => String(text).replaceAll(" ", "␣");

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : { error: (await response.text()).trim() };
    throw new ApiError(body.error || `Request failed (${response.status})`, response.status, body.code);
  }
  if (response.status === 204) return null;
  return response.json();
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function replace(node, children) {
  node.replaceChildren(...(Array.isArray(children) ? children : [children]));
}

function statusRows(entries) {
  return entries.map(([label, value]) => {
    const row = element("div", "status-item");
    row.append(element("strong", "", label), element("span", "", value));
    return row;
  });
}

function simpleRows(entries) {
  if (entries.length === 0) return [element("p", "hint", "No data in this selection.")];
  return entries.map(([label, value]) => {
    const row = element("div", "weak-row");
    row.append(element("strong", "", label), element("span", "", value));
    return row;
  });
}

function table(headers, rows, rowAttributes) {
  const node = element("table");
  const head = element("thead");
  const headerRow = element("tr");
  for (const header of headers) headerRow.append(element("th", "", header));
  head.append(headerRow);
  const body = element("tbody");
  rows.forEach((values, index) => {
    const row = element("tr");
    if (rowAttributes) rowAttributes(row, index);
    for (const value of values) row.append(element("td", "", value));
    body.append(row);
  });
  node.append(head, body);
  return node;
}

const STORAGE_PREFIX = "glove80.lab.";
function stored(key, fallback = "") {
  try { return sessionStorage.getItem(STORAGE_PREFIX + key) ?? fallback; } catch { return fallback; }
}
function remember(key, value) {
  try { sessionStorage.setItem(STORAGE_PREFIX + key, value); } catch { /* optional storage */ }
}
function restoreSelect(select, key) {
  const value = new URL(location.href).searchParams.get(key) ?? stored(key);
  if ([...select.options].some((option) => option.value === value)) select.value = value;
}

let health = null;
let devices = [];
let insightSummary = null;
let activeSession = null;
let heartbeatTimer = null;
let trainingSavePending = false;
let compositionInput = false;
const routeTracker = createRouteTracker(location.pathname, `${location.pathname}${location.search}`);

function replaceLocation(value) {
  history.replaceState(null, "", value);
  routeTracker.replaceLocation(value);
}

function setChip(id, text, state = "") {
  const chip = byId(id);
  chip.textContent = text;
  chip.className = `chip${state ? ` ${state}` : ""}`;
}

function renderHealth(value) {
  health = value;
  setChip("service-chip", `service · ${value.service}`, value.service === "active" ? "good" : "bad");
  setChip("capture-chip", `capture · ${value.capture}${value.paused ? " · paused" : ""}`,
    value.capture === "fresh" && !value.paused ? "good" : "bad");
  setChip("layer-chip", `layer · ${value.layer ?? "unknown"}`);
  byId("overview-rate").textContent = `${number(value.keystrokesPerMinute, 0)} WPM-ish`;
  byId("overview-profile").textContent = value.profile;
  byId("pause-toggle").textContent = value.softPaused ? "Resume capture" : "Pause capture";
  const mechanic = [...byId("family").options].find((option) => option.value === "mechanic");
  mechanic.disabled = !mechanicAvailable(value);
  mechanic.title = mechanic.disabled ? "Requires active, fresh, unpaused keylab capture" : "";
  if (mechanic.disabled && byId("family").value === "mechanic") {
    byId("family").value = "position";
    if (location.pathname === "/train") rememberTrainFilters();
  }
  const profile = byId("profile");
  const signature = value.profiles.join("\0");
  if (profile.dataset.signature !== signature) {
    profile.dataset.signature = signature;
    profile.replaceChildren(...value.profiles.map((name) => {
      const option = element("option", "", name);
      option.value = name;
      return option;
    }));
  }
  profile.value = value.profile;
  replace(byId("health-detail"), statusRows([
    ["Service", value.service],
    ["Capture snapshot", value.capture],
    ["Snapshot age", value.snapshotAgeSeconds === null ? "none" : `${value.snapshotAgeSeconds}s`],
    ["Database", value.database.compatible ? "schema compatible" : value.database.error ?? "absent"],
    ["Soft pause", value.softPaused ? "on" : "off"],
    ["Hard pause", value.hardPaused ? "on · filesystem marker" : "off"],
    ["Profile", value.profile],
    ["Layer", value.layer ?? "not reported"],
  ]));
  const warnings = [];
  if (value.capture !== "fresh") warnings.push(`Capture telemetry is ${value.capture}.`);
  if (value.hardPaused) warnings.push("The hard PAUSED marker is active; Lab cannot remove it.");
  if (value.database.error) warnings.push(value.database.error);
  const warning = byId("global-warning");
  warning.hidden = warnings.length === 0;
  warning.textContent = warnings.join(" ");
}

async function loadHealth() {
  try {
    renderHealth(await api("/api/health"));
  } catch (error) {
    setChip("capture-chip", "capture · unreachable", "bad");
    byId("global-warning").hidden = false;
    byId("global-warning").textContent = error.message;
  }
}

function confidenceText(model) {
  if (model.confidence === "trainer") return `Trainer-derived from ${model.sessionCount} completed sessions.`;
  if (model.confidence === "keylab-tier-c") return "Based on keys corrected per press in real work.";
  if (model.confidence === "bootstrap") return "Bootstrapped from keylab use; trainer evidence is not sufficient yet.";
  return "Neutral keymap fallback; no keylab or trainer evidence is available yet.";
}

function renderWeakness(model, target) {
  const entries = [
    ...model.mechanics.slice(0, 3).map((item) => [item.label, item.detail]),
    ...model.positions.slice(0, 5).map((item) => [
      item.label,
      item.errorRate !== null
        ? `${percentage(item.errorRate)} errors · n=${item.attempts}`
        : item.correctionRate !== null
          ? `${percentage(item.correctionRate)} weighted corrections / press`
          : item.presses > 0 ? `${item.presses} presses · frequency evidence` : "keymap fallback",
    ]),
  ];
  replace(target, simpleRows(entries));
}

function renderTrends(history, target) {
  const entries = Object.entries(history.rollingMedianWpm).map(([language, medians]) => {
    const count = history.points.filter((point) => point.language === language).length;
    return [language.toUpperCase(), `${count} runs · ${number(medians.at(-1), 1)} WPM median`];
  });
  replace(target, simpleRows(entries));
  const latest = Object.values(history.rollingMedianWpm).flatMap((values) => values.slice(-1));
  byId("overview-median").textContent = latest.length === 0 ? "—" : `${number(latest.at(-1), 1)} WPM`;
}

async function loadOverview() {
  await loadHealth();
  const results = await Promise.allSettled([
    api("/api/summary?range=live&profile=*&device=*&corrections=all"),
    api("/api/training/weakness"),
    api("/api/training/history"),
  ]);
  if (results[0].status === "fulfilled") {
    byId("overview-keys").textContent = number(results[0].value.header.totalKeystrokes);
  } else {
    byId("overview-keys").textContent = "unavailable";
  }
  if (results[1].status === "fulfilled") {
    byId("weakness-confidence").textContent = confidenceText(results[1].value);
    renderWeakness(results[1].value, byId("overview-weakness"));
    const family = recommendedDrill(results[1].value);
    byId("overview-recommended").href = `/train?mode=drill&family=${family}&language=en`;
  } else {
    byId("weakness-confidence").textContent = results[1].reason.message;
  }
  if (results[2].status === "fulfilled") renderTrends(results[2].value.benchmark, byId("overview-history"));
}

byId("pause-toggle").addEventListener("click", async () => {
  try { await post("/api/control", { paused: !health?.softPaused }); await loadHealth(); }
  catch (error) { byId("global-warning").hidden = false; byId("global-warning").textContent = error.message; }
});
byId("profile").addEventListener("change", async () => {
  try { await post("/api/control", { profile: byId("profile").value }); await loadHealth(); }
  catch (error) { byId("profile").value = health?.profile ?? "default"; byId("global-warning").hidden = false; byId("global-warning").textContent = error.message; }
});

function level(value, maximum) {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(10, Math.ceil(Math.log1p(value) / Math.log1p(maximum) * 10)));
}
function keyLabel(position) { return position.baseKeycode?.replace(/^KEY_/, "") ?? "—"; }
function renderHeatmap() {
  if (!insightSummary) return;
  const correctionMode = byId("layer").value === "corrections";
  byId("latency-control").hidden = !correctionMode;
  byId("heatmap-source").textContent = correctionMode ? "Tier C · corrections per press" : "Tier B · unordered counts";
  byId("heatmap-title").textContent = correctionMode ? "Corrected key load" : "Physical key load";
  const layer = correctionMode ? insightSummary.correctionLayer : null;
  const corrections = new Map((layer?.positions ?? []).map((entry) => [entry.pos, entry]));
  const maximum = Math.max(0, ...insightSummary.positionLoad.map((position) => position.presses));
  const cells = insightSummary.positionLoad.map((position) => {
    const entry = corrections.get(position.pos);
    const rate = entry?.rate ?? null;
    const heat = correctionMode
      ? rate === null ? "no-data" : `heat-${rateLevel(rate, layer.maximumRate)}`
      : `heat-${level(position.presses, maximum)}`;
    const key = element("div", `key-cell ${heat} pos-${position.pos}`);
    if (position.col === null) key.classList.add("thumb-key");
    else key.classList.add("main-key", `hand-${position.hand}`, `row-${position.row}`, `col-${position.col}`);
    key.append(element("span", "", keyLabel(position)), element("small", "",
      correctionMode ? rate === null ? "—" : percentage(rate) : String(position.presses)));
    key.title = correctionMode
      ? rate === null ? `${position.presses} presses: below the measurement floor` : `${entry.corrections} corrections in ${position.presses} presses`
      : `${position.finger} · ${position.presses} presses`;
    return key;
  });
  replace(byId("heatmap"), cells);
  byId("correction-note").hidden = !correctionMode;
  if (correctionMode) byId("correction-note").textContent = correctionFootnote(layer);
}

function renderBars(items, target, label, value) {
  const maximum = Math.max(0, ...items.map(value));
  replace(target, items.map((item) => {
    const row = element("div", "bar-row");
    const track = element("div", "bar-track");
    track.append(element("div", `bar-fill width-${level(value(item), maximum)}`));
    row.append(element("span", "", label(item)), track, element("span", "bar-value", number(value(item))));
    return row;
  }));
}

function renderFingers(fingers) {
  const groups = ["L", "R"].map((hand) => {
    const section = element("section", "chart-hand");
    const bars = element("div");
    renderBars(fingers.filter((item) => item.hand === hand), bars,
      (item) => fingerLabel(item), (item) => item.presses);
    section.append(element("h3", "", hand === "L" ? "LEFT HAND" : "RIGHT HAND"), bars);
    return section;
  });
  replace(byId("finger-chart"), groups);
}

function renderModifiers(modifiers) {
  replace(byId("modifier-chart"), modifiers.map((modifier) => {
    const section = element("section", "histogram");
    section.append(element("h3", "", modifier.label));
    const bars = element("div", "hist-bars");
    const maximum = Math.max(0, ...modifier.histogram.map((bin) => bin.count));
    for (const bin of modifier.histogram) {
      const bar = element("div", `hist-bar height-${level(bin.count, maximum)}`);
      bar.title = `${bin.openEnded ? ">=" : "~"}${bin.midpointMs} ms · ${bin.count}`;
      bars.append(bar);
    }
    section.append(bars, element("p", "hist-meta", `n=${modifier.count} · total ${modifier.total.label} · median ${modifier.median.label} · p95 ${modifier.p95.label}`));
    return section;
  }));
}

function renderInsights(summary) {
  insightSummary = summary;
  byId("total-keys").textContent = number(summary.header.totalKeystrokes);
  byId("autorepeats").textContent = number(summary.header.autorepeats);
  byId("tier-a-buckets").textContent = number(summary.header.bucketCount);
  byId("tier-b-windows").textContent = number(summary.header.tierBWindowCount);
  byId("alt-hand-warning").hidden = !summary.header.altHandAmbiguous;
  const positional = summary.outerUpperQuadrant.positional;
  byId("unattributed").textContent = percentage(positional.unattributedShare);
  byId("unattributed-card").classList.toggle("unreliable", positional.unreliable);
  byId("reliability-warning").hidden = !positional.unreliable;
  renderHeatmap();
  renderFingers(summary.perFinger);
  replace(byId("row-load"), simpleRows(summary.perRow.map((row) => [
    `${row.hand} row ${row.rowIdx}`, `${number(row.presses)} · ${percentage(row.share)} overall · ${percentage(row.handShare)} of hand`,
  ])));
  replace(byId("layer-usage"), summary.layerUsage === null
    ? [element("p", "hint", "No layer attribution was recorded in this range.")]
    : simpleRows(summary.layerUsage.byLayer.map((layer) => [layer.name, `${number(layer.presses)} · ${percentage(layer.share)}`])));
  replace(byId("outer-load"), simpleRows([
    ...summary.outerUpperQuadrant.byHand.map((hand) => [hand.hand, `${number(hand.presses)}/${number(hand.attributedHandPresses)} · ${percentage(hand.share)}`]),
    ["Position quality", positionalSummary(positional)],
  ]));
  renderModifiers(summary.modifierHolds);
  replace(byId("misfires"), simpleRows(summary.misfires.kinds.map((kind) => [
    kind.label,
    misfireSummary(kind, summary.misfires),
  ])));
  const tax = summary.correctionTax;
  replace(byId("correction-tax"), simpleRows([
    ["Tier B backspaces", `${number(tax.positionalBackspacePresses)} · ${percentage(tax.positionalShare)}`],
    ["Tier A burst estimate", `${tax.burstEstimateOpenEnded ? ">=" : "~"}${number(tax.burstEstimatedBackspacePresses, 1)} · ${percentage(tax.burstShare)}`],
    ["Position quality", positionalSummary(tax.positional)],
  ]));
  const context = tax.context;
  const contextSummary = correctionContextSummary(context);
  const contextNodes = [element("p", "hint", contextSummary === null
    ? "No sealed Tier C windows in range. This does not mean no corrections were made."
    : contextSummary.headline)];
  if (context.windowCount > 0) {
    contextNodes.push(element("p", "hint", contextSummary.latency));
    contextNodes.push(element("p", "hint", contextSummary.top));
    contextNodes.push(table(["count", "trigram", "latency", "run", "modifiers"], context.topNgrams.map((entry) => [
      number(entry.count), entry.characters, entry.latencyClass, entry.runLabel, entry.modLabels.join("+") || "—",
    ])));
    contextNodes.push(element("p", "hint", contextSummary.fingers));
    if (context.byFinger.length > 0) contextNodes.push(table(
      ["count", "fingers", "latency", "run"],
      context.byFinger.map((entry) => [number(entry.count), entry.labels, entry.latencyClass, entry.runLabel]),
    ));
  }
  replace(byId("correction-context"), contextNodes);
  replace(byId("daily-dose"), [
    ...simpleRows([
      ["Active days", number(summary.dailyDose.dayCount)],
      ["Keystrokes / day", number(summary.dailyDose.keystrokesPerDay, 1)],
      ["Hold-hours / day", number(summary.dailyDose.holdHoursPerDay, 4)],
    ]),
    table(["date", "keys", "hold-hours"], summary.dailyDose.days.map((day) => [day.date, number(day.keystrokes), number(day.holdHours, 4)])),
  ]);
  const activeHours = summary.fatigueDrift.filter((entry) => !entry.metrics.header.noData);
  replace(byId("fatigue-drift"), activeHours.length === 0
    ? [element("p", "hint", "No hourly data in range.")]
    : table(["hour", "keys", "hold-h/day", "lonely/1k", "BSP", "outer L/R", "unattributed"], activeHours.map(({ hour, metrics }) => [
      `${String(hour).padStart(2, "0")}:00`,
      number(metrics.header.totalKeystrokes),
      number(metrics.dailyDose.holdHoursPerDay, 4),
      number(metrics.misfires.kinds[0]?.per1000, 2),
      percentage(metrics.correctionTax.positionalShare),
      metrics.outerUpperQuadrant.byHand.map((hand) => percentage(hand.share)).join(" / "),
      percentage(metrics.outerUpperQuadrant.positional.unattributedShare),
    ])));
}

function renderProfileOptions(profiles) {
  const select = byId("view-profile");
  const previous = select.value || stored("profile", "*");
  const all = element("option", "", "All profiles"); all.value = "*";
  select.replaceChildren(all, ...profiles.map((name) => { const option = element("option", "", name); option.value = name; return option; }));
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "*";
}

function renderDeviceOptions(values) {
  devices = values;
  const select = byId("device");
  const previous = select.value || stored("device", "*");
  const options = [];
  if (values.length > 0 && new Set(values.map((device) => device.positionSpace)).size <= 1) {
    const all = element("option", "", values.length === 1 ? "All keyboards" : "All · one position space"); all.value = "*"; options.push(all);
  }
  for (const device of values) {
    const option = element("option", "", `${device.name} · ${device.positionSpace ?? "unknown"} · #${device.id} · ${number(device.keystrokes)} keys`);
    option.value = String(device.id); options.push(option);
  }
  select.replaceChildren(...options);
  select.value = options.some((option) => option.value === previous) ? previous : options[0]?.value ?? "*";
}

function rememberInsightFilters() {
  for (const [id, key] of [["range", "range"], ["view-profile", "profile"], ["device", "device"], ["layer", "heatmap"], ["correction-latency", "corrections"]]) {
    remember(key, byId(id).value);
  }
  if (location.pathname === "/insights") {
    const query = new URLSearchParams({
      range: byId("range").value,
      profile: byId("view-profile").value,
      device: byId("device").value,
      heatmap: byId("layer").value,
      corrections: byId("correction-latency").value,
    });
    replaceLocation(`/insights?${query}`);
  }
}

async function loadInsights() {
  applyStatus(byId("insights-status"), "Loading telemetry…");
  try {
    const [control, loadedDevices] = await Promise.all([api("/api/control"), api("/api/devices")]);
    renderProfileOptions(control.profiles);
    renderDeviceOptions(loadedDevices);
    for (const [id, key] of [["range", "range"], ["view-profile", "profile"], ["device", "device"], ["layer", "heatmap"], ["correction-latency", "corrections"]]) restoreSelect(byId(id), key);
    const query = new URLSearchParams({
      range: byId("range").value,
      profile: byId("view-profile").value || "*",
      device: byId("device").value || "*",
      corrections: byId("correction-latency").value,
    });
    renderInsights(await api(`/api/summary?${query}`));
    rememberInsightFilters();
    applyStatus(byId("insights-status"), `Showing ${insightSummary.range.label} · ${insightSummary.header.profile} · ${insightSummary.header.device}`
      + ` · ${insightSummary.header.positionSpace ?? "no Tier B position space"}`
      + (insightSummary.header.noData ? " · no data in range" : ""));
  } catch (error) {
    applyStatus(byId("insights-status"), error.message, true);
  }
}
const refreshInsights = createRefreshScheduler(loadInsights);
for (const id of ["range", "view-profile", "device", "correction-latency"]) byId(id).addEventListener("change", () => { rememberInsightFilters(); refreshInsights(); });
byId("layer").addEventListener("change", () => { rememberInsightFilters(); renderHeatmap(); });

function renderPrompt(text, typedLength, wrongIndices) {
  replace(byId("prompt"), [...text].map((character, index) => {
    const className = index < typedLength ? wrongIndices.has(index) ? "wrong" : "done" : index === typedLength ? "cursor" : "pending";
    return element("span", className, character);
  }));
}

function renderCorrections(attribution, target = byId("corrections")) {
  const total = attribution?.corrections ?? 0;
  byId("correction-count").textContent = String(total);
  if (!attribution || total === 0) { replace(target, element("p", "hint", "No corrections in this session.")); return; }
  const nodes = [element("p", "hint", `${attribution.charactersRemoved} characters removed · ${attribution.byLatency.fumble} fumble · ${attribution.byLatency.ambiguous} ambiguous · ${attribution.byLatency.edit} edit`)];
  nodes.push(...simpleRows(attribution.words.slice(0, 8).map((word) => [
    word.word, `${word.corrections} in ${word.occurrences} · ${word.offsets.map((entry) => `offset ${entry.offset}×${entry.count}`).join(", ")}`,
  ])));
  if (attribution.transitions.length > 0) nodes.push(element("p", "hint", `Transitions: ${attribution.transitions.slice(0, 8).map((entry) => `${visible(entry.transition)} ×${entry.corrections}`).join(" · ")}`));
  replace(target, nodes);
}

function clearHeartbeat() { if (heartbeatTimer !== null) clearInterval(heartbeatTimer); heartbeatTimer = null; }
function endTrainingWithoutSave(error) {
  resetTrainingUi();
  setChip("training-capture", "session ended · capture unverified", "bad");
  applyStatus(byId("train-status"), "Session ended without saving because its capture lease was lost.", true);
  byId("training-warning").hidden = false;
  byId("training-warning").textContent = error.message;
}
function startHeartbeat() {
  clearHeartbeat();
  if (!activeSession) return;
  heartbeatTimer = setInterval(async () => {
    try {
      const value = await post("/api/training/heartbeat", { token: activeSession?.id });
      if (value.leaseExpiresAt !== null) {
        setChip("training-capture", `capture · ${activeSession.keylabProfile} · lease to ${new Date(value.leaseExpiresAt * 1000).toLocaleTimeString()}`, "good");
      }
    } catch (error) {
      if (trainingErrorIsTerminal(error.code)) {
        endTrainingWithoutSave(error);
      } else {
        setChip("training-capture", "capture heartbeat failed", "bad");
        byId("training-warning").hidden = false;
        byId("training-warning").textContent = error.message;
      }
    }
  }, 10_000);
}

function resetTrainingUi() {
  activeSession = null;
  trainingSavePending = false;
  compositionInput = false;
  clearHeartbeat();
  byId("entry").disabled = true;
  byId("cancel-training").hidden = true;
  byId("complete-mechanic").hidden = true;
  byId("complete-mechanic").disabled = false;
  byId("mechanic-steps").hidden = true;
  byId("start").disabled = false;
  setChip("training-capture", "No active session");
}

async function cancelTraining() {
  if (!activeSession) return;
  const token = activeSession.id;
  try { await post("/api/training/cancel", { token }); } finally {
    resetTrainingUi();
    applyStatus(byId("train-status"), "Session cancelled. Nothing was stored.");
  }
}

function showScore(result) {
  const score = result.score;
  byId("wpm").textContent = score === null ? "guided" : number(score.wpm, 1);
  byId("accuracy").textContent = score === null ? "unscored" : percentage(score.accuracy);
  byId("keystrokes").textContent = score === null ? "—" : String(score.keystrokes);
  byId("composed").textContent = score === null ? "—" : String(score.unattributedCharacters);
  const composed = score !== null && score.unattributedCharacters > 0;
  byId("composed-card").classList.toggle("unreliable", composed);
  byId("ibus-note").hidden = !composed;
  if (composed) byId("ibus-note").textContent = `${score.unattributedCharacters} characters arrived without a keydown. Browser attribution is unavailable; keylab evdev telemetry measures their physical cost.`;
  renderCorrections(result.corrections);
}

async function finishTraining() {
  if (!activeSession || trainingSavePending) return;
  const current = activeSession;
  trainingSavePending = true;
  byId("entry").disabled = true;
  byId("complete-mechanic").disabled = true;
  applyStatus(byId("train-status"), "Saving the completed session atomically…");
  try {
    const result = await post("/api/training/finish", {
      token: current.id,
      keystrokes: current.keystrokes,
      corrections: current.corrections,
    });
    showScore(result);
    resetTrainingUi();
    applyStatus(byId("train-status"), `Session ${result.sessionId} saved.${result.warning ? ` ${result.warning}` : ""}`);
    byId("training-warning").hidden = !result.warning;
    byId("training-warning").textContent = result.warning ?? "";
  } catch (error) {
    if (trainingErrorIsTerminal(error.code)) {
      endTrainingWithoutSave(error);
      return;
    }
    trainingSavePending = false;
    if (activeSession === current) {
      byId("entry").disabled = current.drillFamily === "mechanic";
      byId("complete-mechanic").disabled = false;
    }
    applyStatus(byId("train-status"), `Save failed; the finished result remains retryable: ${error.message}`, true);
  }
}

async function startTraining(body, trainerOnly = false) {
  try {
    const started = await post("/api/training/start", { ...body, trainerOnly });
    activeSession = createTypingSession(started.token, started.text);
    activeSession.keylabProfile = started.keylabProfile;
    activeSession.drillFamily = started.drillFamily;
    byId("start").disabled = true;
    byId("cancel-training").hidden = false;
    byId("training-warning").hidden = !started.warning;
    byId("training-warning").textContent = started.warning ?? "";
    byId("rationale").hidden = !started.rationale;
    byId("rationale").textContent = `${started.rationale ?? ""}${started.confidence ? ` Evidence: ${started.confidence}.` : ""}`;
    setChip("training-capture", started.keylabProfile ? `capture · ${started.keylabProfile}` : "trainer-only", started.keylabProfile ? "good" : "bad");
    byId("entry").value = "";
    byId("prompt").hidden = started.drillFamily === "mechanic";
    byId("entry").hidden = started.drillFamily === "mechanic";
    byId("mechanic-steps").hidden = started.drillFamily !== "mechanic";
    byId("complete-mechanic").hidden = started.drillFamily !== "mechanic";
    if (started.drillFamily === "mechanic") {
      replace(byId("mechanic-steps"), started.steps.map((step, index) => element("div", "mechanic-step", `${index + 1}. ${step.instruction}`)));
    } else {
      renderPrompt(started.text, 0, new Set());
      byId("entry").disabled = false;
      byId("entry").focus();
    }
    applyStatus(byId("train-status"), `${started.mode === "benchmark" ? "Benchmark" : "Drill"} · ${started.corpusId} @ ${started.corpusVersion} · seed ${started.seed}`);
    startHeartbeat();
  } catch (error) {
    if (error.code === "capture-paused" && !trainerOnly && confirm(`${error.message}\n\nStart trainer-only practice?`)) {
      await startTraining(body, true);
      return;
    }
    applyStatus(byId("train-status"), error.message, true);
  }
}

byId("entry").addEventListener("keydown", (event) => { if (activeSession) noteKeydown(activeSession, event); });
byId("entry").addEventListener("compositionstart", () => { compositionInput = true; });
byId("entry").addEventListener("compositionend", () => { queueMicrotask(() => { compositionInput = false; }); });
byId("entry").addEventListener("input", (event) => {
  if (!activeSession) return;
  const typed = byId("entry").value;
  const outcome = applyInput(activeSession, typed, performance.now(), {
    inputType: event.inputType,
    isComposing: event.isComposing || compositionInput,
    trusted: event.isTrusted,
  });
  if (outcome.kind === "unsupported") {
    byId("entry").value = outcome.acceptedValue;
    applyStatus(byId("train-status"), "Paste, autofill, replacements, and mid-text insertion are disabled because they are not measurable physical keystrokes.", true);
    return;
  }
  if (outcome.kind !== "outside") renderPrompt(activeSession.text, outcome.acceptedValue.length, activeSession.wrongIndices);
  if (outcome.complete) finishTraining();
});
byId("entry").addEventListener("paste", (event) => event.preventDefault());
byId("start").addEventListener("click", () => startTraining({
  mode: byId("mode").value,
  family: byId("family").value,
  language: byId("language").value,
  wordCount: Number(byId("word-count").value),
  deviceLabel: navigator.platform || "unknown",
}));
byId("cancel-training").addEventListener("click", () => cancelTraining());
byId("complete-mechanic").addEventListener("click", () => finishTraining());
function updateTrainingControls() {
  const benchmark = byId("mode").value === "benchmark";
  byId("family").disabled = benchmark;
  if (benchmark && byId("language").value === "code") byId("language").value = "en";
  [...byId("language").options].find((option) => option.value === "code").disabled = benchmark;
}
updateTrainingControls();
resetTrainingUi();

const trainFilters = [
  ["mode", "train.mode"],
  ["family", "train.family"],
  ["language", "train.language"],
  ["word-count", "train.length"],
];
function rememberTrainFilters() {
  for (const [id, key] of trainFilters) remember(key, byId(id).value);
  if (location.pathname === "/train") {
    const query = new URLSearchParams({
      mode: byId("mode").value,
      family: byId("family").value,
      language: byId("language").value,
      length: byId("word-count").value,
    });
    replaceLocation(`/train?${query}`);
  }
}
function restoreTrainFilters() {
  for (const [id, key] of trainFilters) {
    const queryKey = key.replace("train.", "");
    const value = new URL(location.href).searchParams.get(queryKey) ?? stored(key);
    const select = byId(id);
    if ([...select.options].some((option) => option.value === value)) select.value = value;
  }
  updateTrainingControls();
}
for (const [id] of trainFilters) byId(id).addEventListener("change", () => {
  updateTrainingControls();
  rememberTrainFilters();
});

function historyQuery() {
  const query = new URLSearchParams();
  if (byId("history-mode").value) query.set("mode", byId("history-mode").value);
  if (byId("history-language").value) query.set("language", byId("history-language").value);
  return query.toString();
}

function restoreHistoryFilters() {
  for (const [id, key] of [["history-mode", "history.mode"], ["history-language", "history.language"]]) {
    const queryKey = key.replace("history.", "");
    const value = new URL(location.href).searchParams.get(queryKey) ?? stored(key);
    const select = byId(id);
    if ([...select.options].some((option) => option.value === value)) select.value = value;
  }
}

function rememberHistoryFilters() {
  remember("history.mode", byId("history-mode").value);
  remember("history.language", byId("history-language").value);
  const query = historyQuery();
  if (location.pathname === "/history") {
    replaceLocation(`/history${query ? `?${query}` : ""}`);
  }
}

async function showHistoryDetail(sessionId) {
  try {
    const detail = await api(`/api/training/history/${sessionId}`);
    const { session, score, corrections } = detail;
    const nodes = [
      ...statusRows([
        ["Session", `#${session.id} · ${session.mode}${session.drillFamily ? ` · ${session.drillFamily}` : ""}`],
        ["Started", new Date(session.startedTs * 1000).toLocaleString()],
        ["Corpus", `${session.corpusId} @ ${session.corpusVersion} · seed ${session.seed}`],
        ["Language / profile", `${session.language} · ${session.keylabProfile ?? "trainer-only"}`],
        ["Score", score === null ? "guided · unscored" : `${number(score.wpm, 1)} WPM · ${percentage(score.accuracy)} · ${score.unattributedCharacters} composed`],
      ]),
      element("p", "hint", session.text ?? "Prompt text predates schema v2 and is unavailable."),
      element("h3", "", "Correction attribution"),
    ];
    const correctionNode = element("div");
    renderCorrections(corrections, correctionNode);
    nodes.push(correctionNode);
    replace(byId("history-detail"), nodes);
  } catch (error) {
    replace(byId("history-detail"), element("p", "warning", error.message));
  }
}

async function loadHistory(restore = false) {
  try {
    if (restore) {
      restoreHistoryFilters();
      rememberHistoryFilters();
    }
    const query = historyQuery();
    const loaded = await api(`/api/training/history${query ? `?${query}` : ""}`);
    renderTrends(loaded.benchmark, byId("history-trends"));
    const rows = loaded.sessions.map(({ session, score, corrections }) => [
      `#${session.id}`,
      new Date(session.startedTs * 1000).toLocaleString(),
      session.mode,
      session.drillFamily ?? (session.mode === "drill" ? "unspecified" : "—"),
      session.language,
      score === null ? "guided" : `${number(score.wpm, 1)} WPM · ${percentage(score.accuracy)}`,
      String(corrections.corrections),
      session.keylabProfile ?? "trainer-only",
    ]);
    replace(byId("history-sessions"), rows.length === 0
      ? element("p", "hint", "No completed sessions match these filters.")
      : table(["id", "started", "mode", "family", "language", "score", "corrections", "capture"], rows, (row, index) => {
        row.dataset.session = String(loaded.sessions[index].session.id);
        row.addEventListener("click", () => showHistoryDetail(loaded.sessions[index].session.id));
      }));
  } catch (error) {
    replace(byId("history-sessions"), element("p", "warning", error.message));
  }
}
for (const id of ["history-mode", "history-language"]) byId(id).addEventListener("change", () => {
  rememberHistoryFilters();
  loadHistory();
});

function applyKeymapZoom() {
  const zoom = Number(byId("keymap-zoom").value);
  byId("keymap-image").style.width = `${Math.round(11 * zoom)}px`;
  byId("keymap-zoom-output").textContent = `${zoom}%`;
  remember("keymap.zoom", String(zoom));
  if (location.pathname === "/keymap") replaceLocation(`/keymap?zoom=${zoom}`);
}
byId("keymap-zoom").addEventListener("input", applyKeymapZoom);

async function loadKeymap() {
  try {
    const requestedZoom = new URL(location.href).searchParams.get("zoom") ?? stored("keymap.zoom", "100");
    if (/^(?:[5-9]0|1\d0|200)$/.test(requestedZoom)) byId("keymap-zoom").value = requestedZoom;
    applyKeymapZoom();
    const value = await api("/api/keymap");
    replace(byId("keymap-meta"), statusRows([
      ["Generated", value.generatedAt ? new Date(value.generatedAt).toLocaleString() : "unavailable"],
      ["Source commit", value.gitCommit ?? "unknown"],
      ["Keymap hash", value.keymapHash ?? "unknown"],
      ["Layers", value.layers.map((layer) => `${layer.index} ${layer.name}`).join(" · ") || "none"],
      ["Output freshness", value.outputFresh ? "fresh against config/layout.json5" : "stale or incomplete"],
      ["Daemon hashes", value.devices.length === 0 ? "no telemetry device hashes" : value.devices.map((device) => `#${device.id} ${device.matchesGenerated ? "matches" : "differs"}`).join(" · ")],
    ]));
    const warnings = [];
    if (!value.available) warnings.push(value.error ?? "Generated metadata is unavailable.");
    if (!value.outputFresh) warnings.push("Generated SVG/PDF/metadata are older than their source or incomplete; run the repository build workflow.");
    if (value.hashMismatch) warnings.push("At least one captured device used a different keymap hash than the generated artifacts.");
    byId("keymap-warning").hidden = warnings.length === 0;
    byId("keymap-warning").textContent = warnings.join(" ");
    byId("keymap-image").hidden = !value.artifacts.svg.available;
    byId("keymap-pdf").hidden = !value.artifacts.pdf.available;
  } catch (error) {
    byId("keymap-warning").hidden = false;
    byId("keymap-warning").textContent = error.message;
  }
}

const pageLoaders = {
  "/": loadOverview,
  "/insights": loadInsights,
  "/train": async () => { restoreTrainFilters(); await loadHealth(); rememberTrainFilters(); },
  "/history": () => loadHistory(true),
  "/keymap": loadKeymap,
};

async function navigate(path, push = true) {
  const target = new URL(path, location.origin);
  const route = pageLoaders[target.pathname] ? target.pathname : "/";
  if (activeSession && routeTracker.leaves(route)) {
    if (!confirm("An active training session owns this page. Cancel it and leave?")) {
      if (!push) history.pushState(null, "", routeTracker.current());
      return false;
    }
    await cancelTraining();
  }
  const targetLocation = `${route}${route === target.pathname ? target.search : ""}`;
  if (push) history.pushState(null, "", targetLocation);
  routeTracker.commit(route, targetLocation);
  document.querySelectorAll("[data-page]").forEach((page) => { page.hidden = page.dataset.page !== route; });
  document.querySelectorAll("nav a[data-route]").forEach((link) => link.classList.toggle("active", link.getAttribute("href") === route));
  document.title = `${route === "/" ? "Overview" : route.slice(1)[0].toUpperCase() + route.slice(2)} · Glove80 Lab`;
  await pageLoaders[route]();
  return true;
}

document.querySelectorAll("a[data-route]").forEach((link) => link.addEventListener("click", async (event) => {
  event.preventDefault();
  const target = new URL(link.href);
  await navigate(`${target.pathname}${target.search}`);
}));
addEventListener("popstate", () => navigate(`${location.pathname}${location.search}`, false));
addEventListener("beforeunload", () => {
  if (!activeSession || trainingSavePending) return;
  fetch("/api/training/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: activeSession.id }),
    credentials: "same-origin",
    keepalive: true,
  });
});

const refreshCurrent = createRefreshScheduler(async () => {
  await loadHealth();
  if (location.pathname === "/" && !activeSession) {
    try {
      const live = await api("/api/summary?range=live&profile=*&device=*&corrections=all");
      byId("overview-keys").textContent = number(live.header.totalKeystrokes);
    } catch {
      byId("overview-keys").textContent = "unavailable";
    }
  }
  if (location.pathname === "/insights" && byId("range").value === "live") {
    await loadInsights();
  }
});
const events = new EventSource("/events");
events.addEventListener("snapshot", refreshCurrent);
setInterval(loadHealth, 5_000);
navigate(`${location.pathname}${location.search}`, false);
