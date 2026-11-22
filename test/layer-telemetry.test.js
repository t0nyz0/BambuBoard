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

test('late viewers receive a bounded history of previous complete layers at the current speed', () => {
  const { update } = makeClock();
  const observe = (layer, at) => {
    update({ bed_temper: 60 }, at - 25);
    return update({ layer_num: layer }, at)?._bb_layer_pace;
  };
  assert.equal(update({ gcode_state: 'RUNNING', subtask_name: 'Model', layer_num: 10,
    total_layer_num: 30, stg_cur: 0, spd_mag: '100', spd_lvl: '2' }, 0), null);
  assert.deepEqual(observe(11, 400), { speedPercent: 100, layerSpeedStable: true, samples: [] });
  assert.deepEqual(observe(12, 1000), {
    speedPercent: 100, layerSpeedStable: true, samples: [{ layer: 11, durationMs: 600 }],
  });
  for (let layer = 13; layer <= 20; layer++) observe(layer, (layer - 11) * 1000);
  const lateSnapshot = update({ nozzle_temper: 210, mc_percent: 80 }, 9800);
  assert.deepEqual(lateSnapshot._bb_layer_pace, {
    speedPercent: 100, layerSpeedStable: true,
    samples: [14, 15, 16, 17, 18, 19].map(layer => ({ layer, durationMs: 1000 })),
  });
  assert.equal(lateSnapshot._bb_layer_elapsed_ms, 800);
});

test('prep, pauses and non-printing stages never produce a pace sample', () => {
  const { update } = makeClock();
  const samples = (report, at) => {
    if (report.layer_num) update({ bed_temper: 60 }, at - 25);
    return update(report, at)?._bb_layer_pace?.samples;
  };
  assert.equal(update({ gcode_state: 'PREPARE', subtask_name: 'Model', stg_cur: 4, spd_mag: 100 }, 0), null);
  assert.deepEqual(samples({ gcode_state: 'RUNNING', layer_num: 1, stg_cur: 0 }, 100), []);
  assert.deepEqual(samples({ layer_num: 2 }, 600), []);
  const secondLayer = [{ layer: 2, durationMs: 500 }];
  assert.deepEqual(samples({ layer_num: 3 }, 1100), secondLayer);
  assert.deepEqual(samples({ gcode_state: 'PAUSED' }, 1200), secondLayer);
  assert.deepEqual(samples({ gcode_state: 'RUNNING', layer_num: 4 }, 3000), secondLayer);
  assert.deepEqual(samples({ layer_num: 5 }, 3800), secondLayer);
  assert.deepEqual(samples({ stage: { _id: 7 } }, 3900), secondLayer);
  assert.deepEqual(samples({ stg_cur: 0 }, 4900), secondLayer);
  assert.deepEqual(samples({ layer_num: 6 }, 5600), secondLayer);
  assert.deepEqual(samples({ layer_num: 7 }, 6200), [...secondLayer, { layer: 6, durationMs: 600 }]);
});

test('unknown, mismatched and changed speeds invalidate past elapsed for the whole current layer', () => {
  const { update } = makeClock();
  const pace = (report, at) => {
    if (at > 0 && report.layer_num) update({ bed_temper: 60 }, at - 25);
    return update(report, at)?._bb_layer_pace;
  };
  assert.equal(pace({ gcode_state: 'RUNNING', subtask_name: 'Model', layer_num: 5,
    stg_cur: 0, spd_lvl: 2, spd_mag: 100 }, 0), undefined);
  pace({ layer_num: 6 }, 500);
  assert.deepEqual(pace({ layer_num: 7 }, 1500), {
    speedPercent: 100, layerSpeedStable: true, samples: [{ layer: 6, durationMs: 1000 }],
  });
  assert.equal(pace({ spd_lvl: '3' }, 1700), undefined);
  assert.equal(pace({ nozzle_temper: 218, spd_lvl: 3 }, 1750), undefined);
  assert.deepEqual(pace({ spd_mag: '124' }, 1800), { speedPercent: 124, layerSpeedStable: false, samples: [] });
  assert.deepEqual(pace({ bed_temper: 45 }, 1900), { speedPercent: 124, layerSpeedStable: false, samples: [] });
  assert.deepEqual(pace({ layer_num: 8 }, 2700), { speedPercent: 124, layerSpeedStable: true, samples: [] });
  assert.deepEqual(pace({ layer_num: 9 }, 3000), {
    speedPercent: 124, layerSpeedStable: true, samples: [{ layer: 8, durationMs: 300 }],
  });
  assert.deepEqual(pace({ spd_mag: 166 }, 3500), { speedPercent: 166, layerSpeedStable: false, samples: [] });
  assert.equal(pace({ spd_mag: -1 }, 3600), undefined);
  assert.equal(pace({ spd_mag: true }, 3700), undefined);
});

