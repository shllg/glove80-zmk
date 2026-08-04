export function createRefreshScheduler(run) {
  let pending = false;
  let queued = false;

  return async function scheduleRefresh() {
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    try {
      do {
        queued = false;
        await run();
      } while (queued);
    } finally {
      pending = false;
    }
  };
}
