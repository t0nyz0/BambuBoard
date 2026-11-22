const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLayerClock, mergePrint } = require('../src/lib/printTelemetry');
const { createPrinterClient } = require('../src/mqtt');
const { temporary, until } = require('./helpers');

function reading(elapsed, advancing) {
  return { _bb_layer_elapsed_ms: elapsed, _bb_layer_advancing: advancing };
}

function makeClock() {
  const clock = createLayerClock();
  let print = {};
  return {
    update(delta, at) {
      print = mergePrint(print, delta);
      return clock.observe(print, delta, at);
    },
    reset: clock.reset,
  };
}

test('observed active layer timing excludes pauses, filament changes and heating', () => {
  const clock = makeClock();
  const update = clock.update;
  assert.equal(update({ gcode_state: 'PREPARE', subtask_name: 'Model' }, 0), null);
  assert.deepEqual(update({ gcode_state: 'RUNNING', layer_num: 1, stg_cur: '0' }, 100), reading(0, true));
  assert.deepEqual(update({ bed_temper: 65 }, 1600), reading(1500, true));
  assert.deepEqual(update({ gcode_state: 'PAUSE' }, 2100), reading(2000, false));
  assert.deepEqual(update({ gcode_state: 'PAUSED' }, 5100), reading(2000, false));
  assert.deepEqual(update({ gcode_state: 'RUNNING', stage: { _id: 4 } }, 8800), reading(2000, false));
  assert.deepEqual(update({ stage: { flags: 1 }, bed_temper: 63 }, 9250), reading(2000, false));
  assert.deepEqual(update({ stage: { _id: 0 } }, 9800), reading(2000, true));
  assert.deepEqual(update({ mc_percent: 20 }, 10300), reading(2500, true));
  assert.deepEqual(update({ layer_num: '2', stage: { _id: 7 } }, 10500), reading(0, false));
  assert.deepEqual(update({ stg_cur: 0 }, 12500), reading(0, true));
  assert.deepEqual(update({ nozzle_temper: 218 }, 13000), reading(500, true));
});

test('cold, skipped and backward layer reports require a new observed transition', () => {
  const { update } = makeClock();
  assert.equal(update({ gcode_state: 'RUNNING', subtask_name: 'Late join', layer_num: 12, total_layer_num: 18, stg_cur: 0 }, 0), null);
  assert.equal(update({ mc_percent: 75, mc_remaining_time: 18 }, 1000), null);
  assert.equal(update({ layer_num: 14 }, 2000), null);
  assert.deepEqual(update({ layer_num: 15 }, 3000), reading(0, true));
  assert.equal(update({ layer_num: 14 }, 3500), null);
  assert.equal(update({ layer_num: 15 }, 4000), null);
  assert.deepEqual(update({ layer_num: 16 }, 4500), reading(0, true));
  assert.equal(update({ layer_num: 16.5 }, 4700), null);
  assert.equal(update({ layer_num: 17 }, 4800), null);
  assert.deepEqual(update({ layer_num: 18 }, 5000), reading(0, true));
  assert.equal(update({ layer_num: 19 }, 5500), null);
});

test('layer timing is discarded across silent connections, new jobs and printer resets', () => {
  const { update, reset } = makeClock();
  assert.equal(update({ gcode_state: 'RUNNING', subtask_name: 'First', layer_num: 0, stg_cur: 0 }, 0), null);
  assert.deepEqual(update({ layer_num: 1 }, 1000), reading(0, true));
  assert.equal(update({ bed_temper: 55 }, 61_001), null);
  assert.deepEqual(update({ layer_num: 2 }, 62_000), reading(0, false));
  assert.deepEqual(update({ stg_cur: 0 }, 63_000), reading(0, true));
  assert.equal(update({ subtask_name: 'Second', layer_num: 3, gcode_state: 'RUNNING' }, 64_000), null);
  assert.deepEqual(update({ layer_num: 4, stg_cur: 0 }, 65_000), reading(0, true));
  reset();
  assert.equal(update({ layer_num: 5, stg_cur: 0 }, 66_000), null);
  assert.deepEqual(update({ layer_num: 6 }, 67_000), reading(0, true));
  assert.equal(update({ gcode_state: 'FINISH', mc_percent: 100 }, 68_000), null);
  assert.equal(update({ gcode_state: 'RUNNING', layer_num: 1, stg_cur: 0 }, 69_000), null);
});

