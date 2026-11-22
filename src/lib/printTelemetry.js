const { randomUUID } = require('node:crypto');
const { confirmsBareCalibration, describe, hasDifferentPrintFile, id } = require('../../public/js/gcode-job');
const { AMS_3H_ID, number, loaded } = require('../../public/widgets/_amsActive');

const LAYER_REPORT_GAP_MS = 60_000;
const PACE_REPORT_GAP_MS = 5_000;
const PACE_BOUNDARY_UNCERTAINTY = 0.25;
const PACE_HISTORY_LAYERS = 6;
const LAYER_TIMING_FIELDS = ['_bb_layer_elapsed_ms', '_bb_layer_advancing', '_bb_layer_pace'];
const ACTIVE_LAYER_STATES = new Set(['RUNNING', 'PAUSE', 'PAUSED']);
const PREPARING_STATES = new Set(['PREPARE', 'SLICING']);
const JOB_FIELDS = ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'param', 'url', 'print_type', 'plate_idx', 'plate_id', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time', 'mapping'];
function mergeObjects(previous, delta) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(delta)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const indexField = key === 'zone_info' ? 'zone_id' : 'id';
    if (Array.isArray(value) && value.length && value.every(item => item && typeof item === 'object' && item[indexField] != null)) {
      // Partial AMS reports merge independent units, trays and drying zones.
      const entries = new Map((Array.isArray(previous?.[key]) ? previous[key] : [])
        .filter(item => item?.[indexField] != null).map(item => [String(item[indexField]), item]));
      for (const item of value) {
        const index = String(item[indexField]);
        const slot = number(item.id);
        const h3cTray = key === 'tray' && number(delta.id ?? previous?.id) === AMS_3H_ID;
        const h3cVirtual = key === 'vir_slot' && slot >= 247 && slot <= 253;
        // Empty spool reports clear cached metadata so subsequent deltas
        // cannot bring the old material/color back under a new spool.
        const state = number(item.state);
        const clear = (h3cTray || h3cVirtual) && ((Number.isInteger(state) && state >= 0 && !loaded(item))
          || Object.keys(item).every(field => field === 'id'));
        entries.set(index, mergeObjects(clear ? {} : (entries.get(index) || {}), item));
      }
      result[key] = [...entries.values()].sort((a, b) => String(a[indexField]).localeCompare(String(b[indexField]), undefined, { numeric: true }));
      continue;
    }
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeObjects(previous?.[key] && typeof previous[key] === 'object' ? previous[key] : {}, value)
      : value;
  }
  return result;
}
function startsNewJob(previous, delta) {
  const active = ['RUNNING', 'PREPARE', 'SLICING'].includes(delta.gcode_state || previous.gcode_state);
  return active && (['FINISH', 'FAILED', 'IDLE'].includes(previous.gcode_state)
    || (Number(previous.mc_percent) >= 90 && delta.mc_percent != null && Number(delta.mc_percent) < 50));
}

function reuseJobId(print, generation) {
  const rebound = { ...print, _bb_job_id: generation };
  if (describe(print).bareCalibration) rebound._bb_system_calibration_job = generation;
  else delete rebound._bb_system_calibration_job;
  return rebound;
}

function reconnectJob(previous, current, waitingForIdentity) {
  if (['IDLE', 'FAILED'].includes(current.gcode_state) || startsNewJob(previous, current)) return 'different';
  const before = describe(previous);
  const after = describe(reuseJobId(current, previous._bb_job_id));
  if ((after.available || after.calibration) && before.calibration === after.calibration && before.key === after.key) return 'same';
  // This reserved path is conclusive even when an MQTT reconnect supplies it
  // in a different field or arrives before the rest of the identity.
  if (after.calibration) return before.calibration ? 'same' : 'different';
  if (before.calibration && after.available) return 'different';
  const conflict = ['task_id', 'subtask_id'].some(key => id(previous[key]) && id(current[key]) && id(previous[key]) !== id(current[key]))
    || ['name', 'file', 'param', 'url'].some(key => before[key] && after[key] && before[key] !== after[key])
    || (before.plateKnown && after.plateKnown && before.plate !== after.plate);
  // First reports can contain only a generic plate path or a subset of the
  // job metadata. A conflicting report or a usable locator after the grace
  // period is handled normally, even if the firmware never sends every field.
  return conflict || (after.available && !waitingForIdentity) ? 'different' : 'waiting';
}

function mergePrint(previous = {}, delta = {}) {
  const report = { ...delta };
  // A printer cannot publish locally inferred calibration or timing.
  delete report._bb_system_calibration_job;
  for (const key of LAYER_TIMING_FIELDS) delete report[key];
  const newLifecycle = startsNewJob(previous, report);
  const before = describe(previous);
  const next = describe(report);
  // Only a coherent report can establish the bare system identity. In
  // particular, a type-only report can arrive late from the preceding job.
  const confirmedBare = confirmsBareCalibration(report);
  const nextCalibration = next.calibration || confirmedBare;
  const calibrationChanged = before.calibration ? !nextCalibration && hasDifferentPrintFile(report, [before.file, before.param, before.url]) : nextCalibration;
  const bareRevoked = before.bareCalibration && ['print_type', 'subtask_name', 'gcode_file'].some(key =>
    Object.hasOwn(report, key) && report[key] !== previous[key]);
  const changed = calibrationChanged || bareRevoked || ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'url'].some(key =>
    Object.hasOwn(report, key) && id(previous[key]) && id(report[key]) && id(previous[key]) !== id(report[key]));
  const base = { ...previous };
  if (newLifecycle || changed) for (const key of JOB_FIELDS) delete base[key];
  const merged = mergeObjects(base, report);
  // Printer-supplied fields cannot override our locally generated lifecycle ID.
  merged._bb_job_id = newLifecycle || changed || !previous._bb_job_id ? randomUUID() : previous._bb_job_id;
  delete merged._bb_system_calibration_job;
  if ((confirmedBare || (!newLifecycle && !changed && before.bareCalibration)) && confirmsBareCalibration(merged)) {
    merged._bb_system_calibration_job = merged._bb_job_id;
  }
  delete merged._bb_job_pending;
  for (const key of LAYER_TIMING_FIELDS) delete merged[key];
  return merged;
}

