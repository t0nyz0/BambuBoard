const assert = require('node:assert/strict');
const test = require('node:test');

const firstTool = [0.05, 0.05, 0.05];
const secondTool = [0.01, 0.2, 0.4];
const tools = [firstTool, secondTool];
const point = x => [x, 0, 0];
const partial = (from, to, tool = 0) => ({ from: point(from), to: point(to), tool });
const packet = (at, end, current = null, heatMode = 'live') => ({ at, end, partial: current, heatMode });

async function fixture() {
  const { createHotDepositionHistory } = await import('../public/widgets/gcode-viz/hot-deposition-history.js');
  const completed = [
    { from: point(0), to: point(10), color: firstTool },
    { from: point(20), to: point(30), color: secondTool },
    { from: [30, 0, 0], to: [30, 3, 0], color: secondTool },
  ];
  return createHotDepositionHistory((start, end) => completed.slice(start, end), tool => tools[tool]);
}

test('straight partial frames join at their original birth times and complete without duplicating laid material', async () => {
  const history = await fixture();
  history.update(packet(0, 0));
  history.update(packet(0.4, 0, partial(0, 2)));
  history.update(packet(0.8, 0, partial(0, 4)));
  history.update(packet(2, 1));
  assert.deepEqual(history.segments(), [{ from: point(0), to: point(10), color: firstTool, fromTime: 0, toTime: 2 }]);

  const laid = history.segments();
  history.update(packet(2.6, 1));
  assert.equal(history.segments(), laid, 'Age-only updates leave the history snapshot untouched');
  history.update(packet(3, 1, partial(20, 22, 1)));
  assert.equal(history.size, 2);
  assert.deepEqual(history.segments()[1].from, point(20));
  assert.deepEqual(history.segments()[1].to, point(22));
  assert.equal(history.segments()[1].fromTime, 2.6);
  assert.equal(history.segments()[1].color, secondTool);
  assert.deepEqual(history.segments()[0].to, point(10));
});

test('completed moves across a frame keep true endpoints, tool changes, and ordered ages across a travel gap', async () => {
  const history = await fixture();
  history.update(packet(11.5, 0));
  history.update(packet(13, 3));
  const [first, second, third] = history.segments();
  assert.equal(first.fromTime, 11.5);
  assert.equal(third.toTime, 13);
  assert.ok(first.toTime > first.fromTime);
  assert.equal(second.fromTime, first.toTime);
  assert.equal(third.fromTime, second.toTime);
  assert.deepEqual(first.to, point(10));
  assert.deepEqual(second.from, point(20));
  assert.deepEqual(third.to, [30, 3, 0]);
  assert.equal(second.color, secondTool);
});

test('heat remains on past material across pause and travel, then disappears at its age limit', async () => {
  const history = await fixture();
  history.update(packet(0, 0));
  history.update(packet(1, 1));
  history.update(packet(28.8, 1, null, 'hold'));
  assert.equal(history.size, 1);
  history.update(packet(57.6, 2));
  assert.equal(history.size, 1, 'Resuming from a missed interval never invents fresh deposition');
  history.update(packet(58, 3));
  assert.equal(history.size, 2);
  history.update(packet(144.9, 3, null, 'hold'));
  assert.equal(history.size, 2);
  history.update(packet(145, 3, null, 'hold'));
  assert.equal(history.size, 1);
  assert.deepEqual(history.segments()[0].from, [30, 0, 0]);
  history.update(packet(202, 3, null, 'hold'));
  assert.equal(history.size, 0);
});

test('cold starts, missed intervals, rewinds and manual mode do not paint older material as new', async () => {
  const history = await fixture();
  history.update(packet(0, 1, partial(20, 23, 1)));
  assert.equal(history.size, 0);
  history.update(packet(0.5, 1, partial(20, 26, 1)));
  assert.deepEqual(history.segments()[0].from, point(23));
  history.update(packet(20, 3));
  assert.equal(history.size, 1);
  history.update(packet(21, 1));
  assert.equal(history.size, 0);
  history.update(packet(21.5, 2));
  assert.equal(history.size, 1);
  history.update(packet(21.6, 2, null, 'clear'));
  assert.equal(history.size, 0);
  history.update(packet(21.7, 3, null, 'replay'));
  assert.equal(history.size, 0);
});

test('large telemetry corrections and skipped layers seed a new cursor while existing heat keeps cooling', async () => {
  const history = await fixture();
  const atAge = (at, layer, layerAge, end, move) => history.update({ ...packet(at, end, move), layer, layerAge });
  atAge(0, 2, 30, 0, null);
  atAge(1, 2, 31, 0, partial(0, 4));
  const alreadyLaid = history.segments();
  atAge(1.1, 2, 51, 1, null);
  assert.equal(history.segments(), alreadyLaid, 'An authoritative age jump cannot flash past material red');

  atAge(1.2, 2, 51.1, 1, partial(20, 21, 1));
  assert.equal(history.size, 2);
  const observed = history.segments();
  atAge(1.3, 4, 0.05, 3, null);
  assert.equal(history.segments(), observed, 'A skipped physical layer provides no new heat timestamp');
});

test('the ring drops only oldest history at its capacity and rejects unobserved geometric jumps', async () => {
  const { createHotDepositionHistory, MAX_RECENT_DEPOSITION_SEGMENTS } =
    await import('../public/widgets/gcode-viz/hot-deposition-history.js');
  const history = createHotDepositionHistory((start, end) => Array.from(
    { length: end - start }, (_, index) => ({
      from: point((start + index) * 2), to: point((start + index) * 2 + 1), color: firstTool,
    })), () => firstTool);
  history.update(packet(0, 0));
  history.update(packet(1, 1_000));
  assert.equal(history.size, 0);
  for (let index = 1; index <= 18; index++) history.update(packet(1 + index / 5, 1_000 + index * 500));
  assert.equal(history.size, MAX_RECENT_DEPOSITION_SEGMENTS);
  assert.equal(history.segments()[0].from[0], (10_000 - MAX_RECENT_DEPOSITION_SEGMENTS) * 2);
  assert.equal(history.segments().at(-1).to[0], 19_999);
});
