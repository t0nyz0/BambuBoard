export const HOT_DEPOSITION_SECONDS = 144;
export const MAX_RECENT_DEPOSITION_SEGMENTS = 8_799;

// A large clock or geometric jump after startup, a seek, or a stalled
// renderer does not establish when the print laid the intervening material.
const MAX_TRACKING_GAP = 2;
const MAX_SEGMENTS_PER_SAMPLE = 512;
const JOIN_TOLERANCE = 0.00005;

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function joinable(previous, next) {
  if (!previous || previous.toTime !== next.fromTime || distance(previous.to, next.from) > JOIN_TOLERANCE ||
      !previous.color.every((value, index) => value === next.color[index])) return false;

  // Coalesce a run of samples along one straight move without joining
  // curves, travel gaps, or materially different temperature gradients.
  const [x, y, z] = previous.to.map((value, axis) => value - previous.from[axis]);
  const [dx, dy, dz] = next.to.map((value, axis) => value - previous.from[axis]);
  const first = Math.hypot(x, y, z);
  const second = distance(next.from, next.to);
  const whole = Math.hypot(dx, dy, dz);
  if (whole === 0 || first + second - whole > JOIN_TOLERANCE ||
      Math.hypot(y * dz - z * dy, z * dx - x * dz, x * dy - y * dx) / whole > JOIN_TOLERANCE) return false;
  const boundary = previous.fromTime + (next.toTime - previous.fromTime) * first / (first + second);
  return Math.abs(boundary - previous.toTime) < 0.025;
}

export function createHotDepositionHistory(readCompleted, colorForTool) {
  const capacity = MAX_RECENT_DEPOSITION_SEGMENTS;
  const ring = new Array(capacity);
  let first = 0, size = 0;
  let cursor = null;
  let mode = null;
  let snapshot = [];

  function removeOldest() {
    ring[first] = undefined;
    first = (first + 1) % capacity;
    size--;
    snapshot = null;
  }

  function clear() {
    while (size) removeOldest();
    cursor = null;
    mode = null;
  }

  function append(piece) {
    if (size) {
      const last = (first + size - 1) % capacity;
      const previous = ring[last];
      if (joinable(previous, piece)) {
        ring[last] = { ...previous, to: piece.to, toTime: piece.toTime };
        snapshot = null;
        return;
      }
    }
    if (size === capacity) removeOldest();
    ring[(first + size) % capacity] = piece;
    size++;
    snapshot = null;
  }

  return {
    get size() { return size; },
    update(deposition) {
      if (!deposition || deposition.heatMode === 'clear') {
        clear();
        return;
      }
      const { heatMode, at, end, partial, layer, layerAge } = deposition;
      if (!Number.isFinite(at)) return;
      while (size && at - ring[first].toTime >= HOT_DEPOSITION_SECONDS) removeOldest();

      if (heatMode !== 'live' && heatMode !== 'replay') {
        cursor = null;
        return;
      }
      if (mode !== heatMode || (cursor && (at < cursor.at || end < cursor.end))) clear();
      mode = heatMode;
      const before = cursor;
      cursor = { at, end, partial, layer, layerAge };
      if (!before) return;
      const elapsed = at - before.at;
      const skippedLayer = layer < before.layer || layer > before.layer + 1;
      const rebased = layer === before.layer &&
        Math.abs(layerAge - before.layerAge - elapsed) > MAX_TRACKING_GAP;
      if (elapsed > MAX_TRACKING_GAP || end - before.end > MAX_SEGMENTS_PER_SAMPLE || skippedLayer || rebased) return;

      const completed = end > before.end ? readCompleted(before.end, end) : [];
      if (!completed) return;
      if (completed.length && before.partial) {
        completed[0] = { ...completed[0], from: before.partial.to };
      }
      if (partial) {
        const previous = end === before.end ? before.partial : null;
        if (!previous || distance(partial.from, partial.to) >= distance(previous.from, previous.to)) {
          completed.push({ from: previous?.to ?? partial.from, to: partial.to, color: colorForTool(partial.tool) });
        }
      }

      const lengths = completed.map(piece => distance(piece.from, piece.to));
      const length = lengths.reduce((sum, value) => sum + value, 0);
      if (!(length > 0 && Number.isFinite(length))) return;
      let offset = 0;
      for (const [index, piece] of completed.entries()) {
        if (lengths[index] === 0) continue;
        const fromTime = before.at + elapsed * offset / length;
        offset += lengths[index];
        const toTime = before.at + elapsed * offset / length;
        append({ ...piece, fromTime, toTime });
      }
    },
    segments() {
      snapshot ??= Array.from({ length: size }, (_, index) => ring[(first + index) % capacity]);
      return snapshot;
    },
  };
}
