// Gcode toolpath route — fetches the current plate's .gcode out of the
// printer's FTPS /cache/ store and serves it to the gcode-viz widget.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { fetchPlateGcode } = require('../services/printerFiles');

const CACHE_KEEP = 5;

function buildGcodeRouter({ getConfig, paths }) {
  const router = express.Router();
  const DATA_FILE = path.join(paths.data, 'data.json');
  const CACHE_DIR = path.join(paths.data, 'gcode-cache');

  async function readPrint() {
    try {
      const raw = await fsp.readFile(DATA_FILE, 'utf-8');
      return (JSON.parse(raw) || {}).print || {};
    } catch (_) {
      return {};
    }
  }

  async function trimCache() {
    let entries;
    try {
      entries = await fsp.readdir(CACHE_DIR);
    } catch (_) { return; }
    const stats = await Promise.all(entries.map(async (name) => {
      try {
        const st = await fsp.stat(path.join(CACHE_DIR, name));
        return { name, mtime: st.mtimeMs };
      } catch (_) { return null; }
    }));
    const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const stale = sorted.slice(CACHE_KEEP);
    await Promise.all(stale.map(s =>
      fsp.unlink(path.join(CACHE_DIR, s.name)).catch(() => {})
    ));
  }

  router.get('/current', async (req, res) => {
    const print = await readPrint();
    const taskId = print.task_id || print.subtask_id;
    const subtask = print.subtask_name;
    const plateIdx = print.plate_idx || print.plate_id || 1;
    const state = print.gcode_state;

    if (!taskId || !subtask || state === 'IDLE') {
      return res.status(404).json({ error: 'no active print' });
    }

    const cacheKey = `${taskId}_p${plateIdx}.gcode`;
    const cachePath = path.join(CACHE_DIR, cacheKey);

    if (fs.existsSync(cachePath)) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return fs.createReadStream(cachePath).pipe(res);
    }

    const cfg = getConfig();
    const printer = cfg.printer || {};
    if (!printer.url || !printer.accessCode) {
      return res.status(500).json({ error: 'printer host/accessCode not configured' });
    }

    try {
      const gcode = await fetchPlateGcode({
        host: printer.url,
        port: 990,
        accessCode: printer.accessCode,
        subtaskName: subtask,
        plateIdx,
      });
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(cachePath, gcode);
      trimCache().catch(() => {});
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(gcode);
    } catch (e) {
      res.status(502).json({ error: 'ftps fetch failed', detail: e.message });
    }
  });

  return { router };
}

module.exports = { buildGcodeRouter };
