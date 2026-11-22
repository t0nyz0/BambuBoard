const assert = require('node:assert/strict');
const test = require('node:test');

test('toolpath framing preserves verified layer comments across transport chunks', async () => {
  const { createToolpathFramer } = await import('../public/widgets/gcode-viz/toolpath-framing.js');
  const frame = createToolpathFramer(80);
  const encode = new TextEncoder();
  const first = frame(encode.encode(' ; ordinary comment\n  ; CHANGE_LA'));
  const middle = frame(encode.encode('YER\r\n; Z_HEIG'));
  const last = frame(encode.encode('HT: 0.20\n; layer num/total_layer_count: 1/2\nG1 X4 ; embedded note'), true);
  assert.deepEqual(first, []);
  assert.deepEqual(middle, ['; CHANGE_LAYER\r']);
  assert.deepEqual(last, ['; Z_HEIGHT: 0.20', '; layer num/total_layer_count: 1/2', 'G1 X4 ; embedded note']);
});

test('layer markers distinguish malformed metadata from ordinary comments and bound comment storage', async () => {
  const { parseToolpathLayerMarker } = await import('../public/widgets/gcode-viz/toolpath-layer-marker.js');
  const { createToolpathFramer } = await import('../public/widgets/gcode-viz/toolpath-framing.js');
  const frame = createToolpathFramer(16);
  const encode = new TextEncoder();
  assert.deepEqual(parseToolpathLayerMarker('; layer num/total_layer_count: 42/1474'), { kind: 'number', layer: 42, total: 1474 });
  assert.deepEqual(parseToolpathLayerMarker('; layer num/total_layer_count: 2/1'), { kind: 'invalid' });
  assert.deepEqual(parseToolpathLayerMarker('; Z_HEIGHT: xx'), { kind: 'invalid' });
  assert.equal(parseToolpathLayerMarker('; LAYER_HEIGHT: .2'), null);
  assert.deepEqual(frame(encode.encode('; ' + 'a'.repeat(100_000))), []);
  assert.deepEqual(frame(encode.encode('\n; Z_HEIGHT: 0.2 ' + 'x'.repeat(1000) + '\nG1 X10\n'), true),
    ['; layer num/total_layer_count: invalid', 'G1 X10']);
});
