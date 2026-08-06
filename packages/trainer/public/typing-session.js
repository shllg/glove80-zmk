/**
 * The keystroke/correction decision, kept out of `app.js` so it can be driven by a test without a
 * DOM — the same split the viewer uses for `refresh-scheduler.js`. Two defects lived here while the
 * logic was inline in an event handler and neither was visible from any test:
 *
 *   1. Backspace never reached `keydown`, because the handler returned on `event.key.length !== 1`.
 *   2. Every deletion then appended a *second* keystroke row for a character already recorded, with
 *      no pending code behind it, so it was counted as an input-method composition. The `Composed`
 *      metric was therefore wrong in exactly the sessions where mistakes were made.
 *
 * A deletion must never append to `keystrokes`: that array is the accuracy and WPM denominator in
 * `src/scoring.ts`, so a backspace row would rescore every historical comparison.
 */

export const COMPOSED_CODE = "Composed";

/**
 * Maps a target character back to the physical key a plain US layout would use. It is deliberately
 * incomplete: a German umlaut has no single physical key on this keymap, and saying so honestly
 * (null) is better than inventing an attribution keylab would contradict.
 */
export function expectedCodeFor(character) {
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

export function createTypingSession(id, text) {
  return {
    id,
    text,
    keystrokes: [],
    corrections: [],
    pendingCode: null,
    pendingDelete: false,
    lastLength: 0,
    // A set rather than the current index: an error the eye has already passed must keep showing
    // as an error, otherwise the display disagrees with the score being recorded.
    wrongIndices: new Set(),
  };
}

/** `keydown` carries the physical key; `input` carries what the application actually received. */
export function noteKeydown(session, event) {
  if (event.key === "Backspace") {
    session.pendingDelete = true;
    return;
  }
  if (event.key.length !== 1) return;
  session.pendingCode = event.code;
}

/**
 * Folds one `input` event into the session and reports what it was, so the caller can render.
 *
 * `kind` is `"correction"` when the text shrank, `"keystroke"` when a character inside the prompt
 * arrived, and `"outside"` for input past the end of the prompt, which is scored nowhere.
 */
export function applyInput(session, typed, tsMs) {
  const previousLength = session.lastLength;
  session.lastLength = typed.length;

  if (typed.length < previousLength) {
    const charIndex = typed.length;
    const viaBackspace = session.pendingDelete;
    session.pendingDelete = false;
    session.pendingCode = null;
    // Indices at or beyond the new length are pending again, not wrong: the eye has not passed
    // them yet, so leaving them marked would disagree with what is being scored.
    for (let index = charIndex; index < previousLength; index += 1) session.wrongIndices.delete(index);
    const expectedCharacter = session.text[charIndex];
    session.corrections.push({
      tsMs,
      // The index of the *first* character removed, so the correction attributes to the character
      // that was wrong rather than to the cursor position left behind.
      charIndex,
      // A held Backspace autorepeat or a Ctrl+Backspace removes more than one character.
      runLength: previousLength - typed.length,
      // Same rule as `expectedCodeFor`: a shrink with no Backspace keydown behind it — an input
      // method retracting its preview — has no physical key to attribute, and null says so.
      expectedCode: viaBackspace && expectedCharacter !== undefined
        ? expectedCodeFor(expectedCharacter)
        : null,
    });
    return { kind: "correction", complete: false };
  }

  session.pendingDelete = false;
  const index = typed.length - 1;
  if (index < 0 || index >= session.text.length) {
    return { kind: "outside", complete: typed.length >= session.text.length };
  }
  const expectedCharacter = session.text[index];
  const correct = typed[index] === expectedCharacter;
  const code = session.pendingCode ?? COMPOSED_CODE;
  session.pendingCode = null;
  session.keystrokes.push({
    tsMs,
    code,
    expectedCode: expectedCodeFor(expectedCharacter),
    correct,
  });
  if (correct) session.wrongIndices.delete(index);
  else session.wrongIndices.add(index);
  return { kind: "keystroke", complete: typed.length >= session.text.length };
}