// Measure how long an observed layer has been printing in this MQTT
// session. Job-wide progress and the time a browser opens are not clocks
// for a layer. Unknown, skipped and previously seen layers have no anchor.
function createLayerClock() {
  let previous = null;
  let paceSamples = [];

  function reset() {
    previous = null;
    paceSamples = [];
  }

  function observe(print, delta, at) {
    const job = print._bb_job_id;
    const state = print.gcode_state;
    const preparing = PREPARING_STATES.has(state);
    if (!job || (!preparing && !ACTIVE_LAYER_STATES.has(state))) {
      reset();
      return null;
    }
    const reported = preparing ? 0 : number(print.layer_num);
    const total = number(print.total_layer_num);
    const layer = Number.isSafeInteger(reported) && reported >= 0 && (!(total > 0) || reported <= total) ? reported : null;
    const gap = at - previous?.at;
    const recent = previous?.job === job && gap >= 0 && gap <= LAYER_REPORT_GAP_MS;
    let stage = recent ? previous.stage : null;
    // New firmware can report stage._id instead of stg_cur. Use the
    // newest packet carrying a stage so an older retained shape cannot win.
    const hasFlatStage = Object.hasOwn(delta, 'stg_cur');
    const hasNestedStage = delta.stage && Object.hasOwn(delta.stage, '_id');
    if (hasFlatStage) stage = number(delta.stg_cur);
    else if (hasNestedStage) stage = number(delta.stage._id);
    const stageAgrees = hasFlatStage || hasNestedStage
      ? !(hasFlatStage && hasNestedStage && stage !== number(delta.stage._id))
      : recent && previous.stageAgrees;

    const advancing = state === 'RUNNING' && layer > 0 && stage === 0;
    const paceAdvancing = advancing && stageAgrees;
    const sameLayer = recent && layer !== null && layer === previous.layer;
    const nextLayer = recent && layer > 0 && previous.layer !== null &&
      layer === previous.layer + 1 && layer > previous.highest;
    const continuous = sameLayer || nextLayer;
    let elapsed = null;
    if (sameLayer && previous.elapsed !== null) {
      elapsed = previous.elapsed + (previous.advancing ? gap : 0);
    } else if (nextLayer) {
      elapsed = 0;
    }

    // spd_mag is the reported speed percentage. A mode-only change can
    // precede its matching percentage, so do not use the retained magnitude.
    const speedMode = Object.hasOwn(delta, 'spd_lvl') ? number(delta.spd_lvl) :
      continuous ? previous.speedMode : null;
    const modeChanged = continuous && speedMode !== previous.speedMode;
    let speedPercent = continuous && !modeChanged ? previous.speedPercent : null;
    if (Object.hasOwn(delta, 'spd_mag')) {
      const reportedSpeed = number(delta.spd_mag);
      speedPercent = Number.isSafeInteger(reportedSpeed) && reportedSpeed > 0 ? reportedSpeed : null;
    }
    const sameSpeed = continuous && !modeChanged && speedPercent !== null && speedPercent === previous.speedPercent;
    const paceTotal = Number.isSafeInteger(total) && total > 0 ? total : null;
    const paceContinuous = sameSpeed && paceTotal === previous.paceTotal && gap <= PACE_REPORT_GAP_MS;
    const boundary = nextLayer && Object.hasOwn(delta, 'layer_num');
    const layerSpeedStable = paceContinuous && (boundary || (sameLayer && previous.layerSpeedStable));
    let paceStart = null;
    if (!paceContinuous || preparing) paceSamples = [];
    if (paceContinuous && paceAdvancing && previous.paceAdvancing) {
      if (sameLayer) {
        paceStart = previous.paceStart;
      } else if (boundary) {
        paceStart = { at, gap };
        const start = previous.paceStart;
        if (start) {
          const durationMs = Math.round(at - start.at);
          // The actual transition could have occurred between the last
          // report of the old layer and the first report of the new one.
          const uncertainty = start.gap + gap;
          if (durationMs > 0 && uncertainty <= durationMs * PACE_BOUNDARY_UNCERTAINTY) {
            paceSamples = [...paceSamples, { layer: previous.layer, durationMs }];
          }
        }
      }
    }
    if (paceSamples[0]?.layer < layer - PACE_HISTORY_LAYERS) {
      paceSamples = paceSamples.filter(sample => sample.layer >= layer - PACE_HISTORY_LAYERS);
    }

    previous = {
      job, layer, stage, stageAgrees, at, advancing, paceAdvancing, elapsed,
      speedMode, speedPercent, layerSpeedStable, paceStart, paceTotal,
      highest: Math.max(layer ?? 0, recent ? previous.highest : 0),
    };
    if (elapsed === null) return null;
    const timing = {
      _bb_layer_elapsed_ms: Math.round(elapsed),
      _bb_layer_advancing: advancing,
    };
    if (speedPercent !== null) timing._bb_layer_pace = { speedPercent, layerSpeedStable, samples: paceSamples };
    return timing;
  }

  return { observe, reset };
}

module.exports = { mergePrint, reconnectJob, reuseJobId, createLayerClock };
