// Decode only the selected motion window and its immediate successor, with
// one request in flight and active-first order.
export function createPackedMotionBuffer(source, windowCount, yieldTask) {
  const ready = new Map();
  let active = -1;
  let request = null;
  let retry = null;
  let attempts = 0;
  let disposed = false;

  function pump() {
    if (disposed || active < 0 || request || retry !== null) return;
    const next = ready.has(active) ? active + 1 : active;
    if (next >= windowCount || ready.has(next)) return;
    const controller = new AbortController();
    const pending = request = { index: next, controller };
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return source.load(next, { signal: controller.signal, yieldTask });
    }).then(path => {
      if (request !== pending) return;
      request = null;
      attempts = 0;
      ready.set(next, path ?? null);
      pump();
    }, error => {
      if (request !== pending) return;
      request = null;
      if (error?.retryable === false || attempts >= 4) {
        attempts = 0;
        ready.set(next, { unavailable: 'decode', bytes: 0 });
        pump();
        return;
      }
      const delay = Math.min(2000, 100 * 2 ** attempts);
      attempts = Math.min(attempts + 1, 5);
      retry = setTimeout(() => {
        retry = null;
        pump();
      }, delay);
    });
  }

  function resetRetry() {
    if (retry !== null) clearTimeout(retry);
    retry = null;
    attempts = 0;
  }

  function select(index) {
    if (disposed || active === index) return;
    active = index;
    resetRetry();
    // A failed lookahead gets a fresh attempt when it becomes the target.
    if (ready.get(index)?.unavailable === 'decode') ready.delete(index);
    for (const window of ready.keys()) {
      if (index < 0 || (window !== index && window !== index + 1)) ready.delete(window);
    }
    if (request && request.index !== index) {
      request.controller.abort();
      request = null;
    }
    pump();
  }

  return {
    select,
    current: () => ready.get(active),
    stats: () => ({
      windows: [...ready.keys()],
      layers: [...new Set([...ready.values()].map(path => path?.layer).filter(Number.isInteger))],
      pendingWindow: request?.index ?? null,
      bytes: [...ready.values()].reduce((sum, path) => sum + (path?.bytes || 0), 0),
    }),
    dispose() {
      disposed = true;
      request?.controller.abort();
      request = null;
      resetRetry();
      ready.clear();
    },
  };
}
