const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fetchPlateGcode, extractPlateGcode, GcodeError, LIMITS, describe } = require('../services/printerFiles');

function buildGcodeRouter({ getConfig, paths, fetchGcode = fetchPlateGcode, log = message => console.warn(message), now = Date.now }) {
  const router = express.Router();
  const cacheDir = path.join(paths.data, 'gcode-cache');
  const diagnosticPath = path.join(paths.data, 'gcode-diagnostics.json');
  const failures = new Map();
  let active = null, latest = null, diagnosticQueue = Promise.resolve();
  let previous = null, legacyGeneration = randomUUID();

  function redact(value) {
    const secret = String(getConfig().printer?.accessCode || '');
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'string'
      ? (secret ? v.split(secret).join('[REDACTED]') : v).replace(/(?:ftps?|https?):\/\/[^\s]+/gi, '[URL omitted]').slice(0, 1500) : v));
  }
  function record(report) {
    latest = redact(report);
    const serialized = JSON.stringify(latest, null, 2);
    diagnosticQueue = diagnosticQueue.then(async () => {
      await fs.mkdir(paths.data, { recursive: true });
      await fs.writeFile(diagnosticPath + '.tmp', serialized, { mode: 0o600 });
      await fs.rename(diagnosticPath + '.tmp', diagnosticPath);
    }).catch(err => log(`[gcode] diagnostic write failed (${err.code || 'unknown'})`));
    if (latest.error && latest.error.code !== 'JOB_CHANGED') log(`[gcode] ${JSON.stringify(latest)}`);
  }
  async function context(req) {
    let print;
    try { print = JSON.parse(await fs.readFile(path.join(paths.data, 'data.json'), 'utf8')).print || {}; }
    catch (_) { throw new GcodeError('TELEMETRY_UNAVAILABLE', 'Printer telemetry is unavailable. Check the printer connection in Setup.', { status: 503, retryable: true, stage: 'telemetry' }); }
    const job = describe(print);
    if (!job.available || print.gcode_state === 'IDLE' || print.gcode_state === 'FAILED') {
      throw new GcodeError('NO_ACTIVE_PRINT', 'Waiting for a print with a filename.', { status: 404, retryable: true, stage: 'telemetry' });
    }
    if (req.query.job != null && req.query.job !== job.key) throw new GcodeError('JOB_CHANGED', 'The print changed. Loading the current print instead.', { status: 409, retryable: true, stage: 'telemetry' });
    const printer = getConfig().printer || {};
    const lifecycle = previous && ['RUNNING', 'PREPARE', 'SLICING'].includes(print.gcode_state)
      && (['IDLE', 'FINISH', 'FAILED'].includes(previous.state) || (previous.percent >= 90 && Number(print.mc_percent) < 50));
    if (!print._bb_job_id && lifecycle) legacyGeneration = randomUUID();
    previous = { state: print.gcode_state, percent: Number(print.mc_percent) };
    // Hash all identity fields and configuration. IDs of "0", reused job IDs,
    // different printers and credential corrections cannot share a cache entry.
    const key = createHash('sha256').update(JSON.stringify([job.key, print._bb_job_id ? '' : legacyGeneration, printer.url, printer.serialNumber, printer.accessCode])).digest('hex');
    return { job, printer, key, cachePath: path.join(cacheDir, key + '.gcode') };
  }
  async function stillCurrent(ctx, signal) {
    if (signal?.aborted) throw new GcodeError('JOB_CHANGED', 'This download was superseded by a newer print or manual file.', { status: 409, retryable: true });
    const current = await context({ query: { job: ctx.job.key } });
    if (current.key !== ctx.key) throw new GcodeError('JOB_CHANGED', 'Printer settings or the print changed during download.', { status: 409, retryable: true });
  }
  async function saveCache(ctx, data, signal) {
    await stillCurrent(ctx, signal);
    await fs.mkdir(cacheDir, { recursive: true });
    const temp = ctx.cachePath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, data);
      await stillCurrent(ctx, signal);
      await fs.rename(temp, ctx.cachePath);
    } finally { await fs.unlink(temp).catch(() => {}); }
    const files = await fs.readdir(cacheDir);
    const entries = await Promise.all(files.filter(name => name.endsWith('.gcode')).map(async name => ({ name, time: (await fs.stat(path.join(cacheDir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    await Promise.all(entries.sort((a, b) => b.time - a.time).slice(5).map(entry => fs.unlink(path.join(cacheDir, entry.name)).catch(() => {})));
  }
  function send(res, ctx, data) {
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Gcode-Job': encodeURIComponent(ctx.job.key) });
    res.send(data);
  }
  function fail(res, err, retryAfter = 0) {
    const error = err instanceof GcodeError ? err : new GcodeError('GCODE_INTERNAL', 'BambuBoard could not save or read the toolpath. Check its data directory and diagnostic log.', { status: 500, stage: 'cache' });
    if (error.code !== 'JOB_CHANGED' && latest?.error?.code !== error.code) record({ schema: 1, startedAt: new Date(now()).toISOString(), result: 'failed', events: [], error: { code: error.code, detail: error.message, stage: error.stage, retryable: error.retryable } });
    if (retryAfter) res.setHeader('Retry-After', String(Math.ceil(retryAfter / 1000)));
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.status).json(redact({ error: error.code, code: error.code, detail: error.message, stage: error.stage, retryable: error.retryable, retryAfterMs: retryAfter, diagnostics: '/api/gcode/diagnostics' }));
  }
  async function download(ctx) {
    const controller = new AbortController();
    const started = now();
    const report = { schema: 1, startedAt: new Date(started).toISOString(), source: 'printer', printer: { model: ctx.printer.model || ctx.printer.type, port: 990 }, job: { task: ctx.job.task, name: ctx.job.name, plate: ctx.job.plate, plateKnown: ctx.job.plateKnown }, events: [] };
    const work = { key: ctx.key, controller, promise: null };
    active = work;
    work.promise = (async () => {
      try {
        const data = await fetchGcode({ host: ctx.printer.url, port: 990, accessCode: ctx.printer.accessCode, model: ctx.printer.model || ctx.printer.type, job: ctx.job, signal: controller.signal,
          onEvent(event) { if (report.events.length < 100) report.events.push({ atMs: now() - started, ...event }); } });
        await saveCache(ctx, data, controller.signal);
        failures.delete(ctx.key);
        Object.assign(report, { result: 'ok', bytes: data.length, durationMs: now() - started }); record(report);
        return data;
      } catch (err) {
        const error = err instanceof GcodeError ? err : new GcodeError('GCODE_INTERNAL', 'The toolpath could not be downloaded or cached. Check the diagnostic log.', { status: 500, stage: 'cache' });
        Object.assign(report, { result: 'failed', durationMs: now() - started, error: { code: error.code, detail: error.message, stage: error.stage, retryable: error.retryable } });
        if (error.code !== 'JOB_CHANGED' && active === work) record(report);
        if (error.code !== 'JOB_CHANGED') {
          const count = (failures.get(ctx.key)?.count || 0) + 1;
          failures.set(ctx.key, { error, count, until: now() + (error.retryable ? Math.min(120000, 15000 * 2 ** (count - 1)) : 300000) });
          if (failures.size > 50) failures.delete(failures.keys().next().value);
        }
        throw error;
      } finally { if (active === work) active = null; }
    })();
    return work.promise;
  }
  router.get('/diagnostics', async (_req, res) => {
    if (!latest) {
      try { latest = redact(JSON.parse(await fs.readFile(diagnosticPath, 'utf8'))); } catch (_) {}
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(latest || { schema: 1, result: 'not_attempted', events: [] });
  });
  router.get('/current', async (req, res) => {
    let ctx;
    try {
      ctx = await context(req);
      if (req.query.nocache !== '1') {
        try { const data = await fs.readFile(ctx.cachePath); if (data.length && data.length <= LIMITS.gcode) { await stillCurrent(ctx); return send(res, ctx, data); } } catch (err) { if (err instanceof GcodeError) throw err; }
      }
      if (!ctx.printer.url || !ctx.printer.accessCode || ctx.printer.accessCode === 'FILL_THIS_OUT') throw new GcodeError('PRINTER_NOT_CONFIGURED', 'Set the printer address and LAN access code in Setup.', { status: 422, stage: 'connect' });
      if (active && active.key === ctx.key) return send(res, ctx, await active.promise);
      const recent = failures.get(ctx.key);
      if (recent && recent.until > now() && req.query.retry !== '1') return fail(res, recent.error, recent.until - now());
      if (active) active.controller.abort();
      return send(res, ctx, await download(ctx));
    } catch (err) { fail(res, err, ctx ? Math.max(0, (failures.get(ctx.key)?.until || 0) - now()) : 0); }
  });
  router.post('/current', express.raw({ type: 'application/octet-stream', limit: LIMITS.archive }), async (req, res) => {
    const started = now();
    try {
      const ctx = await context(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new GcodeError('FILE_REQUIRED', 'Choose the exact sliced .3mf or .gcode for this print.', { status: 400 });
      const report = { schema: 1, startedAt: new Date(started).toISOString(), source: 'manual', job: { name: ctx.job.name, plate: ctx.job.plate }, events: [] };
      const data = await extractPlateGcode(req.body, { plate: ctx.job.plate, plateKnown: ctx.job.plateKnown, onEvent: event => report.events.push(event) });
      await stillCurrent(ctx);
      if (active?.key === ctx.key) { active.controller.abort(); active = null; }
      await saveCache(ctx, data);
      failures.delete(ctx.key); Object.assign(report, { result: 'ok', bytes: data.length, durationMs: now() - started }); record(report);
      send(res, ctx, data);
    } catch (err) { fail(res, err); }
  });
  router.use((err, _req, res, next) => {
    if (err.type === 'entity.too.large') return fail(res, new GcodeError('FILE_TOO_LARGE', 'Choose a sliced file smaller than 128 MiB.', { status: 413 }));
    next(err);
  });
  return { router, flushDiagnostics: () => diagnosticQueue, async stop() {
    active?.controller.abort();
    await active?.promise.catch(() => {});
    await diagnosticQueue;
  } };
}
module.exports = { buildGcodeRouter };
