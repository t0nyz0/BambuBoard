const STARTUP_FACTOR = 1.25;
const MAX_RECENT_LAYERS = 8;
const MIN_FACTOR = 0.75;
const MAX_FACTOR = 4;
const TAIL_START = 0.8;
const TAIL_END = 1.3;

export function reportedPaceSpeed(evidence) {
  const speed = evidence.speedPercent;
  return Number.isFinite(speed) && speed >= 20 && speed <= 300 ? speed : null;
}

export function conservativeLayerPace(speed) {
  return Math.min(MAX_FACTOR, STARTUP_FACTOR * Math.max(1, 100 / (speed ?? 100)));
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function estimateLayerPace(source, modelLayer, evidence) {
  const speed = reportedPaceSpeed(evidence);
  if (evidence.layerSpeedStable !== true) return STARTUP_FACTOR;
  const fallback = conservativeLayerPace(speed);
  if (speed === null || !Array.isArray(evidence.samples)) return fallback;
  const track = source.layer(modelLayer);
  if (!track || track.basis !== 'feed' || !(track.duration >= 2)) return fallback;

  const seen = new Set();
  const ratios = [];
  for (const sample of evidence.samples.slice(-MAX_RECENT_LAYERS)) {
    const index = sample?.layer;
    if (!Number.isInteger(index) || index < 1 || index >= modelLayer ||
        modelLayer - index > MAX_RECENT_LAYERS || seen.has(index)) continue;
    const previous = source.layer(index);
    if (previous?.basis !== 'feed' || !(previous.duration >= 2) ||
        previous.duration < track.duration / 3 || previous.duration > track.duration * 3 ||
        !Number.isFinite(sample.durationMs)) continue;
    const ratio = sample.durationMs / 1000 / previous.duration;
    if (ratio < 0.5 || ratio > 6) continue;
    seen.add(index);
    ratios.push(ratio);
  }
  if (ratios.length < 2) return fallback;
  ratios.sort((a, b) => a - b);
  const center = median(ratios);
  const consistent = ratios.filter(value => value >= center / 1.4 && value <= center * 1.4);
  if (consistent.length < 2) return fallback;
  return Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, median(consistent)));
}

export function estimatedLayerFraction(relativeAge) {
  if (relativeAge <= TAIL_START) return Math.max(0, relativeAge);
  if (relativeAge >= TAIL_END) return 1;
  // Match the initial rate at 80% and smoothly ease to a stop. Keep some
  // real path in reserve for ordinary variations in layer duration.
  const tailAge = (relativeAge - TAIL_START) / (TAIL_END - TAIL_START);
  return TAIL_START + (1 - TAIL_START) * (1 - (1 - tailAge) ** 2.5);
}
