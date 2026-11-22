// Bambu Studio writes the physical layer number alongside its layer-change
// and Z-height markers. Only a complete, consistent series can override the
// preview's inferred layer numbering.
export const MAX_LAYER_MARKER_CHARACTERS = 128;

export function parseToolpathLayerMarker(line) {
  if (line[0] !== ';') return null;
  const value = line.slice(1).trim();
  if (value.startsWith('CHANGE_LAYER')) {
    return { kind: value === 'CHANGE_LAYER' ? 'change' : 'invalid' };
  }
  if (value.startsWith('Z_HEIGHT')) {
    const height = /^Z_HEIGHT:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(value);
    const z = height ? Number(height[1]) : NaN;
    return Number.isFinite(z) && Math.abs(z) <= 1_000_000 ? { kind: 'height', z } : { kind: 'invalid' };
  }
  if (value.startsWith('layer num/total_layer_count')) {
    const number = /^layer num\/total_layer_count:\s*(\d+)\s*\/\s*(\d+)$/.exec(value);
    const layer = number ? Number(number[1]) : 0;
    const total = number ? Number(number[2]) : 0;
    return layer > 0 && layer <= total && total <= 20_000
      ? { kind: 'number', layer, total }
      : { kind: 'invalid' };
  }
  return null;
}
