// Budget the model the viewer retains and renders, rather than the number of
// lines in the sliced file. Standalone comments are removed by the loader.
export const PREVIEW_WORKLOAD_LIMITS = Object.freeze({
  commands: 2_000_000,
  segments: 1_200_000,
  layers: 20_000,
  layerCommands: 250_000,
  layerSegments: 180_000,
  drawBatches: 32_000,
  layerDrawBatches: 1_024,
  arcSegments: 8_192,
  commandCharacters: 65_536,
});

export class PreviewWorkloadError extends Error {
  constructor(reason, { canPack = false } = {}) {
    super(`${reason} Open this plate in Bambu Studio.`);
    this.code = 'PREVIEW_COMPLEXITY';
    this.retryable = false;
    this.recovery = false;
    this.canPack = canPack;
  }
}

const motions = new Set(['g0', 'g00', 'g1', 'g01', 'g2', 'g02', 'g3', 'g03']);
const arcs = new Set(['g2', 'g02', 'g3', 'g03']);
const geometryParams = ['x', 'y', 'z', 'r', 'i', 'j'];
const turn = 2 * Math.PI;

function arcSegments(x, y, nextX, nextY, params, clockwise, inches) {
  const dx = nextX - x, dy = nextY - y;
  let { i = 0, j = 0, r = 0 } = params;
  if (r) {
    const chord = Math.hypot(dx, dy);
    if (!chord) // The native estimator reads axes as absolute; the packed path
    // can validate relative arc endpoints from the actual modal state.
    throw new PreviewWorkloadError('The toolpath contains a radius arc without a distinct endpoint.', { canPack: true });
    // Match the pinned renderer's radius-to-centre conversion for the guard.
    const radius = Math.max(r, chord / 2);
    const side = clockwise ? 1 : -1;
    const offset = side * Math.sqrt(Math.max(0, radius ** 2 - (chord / 2) ** 2)) / chord;
    i = dx / 2 + dy * offset;
    j = dy / 2 - dx * offset;
  }
  const radius = Math.hypot(i, j);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new PreviewWorkloadError('The toolpath contains an arc without a valid centre.');
  }
  const from = Math.atan2(-j, -i);
  const to = Math.atan2(dy - j, dx - i);
  let sweep = clockwise ? from - to : to - from;
  if (dx === 0 && dy === 0) sweep = turn;
  else if (sweep < 0) sweep += turn;

  // The renderer uses one segment per 1.8 mm of arc with its inch-mode
  // multiplier. Count the independently tessellated nozzle path as well.
  const rendererSegments = Math.max(1, Math.ceil(radius * sweep / 1.8 * (inches ? 25 : 1)));
  return Math.max(24, rendererSegments);
}

export function createPreviewBudget(parser, { inches = false, limits = PREVIEW_WORKLOAD_LIMITS } = {}) {
  let commands = 0, segments = 0, currentLayerSegments = 0;
  let toolRuns = 0, currentLayerToolRuns = 0, drawBatches = 0;
  let x = 0, y = 0, z = 0;

  function measure(command) {
    const { gcode, params } = command;
    if (gcode === 'g20') inches = true;
    if (!motions.has(gcode)) return 0;
    for (const axis of geometryParams) {
      if (Object.hasOwn(params, axis) && (!Number.isFinite(params[axis]) || Math.abs(params[axis]) > 1_000_000)) {
        throw new PreviewWorkloadError('The toolpath contains coordinates outside the supported preview range.');
      }
    }
    const nextX = params.x ?? x, nextY = params.y ?? y, nextZ = params.z ?? z;
    const moved = x !== nextX || y !== nextY || z !== nextZ;
    let count = Number(moved);
    if (arcs.has(gcode) && (moved || params.i || params.j)) {
      count = arcSegments(x, y, nextX, nextY, params, gcode === 'g2' || gcode === 'g02', inches);
      if (count > limits.arcSegments) {
        throw new PreviewWorkloadError('An arc in this toolpath needs too many render segments.');
      }
    }
    x = nextX;
    y = nextY;
    z = nextZ;
    return count;
  }

  function parseBatch(lines) {
    if (commands + lines.length > limits.commands) {
      throw new PreviewWorkloadError('The toolpath has more retained commands than the preview can safely hold.', { canPack: true });
    }
    const before = parser.layers.length;
    const previousLayer = parser.layers.at(-1) ?? parser.preamble;
    const previousCommands = previousLayer.commands.length;
    const costs = [];
    const toolChanges = [];
    const parseCommand = parser.parseCommand;
    parser.parseCommand = function (line, keepComments) {
      if (line.length > limits.commandCharacters) {
        throw new PreviewWorkloadError('A single G-code command is too large to preview safely.');
      }
      const command = parseCommand.call(this, line, keepComments);
      const count = measure(command);
      commands++;
      segments += count;
      if (segments > limits.segments) {
        throw new PreviewWorkloadError('The toolpath is too dense for a reliable 3D preview.', { canPack: true });
      }
      if (command.gcode.startsWith('t')) toolChanges.push(costs.length);
      costs.push(count);
      return command;
    };
    try {
      parser.parseGCode(lines);
    } finally {
      parser.parseCommand = parseCommand;
      // The parser retains command sources already. Its separate input history
      // is unused here and concatenating it on every batch grows quadratic.
      parser.lines.length = 0;
    }
    if (parser.layers.length > limits.layers) {
      throw new PreviewWorkloadError('The preview cannot safely hold this many layers.');
    }

    toolRuns += toolChanges.length;
    let offset = 0, nextToolChange = 0;
    function measureLayer(layer, existing) {
      const end = offset + layer.commands.length - existing;
      for (; offset < end; offset++) currentLayerSegments += costs[offset];
      for (; nextToolChange < toolChanges.length && toolChanges[nextToolChange] < end; nextToolChange++) {
        currentLayerToolRuns++;
      }
      if (layer.commands.length > limits.layerCommands || currentLayerSegments > limits.layerSegments) {
        throw new PreviewWorkloadError('A layer is too dense for a reliable 3D preview.');
      }
      if (currentLayerToolRuns + 1 > limits.layerDrawBatches) {
        throw new PreviewWorkloadError('A layer needs too many separate render batches.');
      }
    }
    measureLayer(previousLayer, previousCommands);
    for (let index = before; index < parser.layers.length; index++) {
      currentLayerSegments = 0;
      currentLayerToolRuns = 0;
      measureLayer(parser.layers[index], 0);
    }
    // Each layer (including preamble) and tool transition produces a native
    // line geometry, even if no points were drawn. The last layer can split
    // each run once more for its final-segment color.
    drawBatches = parser.layers.length + 1 + toolRuns + currentLayerToolRuns + 1;
    if (drawBatches > limits.drawBatches) {
      throw new PreviewWorkloadError('The toolpath needs too many separate render batches.', { canPack: true });
    }
  }

  return { parseBatch, stats: () => ({ commands, segments, layers: parser.layers.length, drawBatches }) };
}
