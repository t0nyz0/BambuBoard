import { createPackedMotionBuffer } from './packed-motion-buffer.js';

export function createPackedNozzlePlayback(source, yieldTask, now = () => performance.now()) {
  const buffer = createPackedMotionBuffer(source, source.windowCount, yieldTask);
  let mode = 'hidden';
  let layer = -1;
  let elapsed = 0;
  let clockAt = null;
  let fraction = 0;

  function readClock(time) {
    return elapsed + (clockAt === null ? 0 : (time - clockAt) / 1000);
  }

  function selectLayer(index) {
    if (layer === index) return false;
    layer = index;
    elapsed = 0;
    clockAt = null;
    fraction = 0;
    return true;
  }

  function frame() {
    const snapshot = { mode, layer, state: mode, position: null, ended: false, fraction };
    if (mode === 'hidden' || mode === 'paused') return snapshot;

    const track = source.layer(layer);
    if (!track || track.unavailable) {
      buffer.select(-1);
      return { ...snapshot, state: 'unavailable', unavailable: track?.unavailable };
    }

    // A modal G-code feed estimates motion time. When it is unknown, only
    // manual distance-based seeking has enough information to show a pose.
    if (mode !== 'manual' && !(track.duration > 0)) {
      buffer.select(-1);
      return { ...snapshot, state: 'untimed' };
    }
    const time = now();
    const startingReplay = mode === 'replay' && clockAt === null;
    const progress = mode === 'manual' || startingReplay ? fraction : Math.min(1, readClock(time) / track.duration);
    const target = track.locate(progress);
    if (!target) {
      buffer.select(-1);
      return { ...snapshot, state: 'unavailable' };
    }
    buffer.select(target.index);
    const result = { ...snapshot, window: target.index, layerMoves: track.moves, fraction: progress };
    const path = buffer.current();
    if (path === undefined) return { ...result, state: 'buffering' };
    if (path === null || path.unavailable) {
      return { ...result, state: 'unavailable', unavailable: path?.unavailable };
    }
    if (startingReplay) {
      elapsed = fraction * track.duration;
      clockAt = time;
    }
    const position = path.sample(target.fraction, track.basis);
    return {
      ...result,
      state: position ? 'ready' : 'unavailable',
      position,
      windowMoves: path.moves,
      ended: mode !== 'manual' && progress === 1,
    };
  }

  return {
    prime(index) {
      const track = source.layer(index);
      const first = track?.duration > 0 ? track.locate(0) : null;
      if (first) buffer.select(first.index);
    },
    live(index) {
      const changedLayer = selectLayer(index);
      if (changedLayer || mode !== 'live') {
        // Motion windows follow the live playhead during buffering. A ready
        // window resumes at the current time rather than replaying the stall.
        clockAt = now();
        mode = 'live';
        frame();
      }
    },
    pause() {
      if (mode !== 'live') return;
      elapsed = readClock(now());
      clockAt = null;
      mode = 'paused';
    },
    hide() {
      if (mode === 'hidden') return;
      selectLayer(-1);
      buffer.select(-1);
      mode = 'hidden';
    },
    seek(index, value = 0) {
      selectLayer(index);
      mode = 'manual';
      fraction = Math.min(1, Math.max(0, value));
      clockAt = null;
      frame();
    },
    play(index, value = 0) {
      selectLayer(index);
      mode = 'replay';
      fraction = Math.min(1, Math.max(0, value));
      clockAt = null;
      frame();
    },
    frame,
    stats: () => ({
      ...buffer.stats(),
      sourceBytes: source.sourceBytes ?? null,
      rawSourceBytes: source.rawSourceBytes ?? null,
    }),
    dispose: () => buffer.dispose(),
  };
}