test('layer timing requires the printer to report printing stage and ignores clock regression', () => {
  const { update } = makeClock();
  assert.equal(update({ gcode_state: 'RUNNING', subtask_name: 'Model', layer_num: 0 }, 0), null);
  assert.deepEqual(update({ layer_num: 1 }, 100), reading(0, false));
  assert.deepEqual(update({ stg_cur: false }, 120), reading(0, false));
  assert.deepEqual(update({ stg_cur: 0 }, 130), reading(0, true));
  assert.deepEqual(update({ bed_temper: 52 }, 430), reading(300, true));
  assert.equal(update({ bed_temper: 53 }, 60), null);
  assert.deepEqual(update({ layer_num: 2, stg_cur: 0 }, 90), reading(0, true));
});

test('printer deltas and old snapshots cannot inject reserved layer timing fields', () => {
  const previous = mergePrint({}, { gcode_state: 'RUNNING', layer_num: 7 });
  const spoofed = mergePrint({ ...previous, ...reading(800, true) }, {
    bed_temper: 55, _bb_layer_elapsed_ms: 1500, _bb_layer_advancing: true,
  });
  assert.equal(spoofed.bed_temper, 55);
  assert.equal(spoofed.layer_num, 7);
  assert.equal(Object.hasOwn(spoofed, '_bb_layer_elapsed_ms'), false);
  assert.equal(Object.hasOwn(spoofed, '_bb_layer_advancing'), false);
});

test('MQTT publishes timing only for observed layer transitions in the current connection', async t => {
  const dir = await temporary(t);
  const dataPath = path.join(dir, 'data.json');
  const connectMqtt = () => {
    const broker = new EventEmitter();
    broker.subscribe = () => {};
    broker.publish = () => {};
    broker.end = () => {};
    return broker;
  };
  const first = connectMqtt();
  const second = connectMqtt();
  const brokers = [first, second];
  const client = createPrinterClient({
    printer: { name: 'Fixture', type: 'H2D', url: 'fixture.invalid', serialNumber: 'FIXTURE', accessCode: 'fixture-only' },
    dataPath, log: () => {}, connectMqtt: () => brokers.shift(),
  });
  t.after(() => client.stop());

  async function report(broker, print, sequence) {
    broker.emit('message', 'device/FIXTURE/report', JSON.stringify({ print, sequence }));
    let snapshot;
    await until(async () => {
      try {
        snapshot = JSON.parse(await fs.readFile(dataPath, 'utf8'));
        return snapshot.sequence === sequence;
      } catch (_) { return false; }
    });
    return snapshot;
  }

  const file = { subtask_name: 'Fixture', gcode_file: '/data/Metadata/plate_1.gcode', total_layer_num: 8 };
  client.connect();
  first.emit('connect');
  const initial = await report(first, { ...file, gcode_state: 'RUNNING', layer_num: 2, stg_cur: 0, ...reading(400, true) }, 1);
  assert.equal(initial.print._bb_layer_elapsed_ms, undefined);
  const active = await report(first, { layer_num: 3 }, 2);
  assert.equal(active.print._bb_layer_elapsed_ms, 0);
  assert.equal(active.print._bb_layer_advancing, true);
  assert.ok(Number.isSafeInteger(active._bb_received_at));
  const paused = await report(first, { gcode_state: 'PAUSE', ...reading(99999, true) }, 3);
  assert.equal(paused.print._bb_layer_advancing, false);
  assert.ok(paused.print._bb_layer_elapsed_ms >= 0 && paused.print._bb_layer_elapsed_ms < 99999);
  assert.notEqual(paused.print._bb_layer_elapsed_ms, 99999);
  assert.equal(paused.print._bb_job_id, active.print._bb_job_id);

  first.emit('close');
  assert.equal(client.telemetryConnection, 'offline');
  client.connect();
  second.emit('connect');
  const recovered = await report(second, { ...file, gcode_state: 'RUNNING', layer_num: 4, stg_cur: 0 }, 4);
  assert.equal(recovered.print._bb_job_id, active.print._bb_job_id);
  assert.equal(recovered.print._bb_layer_elapsed_ms, undefined);
  const next = await report(second, { layer_num: 5, stage: { _id: 0 } }, 5);
  assert.equal(next.print._bb_layer_elapsed_ms, 0);
  assert.equal(next.print._bb_layer_advancing, true);

  const calibration = await report(second, { layer_num: 6, param: '/usr/etc/print/auto_cali_for_user_param.gcode' }, 6);
  assert.equal(calibration.print._bb_layer_elapsed_ms, undefined);
  assert.equal(calibration.print._bb_layer_advancing, undefined);
});
