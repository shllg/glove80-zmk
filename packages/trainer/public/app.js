import { applyInput, createTypingSession, noteKeydown } from "/typing-session.js";

const modeSelect = document.querySelector("#mode");
const familySelect = document.querySelector("#family");
const languageSelect = document.querySelector("#language");
const startButton = document.querySelector("#start");
const promptNode = document.querySelector("#prompt");
const entry = document.querySelector("#entry");
const status = document.querySelector("#status");
const rationale = document.querySelector("#rationale");
const ibusNote = document.querySelector("#ibus-note");

let session = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderPrompt(text, typedLength, wrongIndices) {
  promptNode.replaceChildren();
  [...text].forEach((character, index) => {
    let className = "pending";
    if (index < typedLength) className = wrongIndices.has(index) ? "wrong" : "done";
    else if (index === typedLength) className = "cursor";
    promptNode.append(element("span", className, character));
  });
}

function renderScore(score) {
  document.querySelector("#wpm").textContent = score.wpm.toFixed(1);
  document.querySelector("#accuracy").textContent = `${(score.accuracy * 100).toFixed(1)}%`;
  document.querySelector("#keystrokes").textContent = String(score.keystrokes);
  document.querySelector("#composed").textContent = String(score.unattributedCharacters);
  const composed = score.unattributedCharacters > 0;
  document.querySelector("#composed-card").classList.toggle("unreliable", composed);
  ibusNote.hidden = !composed;
  if (composed) {
    // This is the IBus probe, run automatically on every session instead of as a separate manual
    // exercise: characters that arrive without a keydown cannot be attributed to a physical key
    // here at all, so keylab is the only instrument that sees their true cost.
    ibusNote.textContent = `${score.unattributedCharacters} characters arrived with no keydown `
      + "(input-method composition). The browser cannot attribute those physically — keylab's "
      + "evdev capture is the only measure of what they actually cost your hands.";
  }
  renderCorrections(score.corrections);
}

/**
 * Corrections sit beside the score, never inside it: a backspace is not a keystroke, so counting
 * one would move the WPM and accuracy denominators every past run was measured against.
 */
function renderCorrections(attribution) {
  const node = document.querySelector("#corrections");
  node.replaceChildren();
  const total = attribution?.corrections ?? 0;
  document.querySelector("#correction-count").textContent = String(total);
  if (!attribution || total === 0) {
    node.append(element("p", "hint", "No corrections in this session."));
    return;
  }
  const { fumble, ambiguous, edit } = attribution.byLatency;
  node.append(element(
    "p",
    "hint",
    `${attribution.charactersRemoved} characters removed · ${fumble} fumble, `
    + `${ambiguous} ambiguous, ${edit} edit`
    + (attribution.unattributed > 0
      ? ` · ${attribution.unattributed} past the end of the prompt, unattributed`
      : ""),
  ));
  for (const word of attribution.words.slice(0, 6)) {
    const offsets = word.offsets
      .map((entry) => `offset ${entry.offset}×${entry.count}`)
      .join(", ");
    const row = element("div", "weak-row");
    row.append(
      element("strong", "", word.word),
      element("span", "", `${word.corrections} in ${word.occurrences} · ${offsets}`),
    );
    node.append(row);
  }
  if (attribution.transitions.length > 0) {
    node.append(element(
      "p",
      "hint",
      // A digraph containing a space is unreadable raw; the same glyph the analysis report uses.
      `Transitions before the deletion: ${attribution.transitions.slice(0, 6)
        .map((entry) => `${entry.transition.replaceAll(" ", "␣")} ${entry.corrections}`)
        .join("  ")}`,
    ));
  }
}

async function loadHistory() {
  const history = await (await fetch("/api/history")).json();
  const node = document.querySelector("#history");
  node.replaceChildren();
  if (history.points.length === 0) {
    node.append(element("p", "hint", "No completed benchmark runs yet."));
    return;
  }
  for (const [language, medians] of Object.entries(history.rollingMedianWpm)) {
    const runs = history.points.filter((point) => point.language === language);
    const latest = medians[medians.length - 1] ?? 0;
    const row = element("div", "trend-row");
    row.append(
      element("strong", "", language),
      element("span", "", `${runs.length} runs · rolling median ${latest.toFixed(1)} WPM`),
    );
    node.append(row);
  }
}

