const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const { printerTypeFromMqtt } = require('./lib/caps');
const { mergePrint, reconnectJob, reuseJobId, createLayerClock } = require('./lib/printTelemetry');
const { publicTelemetry } = require('./lib/cameraTelemetry');
const { describe: describeGcodeJob } = require('../public/js/gcode-job');
const { isStale } = require('../public/widgets/_telemetry');

const PUSHALL_INTERVAL_MS = 5 * 60 * 1000;
const JOB_RECOVERY_GRACE_MS = 10_000;

function nowLocal() { return new Date().toLocaleString(); }

// Auto-update data/note.json with the current model name when it changes,
// unless the user has manually overridden it (note has { manual: true }).
let lastNoteModel = null;
function autoUpdateNote(printObj, dataPath) {
  try {
    const notePath = path.join(path.dirname(dataPath), 'note.json');
    const candidate = (printObj.subtask_name || printObj.task_name || printObj.gcode_file || '').toString().trim();
    if (!candidate || candidate === lastNoteModel) return;
    let current = {};
    try { current = JSON.parse(fs.readFileSync(notePath, 'utf-8')); } catch (_) {}
    if (current && current.manual) return; // user override; don't touch
    const next = { text: candidate.replace(/\.(3mf|gcode\.3mf|gcode)$/i, ''), manual: false, updatedAt: Date.now() };
    fs.writeFile(notePath, JSON.stringify(next), () => {});
    lastNoteModel = candidate;
  } catch (_) {}
}

