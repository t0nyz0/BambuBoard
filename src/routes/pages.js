const express = require('express');
const path = require('path');

function buildPagesRouter({ paths, getConfig }) {
  const router = express.Router();
  const VIEWS = paths.views;

  function isFirstRun() {
    const p = getConfig().printer || {};
    return !p.serialNumber || p.serialNumber === 'FILL_THIS_OUT' || !p.url || !p.accessCode || p.accessCode === 'FILL_THIS_OUT';
  }

  // Drop legacy *.html links → pretty paths
  router.get(/^(.+)\.html$/, (req, res) => {
    const stripped = req.params[0];
    res.redirect(301, stripped === '/index' ? '/' : stripped);
  });

  // First-run gate: anything that isn't /setup or /api/* gets redirected.
  router.use((req, res, next) => {
    if (!isFirstRun()) return next();
    const p = req.path;
    if (p.startsWith('/api/') || p.startsWith('/assets/') || p.startsWith('/css/')
      || p.startsWith('/js/') || p.startsWith('/widgets/') || p === '/data.json'
      || p === '/setup' || p === '/login' || p === '/favicon.ico') return next();
    return res.redirect(`/setup?firstRun=1`);
  });

  router.get('/',             (req, res) => res.sendFile(path.join(VIEWS, 'hub.html')));
  // The standalone dashboard was retired in 3.1.0 — /live (a published scene,
  // or the default layout) is the monitor now. Redirect old bookmarks.
  router.get('/dashboard',    (req, res) => res.redirect(302, '/live'));
  router.get('/setup',        (req, res) => res.sendFile(path.join(VIEWS, 'setup.html')));
  router.get('/customize',    (req, res) => res.sendFile(path.join(VIEWS, 'customize.html')));
  router.get('/scene-editor', (req, res) => res.sendFile(path.join(VIEWS, 'scene-editor.html')));
  // Composited broadcast output: renders a saved scene as a single full-page
  // view (camera + every widget, positioned exactly as designed). The whole
  // point is that an OBS scene needs just ONE Browser Source pointing here —
  // no per-widget sources, no camera media source, no SDP.
  router.get('/live',         (req, res) => res.sendFile(path.join(VIEWS, 'live.html')));
  router.get('/login',        (req, res) => res.sendFile(path.join(VIEWS, 'login.html')));

  return router;
}

module.exports = { buildPagesRouter };
