export function createRefreshScheduler(
  run: () => void | Promise<void>,
): () => Promise<void>;
