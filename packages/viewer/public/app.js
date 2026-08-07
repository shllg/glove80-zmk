import { createRefreshScheduler } from "/refresh-scheduler.js";
import {
  correctionFootnote,
  createControlTracker,
  percentage,
  rateLevel,
} from "/view-model.js";

const rangeSelect = document.querySelector("#range");
const profileSelect = document.querySelector("#profile");
const viewProfileSelect = document.querySelector("#view-profile");
const deviceSelect = document.querySelector("#device");
const layerSelect = document.querySelector("#layer");
const latencySelect = document.querySelector("#correction-latency");
const latencyControl = document.querySelector("#latency-control");
const correctionNote = document.querySelector("#correction-note");
const heatmapSource = document.querySelector("#heatmap-source");
const heatmapTitle = document.querySelector("#heatmap-title");
const controlChip = document.querySelector("#control-chip");
const pauseToggle = document.querySelector("#pause-toggle");
const status = document.querySelector("#status");

// The daemon owns this state. The chip always shows what the daemon reports, never what was last
// selected here, so a rejected or auto-reverted change is visible rather than silently assumed.
let control = { paused: false, profile: "default", profiles: [] };
let profileOptions = "";
let viewProfileOptions = "";
let deviceOptions = "";
// The pending switch and the status text it produces live in `view-model.js`, where they can be
// driven without a DOM.
const controlTracker = createControlTracker();
// The last summary, so switching layers redraws what is already loaded. The correction *kind*
// filter is applied server-side and does refetch, because the rate depends on which rows count.
let summary = null;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function showLiveStatus() {
  const line = controlTracker.status();
  setStatus(line.text, line.isError);
}

/**
 * Selections belong to whoever made them. The page refreshes about once a second, so anything not
 * remembered here is something the user has to re-pick after every tick and every reload. Session
 * storage rather than local: a new window starts from the defaults.
 */
const STORAGE_PREFIX = "keylab.viewer.";

function stored(key) {
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    // Private-mode storage refusals must not take the page down with them.
  }
}

