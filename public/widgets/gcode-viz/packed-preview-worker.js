import { createPackedCommandParser } from './packed-command-parser.js';
import { createPackedToolpath } from './packed-toolpath.js';

let builder;
let timing;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    switch (type) {
      case 'init':
        builder = createPackedToolpath(createPackedCommandParser(data.tolerance), {
          // Each incoming batch is already bounded and cancellation
          // terminates this worker, including work inside a single arc.
          yieldTask: () => Promise.resolve(),
          transferable: true,
        });
        timing = { parseMs: 0, finalizeMs: 0, batches: 0 };
        self.postMessage({ id, result: null });
        break;
      case 'batch': {
        const start = performance.now();
        await builder.parseBatch(data.lines);
        timing.parseMs += performance.now() - start;
        timing.batches++;
        self.postMessage({ id, result: null });
        break;
      }
      case 'finish': {
        const start = performance.now();
        const result = builder.finish();
        builder = null;
        const transfers = result.chunks.flatMap(chunk => [chunk.positions.buffer, chunk.tools.buffer]);
        timing.finalizeMs = performance.now() - start;
        self.postMessage({ id, result: { ...result, timing: { ...result.timing, ...timing } } }, transfers);
        break;
      }
      default:
        throw new Error('Unsupported packed preview worker request.');
    }
  } catch (error) {
    self.postMessage({ id, error: {
      message: error.message, code: error.code, retryable: error.retryable, recovery: error.recovery,
    } });
  }
};