test('late-viewer pace history never crosses a jump, regression, long gap, job or connection change', () => {
  for (const interruption of [
    { report: { layer_num: 14 }, at: 2000 },
    { report: { layer_num: 8 }, at: 2000 },
    { report: { layer_num: 12.5 }, at: 2000 },
    { report: { bed_temper: 60 }, at: 63_000 },
    { report: { subtask_name: 'Next', gcode_state: 'RUNNING', layer_num: 13 }, at: 2000 },
    { report: { gcode_state: 'FINISH' }, at: 2000 },
    { report: { layer_num: 13 }, at: 700 },
    { report: { layer_num: 13 }, at: 2000, reconnect: true },
  ]) {
    const { update, reset } = makeClock();
    update({ gcode_state: 'RUNNING', subtask_name: 'Model', layer_num: 10, stg_cur: 0, spd_mag: 100 }, 0);
    update({ bed_temper: 60 }, 475);
    update({ layer_num: 11 }, 500);
    update({ bed_temper: 60 }, 975);
    const prior = update({ layer_num: 12 }, 1000);
    assert.equal(prior._bb_layer_pace.samples.length, 1);
    if (interruption.reconnect) reset();
    const interrupted = update(interruption.report, interruption.at);
    assert.equal(interrupted?._bb_layer_pace, undefined, JSON.stringify(interruption));
    const recovered = update({ spd_mag: 100, stg_cur: 0 }, interruption.at + 100);
    assert.equal(recovered?._bb_layer_pace?.samples.length ?? 0, 0, JSON.stringify(interruption));
  }
});

test('delayed layer boundaries and ambiguous stage packets cannot teach a pace', () => {
  const { update } = makeClock();
  const observe = (layer, at) => update({ layer_num: layer }, at)?._bb_layer_pace;
  update({ gcode_state: 'RUNNING', subtask_name: 'Model', layer_num: 10, stg_cur: 0, spd_mag: 100 }, 0);
  update({ nozzle_temper: 215 }, 500);
  observe(11, 1000);
  update({ nozzle_temper: 215 }, 1900);
  const lateBoundary = observe(12, 2000);
  assert.equal(lateBoundary.layerSpeedStable, true);
  assert.deepEqual(lateBoundary.samples, [], 'These fresh boundary packets bracket too much uncertainty');
  update({ nozzle_temper: 215 }, 3900);
  const subsequent = observe(13, 4000);
  assert.deepEqual(subsequent.samples, [{ layer: 12, durationMs: 2000 }]);
  const shortGap = update({ nozzle_temper: 215 }, 9100);
  assert.equal(shortGap._bb_layer_elapsed_ms, 5100, 'Only pace learning uses the stricter packet gap');
  assert.deepEqual(shortGap._bb_layer_pace, { speedPercent: 100, layerSpeedStable: false, samples: [] });
  observe(14, 9200);
  update({ stg_cur: 0, stage: { _id: 7 } }, 9500);
  update({ nozzle_temper: 215 }, 9800);
  assert.deepEqual(observe(15, 9900).samples, []);
  update({ stage: { _id: 0 } }, 10200);
  update({ nozzle_temper: 215 }, 10800);
  observe(16, 10900);
  update({ nozzle_temper: 215 }, 11800);
  assert.deepEqual(observe(17, 11900).samples, [{ layer: 16, durationMs: 1000 }]);
  assert.deepEqual(update({ total_layer_num: 40 }, 12100)._bb_layer_pace, {
    speedPercent: 100, layerSpeedStable: false, samples: [],
  });
});

