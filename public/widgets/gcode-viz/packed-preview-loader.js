import { createPackedToolpath, restorePackedMotion } from './packed-toolpath.js';

const BATCH_LINES = 4096;
const BATCH_CHARACTERS = 256 * 1024;
const STARTUP_TIMEOUT_MS = 4000;

function connect(worker, signal) {
  let id = 0;
  let pending = null;
  let closed = null;

  function close(error = new Error('The toolpath parser closed.')) {
    if (closed) return;
    closed = error;
    const request = pending;
    pending = null;
    signal.removeEventListener('abort', onAbort);
    worker.terminate();
    request?.reject(error);
  }

  function onAbort() {
    close(signal.reason);
  }

  signal.addEventListener('abort', onAbort, { once: true });
  worker.onmessage = ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    const request = pending;
    pending = null;
    if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
    else request.resolve(data.result);
  };
  worker.onerror = event => {
    event.preventDefault();
    close(new Error('The toolpath parser worker stopped.'));
  };
  worker.onmessageerror = () => close(new Error('Could not read the toolpath parser response.'));

  return {
    close,
    send(type, fields = {}) {
      signal.throwIfAborted();
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        pending = { id: ++id, resolve, reject };
        try {
          worker.postMessage({ id, type, ...fields });
        } catch (error) {
          close(error);
        }
      });
    },
  };
}

export async function openPackedPreview(parser, signal, yieldTask) {
  signal.throwIfAborted();
  const fallback = () => ({
    ...createPackedToolpath(parser, { signal, yieldTask }),
    reader: 'cooperative',
    close() {},
  });
  let connection;
  try {
    connection = connect(new Worker(new URL('./packed-preview-worker.js', import.meta.url), { type: 'module' }), signal);
  } catch (_) {
    return fallback();
  }

  const startup = setTimeout(() => connection.close(new Error('The toolpath parser worker did not start.')), STARTUP_TIMEOUT_MS);
  try {
    await connection.send('init', { tolerance: parser.tolerance });
  } catch (_) {
    connection.close();
    signal.throwIfAborted();
    return fallback();
  } finally {
    clearTimeout(startup);
  }

  let batch = [];
  let characters = 0;

  async function flush() {
    if (!batch.length) return;
    const lines = batch;
    batch = [];
    characters = 0;
    await connection.send('batch', { lines });
  }

  return {
    reader: 'worker',
    async parseBatch(lines) {
      for (const line of lines) {
        batch.push(line);
        characters += line.length;
        if (batch.length >= BATCH_LINES || characters >= BATCH_CHARACTERS) await flush();
      }
    },
    async finish() {
      try {
        await flush();
        const packed = await connection.send('finish');
        signal.throwIfAborted();
        return { ...packed, motion: restorePackedMotion(parser, packed.motion) };
      } finally {
        connection.close();
      }
    },
    close() {
      batch = [];
      connection.close();
    },
  };
}