function createPrinterClient({ printer, dataPath, log, onPrinterDetected, connectMqtt = mqtt.connect }) {
  let client = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let sequenceID = 20000;
  let status = 'offline';
  let publishedTelemetry = null;
  let lastUpdate = null;
  let printSnapshot = {};
  const layerClock = createLayerClock();
  let previousJobSnapshot = null;
  let cameraTelemetry;
  let writeQueue = Promise.resolve();
  // Auto-detected from the MQTT `get_version` response. Stays null until the
  // printer publishes a module list. Exposed via state so /api/status can
  // surface { detectedFrom: 'mqtt'|'config', model: '<friendly name>' }.
  let detectedType = null;
  let detectedModel = null;

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(refreshTimer);
    refreshTimer = null;
    const retiringClient = client;
    client = null;
    // Leave MQTT.js's cleanup and error handlers in place. Our handlers
    // ignore events from a client once it is no longer current.
    try { retiringClient?.end(true); } catch (_) {}
    status = 'offline';
    publishedTelemetry = null;
    if (!previousJobSnapshot && !['IDLE', 'FAILED'].includes(printSnapshot.gcode_state)) {
      const job = describeGcodeJob(printSnapshot);
      if (job.available || job.calibration) previousJobSnapshot = printSnapshot;
    }
    printSnapshot = {};
    layerClock.reset();
  }

  const state = {
    get status() { return status; },
    get telemetryConnection() {
      if (status !== 'online') return status;
      return publishedTelemetry && !isStale(publishedTelemetry, Date.now()) ? 'online' : 'waiting';
    },
    get lastUpdate() { return lastUpdate; },
    get lastTelemetryUpdate() { return publishedTelemetry ? new Date(publishedTelemetry._bb_received_at).toLocaleString() : null; },
    get detectedType() { return detectedType; },
    get detectedModel() { return detectedModel; },
    get cameraTelemetry() { return cameraTelemetry; },
    stop() {
      disconnect();
      detectedType = null;
      detectedModel = null;
      cameraTelemetry = undefined;
      previousJobSnapshot = null;
    },
  };

  function connect() {
    disconnect();
    if (!printer.url || !printer.serialNumber || !printer.accessCode
        || printer.serialNumber === 'FILL_THIS_OUT'
        || printer.accessCode === 'FILL_THIS_OUT') {
      log(`MQTT skipped: printer not fully configured.`);
      return;
    }

    const clientId = `bambuboard_${Math.random().toString(16).slice(2)}`;
    const url = `mqtts://${printer.url}:${printer.port || 8883}`;
    const topic = `device/${printer.serialNumber}/report`;
    const topicRequest = `device/${printer.serialNumber}/request`;

    log(`Connecting to ${printer.name || printer.type} at ${url}`);

    const connection = connectMqtt(url, {
      clientId,
      clean: true,
      connectTimeout: 5000,
      username: 'bblp',
      password: printer.accessCode,
      reconnectPeriod: 0,
      rejectUnauthorized: false,
    });
    client = connection;
    let jobRecoveryUntil = 0;

    function requestFullState() {
      if (client !== connection || status !== 'online') return;
      connection.publish(topicRequest, JSON.stringify({
        pushing: { sequence_id: ++sequenceID, command: 'pushall' },
        user_id: '9586569',
      }));
    }

    connection.on('connect', () => {
      if (client !== connection) return;
      log(`Connected. Subscribing to ${topic}`);
      status = 'online';
      jobRecoveryUntil = Date.now() + JOB_RECOVERY_GRACE_MS;
      connection.subscribe(topic, () => {});
      requestFullState();
      clearInterval(refreshTimer);
      // A quiet printer may send no events, including no status deltas that
      // could trigger a refresh. Keep polling while this connection is live.
      refreshTimer = setInterval(requestFullState, PUSHALL_INTERVAL_MS);
      refreshTimer.unref();
      // get_version = module list with hw/sw versions and product_name.
      // We use the response to auto-identify the printer model (matches
      // ha-bambulab's behavior). Sent right after pushall so both arrive
      // together; the printer responds with a separate `info` message.
      sequenceID++;
      connection.publish(topicRequest, JSON.stringify({
        info: { sequence_id: String(sequenceID), command: 'get_version' },
      }));
    });

    connection.on('message', (reportedTopic, message) => {
      if (client !== connection || status !== 'online' || reportedTopic !== topic) return;
      try {
        const json = JSON.parse(message.toString());
        lastUpdate = json.t_utc && !isNaN(json.t_utc)
          ? new Date(json.t_utc).toLocaleString()
          : nowLocal();

        // Handle `info` responses (get_version returns the module array).
        // Module list contains AP/OTA/ESP32 nodes with product_name + hw_ver,
        // which `printerTypeFromMqtt` uses to identify the printer.
        if (json.info && json.info.command === 'get_version') {
          const modules = Array.isArray(json.info.module) ? json.info.module : [];
          const detected = printerTypeFromMqtt(modules, detectedType || printer.type);
          if (detected) {
            const changed = detected.type !== detectedType || detected.model !== detectedModel;
            detectedType = detected.type;
            detectedModel = detected.model;
            if (changed) {
              log(`Auto-detected printer: ${detected.model} (${detected.type})`);
              if (typeof onPrinterDetected === 'function') {
                Promise.resolve().then(() => onPrinterDetected(detected)).catch(e => {
                  console.warn(`[bambuboard] Could not save detected printer settings (${e?.code || 'error'}).`);
                });
              }
            }
          }
        }

        if (json.print) {
          const receivedAt = Date.now();
          const layerSampleAt = performance.now();
          // MQTT reports are deltas. Preserve job metadata through temperature,
          // layer and AMS updates, and publish complete snapshots atomically.
          const { _bb_job_id: previousJob, gcode_state: previousState } = printSnapshot;
          printSnapshot = mergePrint(printSnapshot, json.print);
          if (Object.hasOwn(json.print, 'ipcam')) {
            const reportedCamera = json.print.ipcam;
            cameraTelemetry = reportedCamera && typeof reportedCamera === 'object'
              ? { ...cameraTelemetry, ...reportedCamera } : reportedCamera;
          }
          // Collect reports from this connection only. Leave the last saved
          // snapshot in place until this session has supplied a print state.
          if (typeof printSnapshot.gcode_state !== 'string' || !printSnapshot.gcode_state.trim()) return;
          let jobPending = false;
          if (previousJobSnapshot) {
            const recovery = reconnectJob(previousJobSnapshot, printSnapshot, Date.now() < jobRecoveryUntil);
            jobPending = recovery === 'waiting';
            if (recovery === 'same') printSnapshot = reuseJobId(printSnapshot, previousJobSnapshot._bb_job_id);
            if (!jobPending) previousJobSnapshot = null;
          }
          const job = describeGcodeJob(printSnapshot);
          if ((!previousState || previousJob !== printSnapshot._bb_job_id)
              && (jobPending || (!job.available && !job.calibration
                && ['RUNNING', 'PREPARE', 'SLICING'].includes(printSnapshot.gcode_state)))) {
            // A new job's first packet may contain only its state/ID. Request
            // a read-only full snapshot once, rather than waiting five minutes.
            requestFullState();
          }
          let print = printSnapshot;
          if (jobPending) print = { ...print, _bb_job_pending: true };
          if (job.available && !job.calibration && !jobPending) {
            const timing = layerClock.observe(printSnapshot, json.print, layerSampleAt);
            if (timing) print = { ...print, ...timing };
          } else {
            layerClock.reset();
          }
          const snapshot = JSON.stringify(publicTelemetry({ ...json, print, _bb_received_at: receivedAt }));
          writeQueue = writeQueue.then(async () => {
            if (client !== connection || status !== 'online') return;
            const temp = `${dataPath}.${clientId}.tmp`;
            let committed = false;
            try {
              await fs.promises.writeFile(temp, snapshot);
              if (client !== connection || status !== 'online') return;
              await fs.promises.rename(temp, dataPath);
              committed = true;
              if (client === connection && status === 'online') {
                publishedTelemetry = { _bb_received_at: receivedAt, print: { gcode_state: print.gcode_state } };
              }
            } finally {
              if (!committed) await fs.promises.rm(temp, { force: true });
            }
          }).catch(err => log(`Error writing data.json: ${err.code || 'unknown'}`));
          if (!jobPending && !job.calibration) autoUpdateNote(printSnapshot, dataPath);
        } else if (['X1', 'X1C'].includes(detectedType || printer.type)) requestFullState();
      } catch (err) {
        log(`Parse error: ${err.message}`);
      }
    });

    const onDrop = (label) => async (err) => {
      if (connection !== client) return;
      log(`MQTT ${label}${err ? ': ' + err.message : ''}. Reconnecting in 3s...`);
      status = 'offline';
      publishedTelemetry = null;
      layerClock.reset();
      clearInterval(refreshTimer);
      refreshTimer = null;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; if (connection === client) connect(); }, 3000);
    };
    connection.on('error', onDrop('error'));
    connection.on('close', onDrop('close'));
    connection.on('disconnect', onDrop('disconnect'));
    connection.on('offline', onDrop('offline'));
  }

  state.connect = connect;
  return state;
}

function testConnection({ url, port, serialNumber, accessCode }, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!url || !serialNumber || !accessCode) {
      return resolve({ ok: false, error: 'Missing url, serialNumber or accessCode' });
    }
    let done = false;
    const finish = (result) => { if (!done) { done = true; try { c.end(true); } catch (_) {} resolve(result); } };
    const c = mqtt.connect(`mqtts://${url}:${port || 8883}`, {
      clientId: `bambuboard_test_${Math.random().toString(16).slice(2)}`,
      clean: true,
      connectTimeout: timeoutMs,
      username: 'bblp',
      password: accessCode,
      reconnectPeriod: 0,
      rejectUnauthorized: false,
    });
    const unreachable = { ok: false, code: 'UNREACHABLE', error: 'Could not reach the printer.' };
    const timer = setTimeout(() => finish(unreachable), timeoutMs + 500);
    c.on('connect', () => { clearTimeout(timer); finish({ ok: true }); });
    c.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 4 || err.code === 5) {
        finish({ ok: false, code: 'AUTHENTICATION', error: 'The printer rejected the LAN access code.' });
      } else {
        finish(unreachable);
      }
    });
  });
}

module.exports = { createPrinterClient, testConnection };