function persistSelect(select, key, onChange) {
  const previous = stored(key);
  if (previous !== null && [...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
  select.addEventListener("change", () => {
    remember(key, select.value);
    onChange();
  });
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

function keyLabel(position) {
  return position.baseKeycode ? position.baseKeycode.replace(/^KEY_/, "") : "—";
}

function pressCell(position, maximum) {
  const key = element("div", `key-cell heat-${level(position.presses, maximum)}`);
  key.append(element("span", "", keyLabel(position)), element("small", "", String(position.presses)));
  key.title = `Position ${position.pos} · ${position.finger} · ${position.presses} presses`;
  return key;
}

function correctionCell(position, entry, maximum) {
  const rate = entry?.rate ?? null;
  const key = element("div", rate === null ? "key-cell no-data" : `key-cell heat-${rateLevel(rate, maximum)}`);
  key.append(
    element("span", "", keyLabel(position)),
    element("small", "", rate === null ? "—" : `${(rate * 100).toFixed(1)}%`),
  );
  key.title = rate === null
    ? `Position ${position.pos} · ${position.finger} · ${position.presses} presses is below the `
      + "press floor, so its correction rate would be noise"
    : `Position ${position.pos} · ${position.finger} · ${entry.corrections} corrections in `
      + `${position.presses} presses`;
  return key;
}

function renderHeatmap(positions, layer) {
  const heatmap = document.querySelector("#heatmap");
  heatmap.replaceChildren();
  const corrections = new Map((layer?.positions ?? []).map((entry) => [entry.pos, entry]));
  const maximum = Math.max(0, ...positions.map((position) => position.presses));
  for (const position of positions) {
    const key = layer
      ? correctionCell(position, corrections.get(position.pos), layer.maximumRate)
      : pressCell(position, maximum);
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

function renderLayer() {
  if (!summary) return;
  const corrections = layerSelect.value === "corrections";
  latencyControl.hidden = !corrections;
  heatmapSource.textContent = corrections
    ? "Tier C · corrections per press"
    : "Tier B · unordered counts";
  heatmapTitle.textContent = corrections ? "Corrected key load" : "Physical key load";
  renderHeatmap(summary.positionLoad, corrections ? summary.correctionLayer : null);
  correctionNote.hidden = !corrections;
  if (corrections) correctionNote.textContent = correctionFootnote(summary.correctionLayer);
}

function render(loaded) {
  summary = loaded;
  document.querySelector("#total-keys").textContent = summary.header.totalKeystrokes.toLocaleString();
  document.querySelector("#autorepeats").textContent = summary.header.autorepeats.toLocaleString();
  document.querySelector("#tier-b-windows").textContent = summary.header.tierBWindowCount.toLocaleString();
  const positional = summary.outerUpperQuadrant.positional;
  document.querySelector("#unattributed").textContent = percentage(positional.unattributedShare);
  document.querySelector("#unattributed-card").classList.toggle("unreliable", positional.unreliable);
  document.querySelector("#reliability-warning").hidden = !positional.unreliable;
  renderLayer();
  renderFingers(summary.perFinger);
  renderModifiers(summary.modifierHolds);
}

/**
 * Two different axes that used to look like one control. The capture select tells the daemon what
 * label to record under; this one says which labels to *show*. Defaulting to everything matters:
 * scoped to one profile, the totals silently omit whatever was typed under the others while still
 * reading as the whole picture.
 */
function renderViewProfiles(profiles) {
  const signature = profiles.join(" ");
  if (signature === viewProfileOptions) return;
  viewProfileOptions = signature;
  const previous = viewProfileSelect.value || stored("profile") || "*";
  viewProfileSelect.replaceChildren();
  const all = element("option", "", "All profiles");
  all.value = "*";
  viewProfileSelect.append(all);
  for (const name of profiles) {
    const option = element("option", "", name);
    option.value = name;
    viewProfileSelect.append(option);
  }
  const options = [...viewProfileSelect.options].map((option) => option.value);
  viewProfileSelect.value = options.includes(previous) ? previous : "*";
  remember("profile", viewProfileSelect.value);
}

function renderControl(state) {
  control = state;
  renderViewProfiles(state.profiles);
  const signature = state.profiles.join("\u0000");
  if (signature !== profileOptions) {
    profileOptions = signature;
    profileSelect.replaceChildren();
    for (const name of state.profiles) {
      const option = element("option", "", name);
      option.value = name;
      profileSelect.append(option);
    }
  }
  profileSelect.value = controlTracker.observe(state, Date.now());
  // The chip stays the daemon's word rather than the selection: that is what makes a rejected
  // switch or an idle auto-revert visible instead of assumed.
  controlChip.textContent = state.paused ? `paused · ${state.profile}` : `profile · ${state.profile}`;
  controlChip.classList.toggle("chip-paused", state.paused);
  pauseToggle.textContent = state.paused ? "Resume" : "Pause";
}

async function postControl(body) {
  const response = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Control request failed (${response.status})`);
  await refresh();
}

/** Enough to tell two rows of the same keyboard apart: which id, since when, and how much. */
function deviceLabel(device) {
  const seen = new Date(device.firstTs * 1000).toISOString().slice(0, 10);
  const keys = device.keystrokes >= 1000
    ? `${(device.keystrokes / 1000).toFixed(1)}k keys`
    : `${device.keystrokes} keys`;
  return `${device.name} · ${device.positionSpace ?? "unknown"} · #${device.id}`
    + ` · ${keys}${device.tierBWindows === 0 ? " · no heatmap" : ""} · since ${seen}`;
}

function renderDevices(devices) {
  const signature = devices.map((device) => `${device.id}:${deviceLabel(device)}`).join(" ");
  if (signature === deviceOptions) return;
  deviceOptions = signature;
  // A rebuild must not silently move the selection: fall back to what was stored for this session,
  // and only to the first option when neither is still on offer.
  const previous = deviceSelect.value || stored("device") || "";
  deviceSelect.replaceChildren();
  // Pooling is only offered when it is legal; with two position spaces the server refuses it, so
  // the option is simply not presented rather than presented and then rejected.
  const spaces = new Set(devices.map((device) => device.positionSpace));
  if (devices.length > 0 && spaces.size <= 1) {
    const all = element("option", "", devices.length === 1 ? "All keyboards" : "All (one space)");
    all.value = "*";
    deviceSelect.append(all);
  }
  for (const device of devices) {
    const option = element("option", "", deviceLabel(device));
    option.value = String(device.id);
    deviceSelect.append(option);
  }
  const options = [...deviceSelect.options].map((option) => option.value);
  deviceSelect.value = options.includes(previous) ? previous : (options[0] ?? "*");
  remember("device", deviceSelect.value);
}

async function loadSummary() {
  try {
    const [controlResponse, devicesResponse] = await Promise.all([
      fetch("/api/control", { credentials: "same-origin" }),
      fetch("/api/devices", { credentials: "same-origin" }),
    ]);
    if (!controlResponse.ok) throw new Error(`Control request failed (${controlResponse.status})`);
    if (!devicesResponse.ok) throw new Error(`Device request failed (${devicesResponse.status})`);
    renderControl(await controlResponse.json());
    renderDevices(await devicesResponse.json());

    const query = `range=${encodeURIComponent(rangeSelect.value)}`
      + `&device=${encodeURIComponent(deviceSelect.value || "*")}`
      + `&profile=${encodeURIComponent(viewProfileSelect.value || stored("profile") || "*")}`
      + `&corrections=${encodeURIComponent(latencySelect.value)}`;
    const response = await fetch(`/api/summary?${query}`, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(
        response.status === 500
          ? "Cannot pool positional data across two keyboards; pick one."
          : `Summary request failed (${response.status})`,
      );
    }
    render(await response.json());
    showLiveStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to load summary", true);
  }
}

const refresh = createRefreshScheduler(loadSummary);

// Restored before the first fetch, so the opening request already asks for what was last chosen
// rather than loading the defaults and replacing them a second later.
persistSelect(rangeSelect, "range", refresh);
persistSelect(layerSelect, "layer", renderLayer);
persistSelect(latencySelect, "corrections", refresh);
deviceSelect.addEventListener("change", () => {
  remember("device", deviceSelect.value);
  refresh();
});
viewProfileSelect.addEventListener("change", () => {
  remember("profile", viewProfileSelect.value);
  refresh();
});
profileSelect.addEventListener("change", () => {
  // Optimistic on purpose: the write has been accepted by the time the POST returns, but the
  // daemon publishes its state up to a second later. `renderControl` holds the selection until
  // then and reports it if the switch never lands.
  controlTracker.request(profileSelect.value, Date.now());
  showLiveStatus();
  postControl({ profile: profileSelect.value }).catch((error) => {
    controlTracker.reject(error.message);
    showLiveStatus();
    // Snap back to the daemon's state rather than leaving a selection it never accepted.
    profileSelect.value = control.profile;
  });
});
pauseToggle.addEventListener("click", () => {
  postControl({ paused: !control.paused }).catch((error) => {
    controlTracker.fail(error.message);
    showLiveStatus();
  });
});
const events = new EventSource("/events");
events.addEventListener("snapshot", refresh);
events.addEventListener("open", () => {
  showLiveStatus();
  refresh();
});
events.addEventListener("error", () => {
  setStatus("Reconnecting to local viewer…", true);
});
refresh();