test('printer deltas and old snapshots cannot inject reserved layer timing fields', () => {
  const previous = mergePrint({}, { gcode_state: 'RUNNING', layer_num: 7 });
  const fakePace = { speedPercent: 60, layerSpeedStable: true, samples: [{ layer: 6, durationMs: 3 }] };
  const spoofed = mergePrint({ ...previous, ...reading(800, true), _bb_layer_pace: fakePace }, {
    bed_temper: 55, _bb_layer_elapsed_ms: 1500, _bb_layer_advancing: true, _bb_layer_pace: fakePace,
  });
  assert.equal(spoofed.bed_temper, 55);
  assert.equal(spoofed.layer_num, 7);
  assert.equal(Object.hasOwn(spoofed, '_bb_layer_elapsed_ms'), false);
  assert.equal(Object.hasOwn(spoofed, '_bb_layer_advancing'), false);
  assert.equal(Object.hasOwn(spoofed, '_bb_layer_pace'), false);
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
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const client = createPrinterClient({
    printer: { name: 'Fixture', type: 'H2D', url: 'fixture.invalid', serialNumber: 'FIXTURE', accessCode: 'fixture-only' },
    dataPath, log: () => {}, connectMqtt: () => brokers.shift(),
  });
  t.after(() => client.stop());

  async function report(broker, print, sequence, at = sequence * 1000) {
    clock = at;
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
  const initial = await report(first, { ...file, gcode_state: 'RUNNING', layer_num: 2, stg_cur: 0,
    spd_mag: 100, ...reading(400, true), _bb_layer_pace: { speedPercent: 10, samples: [] } }, 1);
  assert.equal(initial.print._bb_layer_elapsed_ms, undefined);
  assert.equal(initial.print._bb_layer_pace, undefined);
  await report(first, { nozzle_temper: 215 }, 2, 1950);
  const active = await report(first, { layer_num: 3 }, 3, 2000);
  assert.equal(active.print._bb_layer_elapsed_ms, 0);
  assert.equal(active.print._bb_layer_advancing, true);
  assert.ok(Number.isSafeInteger(active._bb_received_at));
  await report(first, { nozzle_temper: 215 }, 4, 2950);
  const adjacent = await report(first, { layer_num: 4 }, 5, 3000);
  const snapshotPace = adjacent.print._bb_layer_pace;
  assert.equal(snapshotPace.speedPercent, 100);
  assert.equal(snapshotPace.layerSpeedStable, true);
  assert.equal(snapshotPace.samples.length, 1);
  assert.equal(snapshotPace.samples[0].layer, 3);
  assert.equal(snapshotPace.samples[0].durationMs, 1000);
  const paused = await report(first, { gcode_state: 'PAUSE', ...reading(99999, true) }, 6);
  assert.equal(paused.print._bb_layer_advancing, false);
  assert.ok(paused.print._bb_layer_elapsed_ms >= 0 && paused.print._bb_layer_elapsed_ms < 99999);
  assert.notEqual(paused.print._bb_layer_elapsed_ms, 99999);
  assert.equal(paused.print._bb_job_id, active.print._bb_job_id);
  assert.deepEqual(paused.print._bb_layer_pace, snapshotPace);

  first.emit('close');
  assert.equal(client.telemetryConnection, 'offline');
  client.connect();
  second.emit('connect');
  const recovered = await report(second, { ...file, gcode_state: 'RUNNING', layer_num: 4, stg_cur: 0, spd_mag: 100 }, 7);
  assert.equal(recovered.print._bb_job_id, active.print._bb_job_id);
  assert.equal(recovered.print._bb_layer_elapsed_ms, undefined);
  assert.equal(recovered.print._bb_layer_pace, undefined);
  const next = await report(second, { layer_num: 5, stage: { _id: 0 } }, 8);
  assert.equal(next.print._bb_layer_elapsed_ms, 0);
  assert.equal(next.print._bb_layer_advancing, true);
  assert.deepEqual(next.print._bb_layer_pace, { speedPercent: 100, layerSpeedStable: true, samples: [] });

  const calibration = await report(second, { layer_num: 6, param: '/usr/etc/print/auto_cali_for_user_param.gcode' }, 9);
  assert.equal(calibration.print._bb_layer_elapsed_ms, undefined);
  assert.equal(calibration.print._bb_layer_advancing, undefined);
  assert.equal(calibration.print._bb_layer_pace, undefined);
});
