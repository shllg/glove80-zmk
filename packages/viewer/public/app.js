import { createRefreshScheduler } from "/refresh-scheduler.js";

const rangeSelect = document.querySelector("#range");
const status = document.querySelector("#status");

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function level(value, maximum) {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(10, Math.ceil(Math.log1p(value) / Math.log1p(maximum) * 10)));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function keyCell(position, maximum) {
  const key = element("div", `key-cell heat-${level(position.presses, maximum)}`);
  const label = position.baseKeycode ? position.baseKeycode.replace(/^KEY_/, "") : "—";
  key.append(element("span", "", label), element("small", "", String(position.presses)));
  key.title = `Position ${position.pos} · ${position.finger} · ${position.presses} presses`;
  return key;
}

function renderHeatmap(positions) {
  const heatmap = document.querySelector("#heatmap");
  heatmap.replaceChildren();
  const maximum = Math.max(0, ...positions.map((position) => position.presses));
  for (const position of positions) {
    const key = keyCell(position, maximum);
    key.classList.add(`pos-${position.pos}`);
    if (position.col === null) {
      key.classList.add("thumb-key");
    } else {
      key.classList.add("main-key", `hand-${position.hand}`, `row-${position.row}`, `col-${position.col}`);
    }
    heatmap.append(key);
  }
}

function renderFingers(fingers) {
  const chart = document.querySelector("#finger-chart");
  chart.replaceChildren();
  const maximum = Math.max(0, ...fingers.map((finger) => finger.presses));
  for (const hand of ["L", "R"]) {
    const section = element("section", "chart-hand");
    section.append(element("h3", "", hand === "L" ? "LEFT HAND" : "RIGHT HAND"));
    for (const finger of fingers.filter((entry) => entry.hand === hand)) {
      const row = element("div", "bar-row");
      const track = element("div", "bar-track");
      track.append(element("div", `bar-fill width-${level(finger.presses, maximum)}`));
      row.append(
        element("span", "", finger.label.replace(/^[LR]_/, "")),
        track,
        element("span", "bar-value", percentage(finger.share)),
      );
      section.append(row);
    }
    chart.append(section);
  }
}

function renderModifiers(modifiers) {
  const chart = document.querySelector("#modifier-chart");
  chart.replaceChildren();
  for (const modifier of modifiers) {
    const section = element("section", "histogram");
    section.append(element("h3", "", modifier.label));
    const bars = element("div", "hist-bars");
    const maximum = Math.max(0, ...modifier.histogram.map((bin) => bin.count));
    for (const bin of modifier.histogram) {
      const bar = element("div", `hist-bar height-${level(bin.count, maximum)}`);
      bar.title = `${bin.openEnded ? ">=" : "~"}${bin.midpointMs} ms · ${bin.count}`;
      bars.append(bar);
    }
    section.append(
      bars,
      element("p", "hist-meta", `n=${modifier.count} · median ${modifier.median.label} · p95 ${modifier.p95.label}`),
    );
    chart.append(section);
  }
}

function render(summary) {
  document.querySelector("#total-keys").textContent = summary.header.totalKeystrokes.toLocaleString();
  document.querySelector("#autorepeats").textContent = summary.header.autorepeats.toLocaleString();
  document.querySelector("#tier-b-windows").textContent = summary.header.tierBWindowCount.toLocaleString();
  const positional = summary.outerUpperQuadrant.positional;
  document.querySelector("#unattributed").textContent = percentage(positional.unattributedShare);
  document.querySelector("#unattributed-card").classList.toggle("unreliable", positional.unreliable);
  document.querySelector("#reliability-warning").hidden = !positional.unreliable;
  renderHeatmap(summary.positionLoad);
  renderFingers(summary.perFinger);
  renderModifiers(summary.modifierHolds);
}

async function loadSummary() {
  try {
    const response = await fetch(`/api/summary?range=${encodeURIComponent(rangeSelect.value)}`, {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Summary request failed (${response.status})`);
    render(await response.json());
    status.textContent = "Live connection active";
    status.classList.remove("error");
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to load summary";
    status.classList.add("error");
  }
}

const refresh = createRefreshScheduler(loadSummary);

rangeSelect.addEventListener("change", refresh);
const events = new EventSource("/events");
events.addEventListener("snapshot", refresh);
events.addEventListener("open", () => {
  status.textContent = "Live connection active";
  status.classList.remove("error");
  refresh();
});
events.addEventListener("error", () => {
  status.textContent = "Reconnecting to local viewer…";
  status.classList.add("error");
});
refresh();
