import { createPackedMotionBuffer } from './packed-motion-buffer.js';

export function createPackedNozzlePlayback(source, layerCount, yieldTask, now = () => performance.now()) {
  const buffer = createPackedMotionBuffer(source, layerCount, yieldTask);
  let mode = 'hidden';
  let layer = -1;
  let elapsed = 0;
  let clockAt = null;
  let fraction = 0;

  function readClock(time) {
    return elapsed + (clockAt === null ? 0 : (time - clockAt) / 1000);
  }

  function select(index) {
    if (layer === index) return false;
    layer = index;
    elapsed = 0;
    clockAt = null;
    fraction = 0;
    buffer.select(index);
    return true;
  }

  return {
    live(index) {
      const time = now();
      const changedLayer = select(index);
      if (changedLayer || mode !== 'live') {
        // Keep the clock tied to the layer report during ordinary underflow.
        // When decoding finishes, the view uses the current playhead.
        clockAt = time;
      }
      mode = 'live';
    },
    pause() {
      if (mode !== 'live') return;
      elapsed = readClock(now());
      clockAt = null;
      mode = 'paused';
    },
    hide() {
      if (mode === 'hidden') return;
      select(-1);
      mode = 'hidden';
    },
    seek(index, value = 0) {
      select(index);
      mode = 'manual';
      fraction = Math.min(1, Math.max(0, value));
      clockAt = null;
    },
    play(index, value = 0) {
      select(index);
      mode = 'replay';
      fraction = Math.min(1, Math.max(0, value));
      clockAt = null;
    },
    frame() {
      const snapshot = { mode, layer, state: mode, position: null, ended: false, fraction };
      if (mode === 'hidden' || mode === 'paused') return snapshot;
      const path = buffer.current();
      if (path === undefined) return { ...snapshot, state: 'buffering' };
      if (path === null || path.unavailable) {
        return { ...snapshot, state: 'unavailable', unavailable: path?.unavailable };
      }
      // G-code F gives nominal move time. Firmware acceleration, tool swaps,
      // and dwell scheduling are not measured. With no feed no speed is
      // guessed. The operator can still seek by distance along the path.
      if (mode !== 'manual' && !(path.duration > 0)) return { ...snapshot, state: 'untimed' };
      const time = now();
      if (mode === 'replay' && clockAt === null) {
        elapsed = fraction * path.duration;
        clockAt = time;
      }
      const progress = mode === 'manual' ? fraction : Math.min(1, readClock(time) / path.duration);
      const position = path.sample(progress);
      return {
        ...snapshot,
        state: position ? 'ready' : 'unavailable',
        position,
        ended: mode !== 'manual' && progress === 1,
        fraction: progress,
      };
    },
    stats: () => ({
      ...buffer.stats(),
      sourceBytes: source.sourceBytes ?? null,
      rawSourceBytes: source.rawSourceBytes ?? null,
    }),
    dispose: () => buffer.dispose(),
  };
}
