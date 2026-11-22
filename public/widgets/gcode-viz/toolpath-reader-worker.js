import { createToolpathFramer } from './toolpath-framing.js';

let frame;
self.onmessage = ({ data }) => {
  try {
    if (data.maxCharacters) {
      frame = createToolpathFramer(data.maxCharacters);
      self.postMessage({ ready: true });
      return;
    }
    self.postMessage({ lines: frame(data.chunk, data.done) });
  } catch (err) {
    self.postMessage({ error: err.message, code: err.code });
  }
};
