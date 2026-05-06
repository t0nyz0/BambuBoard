// Tier-1 customizer: read URL params and apply theme to the widget.
// Each widget's index.html includes:
//   <script src="../_customizer.js"></script>
// This script applies inline before any chart/widget script runs.
//
// Supported params:
//   ?theme=dark|light|transparent
//   ?accent=51a34f          (hex without #)
//   ?fontSize=24
//   ?title=Anything you want   — overrides the widget's <h2 class="partTitle">
//   ?pad=12                    — body padding in px (breathing room around content)
//
// Advanced: telemetry bindings (Tier 2 power-user feature)
//   ?bind.<id>=<JSONPath>      — bind a widget parameter to any field in /data.json
//
// Each widget.json may declare a `bindings` manifest listing which params are
// bindable plus their default JSONPaths, e.g.:
//   "bindings": [
//     { "id": "amsUnit", "label": "AMS unit data",
//       "default": "$.print.ams.ams[0]", "type": "object" }
//   ]
// At iframe load, the customizer fetches /data.json, resolves every binding
// path, and exposes results on `window.__bindings`. Widgets that opt in to
// bindings read window.__bindings.<id> instead of (or as a fallback to) the
// hardcoded telemetry path. The customizer auto-refreshes bindings every
// 1.5s so they stay live.
(function () {
  try {
    var p = new URLSearchParams(window.location.search);
    var theme = p.get('theme');
    var accent = p.get('accent');
    var fontSize = p.get('fontSize');
    var title = p.get('title');
    var pad = p.get('pad');
    var html = document.documentElement;
    if (theme) html.classList.add('bb-theme-' + theme.replace(/[^a-z0-9]/gi, ''));
    if (accent) html.style.setProperty('--bb-accent', '#' + accent.replace(/^#/, ''));
    if (fontSize) document.body && (document.body.style.fontSize = fontSize + 'px');
    if (pad) {
      var padPx = Math.max(0, Math.min(64, parseInt(pad, 10) || 0)) + 'px';
      var setPad = function () { document.body.style.padding = padPx; document.body.style.boxSizing = 'border-box'; };
      if (document.body) setPad();
      else document.addEventListener('DOMContentLoaded', setPad);
    }

    var titleSelector = '.partTitle, .widget-title, h1, h2';

    // Apply explicit ?title= override (highest priority).
    function applyTitleParam () {
      if (!title) return;
      var node = document.querySelector(titleSelector);
      if (node) {
        // Preserve any inner badge/active-tag span by replacing only the leading text node.
        var firstText = node.firstChild;
        if (firstText && firstText.nodeType === 3) firstText.nodeValue = title;
        else node.textContent = title;
      }
    }

    // Capability-aware default: a title element can declare data-default and
    // data-default-dual to swap text based on whether the configured printer
    // has dual nozzles (H2D etc.). Used by the nozzle-temp widget so single-
    // nozzle printers see "Nozzle" while H2D shows "Right Nozzle".
    // Skipped entirely if ?title= is set.
    function applyCapDefault () {
      if (title) return; // explicit override wins
      var node = document.querySelector(titleSelector);
      if (!node) return;
      var dDefault = node.getAttribute('data-default');
      var dDual = node.getAttribute('data-default-dual');
      if (!dDefault && !dDual) return;
      fetch('/api/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        if (!s || !s.caps) return;
        var pick = s.caps.hasDualNozzle && dDual ? dDual : (dDefault || node.textContent);
        var firstText = node.firstChild;
        if (firstText && firstText.nodeType === 3) firstText.nodeValue = pick;
        else node.textContent = pick;
      }).catch(function () { /* widget keeps default text */ });
    }

    function applyAll () {
      applyTitleParam();
      applyCapDefault();
      if (fontSize) document.body.style.fontSize = fontSize + 'px';
    }

    if (document.readyState !== 'loading') applyAll();
    else document.addEventListener('DOMContentLoaded', applyAll);

    // Auto-size: measure the rendered content's bounding box and postMessage
    // the natural dimensions to the parent (scene editor). Parent uses this
    // to optionally resize the OBS source's settings.{width,height}. Runs
    // 600ms after load so any /data.json fetch + DOM hydration has completed.
    function reportSize () {
      try {
        var slug = (location.pathname.match(/\/widgets\/([^\/]+)\//) || [])[1] || null;
        // Use scrollWidth/Height of the documentElement to capture the full
        // rendered layout including content past the viewport.
        var w = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'bambuboard:size', slug: slug, w: w, h: h }, '*');
        }
      } catch (_) { /* widget framed cross-origin or in OBS — both fine */ }
    }
    if (document.readyState === 'complete') setTimeout(reportSize, 600);
    else window.addEventListener('load', function () { setTimeout(reportSize, 600); });

    // ----- Tier-2: telemetry bindings -----
    // Collect every ?bind.<id>=<path> param. If we found any, start a polling
    // loop that fetches /data.json, resolves each path, and exposes results
    // on window.__bindings. Widgets can listen for the
    // 'bambuboard:binding-update' event or read window.__bindings on demand.
    var bindings = {};
    p.forEach(function (val, key) {
      if (key.indexOf('bind.') === 0) {
        var id = key.slice(5);
        if (id) bindings[id] = val;
      }
    });
    var bindingIds = Object.keys(bindings);
    if (bindingIds.length > 0) {
      window.__bindings = {};
      window.__bindingPaths = bindings;

      // Tiny JSONPath resolver. Supports `$.a.b[0].c`, `a.b[0]`, `$[2].x`.
      // No recursive descent (`..`), no filters, no functions — minimal
      // surface area, easy to reason about. Returns undefined on miss.
      function resolvePath (root, path) {
        if (!path || typeof path !== 'string') return undefined;
        var p = path.replace(/^\$\.?/, ''); // strip leading $ or $.
        if (p === '') return root;
        // Tokenize: split on . or [N]. Brackets become numeric tokens.
        var tokens = [];
        var re = /([^.\[\]]+)|\[(\d+)\]/g;
        var m;
        while ((m = re.exec(p)) !== null) {
          tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
        }
        var node = root;
        for (var i = 0; i < tokens.length; i++) {
          if (node == null) return undefined;
          node = node[tokens[i]];
        }
        return node;
      }

      function refreshBindings () {
        fetch('/data.json', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) return;
            var changed = false;
            for (var i = 0; i < bindingIds.length; i++) {
              var id = bindingIds[i];
              var v = resolvePath(data, bindings[id]);
              if (window.__bindings[id] !== v) { window.__bindings[id] = v; changed = true; }
            }
            if (changed) {
              try {
                window.dispatchEvent(new CustomEvent('bambuboard:binding-update', {
                  detail: { bindings: window.__bindings, paths: bindings },
                }));
              } catch (_) {}
            }
          })
          .catch(function () { /* ignore — next tick will retry */ });
      }
      refreshBindings();
      setInterval(refreshBindings, 1500);
    }
  } catch (_) { /* no-op */ }
})();
