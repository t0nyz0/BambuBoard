import { createPackedMotionBuffer } from './packed-motion-buffer.js';
import { conservativeLayerPace, estimateLayerPace, estimatedLayerFraction, reportedPaceSpeed } from './packed-layer-pace.js';

export function createPackedNozzlePlayback(source, yieldTask, now = () => performance.now()) {
  const buffer = createPackedMotionBuffer(source, source.windowCount, yieldTask);
  let mode = 'hidden';
  let layer = -1;
  let elapsed = 0;
  let sampledElapsed = 0;
  let clockAt = null;
  let fraction = 0;
  let receipt = null;
  let anchored = false;
  let lastPose = null;
  let pacing;

  function readClock(time) {
    return elapsed + (clockAt === null ? 0 : Math.max(0, time - clockAt) / 1000);
  }

  function selectLayer(index) {
    if (layer === index) return;
    layer = index;
    elapsed = 0;
    sampledElapsed = 0;
    clockAt = null;
    fraction = 0;
    receipt = null;
    anchored = false;
    lastPose = null;
    pacing = undefined;
  }

  function setTiming(timing, advancing) {
    if (!timing) {
      elapsed = readClock(now());
      clockAt = null;
      return;
    }
    if (!anchored || receipt !== timing.receivedAt) {
      const time = now();
      const transit = advancing ? Math.max(0, time - timing.observedAt) / 1000 : 0;
      // A later poll can carry an older estimate than the display has
      // already sampled. Keep same-layer deposition and completion steady.
      elapsed = Math.max(sampledElapsed, timing.elapsedMs / 1000 + transit);
      receipt = timing.receivedAt;
      anchored = true;
      clockAt = advancing ? time : null;
    } else if (advancing && clockAt === null) {
      clockAt = now();
    } else if (!advancing && clockAt !== null) {
      elapsed = readClock(now());
      clockAt = null;
    }
  }

  function pacedAge(wallAge) {
    return pacing.nominalAnchor + Math.max(0, wallAge - pacing.wallAnchor) / pacing.factor;
  }

  function setPace(timing) {
    if (!timing || pacing === null) return;
    const evidence = timing.pace;
    if (evidence === undefined) {
      if (!pacing) pacing = null;
      return;
    }
    const speed = reportedPaceSpeed(evidence);
    if (pacing?.speed === speed) return;

    // A speed change affects subsequent motion. Reusing the new speed for
    // the whole layer would jump the nozzle and redraw past deposition.
    const wallAnchor = pacing || evidence.layerSpeedStable !== true ? readClock(now()) : 0;
    const nominalAnchor = pacing ? pacedAge(wallAnchor) : wallAnchor / conservativeLayerPace(null);
    const factor = evidence.layerSpeedStable === true ? estimateLayerPace(source, layer, evidence)
      : conservativeLayerPace(speed);
    pacing = { speed, factor, wallAnchor, nominalAnchor };
  }

  function frame() {
    const snapshot = { mode, layer, state: mode, position: null, deposition: lastPose, ended: false, fraction };
    if (mode === 'hidden' || mode === 'waiting' || (mode === 'paused' && !anchored)) return snapshot;

    const track = source.layer(layer);
    if (!track || track.unavailable) {
      buffer.select(-1);
      return { ...snapshot, state: 'unavailable', unavailable: track?.unavailable };
    }

    // Reported layer age anchors an estimate along the commanded path.
    // Firmware time does not measure head position, and whole-job percent
    // cannot establish a position within the current layer.
    if (mode !== 'manual' && !(track.duration > 0)) {
      buffer.select(-1);
      return { ...snapshot, state: 'untimed' };
    }
    const time = now();
    const startingReplay = mode === 'replay' && clockAt === null;
    const wallAge = readClock(time);
    const estimated = pacing && (mode === 'live' || mode === 'paused')
      ? estimatedLayerFraction(pacedAge(wallAge) / track.duration) : Math.min(1, wallAge / track.duration);
    const progress = mode === 'manual' || startingReplay ? fraction : estimated;
    const target = track.locate(progress);
    if (!target) {
      buffer.select(-1);
      return { ...snapshot, state: 'unavailable' };
    }
    buffer.select(target.index);
    const result = { ...snapshot, window: target.index, layerMoves: track.moves, fraction: progress, paceFactor: pacing?.factor };
    const path = buffer.current();
    if (path === undefined) return { ...result, state: mode === 'paused' ? 'paused' : 'buffering' };
    if (path === null || path.unavailable) {
      return { ...result, state: 'unavailable', unavailable: path?.unavailable };
    }
    if (startingReplay) {
      elapsed = fraction * track.duration;
      clockAt = time;
    }
    const pose = path.sample(target.fraction, track.basis);
    if (pose) {
      lastPose = pose;
      if (mode === 'live' || mode === 'paused') sampledElapsed = wallAge;
    }
    const waitingForLayer = mode === 'live' && progress === 1;
    return {
      ...result,
      state: !pose ? 'unavailable' : waitingForLayer ? 'awaiting-layer' : mode === 'paused' ? 'paused' : 'ready',
      position: waitingForLayer || mode === 'paused' ? null : pose,
      deposition: lastPose,
      windowMoves: path.moves,
      ended: mode !== 'manual' && progress === 1,
    };
  }

  return {
    prime(index, timing) {
      const track = source.layer(index);
      if (!timing || !(track?.duration > 0)) return;
      const age = timing.elapsedMs / 1000 + (timing.advancing ? Math.max(0, now() - timing.observedAt) / 1000 : 0);
      const progress = timing.pace === undefined ? Math.min(1, age / track.duration)
        : estimatedLayerFraction(age / track.duration / estimateLayerPace(source, index, timing.pace));
      const first = track.locate(progress);
      if (first) buffer.select(first.index);
    },
    live(index, timing) {
      if (mode === 'manual' || mode === 'replay') selectLayer(-1);
      selectLayer(index);
      if (!timing?.advancing) {
        setTiming(timing, false);
        if (mode !== 'waiting') buffer.select(-1);
        mode = 'waiting';
        return;
      }
      setTiming(timing, true);
      setPace(timing);
      mode = 'live';
      frame();
    },
    pause(index = layer, timing = null) {
      if (index < 0 || mode === 'manual' || mode === 'replay') return;
      selectLayer(index);
      setTiming(timing, false);
      setPace(timing);
      mode = 'paused';
    },
    hide() {
      selectLayer(-1);
      buffer.select(-1);
      mode = 'hidden';
    },
    seek(index, value = 0) {
      selectLayer(index);
      const requested = Math.min(1, Math.max(0, value));
      if (mode !== 'manual' || requested !== fraction) lastPose = null;
      mode = 'manual';
      fraction = requested;
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
