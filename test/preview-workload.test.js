const assert = require('node:assert/strict');
const test = require('node:test');

async function fixture(overrides = {}, options = {}) {
  const { WebGLPreview } = await import('../public/vendor/gcode-preview.esm.js');
  const { createPreviewBudget, PREVIEW_WORKLOAD_LIMITS } = await import('../public/widgets/gcode-viz/preview-workload.js');
  // clear() creates the same parser as the browser without constructing WebGL.
  const preview = Object.create(WebGLPreview.prototype);
  preview.minLayerThreshold = 0.05;
  preview.clear();
  const parser = preview.parser;
  return { parser, budget: createPreviewBudget(parser, { ...options, limits: { ...PREVIEW_WORKLOAD_LIMITS, ...overrides } }) };
}

const refusal = { code: 'PREVIEW_COMPLEXITY', retryable: false, recovery: false };

test('workload tracking preserves native grouping, commands, and modal records across batches', async () => {
  const baseline = (await fixture()).parser;
  const { parser, budget } = await fixture();
  const batches = [
    ['G90', 'M82', 'T1 ; first spool', 'G1 X10 Y10 Z0.2 F1800 E1', 'G92 E0', 'G91'],
    ['M83', 'G1 X20 Y10 Z0.4 E1', 'T0', 'G3 X20 Y20 I0 J5 E0.5', 'G0 X30 Y30'],
  ];
  for (const batch of batches) {
    baseline.parseGCode(batch);
    budget.parseBatch(batch);
    assert.deepEqual(parser.lines, []);
  }
  assert.deepEqual(parser.preamble, baseline.preamble);
  assert.deepEqual(parser.layers, baseline.layers);
  assert.deepEqual(parser.metadata, baseline.metadata);
  assert.deepEqual(budget.stats(), { commands: 11, segments: 27, layers: 2, drawBatches: 7 });
});

test('retained layer workload is accumulated across batches and reset for a new layer', async () => {
  const { budget } = await fixture({ layerSegments: 2 });
  budget.parseBatch(['G1 X10 Y10 Z0.2 E1', 'G1 X20 Y10 E1']);
  budget.parseBatch(['G1 X30 Y10 Z0.4 E1']);
  budget.parseBatch(['G1 X40 Y10 E1']);
  assert.throws(() => budget.parseBatch(['G1 X50 Y10 E1']), { ...refusal, message: /A layer is too dense/ });

  const layerBound = (await fixture({ layers: 1 })).budget;
  layerBound.parseBatch(['G1 X10 Y10 Z0.2 E1']);
  assert.throws(() => layerBound.parseBatch(['G1 X20 Y10 Z0.4 E1']), { ...refusal, message: /this many layers/ });
});

test('expanded arc and total geometry budgets reject excessive renderer work', async () => {
  const commands = ['G1 X10 Y0 Z0.2 E1', 'G2 X20 Y0 R5 E1'];
  const millimeters = (await fixture({ arcSegments: 30 })).budget;
  millimeters.parseBatch(commands);
  assert.equal(millimeters.stats().segments, 25);

  const inches = (await fixture({ arcSegments: 30 })).budget;
  inches.parseBatch(['G20']);
  assert.throws(() => inches.parseBatch(commands), { ...refusal, message: /arc.+too many render segments/ });

  const dense = (await fixture({ segments: 24 })).budget;
  assert.throws(() => dense.parseBatch(commands), { ...refusal, message: /too dense/ });
});

test('a single command and a large retained command set are bounded independently of file lines', async () => {
  const lineBound = await fixture({ commandCharacters: 8 });
  const original = lineBound.parser.parseCommand;
  assert.throws(() => lineBound.budget.parseBatch(['G1 X10 Y10']), { ...refusal, message: /single G-code command/ });
  assert.equal(lineBound.parser.parseCommand, original);
  assert.deepEqual(lineBound.parser.lines, []);

  const state = (await fixture({ commands: 2 })).budget;
  state.parseBatch(['G90', 'M83']);
  assert.throws(() => state.parseBatch(['T0']), { ...refusal, message: /more retained commands/ });
});

test('sequential tools retain normal batches while an excess of per-layer draw batches stops', async () => {
  const { budget } = await fixture({ drawBatches: 10, layerDrawBatches: 2 });
  budget.parseBatch(['G1 X10 Y10 Z0.2 E1', 'T1', 'G1 X20 Y10 E1']);
  budget.parseBatch(['G1 X30 Y10 Z0.4 E1', 'T0', 'G1 X40 Y10 E1']);
  assert.equal(budget.stats().drawBatches, 7);
  assert.throws(() => budget.parseBatch(['T1']), { ...refusal, message: /layer.+too many.+render batches/ });

  const total = (await fixture({ drawBatches: 6 })).budget;
  total.parseBatch(['G1 X10 Y10 Z0.2 E1', 'T1']);
  assert.throws(() => total.parseBatch(['G1 X20 Y10 Z0.4 E1', 'T0']), { ...refusal, message: /toolpath.+too many.+render batches/ });
});
