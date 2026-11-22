import { MAX_LAYER_MARKER_CHARACTERS, parseToolpathLayerMarker } from './toolpath-layer-marker.js';

// Preserve only the small set of standalone comments that can corroborate
// physical layer numbering. Ordinary comments can be arbitrarily long.
export function createToolpathFramer(maxCharacters) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', comment = false, oversizedComment = false;

  function append(fragment) {
    if (oversizedComment) return;
    if (!pending && !comment) {
      fragment = fragment.trimStart();
      comment = fragment.startsWith(';');
    }
    if (comment) {
      const remaining = MAX_LAYER_MARKER_CHARACTERS - pending.length;
      oversizedComment = fragment.length > remaining;
      pending += fragment.slice(0, remaining);
      return;
    }
    if (pending.length + fragment.length > maxCharacters) {
      throw Object.assign(new Error('A G-code command is too large for the preview.'), { code: 'PREVIEW_COMPLEXITY' });
    }
    pending += fragment;
  }

  function endLine(lines) {
    if (pending && (!comment || parseToolpathLayerMarker(pending))) {
      lines.push(oversizedComment ? '; layer num/total_layer_count: invalid' : pending);
    }
    pending = '';
    comment = false;
    oversizedComment = false;
  }

  return function frame(chunk, done = false) {
    let text;
    try { text = decoder.decode(chunk, { stream: !done }); }
    catch (_) {
      throw Object.assign(new Error('The toolpath contains invalid text. Re-export the exact sliced file.'), { code: 'TOOLPATH_ENCODING' });
    }
    const lines = [];
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      append(text.slice(start, end));
      endLine(lines);
      start = end + 1;
    }
    append(text.slice(start));
    if (done) endLine(lines);
    return lines;
  };
}

// One outstanding chunk provides backpressure. When workers are disabled by
// the browser, run the same bounded framer on the main thread.
export async function openToolpathFramer(maxCharacters, signal) {
  const fallback = () => ({ frame: createToolpathFramer(maxCharacters), close() {} });
  let worker;
  try { worker = new Worker(new URL('./toolpath-reader-worker.js', import.meta.url), { type: 'module' }); }
  catch (_) { return fallback(); }

  let pending, stopped;
  const close = () => {
    worker.terminate();
    signal.removeEventListener('abort', abort);
  };
  const fail = err => {
    const request = pending;
    pending = null;
    if (request) request.reject(err);
  };
  const abort = () => { fail(signal.reason); close(); };
  signal.addEventListener('abort', abort, { once: true });
  worker.onmessage = ({ data }) => {
    if (data.error) { fail(Object.assign(new Error(data.error), { code: data.code })); return; }
    const request = pending;
    pending = null;
    request?.resolve(data.lines);
  };
  worker.onerror = () => {
    stopped = new Error('Toolpath decoding worker stopped.');
    fail(stopped);
  };

  function send(message, transfers = []) {
    signal.throwIfAborted();
    if (stopped) throw stopped;
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      worker.postMessage(message, transfers);
    });
  }

  const startup = setTimeout(() => fail(new Error('Toolpath worker did not start.')), 2000);
  try { await send({ maxCharacters }); }
  catch (_) {
    close();
    signal.throwIfAborted();
    return fallback();
  } finally { clearTimeout(startup); }

  return {
    frame(chunk, done) {
      return send({ chunk, done }, chunk ? [chunk.buffer] : []);
    },
    close,
  };
}
