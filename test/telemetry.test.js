const test = require('node:test');
const assert = require('node:assert/strict');
const { reading, number, nozzleTemps } = require('../public/widgets/_telemetry');

test('telemetry distinguishes a disconnected or waiting printer from a current snapshot', () => {
  const print = { gcode_state: 'RUNNING', mc_percent: 47 };
  const snapshot = { print, _bb_received_at: 300_000 };
  assert.deepEqual(reading(snapshot, { connection: 'offline', now: 300_001 }), { state: 'offline' });
  assert.deepEqual(reading(snapshot, { connection: 'waiting', now: 300_001 }), { state: 'waiting' });
  assert.deepEqual(reading(snapshot, { connection: 'online', now: 300_001 }), { state: 'live', print });
  assert.deepEqual(reading({}), { state: 'waiting' });
  assert.deepEqual(reading({ print: { gcode_state: ' ' } }), { state: 'waiting' });
  assert.deepEqual(reading({ print }), { state: 'live', print }, 'Honor legacy snapshots without metadata');

  const ready = result => number(result.mc_percent) !== null;
  assert.deepEqual(reading({ print: { gcode_state: 'RUNNING', mc_percent: null } }, { ready }), { state: 'waiting' });
  assert.equal(reading({ print: { gcode_state: 'RUNNING', mc_percent: '0' } }, { ready }).state, 'live');

  const legacy = { nozzle_temper: '210', nozzle_target_temper: '0' };
  assert.deepEqual(nozzleTemps(legacy, 0), { current: 210, target: 0 });
  assert.equal(nozzleTemps({ ...legacy, device: { extruder: { info: [{ temp: 210 }] } } }, 1), null);
  const leftOnly = { device: { extruder: { info: [{ id: '1', temp: (250 << 16) + 210 }] } } };
  assert.equal(nozzleTemps(leftOnly, 0), null);
  assert.deepEqual(nozzleTemps(leftOnly, 1), { current: 210, target: 250 });
});

test('quiet idle telemetry can outlast the active-job freshness window', () => {
  const print = { gcode_state: 'IDLE' };
  const snapshot = { print, _bb_received_at: 100_000 };
  assert.deepEqual(reading(snapshot, { now: 401_000 }), { state: 'live', print });
  assert.deepEqual(reading(snapshot, { now: 431_000 }), { state: 'waiting' });
  assert.deepEqual(reading({ ...snapshot, print: { gcode_state: 'PAUSE' } }, { now: 161_000 }), { state: 'waiting' });
  const amsOnly = { ams: { ams: [] } };
  assert.deepEqual(reading({ print: amsOnly }, { ready: value => !!value.ams }), { state: 'live', print: amsOnly });
});
