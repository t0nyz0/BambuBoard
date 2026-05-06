const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const { capsFor, printerTypeFromMqtt } = require('./lib/caps');

const PUSHALL_INTERVAL_MS = 5 * 60 * 1000;

function nowLocal() { return new Date().toLocaleString(); }

// Auto-update data/note.json with the current model name when it changes,
// unless the user has manually overridden it (note has { manual: true }).
let lastNoteModel = null;
function autoUpdateNote(printObj) {
  try {
    const ROOT = path.resolve(__dirname, '..');
    const notePath = path.join(ROOT, 'data', 'note.json');
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

function createPrinterClient({ printer, dataPath, log, onPrinterDetected }) {
  let client = null;
  let sequenceID = 20000;
  let lastPushallTime = 0;
  let status = 'offline';
  let lastUpdate = null;
  // Auto-detected from the MQTT `get_version` response. Stays null until the
  // printer publishes a module list. Exposed via state so /api/status can
  // surface { detectedFrom: 'mqtt'|'config', model: '<friendly name>' }.
  let detectedType = null;
  let detectedModel = null;

  const state = {
    get status() { return status; },
    get lastUpdate() { return lastUpdate; },
    get detectedType() { return detectedType; },
    get detectedModel() { return detectedModel; },
    stop() {
      if (client) {
        try { client.removeAllListeners(); client.end(true); } catch (_) {}
        client = null;
      }
      status = 'offline';
      detectedType = null;
      detectedModel = null;
    },
  };

  function connect() {
    state.stop();
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

    client = mqtt.connect(url, {
      clientId,
      clean: true,
      connectTimeout: 5000,
      username: 'bblp',
      password: printer.accessCode,
      reconnectPeriod: 0,
      rejectUnauthorized: false,
    });

    client.on('connect', () => {
      log(`Connected. Subscribing to ${topic}`);
      status = 'online';
      sequenceID++;
      client.subscribe(topic, () => {});
      // Pushall = full state snapshot (print/ams/temps/etc).
      client.publish(topicRequest, JSON.stringify({
        pushing: { sequence_id: sequenceID, command: 'pushall' },
        user_id: '9586569',
      }));
      // get_version = module list with hw/sw versions and product_name.
      // We use the response to auto-identify the printer model (matches
      // ha-bambulab's behavior). Sent right after pushall so both arrive
      // together; the printer responds with a separate `info` message.
      sequenceID++;
      client.publish(topicRequest, JSON.stringify({
        info: { sequence_id: String(sequenceID), command: 'get_version' },
      }));
    });

    client.on('message', (_topic, message) => {
      try {
        const json = JSON.parse(message.toString());
        const dataToWrite = JSON.stringify(json);
        lastUpdate = json.t_utc && !isNaN(json.t_utc)
          ? new Date(json.t_utc).toLocaleString()
          : nowLocal();

        // Handle `info` responses (get_version returns the module array).
        // Module list contains AP/OTA/ESP32 nodes with product_name + hw_ver,
        // which `printerTypeFromMqtt` uses to identify the printer.
        if (json.info && json.info.command === 'get_version') {
          const modules = Array.isArray(json.info.module) ? json.info.module : [];
          const detected = printerTypeFromMqtt(modules);
          if (detected) {
            const changed = detected.type !== detectedType;
            detectedType = detected.type;
            detectedModel = detected.model;
            if (changed) {
              log(`Auto-detected printer: ${detected.model} (${detected.type})`);
              if (typeof onPrinterDetected === 'function') {
                try { onPrinterDetected(detected); } catch (e) { log(`onPrinterDetected error: ${e.message}`); }
              }
            }
          }
        }

        if (json.print) {
          fs.writeFile(dataPath, dataToWrite, (err) => {
            if (err) log(`Error writing data.json: ${err.message}`);
          });
          autoUpdateNote(json.print);
        } else {
          // Type-aware pushall cadence
          const caps = capsFor(printer.type);
          const continuousPushall = ['X1', 'X1C'].includes(printer.type);
          const now = Date.now();
          if (continuousPushall || (now - lastPushallTime >= PUSHALL_INTERVAL_MS)) {
            client.publish(topicRequest, JSON.stringify({
              pushing: { sequence_id: sequenceID, command: 'pushall' },
              user_id: '9586569',
            }));
            lastPushallTime = now;
          }
        }
      } catch (err) {
        log(`Parse error: ${err.message}`);
      }
    });

    let reconnecting = false;
    const onDrop = (label) => async (err) => {
      log(`MQTT ${label}${err ? ': ' + err.message : ''}. Reconnecting in 3s...`);
      status = 'offline';
      if (reconnecting) return;
      reconnecting = true;
      setTimeout(() => { reconnecting = false; connect(); }, 3000);
    };
    client.on('error', onDrop('error'));
    client.on('close', onDrop('close'));
    client.on('disconnect', onDrop('disconnect'));
    client.on('offline', onDrop('offline'));
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
    const timer = setTimeout(() => finish({ ok: false, error: 'Connection timed out' }), timeoutMs + 500);
    c.on('connect', () => { clearTimeout(timer); finish({ ok: true }); });
    c.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message }); });
  });
}

module.exports = { createPrinterClient, testConnection };