async function loadWeakness() {
  const node = document.querySelector("#weakness");
  const confidence = document.querySelector("#weakness-confidence");
  node.replaceChildren();
  try {
    const model = await (await fetch("/api/weakness")).json();
    // Each regime gets its own sentence: a drill weighted by frequency must never read like one
    // weighted by measured error, and one weighted by real-use corrections is neither of those.
    confidence.textContent = model.confidence === "trainer"
      ? `Trainer-derived from ${model.sessionCount} sessions.`
      : model.confidence === "keylab-tier-c"
        ? "No trainer history yet; weighted by the keys keylab saw you correct in real work."
        : "Bootstrapped from keylab position frequency; no trainer history, no corrections yet.";
    for (const mechanic of model.mechanics.slice(0, 4)) {
      const row = element("div", "weak-row");
      row.append(element("strong", "", mechanic.label), element("span", "", mechanic.detail));
      node.append(row);
    }
    for (const position of model.positions.slice(0, 6)) {
      const row = element("div", "weak-row");
      const measured = position.errorRate !== null
        ? `${(position.errorRate * 100).toFixed(1)}% errors over ${position.attempts}`
        : position.correctionRate !== null
          ? `${(position.correctionRate * 100).toFixed(2)}% fumble-weighted corrections per press`
          : `${position.presses} presses (frequency only)`;
      row.append(element("strong", "", position.label), element("span", "", measured));
      node.append(row);
    }
  } catch (error) {
    confidence.textContent = `Weakness model unavailable: ${error.message}`;
  }
}

async function finish() {
  if (!session) return;
  const response = await fetch("/api/session/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: session.id,
      keystrokes: session.keystrokes,
      corrections: session.corrections,
    }),
  });
  if (!response.ok) {
    status.textContent = `Could not save the session (${response.status}).`;
    return;
  }
  renderScore(await response.json());
  status.textContent = "Session complete.";
  entry.disabled = true;
  session = null;
  await Promise.all([loadHistory(), loadWeakness()]);
}

// keydown carries the physical key; `input` carries what the application actually received. When a
// character appears with no keydown behind it the input method composed it, and that gap is the
// measurement — see the note rendered above. The decision itself lives in `typing-session.js` so a
// test can drive it without a DOM.
entry.addEventListener("keydown", (event) => {
  if (!session) return;
  noteKeydown(session, event);
});

entry.addEventListener("input", () => {
  if (!session) return;
  const typed = entry.value;
  const outcome = applyInput(session, typed, performance.now());
  if (outcome.kind !== "outside") renderPrompt(session.text, typed.length, session.wrongIndices);
  if (outcome.complete) finish();
});

startButton.addEventListener("click", async () => {
  const body = {
    mode: modeSelect.value,
    family: familySelect.value,
    language: languageSelect.value,
    deviceLabel: navigator.platform || "unknown",
  };
  const response = await fetch("/api/session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    status.textContent = `Could not start (${response.status}): ${await response.text()}`;
    return;
  }
  const started = await response.json();
  session = createTypingSession(started.sessionId, started.text);
  entry.disabled = false;
  entry.value = "";
  entry.focus();
  renderPrompt(started.text, 0, new Set());
  rationale.hidden = !started.rationale;
  rationale.textContent = started.rationale ?? "";
  status.textContent = started.mode === "benchmark"
    ? `Benchmark · ${started.corpusId} @ ${started.corpusVersion} · seed ${started.seed}`
    : `Drill · ${started.corpusId} · seed ${started.seed}`;
});

modeSelect.addEventListener("change", () => {
  familySelect.disabled = modeSelect.value !== "drill";
});
familySelect.disabled = true;
entry.disabled = true;
loadHistory();
loadWeakness();
