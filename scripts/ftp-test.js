#!/usr/bin/env node
// Read-only self-test using the same downloader as the widget. Credentials
// stay inside this process; only bounded, redacted diagnostics go to stdout.
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');
const { fetchPlateGcode, describe } = require('../src/services/printerFiles');
(async () => {
  let saved = {}, print = {};
  try { saved = JSON.parse(await fs.readFile(config.CONFIG_PATH, 'utf8')); } catch (_) {}
  try { print = JSON.parse(await fs.readFile(path.join(config.DATA_DIR, 'data.json'), 'utf8')).print || {}; } catch (_) {}
  const printer = { ...saved.printer };
  printer.url = process.env.BAMBUBOARD_PRINTER_URL || printer.url;
  printer.accessCode = process.env.BAMBUBOARD_PRINTER_ACCESS_CODE || printer.accessCode;
  const report = { schema: 1, startedAt: new Date().toISOString(), source: 'self-test', printer: { model: printer.model || printer.type, port: 990 }, state: print.gcode_state || 'unknown', events: [] };
  const redact = value => JSON.stringify(value, (_key, text) => typeof text === 'string'
    ? (printer.accessCode ? text.split(printer.accessCode).join('[REDACTED]') : text).replace(/(?:ftps?|https?):\/\/[^\s]+/gi, '[URL omitted]') : text, 2);
  if (!printer.url || !printer.accessCode || printer.accessCode === 'FILL_THIS_OUT') {
    report.result = 'failed'; report.error = { code: 'PRINTER_NOT_CONFIGURED', detail: 'Configure the printer address and LAN access code in Setup first.' };
    console.log(redact(report)); process.exitCode = 1; return;
  }
  const started = Date.now(), job = describe(print);
  try {
    const data = await fetchPlateGcode({ host: printer.url, accessCode: printer.accessCode, model: printer.model || printer.type, job,
      onEvent: event => { if (report.events.length < 100) report.events.push({ atMs: Date.now() - started, ...event }); } });
    report.result = 'ok'; report.bytes = data.length;
  } catch (error) {
    if (!job.available && error.code === 'FILE_NOT_FOUND') {
      report.result = 'ok'; report.detail = 'FTPS login succeeded; no current print filename is available to test. Run again during a print.';
    } else {
      report.result = 'failed'; report.error = { code: error.code || 'UNKNOWN', stage: error.stage, detail: error.code ? error.message : 'The file check failed. Re-export the sliced file and retry.' };
      process.exitCode = 2;
    }
  }
  report.durationMs = Date.now() - started;
  console.log(redact(report));
})().catch(() => { console.error('The read-only file check could not run. Check BambuBoard data-directory permissions.'); process.exitCode = 1; });
