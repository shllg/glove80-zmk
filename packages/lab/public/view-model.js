/**
 * The page's logic, kept out of `app.js` so a test can drive it without a DOM — the same split
 * `refresh-scheduler.js` and the trainer's `typing-session.js` already use. `app.js` is left with
 * what genuinely needs an element: queries, listeners and DOM construction.
 *
 * Both of the header's axes appear here and neither knows about the other. The control tracker is
 * the daemon's state as this page understands it; `correctionFootnote` and `rateLevel` are the
 * view's own derivations and never write anything.
 */

/**
 * How long a switch may stay unconfirmed before it is reported as failed. The daemon publishes
 * `live_snapshot` about once a second, so anything under a couple of seconds would report a switch
 * that simply had not been written yet.
 */
export const PROFILE_CONFIRM_MS = 5_000;

/**
 * The optimistic half of the capture control. A switch the daemon has accepted is not visible in
 * `live_snapshot` for up to a second; overwriting the select in that window makes an accepted switch
 * look rejected, and the user switches again into the same window. The tracker holds the selection
 * until the daemon publishes it, and says so when it never does.
 */
export function createControlTracker(confirmMs = PROFILE_CONFIRM_MS) {
  let pending = null;
  let error = null;

  return {
    /** The user asked for a switch. Any earlier failure is theirs to retry, so it is cleared. */
    request(profile, nowMs) {
      pending = { profile, since: nowMs };
      error = null;
    },

    /** The switch POST itself failed: there is nothing left in flight to wait for. */
    reject(message) {
      pending = null;
      error = message;
    },

    /** Some other control call failed. A switch still in flight is unrelated and keeps waiting. */
    fail(message) {
      error = message;
    },

    /**
     * The daemon's published state. Returns the profile the capture select must show — the pending
     * one while it is still in flight, the daemon's own otherwise, never a mixture of the two.
     */
    observe(state, nowMs) {
      if (pending && state.profile === pending.profile) {
        pending = null;
      } else if (pending && nowMs - pending.since > confirmMs) {
        // The daemon rejects a profile it has not been configured with, and auto-reverts to
        // `default` after an idle stretch. Either way the user asked for something that did not
        // happen, and silence would read as success.
        error = `The daemon did not switch to ${pending.profile};`
          + ` it still reports ${state.profile}.`;
        pending = null;
      }
      return pending ? pending.profile : state.profile;
    },

    /**
     * The status line, derived from state rather than assigned from three places, or the last
     * writer of the second wins and a pending switch or a real error is erased by the next tick.
     */
    status() {
      if (error !== null) return { text: error, isError: true };
      if (pending) return { text: `Switching to ${pending.profile}…`, isError: false };
      return { text: "Live connection active", isError: false };
    },
  };
}

export function percentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function applyStatus(target, text, isError = false) {
  target.textContent = text;
  target.classList.toggle("error", isError);
}

export function createRouteTracker(initialRoute, initialLocation = initialRoute) {
  let displayedRoute = initialRoute;
  let displayedLocation = initialLocation;
  return {
    current: () => displayedLocation,
    leaves: (nextRoute) => nextRoute !== displayedRoute,
    commit(nextRoute, nextLocation = nextRoute) {
      displayedRoute = nextRoute;
      displayedLocation = nextLocation;
    },
    replaceLocation(nextLocation) { displayedLocation = nextLocation; },
  };
}

export function mechanicAvailable(health) {
  return health?.service === "active" && health.capture === "fresh" && !health.paused;
}

export function trainingErrorIsTerminal(code) {
  return code === "lease-lost" || code === "not-found";
}

export function recommendedDrill(model) {
  if (model.positions?.length > 0) return "position";
  if (model.correctedTransitions?.length > 0 || model.bigrams?.length > 0) return "bigram";
  if (model.mechanics?.length > 0) return "mechanic";
  return "language";
}

export function fingerLabel(finger) {
  return `${finger.label.replace(/^[LR]_/, "")} · ${percentage(finger.share)}`;
}

export function positionalSummary(context) {
  return `${percentage(context.unattributedShare)} unattributed `
    + `(${context.unattributedPresses}/${context.tierBKeystrokes} Tier B keystrokes)`
    + (context.unreliable ? " · unreliable" : "");
}

export function misfireSummary(kind, misfires) {
  const target = kind.kind === 0
    ? ` · target <${misfires.targetPercent}%: ${misfires.lonelyModTargetMet ? "met" : "above"}`
    : "";
  const classes = kind.byModClass
    .map((entry) => `${entry.label} ${entry.per1000.toFixed(2)}/1k (${entry.count})`)
    .join(" · ");
  return `${kind.per1000.toFixed(2)} / 1k · ${kind.count}${target} · ${classes}`;
}

export function correctionContextSummary(context) {
  if (context.windowCount === 0) return null;
  const denominator = context.corrections || 1;
  const latency = ["fumble", "ambiguous", "edit"]
    .map((kind) => `${kind} ${context.byLatency[kind]} (${percentage(context.byLatency[kind] / denominator)})`)
    .join(" · ");
  return {
    headline: `${context.windowCount} windows · ${context.corrections} corrections · `
      + `degraded ${context.degraded} (${percentage(context.degradedShare)}) · `
      + `dropped ${context.dropped} (${percentage(context.droppedShare)})`,
    latency,
    top: `${context.topNgrams.length} of ${context.distinctNgrams} distinct trigrams shown`,
    fingers: `${context.byFinger.length} of ${context.distinctFingerNgrams} distinct finger transitions shown`,
  };
}

/**
 * The footnote is not decoration: a correction layer that silently omits the positions it cannot
 * rate, and the corrections that never had a position, reads as a complete picture of corrections.
 */
export function correctionFootnote(layer) {
  const parts = [
    `Corrections per press. ${layer.corrections.toLocaleString()} corrections on drawable positions`
    + ` in this filter.`,
    `Positions under ${layer.pressFloor} presses in range show no data`
    + (layer.belowFloor > 0 ? ` (${layer.belowFloor} hidden that carry corrections).` : "."),
  ];
  if (layer.withoutPosition.unattributed + layer.withoutPosition.absent > 0) {
    parts.push(
      `${percentage(layer.withoutPosition.share)} had no position to draw: `
      + `${layer.withoutPosition.unattributed} unattributed, ${layer.withoutPosition.absent} with no `
      + "key before the correction.",
    );
  }
  if (layer.latency === "all") {
    parts.push("Ambiguous corrections (400–1000 ms) count here and in neither other filter.");
  }
  return parts.join(" ");
}

/**
 * A rate scales linearly against the worst rate on the board. The log curve `app.js` uses for
 * counts is right for values spanning orders of magnitude and wrong here: it would push every mid
 * rate to the top of the scale.
 */
export function rateLevel(rate, maximum) {
  if (rate <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(10, Math.ceil(rate / maximum * 10)));
}
