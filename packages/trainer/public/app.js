const modeSelect = document.querySelector("#mode");
const familySelect = document.querySelector("#family");
const languageSelect = document.querySelector("#language");
const startButton = document.querySelector("#start");
const promptNode = document.querySelector("#prompt");
const entry = document.querySelector("#entry");
const status = document.querySelector("#status");
const rationale = document.querySelector("#rationale");
const ibusNote = document.querySelector("#ibus-note");

const COMPOSED_CODE = "Composed";

let session = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Maps a target character back to the physical key a plain US layout would use. It is deliberately
 * incomplete: a German umlaut has no single physical key on this keymap, and saying so honestly
 * (null) is better than inventing an attribution keylab would contradict.
 */
function expectedCodeFor(character) {
  if (/^[a-z]$/.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[A-Z]$/.test(character)) return `Key${character}`;
  if (/^[0-9]$/.test(character)) return `Digit${character}`;
  const named = {
    " ": "Space", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
    "\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote", ",": "Comma",
    ".": "Period", "/": "Slash", "_": "Minus",
  };
  return named[character] ?? null;
}

// `wrongIndices` is a set rather than the current index: an error the eye has already passed must
// keep showing as an error, otherwise the display disagrees with the score being recorded.
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
    confidence.textContent = model.confidence === "trainer"
      ? `Trainer-derived from ${model.sessionCount} sessions.`
      : "Bootstrapped from keylab; no trainer history yet.";
    for (const mechanic of model.mechanics.slice(0, 4)) {
      const row = element("div", "weak-row");
      row.append(element("strong", "", mechanic.label), element("span", "", mechanic.detail));
      node.append(row);
    }
    for (const position of model.positions.slice(0, 6)) {
      const row = element("div", "weak-row");
      const measured = position.errorRate === null
        ? `${position.presses} presses (frequency only)`
        : `${(position.errorRate * 100).toFixed(1)}% errors over ${position.attempts}`;
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
    body: JSON.stringify({ sessionId: session.id, keystrokes: session.keystrokes }),
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
// measurement — see the note rendered above.
entry.addEventListener("keydown", (event) => {
  if (!session || event.key.length !== 1) return;
  session.pendingCode = event.code;
});

entry.addEventListener("input", () => {
  if (!session) return;
  const typed = entry.value;
  const index = typed.length - 1;
  if (index < 0 || index >= session.text.length) {
    if (typed.length >= session.text.length) finish();
    return;
  }
  const expectedCharacter = session.text[index];
  const actualCharacter = typed[index];
  const correct = actualCharacter === expectedCharacter;
  const code = session.pendingCode ?? COMPOSED_CODE;
  session.pendingCode = null;
  session.keystrokes.push({
    tsMs: performance.now(),
    code,
    expectedCode: expectedCodeFor(expectedCharacter),
    correct,
  });
  if (correct) session.wrongIndices.delete(index);
  else session.wrongIndices.add(index);
  renderPrompt(session.text, typed.length, session.wrongIndices);
  if (typed.length >= session.text.length) finish();
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
  session = {
    id: started.sessionId,
    text: started.text,
    keystrokes: [],
    pendingCode: null,
    wrongIndices: new Set(),
  };
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
