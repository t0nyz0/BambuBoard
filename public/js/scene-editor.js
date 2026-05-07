// OBS scene-collection editor.
//   Loads a template / saved scene / uploaded JSON, renders the first scene
//   as a scaled 1920×1080 canvas with live widget iframes positioned at their
//   real OBS coordinates. Drag to move, drag the bottom-right handle to
//   resize. Click a widget tile to open the inspector for theme/accent/font
//   plus exact pos/size editing. Save back to data/scenes/<name>.json or
//   download the modified scene-collection JSON.
//
// Round-trip safety: we keep the original parsed JSON in `state.original`
// and only mutate the *items* inside the active scene's `settings.items[]`
// (and the corresponding browser_source URLs when widget customizations are
// applied). All other top-level fields, sources, transitions, hotkeys etc.
// are passed through verbatim.

// Default canvas dimensions; overridden when a loaded scene specifies its own
// `resolution` field (e.g. ultra-wide or 4K scenes). Keeping these as `let`
// so loadCollection() can update them.
let CANVAS_W = 1920;
let CANVAS_H = 1080;

const state = {
  original: null,        // the loaded scene-collection JSON
  sceneName: null,       // currently-selected scene name
  sources: {},           // name → source object (lookup)
  items: [],             // scene items, in render order
  selectedIndex: -1,
  customizations: {},    // widgetSlug → { theme, accent, fontSize }
  zoom: 1,
  // Undo/redo: snapshots of {items, customizations} taken before each
  // mutating action. Cmd/Ctrl+Z pops; Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) re-pushes.
  history: [],
  future: [],
};

const SNAP_GRID = 10;       // px when shift held during drag
const SNAP_PROXIMITY = 8;   // px — snap to widget edges when within this distance

const els = {
  canvas:    () => document.getElementById('canvas'),
  wrap:      () => document.getElementById('canvas-wrap'),
  shell:     () => document.getElementById('canvas-shell'),
  loader:    () => document.getElementById('loader'),
  scenes:    () => document.getElementById('scene-picker'),
  fileIn:    () => document.getElementById('file-input'),
  inspector: () => document.getElementById('inspector'),
  diff:      () => document.getElementById('diff'),
  zoomLbl:   () => document.getElementById('zoom-label'),
};

const widgetSlugRe = /\/widgets\/([a-zA-Z0-9_\-]+)\//;
const isWidgetSrc = (src) =>
  src && src.id === 'browser_source' && src.settings && typeof src.settings.url === 'string'
  && widgetSlugRe.test(src.settings.url);
const widgetSlugOf = (src) => {
  const m = src.settings.url.match(widgetSlugRe);
  return m ? m[1] : null;
};

// Heuristic: should this URL be rendered as an <img> rather than an <iframe>?
// True for explicit image-extension URLs and for known image-host patterns
// where the path has no extension but consistently returns image bytes
// (S3 trademark store, generic CDN paths). Cross-origin iframes can't be
// styled, so when the URL is just an image we'd rather load it as <img>
// inside a wrapper we can style — that's how the H2D logo gets its rounded
// dark backdrop in the editor.
function looksLikeImageUrl (url) {
  if (!url) return false;
  // Strip query string before checking extension.
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(path)) return true;
  // Known image-host patterns where URLs lack file extensions.
  if (/^https?:\/\/[^/]*\.s3[.-]?[a-z0-9-]*\.amazonaws\.com\/[^/?#]+$/.test(url)) return true;
  return false;
}

// Build an iframe styled to OBS's browser-source rendering pipeline: paint
// at the source's natural viewport (settings.{width,height}) then visually
// scale to the rendered on-canvas size. Used by both the widget and the
// generic browser_source branches so the styling stays consistent.
function mkIframe (url, title, sz) {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = title;
  iframe.loading = 'lazy';
  iframe.style.width  = sz.naturalW + 'px';
  iframe.style.height = sz.naturalH + 'px';
  iframe.style.transformOrigin = 'top left';
  iframe.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
  return iframe;
}

// OBS browser-source `settings.css` is injected by OBS into the body of the
// loaded page when it renders. We replicate that for our same-origin widgets
// by waiting for the iframe to load and appending a <style> tag to its head.
// Critical for visual fidelity — the H2D scene relies on this CSS to give the
// logo a rounded dark backdrop and the notes widget a translucent black bar.
function injectObsCss (iframe, css) {
  if (!css) return;
  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const style = doc.createElement('style');
      style.setAttribute('data-obs-source-css', '');
      style.textContent = css;
      doc.head.appendChild(style);
    } catch (_) { /* cross-origin or detached; nothing we can do */ }
  });
}

// For cross-origin iframes (e.g. the trademark image hosted on AWS) we can't
// touch contentDocument. Approximate the OBS-applied CSS by parsing the most
// common body-level rules (background, border-radius, padding, margin) out of
// the settings.css string and applying them to a wrapper element instead.
// Imperfect but covers ~95% of real-world OBS settings.css usage.
function applyObsCssApprox (wrapper, css) {
  if (!css) return;
  // Strip any selector wrapping; consider only the rules inside `body { ... }`
  // (the conventional OBS pattern) plus loose top-level rules.
  const bodyMatch = css.match(/body\s*\{([^}]*)\}/);
  const rules = (bodyMatch ? bodyMatch[1] : css).trim();
  if (!rules) return;
  // Allowlist of properties that map cleanly onto a wrapper div.
  const ALLOW = ['background', 'background-color', 'border-radius', 'padding', 'margin', 'box-shadow', 'border'];
  rules.split(';').forEach(decl => {
    const ix = decl.indexOf(':');
    if (ix < 0) return;
    const prop = decl.slice(0, ix).trim().toLowerCase();
    const val  = decl.slice(ix + 1).trim();
    if (ALLOW.includes(prop) && val) {
      wrapper.style.setProperty(prop, val);
    }
  });
  wrapper.style.boxSizing = 'border-box';
  wrapper.style.overflow = 'hidden';
}

// OBS color_source.color is a packed 32-bit ABGR int.
// Bits: 31-24 alpha, 23-16 blue, 15-8 green, 7-0 red.
function obsColorToCss (n) {
  if (typeof n !== 'number') return '#000';
  const a = ((n >>> 24) & 0xFF) / 255;
  const b = (n >>> 16) & 0xFF;
  const g = (n >>> 8) & 0xFF;
  const r = n & 0xFF;
  return `rgba(${r},${g},${b},${a})`;
}

// Push current state onto the undo history. Future stack is cleared on each
// new action — standard linear-history undo semantics.
function snapshot () {
  state.history.push({
    items: structuredClone(state.items),
    customizations: structuredClone(state.customizations),
  });
  if (state.history.length > 100) state.history.shift();
  state.future.length = 0;
  updateUndoButtons();
}

function undo () {
  if (!state.history.length) return;
  state.future.push({
    items: structuredClone(state.items),
    customizations: structuredClone(state.customizations),
  });
  const prev = state.history.pop();
  state.items = prev.items;
  state.customizations = prev.customizations;
  render();
  updateUndoButtons();
}

function redo () {
  if (!state.future.length) return;
  state.history.push({
    items: structuredClone(state.items),
    customizations: structuredClone(state.customizations),
  });
  const next = state.future.pop();
  state.items = next.items;
  state.customizations = next.customizations;
  render();
  updateUndoButtons();
}

function updateUndoButtons () {
  const u = document.getElementById('undo-btn');
  const r = document.getElementById('redo-btn');
  if (u) u.disabled = state.history.length === 0;
  if (r) r.disabled = state.future.length === 0;
}

// ---- bootstrap ----
(async function init () {
  populateLoader();
  fitZoom();
  // Re-fit on window resize, and also when the shell itself changes size
  // (e.g. nav collapses, toast pushes content). ResizeObserver fires on the
  // shell directly so we don't depend on layout side-effects to bubble up.
  window.addEventListener('resize', fitZoom);
  if (window.ResizeObserver) {
    new ResizeObserver(fitZoom).observe(els.shell());
  }

  // Keyboard shortcuts:
  //   Arrow keys: nudge selected item 1px (10px with Shift)
  //   Cmd/Ctrl+Z: undo, Cmd/Ctrl+Shift+Z (or +Y): redo
  //   Esc: deselect
  document.addEventListener('keydown', (e) => {
    // Don't intercept while typing in an input/textarea
    if (e.target.matches('input, textarea, select')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      state.selectedIndex = -1;
      document.querySelectorAll('.scene-item.selected').forEach(n => n.classList.remove('selected'));
      closeInspector();
      return;
    }
    if (state.selectedIndex < 0) return;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft')  dx = -step;
    if (e.key === 'ArrowRight') dx =  step;
    if (e.key === 'ArrowUp')    dy = -step;
    if (e.key === 'ArrowDown')  dy =  step;
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    snapshot();
    const item = state.items[state.selectedIndex];
    item.pos = { x: (item.pos?.x || 0) + dx, y: (item.pos?.y || 0) + dy };
    applyToDom(state.selectedIndex);
    refreshInspector();
    updateDiff();
  });

  els.fileIn().addEventListener('change', onFileUpload);
  document.getElementById('save-btn').addEventListener('click', onSave);
  document.getElementById('download-btn').addEventListener('click', onDownload);
  document.getElementById('save-continue-btn').addEventListener('click', onSaveAndContinue);
  document.getElementById('reset-btn').addEventListener('click', () => { if (state.original) loadCollection(structuredClone(state.original)); });
  document.getElementById('undo-btn').addEventListener('click', undo);
  document.getElementById('redo-btn').addEventListener('click', redo);
  document.getElementById('autolayout-btn').addEventListener('click', autoLayout);
  document.getElementById('canvas-res-btn').addEventListener('click', pickCanvasResolution);
  updateCanvasInfoBtn();

  // Receive size measurements from widget iframes (sent by _customizer.js).
  // Stash them keyed by slug so the inspector's auto-size button can use the
  // most recent measurement for the selected widget.
  state.measuredSizes = {};
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.type === 'bambuboard:size' && m.slug && m.w && m.h) {
      state.measuredSizes[m.slug] = { w: m.w, h: m.h };
      // If this widget is currently selected, refresh the inspector to enable
      // the auto-size button now that we have a measurement.
      if (state.selectedIndex >= 0) {
        const src = state.sources[state.items[state.selectedIndex].name];
        if (isWidgetSrc(src) && widgetSlugOf(src) === m.slug) refreshInspector();
      }
    }
  });
  document.getElementById('inspector-close').addEventListener('click', () => closeInspector());
  document.addEventListener('click', (e) => {
    if (e.target.closest('.scene-item') || e.target.closest('.inspector') || e.target.closest('.editor-toolbar') || e.target.closest('.widget-drawer')) return;
    closeInspector();
    state.selectedIndex = -1;
    document.querySelectorAll('.scene-item.selected').forEach(n => n.classList.remove('selected'));
  });

  // Widget drawer toggle + populate
  document.getElementById('widget-drawer-btn').addEventListener('click', toggleWidgetDrawer);
  document.getElementById('widget-drawer-close').addEventListener('click', () => closeWidgetDrawer());
  populateWidgetDrawer();

  // Canvas drop target — accept widgets dragged from the drawer
  setupCanvasDrop();
})();

async function populateLoader () {
  const [tplR, scnR, statusR] = await Promise.all([
    fetch('/api/obs/templates').then(r => r.json()).catch(() => []),
    fetch('/api/obs/scenes').then(r => r.json()).catch(() => []),
    fetch('/api/status').then(r => r.json()).catch(() => null),
  ]);
  const sel = els.loader();
  sel.innerHTML = '<option value="">— pick a starting point —</option>'
    + (tplR.length ? '<optgroup label="Templates">' + tplR.map(t =>
        `<option value="tpl:${t.slug}">${escape(t.label || t.slug)}</option>`).join('') + '</optgroup>' : '')
    + (scnR.length ? '<optgroup label="Saved scenes">' + scnR.map(s =>
        `<option value="scn:${s.slug}">${escape(s.name)}</option>`).join('') + '</optgroup>' : '')
    + '<optgroup label="From file"><option value="upload">Upload a .json file…</option></optgroup>';
  sel.addEventListener('change', onLoaderChange);

  // Auto-select the template that matches the connected printer's type so
  // users don't have to pick from the dropdown on every page load. Looks at
  // each template's `recommendedTypes` field — a template with the printer's
  // type in that list wins. If no exact match exists, fall back to default-x1
  // (covers X1/P1/A1 — the largest printer family). Show a brief loading
  // indicator while the template fetches, and dispatch a window event when
  // the scene is loaded so the stepper UI can mark Step 3 as in-progress.
  const printerType = statusR && statusR.printer && statusR.printer.type;
  if (tplR.length) {
    let pick = null;
    if (printerType) {
      pick = tplR.find(t => Array.isArray(t.recommendedTypes) && t.recommendedTypes.includes(printerType));
    }
    if (!pick) pick = tplR.find(t => t.slug === 'default-x1');
    if (!pick) pick = tplR[0];

    if (pick) {
      // Show a loading hint in the diff badge until the scene populates.
      const diff = document.getElementById('diff');
      if (diff) diff.textContent = `Loading layout for ${printerType || 'your printer'}…`;

      sel.value = `tpl:${pick.slug}`;
      // Auto-load it. Fire the change handler so the rest of the editor
      // initializes as if the user had picked it themselves.
      sel.dispatchEvent(new Event('change'));
      // Notify any listeners (the workflow stepper) that Step 3 has begun.
      try {
        window.dispatchEvent(new CustomEvent('bambuboard:scene-loaded', {
          detail: { template: pick.slug, printerType },
        }));
      } catch (_) {}
    }
  }
}

async function onLoaderChange (e) {
  const v = e.target.value;
  if (!v) return;
  if (v === 'upload') { els.fileIn().click(); e.target.value = ''; return; }
  const [kind, slug] = v.split(':');
  const url = kind === 'tpl' ? `/api/obs/templates/${slug}/raw` : `/api/obs/scenes/${slug}`;
  const r = await fetch(url);
  if (!r.ok) return window.toast('Load failed', 'error');
  const json = await r.json();
  loadCollection(json);
}

function onFileUpload (e) {
  const f = e.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try { loadCollection(JSON.parse(fr.result)); }
    catch (err) { window.toast('Invalid JSON: ' + err.message, 'error'); }
  };
  fr.readAsText(f);
}

function loadCollection (json) {
  state.original = json;
  // Honor the scene-collection's declared canvas resolution. Some users have
  // 2560×1440 or 4K canvases. Default 1920×1080 when missing.
  CANVAS_W = (json.resolution && json.resolution.x) || 1920;
  CANVAS_H = (json.resolution && json.resolution.y) || 1080;
  updateCanvasInfoBtn();
  // Build sources lookup
  state.sources = {};
  (json.sources || []).forEach(s => { if (s && s.name) state.sources[s.name] = s; });
  // Reset customizations and re-parse them from each widget source's existing
  // URL params. This way: previously-saved customizations / bindings show up
  // in the inspector when the scene loads, and round-trip cleanly through
  // Save/Download even if the user only edits a different field.
  state.customizations = {};
  (json.sources || []).forEach(src => {
    if (!isWidgetSrc(src)) return;
    const slug = widgetSlugOf(src);
    const url = (src.settings && src.settings.url) || '';
    const qIdx = url.indexOf('?');
    if (qIdx < 0) return;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const cust = state.customizations[slug] = state.customizations[slug] || {};
    params.forEach((val, key) => {
      if (CUST_KEYS.includes(key)) {
        cust[key] = val;
      } else if (key.indexOf('bind.') === 0) {
        const id = key.slice(5);
        if (id) {
          cust.bindings = cust.bindings || {};
          cust.bindings[id] = val;
        }
      }
    });
  });
  // Pick scene
  const scenes = (json.sources || []).filter(s => s.id === 'scene');
  if (!scenes.length) return window.toast('No scenes found in file', 'error');
  populateScenePicker(scenes);
  selectScene(json.current_scene || scenes[0].name);
  fitZoom(); // recompute scale-to-fit after canvas dimensions change
}

function populateScenePicker (scenes) {
  const sel = els.scenes();
  sel.innerHTML = scenes.map(s => `<option value="${escape(s.name)}">${escape(s.name)}</option>`).join('');
  sel.disabled = scenes.length < 2;
  sel.onchange = (e) => selectScene(e.target.value);
}

function selectScene (name) {
  state.sceneName = name;
  els.scenes().value = name;
  const scene = state.sources[name];
  if (!scene) return;
  // Deep-clone — state.items mutations (drag, resize, auto-layout) must NOT
  // mutate state.original. A shallow slice keeps each item's `pos`/`scale`/
  // `bounds` objects shared with the original, which silently breaks the
  // modified-vs-original diff counter and the Reset button.
  state.items = structuredClone(scene.settings?.items || []);
  // Reset undo history when switching scenes — the previous history applied
  // to a different scene's items.
  state.history.length = 0;
  state.future.length = 0;
  updateUndoButtons();
  render();
}

// ---- render ----
function fitZoom () {
  const shell = els.shell();
  const wrap = els.wrap();
  const c = els.canvas();
  if (!shell || !wrap || !c) return;
  const avail = shell.getBoundingClientRect();
  const maxW = Math.max(320, avail.width - 32);
  const maxH = Math.max(240, avail.height - 32);
  state.zoom = Math.min(maxW / CANVAS_W, maxH / CANVAS_H, 1);

  // The inner canvas keeps its 1920×1080 coordinate box; transform: scale()
  // shrinks the visual rendering. The wrapper is sized to the *visual* extent
  // so flex centering in the shell works on what the user sees, not on the
  // pre-scale layout box (which would force horizontal scrolling).
  c.style.width  = CANVAS_W + 'px';
  c.style.height = CANVAS_H + 'px';
  c.style.transform = `scale(${state.zoom})`;
  wrap.style.width  = (CANVAS_W * state.zoom) + 'px';
  wrap.style.height = (CANVAS_H * state.zoom) + 'px';

  if (els.zoomLbl()) els.zoomLbl().textContent = `${Math.round(state.zoom * 100)}%`;
}

// OBS source-id-specific defaults. color_source and image_source default to
// the canvas size when no explicit dimensions are given (matches OBS behavior).
function naturalDimsFor (src) {
  const settings = (src && src.settings) || {};
  const id = src && src.id;
  if (settings.width && settings.height) return { w: settings.width, h: settings.height };
  if (id === 'color_source')   return { w: settings.width || CANVAS_W, h: settings.height || CANVAS_H };
  if (id === 'image_source' || id === 'image_source_v2') return { w: settings.width || 600, h: settings.height || 400 };
  if (id === 'text_ft2_source') return { w: 400, h: 80 };
  if (id === 'ffmpeg_source' || id === 'vlc_source' || id === 'rtsp_source') return { w: settings.width || 1920, h: settings.height || 1080 };
  return { w: settings.width || 400, h: settings.height || 200 };
}

// Returns { naturalW, naturalH, w, h, scaleX, scaleY } where:
//   naturalW/H = the source's design viewport (what OBS renders the browser at internally)
//   w/h = the rendered (on-canvas) size
//   scaleX/Y = the visual scale to apply (rendered = natural * scale)
//
// OBS semantics: a browser source paints into its settings.width × settings.height
// viewport, and *then* the scene transform scales/positions it. Reproducing that
// is critical for visual fidelity — sizing the iframe directly to the rendered
// dimensions makes the widget's CSS think it has less room than it was designed for.
function itemSize (item, src) {
  const nat = naturalDimsFor(src);
  const naturalW = nat.w, naturalH = nat.h;
  const bt = item.bounds_type || 0;

  if (bt !== 0 && item.bounds && item.bounds.x > 0 && item.bounds.y > 0) {
    // Bounds modes 1–6: bounds.x × bounds.y is the rendered size on-canvas.
    // (Variants differ in how they preserve aspect, but rendered box is the same.)
    const w = item.bounds.x, h = item.bounds.y;
    return { naturalW, naturalH, w, h, scaleX: w / naturalW, scaleY: h / naturalH };
  }
  const scaleX = item.scale?.x ?? 1;
  const scaleY = item.scale?.y ?? 1;
  return { naturalW, naturalH, w: naturalW * scaleX, h: naturalH * scaleY, scaleX, scaleY };
}

// OBS alignment enum (libobs/graphics/math-defs.h):
//   0 = center, 1 = left, 2 = right, 4 = top, 8 = bottom
// Combined: 5 = top-left (1|4), 6 = top-right (2|4), 9 = bottom-left,
// 10 = bottom-right. Returns the normalized anchor offset as a fraction
// of width/height: {ox, oy} where 0 = leading edge, 0.5 = center, 1 = trailing.
function alignOffsets (align) {
  const a = align || 0;
  let ox = 0.5, oy = 0.5;
  if (a & 1) ox = 0;       // left
  else if (a & 2) ox = 1;  // right
  if (a & 4) oy = 0;       // top
  else if (a & 8) oy = 1;  // bottom
  return { ox, oy };
}

// Same bitfield as alignOffsets but for bounds_align. Controls where content
// sits within the bounding box when the content doesn't fill it completely
// (e.g. bounds_type=4 inner-bounds with a wide source in a tall box).
// Returns {ox, oy} fractions: 0=leading, 0.5=center, 1=trailing.
const boundsAlignOffsets = alignOffsets;

// Snap-to-widget: given a proposed position (px, py) and the item being moved
// (by index), compute the closest snap position by checking edges/centers of
// all other items. Returns {x, y, guides} where guides is an array of
// {axis, pos} for drawing snap guides if desired.
function snapToWidgets (px, py, movingIdx, movingW, movingH) {
  const PROX = SNAP_PROXIMITY;
  let bestX = px, bestDx = Infinity;
  let bestY = py, bestDy = Infinity;
  const guides = [];

  // Edges and center of the moving item.
  const mEdges = {
    left: px, right: px + movingW, cx: px + movingW / 2,
    top: py, bottom: py + movingH, cy: py + movingH / 2,
  };

  state.items.forEach((other, idx) => {
    if (idx === movingIdx) return;
    const src = state.sources[other.name];
    if (!src) return;
    const sz = itemSize(other, src);
    const ox = other.pos?.x || 0;
    const oy = other.pos?.y || 0;
    const oRight = ox + sz.w;
    const oBottom = oy + sz.h;
    const oCx = ox + sz.w / 2;
    const oCy = oy + sz.h / 2;

    // Check X snap: left-to-left, right-to-right, left-to-right, right-to-left, center-to-center
    const xChecks = [
      { from: mEdges.left, to: ox, adj: 0 },            // left edge → left edge
      { from: mEdges.right, to: oRight, adj: -movingW }, // right → right
      { from: mEdges.left, to: oRight, adj: 0 },         // left → other's right (gap=0 abut)
      { from: mEdges.right, to: ox, adj: -movingW },     // right → other's left
      { from: mEdges.cx, to: oCx, adj: -movingW / 2 },   // center → center
    ];
    for (const { from, to, adj } of xChecks) {
      const d = Math.abs(from - to);
      if (d < PROX && d < bestDx) {
        bestDx = d;
        bestX = to + adj;
      }
    }

    // Check Y snap: top-to-top, bottom-to-bottom, top-to-bottom, bottom-to-top, center-to-center
    const yChecks = [
      { from: mEdges.top, to: oy, adj: 0 },
      { from: mEdges.bottom, to: oBottom, adj: -movingH },
      { from: mEdges.top, to: oBottom, adj: 0 },          // abut below
      { from: mEdges.bottom, to: oy, adj: -movingH },     // abut above
      { from: mEdges.cy, to: oCy, adj: -movingH / 2 },
    ];
    for (const { from, to, adj } of yChecks) {
      const d = Math.abs(from - to);
      if (d < PROX && d < bestDy) {
        bestDy = d;
        bestY = to + adj;
      }
    }
  });

  // Also snap to canvas edges (0, CANVAS_W, CANVAS_H).
  const canvasXEdges = [0, CANVAS_W];
  const canvasYEdges = [0, CANVAS_H];
  for (const cx of canvasXEdges) {
    for (const { from, adj } of [
      { from: mEdges.left, adj: 0 },
      { from: mEdges.right, adj: -movingW },
      { from: mEdges.cx, adj: -movingW / 2 },
    ]) {
      const d = Math.abs(from - cx);
      if (d < PROX && d < bestDx) { bestDx = d; bestX = cx + adj; }
    }
  }
  for (const cy of canvasYEdges) {
    for (const { from, adj } of [
      { from: mEdges.top, adj: 0 },
      { from: mEdges.bottom, adj: -movingH },
      { from: mEdges.cy, adj: -movingH / 2 },
    ]) {
      const d = Math.abs(from - cy);
      if (d < PROX && d < bestDy) { bestDy = d; bestY = cy + adj; }
    }
  }

  return { x: bestX, y: bestY };
}

function render () {
  const c = els.canvas();
  // Update canvas dimensions in case CANVAS_W/H changed (resolution from JSON).
  c.style.width = CANVAS_W + 'px';
  c.style.height = CANVAS_H + 'px';
  c.innerHTML = '';
  state.items.forEach((item, idx) => {
    // Defensive: if rendering ONE item throws (an unexpected source type, a
    // missing helper, etc.), don't black-hole the rest of the canvas. Log the
    // failure and keep going. Saved us from the looksLikeImageUrl-undefined
    // bug where a single source threw and 10 left-rail widgets vanished.
    try {
      renderItem(item, idx);
    } catch (err) {
      console.error('scene-editor: error rendering item', item.name, err);
    }
  });
  updateDiff();
}

function renderItem (item, idx) {
    const src = state.sources[item.name];
    if (!src) return;
    if (src.enabled === false) return; // OBS source disabled
    const c = els.canvas();
    const sz = itemSize(item, src);

    // Compute the CSS top-left position from OBS pos + align. OBS treats `pos`
    // as the anchor-point screen coords; we need top-left for CSS positioning.
    const align = alignOffsets(item.align);
    const left = (item.pos?.x || 0) - sz.w * align.ox;
    const top  = (item.pos?.y || 0) - sz.h * align.oy;

    const node = document.createElement('div');
    node.className = 'scene-item' + (idx === state.selectedIndex ? ' selected' : '');
    if (item.visible === false) node.classList.add('item-hidden');
    if (item.locked === true)   node.classList.add('locked');
    node.style.left   = left + 'px';
    node.style.top    = top  + 'px';
    node.style.width  = sz.w + 'px';
    node.style.height = sz.h + 'px';
    // Rotation around the alignment anchor. OBS rot is in degrees, positive
    // = clockwise (matches CSS).
    if (item.rot) {
      const ox = (align.ox * 100).toFixed(2) + '%';
      const oy = (align.oy * 100).toFixed(2) + '%';
      node.style.transformOrigin = `${ox} ${oy}`;
      node.style.transform = `rotate(${item.rot}deg)`;
    }
    // Blend mode (mix-blend-mode covers most OBS blend types: lighten,
    // multiply, screen, darken, color-dodge, color-burn, hard-light,
    // soft-light, difference, exclusion). The OBS "default" maps to "normal"
    // which is also the CSS default.
    const bt = item.blend_type;
    if (bt && bt !== 'normal' && bt !== 'default') {
      // Only apply known-safe values to avoid breaking layout with unsupported names.
      const safe = ['lighten','multiply','screen','darken','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','overlay'];
      if (safe.includes(bt)) node.style.mixBlendMode = bt;
    }
    node.dataset.idx = idx;

    const body = document.createElement('div');
    body.className = 'body';

    // Crop: clip the body to exclude cropped edges. OBS crop values are in
    // source (natural) pixels; convert to rendered pixels using the scale factors.
    const cl = item.crop_left   || 0;
    const ct = item.crop_top    || 0;
    const cr = item.crop_right  || 0;
    const cb = item.crop_bottom || 0;
    if (cl || ct || cr || cb) {
      body.style.clipPath = `inset(${ct * sz.scaleY}px ${cr * sz.scaleX}px ${cb * sz.scaleY}px ${cl * sz.scaleX}px)`;
    }

    // scale_filter: only meaningful for pixel-content elements (img/video).
    // OBS "point" → CSS pixelated; everything else → auto.
    const ir = item.scale_filter === 'point' ? 'pixelated' : 'auto';

    if (isWidgetSrc(src)) {
      // Render iframe at the source's natural design viewport, then visually
      // scale it to the rendered size. This matches OBS's browser-source pipeline
      // (browser paints at settings.{width,height}, scene transform scales output).
      const slug = widgetSlugOf(src);
      const iframe = document.createElement('iframe');
      iframe.src = widgetUrlForPreview(slug);
      iframe.title = item.name;
      iframe.loading = 'lazy';
      iframe.style.width  = sz.naturalW + 'px';
      iframe.style.height = sz.naturalH + 'px';
      iframe.style.transformOrigin = 'top left';
      iframe.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
      injectObsCss(iframe, src.settings?.css);
      body.appendChild(iframe);
    } else if (src.id === 'browser_source' && src.settings?.url) {
      // Non-widget browser sources. URLs that point at an image (the H2D
      // trademark logo, custom badge images, etc.) need to be rendered as
      // <img> so the wrapper's CSS-derived background (rounded dark backdrop)
      // shows through the image's transparent pixels. URLs that point at HTML
      // need an <iframe> so the page actually executes. Customize panel is
      // suppressed downstream since these aren't ours to theme.
      applyObsCssApprox(body, src.settings?.css);
      const url = src.settings.url;
      if (looksLikeImageUrl(url)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = item.name;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        img.style.imageRendering = ir;
        // If the image fails to load (e.g. it was actually HTML), gracefully
        // fall back to an iframe so we still show *something*.
        img.onerror = () => {
          img.remove();
          const iframe = mkIframe(url, item.name, sz);
          body.appendChild(iframe);
        };
        body.appendChild(img);
      } else {
        body.appendChild(mkIframe(url, item.name, sz));
      }
    } else if (src.id === 'color_source') {
      // OBS color source: solid filled rectangle. The H2D template uses this as
      // a full-canvas dark background; rendering it correctly is what makes the
      // editor's visual layout match what OBS would actually composite.
      body.style.background = obsColorToCss(src.settings?.color);
    } else if (src.id === 'image_source' || src.id === 'image_source_v2') {
      const img = document.createElement('img');
      img.src = src.settings?.file || src.settings?.url || '';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.display = 'block';
      img.style.imageRendering = ir;
      body.appendChild(img);
    } else if (src.id === 'text_ft2_source' || src.id === 'text_gdiplus_v2' || src.id === 'text_gdiplus') {
      // Render text source content. Font size scales with the source's natural
      // viewport so the text looks roughly right at any zoom level.
      const text = src.settings?.text || '';
      const font = src.settings?.font || {};
      const fontSize = font.size || 24;
      const div = document.createElement('div');
      div.textContent = text;
      div.style.fontSize = (fontSize * 1.5) + 'px';
      div.style.fontFamily = font.face ? `"${font.face}", sans-serif` : 'sans-serif';
      div.style.color = obsColorToCss(src.settings?.color1 ?? 0xFFFFFFFF);
      div.style.padding = '4px 8px';
      div.style.whiteSpace = 'nowrap';
      body.appendChild(div);
    } else if (src.id === 'ffmpeg_source' || src.id === 'vlc_source' || src.id === 'rtsp_source') {
      // OBS Media Source — typically the printer's RTSP/SDP camera feed.
      // We can't play raw RTSP in browser without a relay, so we render either:
      //   - a per-source override URL the user has set (an MJPEG stream, mp4
      //     loop, or any browser-playable media URL), stored in localStorage
      //     keyed by source UUID so it persists across page loads
      //   - otherwise a placeholder telling the user this is where their
      //     camera feed will appear in OBS
      const overrideKey = `bb-media-override:${src.uuid || src.name}`;
      const overrideUrl = localStorage.getItem(overrideKey);
      if (overrideUrl) {
        const isImg = /\.(jpe?g|png|gif|webp)$|\/video$|mjpeg/i.test(overrideUrl);
        const tag = isImg ? document.createElement('img') : document.createElement('video');
        tag.src = overrideUrl;
        if (!isImg) { tag.autoplay = true; tag.muted = true; tag.loop = true; tag.playsInline = true; }
        tag.style.width = '100%';
        tag.style.height = '100%';
        tag.style.objectFit = 'contain';
        tag.style.background = '#000';
        tag.style.imageRendering = ir;
        body.appendChild(tag);
      } else {
        // Try the RTSP relay WebSocket endpoint (if available).
        // JSMpeg renders MPEG-TS into a <canvas> element.
        fetch('/api/printer/video/status').then(r => r.json()).then(status => {
          if (status.available && typeof JSMpeg !== 'undefined') {
            const canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.background = '#000';
            body.appendChild(canvas);
            const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${wsProto}//${location.host}/api/printer/video`;
            try {
              new JSMpeg.Player(wsUrl, {
                canvas: canvas,
                autoplay: true,
                audio: false,
                loop: true,
                onSourceEstablished: () => { console.log('RTSP stream connected'); },
              });
            } catch (e) {
              console.warn('JSMpeg connect failed:', e);
              showMediaPlaceholder(body, item.name, status.hint);
            }
          } else {
            showMediaPlaceholder(body, item.name, status.hint);
          }
        }).catch(() => {
          showMediaPlaceholder(body, item.name);
        });
      }
    } else {
      // Unknown source type — fall back to a labeled placeholder.
      node.classList.add('placeholder');
      body.innerHTML = `<div class="pname">${escape(item.name)}</div><div class="ptype">${escape(src.id || 'source')}</div>`;
    }

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${item.name} · ${Math.round(sz.w)}×${Math.round(sz.h)}`;

    const move = document.createElement('div');
    move.className = 'move-handle';
    attachDrag(move, idx, /*resize*/ false);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    attachDrag(handle, idx, /*resize*/ true);

    node.appendChild(body);
    node.appendChild(label);
    if (isWidgetSrc(src)) { node.appendChild(move); node.appendChild(handle); }
    node.addEventListener('click', (e) => { e.stopPropagation(); selectItem(idx); });
    c.appendChild(node);
}

const CUST_KEYS = ['theme', 'accent', 'fontSize', 'title', 'pad'];

function widgetUrlForPreview (slug) {
  const cust = state.customizations[slug];
  if (!cust) return `/widgets/${slug}/`;
  const params = new URLSearchParams();
  for (const k of CUST_KEYS) if (cust[k]) params.set(k, cust[k]);
  // Telemetry bindings: each non-default binding becomes `bind.<id>=<path>`.
  // _customizer.js parses these and exposes the resolved values on window.__bindings.
  if (cust.bindings) {
    for (const id of Object.keys(cust.bindings)) {
      const val = cust.bindings[id];
      if (val) params.set('bind.' + id, val);
    }
  }
  const qs = params.toString();
  return `/widgets/${slug}/` + (qs ? '?' + qs : '');
}

// Tiny JSONPath resolver — same logic as the one in _customizer.js, kept in
// sync. Used by renderBindings() to show the live current value next to each
// binding input in the inspector. Supports `$.a.b[0].c`, `a.b[0]`.
function _resolvePath (root, path) {
  if (!path || typeof path !== 'string') return undefined;
  const p = path.replace(/^\$\.?/, '');
  if (p === '') return root;
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p)) !== null) tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  let node = root;
  for (let i = 0; i < tokens.length; i++) {
    if (node == null) return undefined;
    node = node[tokens[i]];
  }
  return node;
}

function renderBindings (slug) {
  const block = document.getElementById('bindings-block');
  const list = document.getElementById('bindings-list');
  if (!block || !list) return;
  const manifest = state.widgetManifests && state.widgetManifests[slug];
  const bindings = manifest && Array.isArray(manifest.bindings) ? manifest.bindings : null;
  if (!bindings || bindings.length === 0) {
    block.style.display = 'none';
    return;
  }
  block.style.display = '';
  list.innerHTML = '';

  // Get current overrides for this widget; lazy-fetch latest /data.json so
  // we can resolve and preview each path's live value next to the input.
  const cust = state.customizations[slug] = state.customizations[slug] || {};
  const overrides = cust.bindings = cust.bindings || {};

  // Fetch /data.json once per render so each binding can show its live value.
  // Cached on state so rapid inspector refreshes don't spam the endpoint.
  const now = Date.now();
  if (!state._dataCache || (now - state._dataCacheAt > 1000)) {
    fetch('/data.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        state._dataCache = data;
        state._dataCacheAt = Date.now();
        // Re-render once data arrives so values populate.
        if (state.selectedIndex >= 0) {
          const cur = state.items[state.selectedIndex];
          const curSrc = state.sources[cur.name];
          if (curSrc && widgetSlugOf(curSrc) === slug) renderBindingsRows(slug, bindings, overrides);
        }
      })
      .catch(() => {});
  }
  renderBindingsRows(slug, bindings, overrides);
}

function renderBindingsRows (slug, bindings, overrides) {
  const list = document.getElementById('bindings-list');
  if (!list) return;
  list.innerHTML = '';
  for (const b of bindings) {
    const row = document.createElement('div');
    row.className = 'bindings-row';
    row.style.cssText = 'display: grid; grid-template-columns: 1fr; gap: 2px; margin-bottom: 8px';

    const label = document.createElement('label');
    label.style.cssText = 'font-size: 11px; color: var(--color-text-dim); display: flex; justify-content: space-between; align-items: baseline; gap: 6px';
    const labelText = document.createElement('span');
    labelText.textContent = b.label || b.id;
    const valueSpan = document.createElement('span');
    valueSpan.className = 'binding-live-value';
    valueSpan.style.cssText = 'font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap';
    label.appendChild(labelText);
    label.appendChild(valueSpan);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.style.cssText = 'font-family: var(--font-mono); font-size: 11px; padding: 4px 6px; width: 100%; box-sizing: border-box';
    input.value = overrides[b.id] || b.default || '';
    input.placeholder = b.default || '';
    if (b.hint) input.title = b.hint;

    const updatePreview = () => {
      const path = input.value.trim();
      const live = _resolvePath(state._dataCache || {}, path);
      let preview = '—';
      if (live !== undefined) {
        if (typeof live === 'object') preview = '{...}';
        else if (typeof live === 'string') preview = '"' + live.slice(0, 30) + '"';
        else preview = String(live);
      }
      valueSpan.textContent = preview;
    };

    input.addEventListener('input', () => {
      const v = input.value.trim();
      // Only mark as override if the value differs from the default — keeps
      // the URL clean when the user resets a binding to its default.
      if (v && v !== b.default) {
        overrides[b.id] = v;
      } else {
        delete overrides[b.id];
      }
      updatePreview();
      updateDiff();
      // Re-render the iframe so the binding takes effect live in the canvas.
      const idx = state.selectedIndex;
      if (idx >= 0) {
        const it = state.items[idx];
        const node = document.querySelector(`.scene-item[data-idx="${idx}"] iframe`);
        if (node) node.src = widgetUrlForPreview(slug);
      }
    });

    row.appendChild(label);
    row.appendChild(input);
    list.appendChild(row);
    updatePreview();
  }
}

// ---- drag / resize ----
function attachDrag (handle, idx, resize) {
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    snapshot(); // record state once at drag start; ignore intra-drag deltas
    const startX = e.clientX, startY = e.clientY;
    const item = state.items[idx];
    const start = { px: item.pos?.x || 0, py: item.pos?.y || 0 };
    const src = state.sources[item.name];
    const baseSize = itemSize(item, src);

    function onMove (ev) {
      let dx = (ev.clientX - startX) / state.zoom;
      let dy = (ev.clientY - startY) / state.zoom;
      // Hold Shift during drag to snap to a 10px grid (matches the canvas
      // grid background). Snap on the resulting absolute coordinate, not on
      // the delta, so the snap point is consistent regardless of where the
      // drag started.
      if (resize) {
        let newW = Math.max(40, baseSize.w + dx);
        let newH = Math.max(20, baseSize.h + dy);
        if (ev.shiftKey) {
          newW = Math.round(newW / SNAP_GRID) * SNAP_GRID;
          newH = Math.round(newH / SNAP_GRID) * SNAP_GRID;
        }
        if (item.bounds_type && item.bounds_type !== 0) {
          item.bounds = { x: newW, y: newH };
        } else {
          item.scale = {
            x: baseSize.naturalW ? newW / baseSize.naturalW : 1,
            y: baseSize.naturalH ? newH / baseSize.naturalH : 1,
          };
        }
      } else {
        let nx = start.px + dx;
        let ny = start.py + dy;
        if (ev.shiftKey) {
          nx = Math.round(nx / SNAP_GRID) * SNAP_GRID;
          ny = Math.round(ny / SNAP_GRID) * SNAP_GRID;
        }
        // Snap to nearest widget edges/centers.
        const snapped = snapToWidgets(nx, ny, idx, baseSize.w, baseSize.h);
        nx = snapped.x;
        ny = snapped.y;
        item.pos = { x: nx, y: ny };
      }
      applyToDom(idx);
      updateDiff();
    }
    function onUp () {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      if (idx === state.selectedIndex) refreshInspector();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function applyToDom (idx) {
  const node = els.canvas().querySelector(`.scene-item[data-idx="${idx}"]`);
  if (!node) return;
  const item = state.items[idx];
  const src = state.sources[item.name];
  const sz = itemSize(item, src);
  node.style.left = (item.pos?.x || 0) + 'px';
  node.style.top  = (item.pos?.y || 0) + 'px';
  node.style.width = sz.w + 'px';
  node.style.height = sz.h + 'px';
  const iframe = node.querySelector('iframe');
  if (iframe) {
    iframe.style.width  = sz.naturalW + 'px';
    iframe.style.height = sz.naturalH + 'px';
    iframe.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
  }
  const lbl = node.querySelector('.label');
  if (lbl) lbl.textContent = `${item.name} · ${Math.round(sz.w)}×${Math.round(sz.h)} (natural ${Math.round(sz.naturalW)}×${Math.round(sz.naturalH)})`;
}

// ---- selection / inspector ----
function selectItem (idx) {
  state.selectedIndex = idx;
  document.querySelectorAll('.scene-item').forEach(n => n.classList.toggle('selected', Number(n.dataset.idx) === idx));
  openInspector();
}

function openInspector () {
  const idx = state.selectedIndex;
  if (idx < 0) return closeInspector();
  els.inspector().classList.add('open');
  refreshInspector();
}

function refreshInspector () {
  const idx = state.selectedIndex;
  if (idx < 0) return;
  const item = state.items[idx];
  const src = state.sources[item.name];
  const sz = itemSize(item, src);
  document.getElementById('insp-name').textContent = item.name;
  document.getElementById('insp-x').value = Math.round(item.pos?.x || 0);
  document.getElementById('insp-y').value = Math.round(item.pos?.y || 0);
  document.getElementById('insp-w').value = Math.round(sz.w);
  document.getElementById('insp-h').value = Math.round(sz.h);
  document.getElementById('insp-w').disabled = false;
  document.getElementById('insp-h').disabled = false;

  const cust = isWidgetSrc(src) ? (state.customizations[widgetSlugOf(src)] || {}) : null;
  document.getElementById('cust-block').style.display = cust ? '' : 'none';
  if (cust !== null) {
    document.getElementById('cust-title').value = cust.title || '';
    document.getElementById('cust-theme').value = cust.theme || '';
    document.getElementById('cust-accent').value = cust.accent ? '#' + cust.accent : '#51a34f';
    document.getElementById('cust-font').value = cust.fontSize || '';
    document.getElementById('cust-pad').value = cust.pad || '';
    // Auto-size button is enabled only once we've received a size measurement
    // for this widget from the iframe.
    const slug = widgetSlugOf(src);
    const measured = state.measuredSizes && state.measuredSizes[slug];
    document.getElementById('autosize-btn').disabled = !measured;
    if (measured) {
      document.getElementById('autosize-btn').textContent = `Auto-size to content (${Math.round(measured.w)}×${Math.round(measured.h)})`;
    } else {
      document.getElementById('autosize-btn').textContent = 'Auto-size to content';
    }

    // Render the Advanced — telemetry bindings sub-section if this widget
    // declares any in its widget.json. See `_customizer.js` for how widgets
    // consume `?bind.<id>=<JSONPath>` URL params and expose values via
    // window.__bindings.
    renderBindings(slug);
  }

  // Phase 14 fields — visible/locked toggles, scale_filter, bounds_align, crop.
  document.getElementById('insp-visible').checked = item.visible !== false;
  document.getElementById('insp-locked').checked  = item.locked === true;
  document.getElementById('insp-scale-filter').value  = item.scale_filter || '';
  document.getElementById('insp-bounds-align').value  = String(item.bounds_align != null ? item.bounds_align : 0);
  document.getElementById('insp-crop-l').value = item.crop_left   || 0;
  document.getElementById('insp-crop-t').value = item.crop_top    || 0;
  document.getElementById('insp-crop-r').value = item.crop_right  || 0;
  document.getElementById('insp-crop-b').value = item.crop_bottom || 0;

  // Layer info — show position in stack
  const total = state.items.length;
  document.getElementById('layer-info').textContent = `${idx + 1} / ${total}`;
  document.getElementById('layer-front').disabled = (idx === total - 1);
  document.getElementById('layer-fwd').disabled   = (idx === total - 1);
  document.getElementById('layer-bwd').disabled   = (idx === 0);
  document.getElementById('layer-back').disabled   = (idx === 0);

  // Media-source override block: only shown for ffmpeg / vlc / rtsp sources.
  // Stored in localStorage so the preview URL persists per source UUID.
  const mediaBlock = document.getElementById('media-block');
  const isMedia = src && (src.id === 'ffmpeg_source' || src.id === 'vlc_source' || src.id === 'rtsp_source');
  mediaBlock.style.display = isMedia ? '' : 'none';
  if (isMedia) {
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    document.getElementById('media-url').value = localStorage.getItem(overrideKey) || '';
  }
}

function closeInspector () {
  els.inspector().classList.remove('open');
}

// Wire inspector inputs
document.addEventListener('DOMContentLoaded', () => {
  ['x','y','w','h'].forEach(k => {
    document.getElementById('insp-' + k).addEventListener('change', (e) => {
      const idx = state.selectedIndex; if (idx < 0) return;
      snapshot();
      const item = state.items[idx];
      const src = state.sources[item.name];
      const v = Number(e.target.value);
      if (k === 'x') item.pos = { ...(item.pos||{x:0,y:0}), x: v };
      else if (k === 'y') item.pos = { ...(item.pos||{x:0,y:0}), y: v };
      else if (k === 'w' || k === 'h') {
        const cur = itemSize(item, src);
        const nw = k === 'w' ? v : cur.w;
        const nh = k === 'h' ? v : cur.h;
        if (item.bounds_type && item.bounds_type !== 0) {
          item.bounds = { x: nw, y: nh };
        } else {
          item.scale = {
            x: cur.naturalW ? nw / cur.naturalW : 1,
            y: cur.naturalH ? nh / cur.naturalH : 1,
          };
        }
      }
      applyToDom(idx);
      updateDiff();
    });
  });
  ['title','theme','accent','font','pad'].forEach(k => {
    document.getElementById('cust-' + k).addEventListener('input', (e) => {
      const idx = state.selectedIndex; if (idx < 0) return;
      const src = state.sources[state.items[idx].name];
      if (!isWidgetSrc(src)) return;
      snapshot();
      const slug = widgetSlugOf(src);
      const cust = state.customizations[slug] = state.customizations[slug] || {};
      const keyMap = { font: 'fontSize', pad: 'pad' };
      const key = keyMap[k] || k;
      let val = e.target.value;
      if (k === 'accent') val = val.replace(/^#/, '');
      if (val === '' || val == null) delete cust[key]; else cust[key] = val;
      // Refresh that iframe's src
      const node = els.canvas().querySelector(`.scene-item[data-idx="${idx}"] iframe`);
      if (node) node.src = widgetUrlForPreview(slug);
      updateDiff();
    });
  });

  // Visible / locked toggles.
  document.getElementById('insp-visible').addEventListener('change', (e) => {
    const idx = state.selectedIndex; if (idx < 0) return;
    snapshot();
    state.items[idx].visible = e.target.checked;
    render(); refreshInspector(); updateDiff();
  });
  document.getElementById('insp-locked').addEventListener('change', (e) => {
    const idx = state.selectedIndex; if (idx < 0) return;
    snapshot();
    state.items[idx].locked = e.target.checked;
    render(); refreshInspector(); updateDiff();
  });

  // Scale filter.
  document.getElementById('insp-scale-filter').addEventListener('change', (e) => {
    const idx = state.selectedIndex; if (idx < 0) return;
    snapshot();
    const v = e.target.value;
    if (v) state.items[idx].scale_filter = v; else delete state.items[idx].scale_filter;
    render(); updateDiff();
  });

  // Bounds align.
  document.getElementById('insp-bounds-align').addEventListener('change', (e) => {
    const idx = state.selectedIndex; if (idx < 0) return;
    snapshot();
    state.items[idx].bounds_align = parseInt(e.target.value, 10);
    render(); updateDiff();
  });

  // Crop fields.
  [['l','crop_left'],['t','crop_top'],['r','crop_right'],['b','crop_bottom']].forEach(([k, field]) => {
    document.getElementById('insp-crop-' + k).addEventListener('change', (e) => {
      const idx = state.selectedIndex; if (idx < 0) return;
      snapshot();
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      if (v) state.items[idx][field] = v; else delete state.items[idx][field];
      render(); updateDiff();
    });
  });

  // Z-order / layer controls — reorder items in the array to change visual stacking.
  // OBS convention: lower index = behind (background), higher index = in front.
  function moveLayer(direction) {
    const idx = state.selectedIndex; if (idx < 0) return;
    const items = state.items;
    const total = items.length;
    let newIdx = idx;

    if (direction === 'front') newIdx = total - 1;
    else if (direction === 'back') newIdx = 0;
    else if (direction === 'fwd' && idx < total - 1) newIdx = idx + 1;
    else if (direction === 'bwd' && idx > 0) newIdx = idx - 1;
    else return; // no change

    if (newIdx === idx) return;
    snapshot();
    const [item] = items.splice(idx, 1);
    items.splice(newIdx, 0, item);
    state.selectedIndex = newIdx;
    render(); refreshInspector(); updateDiff();
  }

  document.getElementById('layer-front').addEventListener('click', () => moveLayer('front'));
  document.getElementById('layer-fwd').addEventListener('click', () => moveLayer('fwd'));
  document.getElementById('layer-bwd').addEventListener('click', () => moveLayer('bwd'));
  document.getElementById('layer-back').addEventListener('click', () => moveLayer('back'));

  // Auto-size button — uses the size last reported by the widget's iframe via
  // postMessage (see _customizer.js:reportSize). One-shot: sets the OBS
  // source's settings.{width,height} to those measured values, snaps to the
  // grid, then re-renders. Disabled until a measurement comes in.
  document.getElementById('autosize-btn').addEventListener('click', () => {
    const idx = state.selectedIndex; if (idx < 0) return;
    const src = state.sources[state.items[idx].name];
    if (!isWidgetSrc(src)) return;
    const slug = widgetSlugOf(src);
    const reported = state.measuredSizes && state.measuredSizes[slug];
    if (!reported) { window.toast && window.toast('No size reported yet — wait a sec', 'warn'); return; }
    snapshot();
    const w = Math.max(40, Math.round(reported.w / 10) * 10);
    const h = Math.max(20, Math.round(reported.h / 10) * 10);
    src.settings = src.settings || {};
    src.settings.width = w;
    src.settings.height = h;
    render();
    window.toast && window.toast(`Sized ${src.name} to ${w}×${h}`);
  });

  // Media source override input — saves to localStorage, re-renders the item.
  document.getElementById('media-url').addEventListener('change', (e) => {
    const idx = state.selectedIndex; if (idx < 0) return;
    const src = state.sources[state.items[idx].name];
    if (!src) return;
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    if (e.target.value) localStorage.setItem(overrideKey, e.target.value);
    else localStorage.removeItem(overrideKey);
    render();
  });
  document.getElementById('media-clear').addEventListener('click', () => {
    const idx = state.selectedIndex; if (idx < 0) return;
    const src = state.sources[state.items[idx].name];
    if (!src) return;
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    localStorage.removeItem(overrideKey);
    document.getElementById('media-url').value = '';
    render();
  });
});

// ---- diff / save / download ----
function modifiedItemNames () {
  if (!state.original) return [];
  const origScene = (state.original.sources || []).find(s => s.id === 'scene' && s.name === state.sceneName);
  const orig = (origScene?.settings?.items || []);
  const out = [];
  state.items.forEach((cur, i) => {
    const o = orig[i];
    if (!o) return;
    const sameXY = (a, b) => Math.abs((a?.x||0) - (b?.x||0)) < 0.5 && Math.abs((a?.y||0) - (b?.y||0)) < 0.5;
    const samePos    = sameXY(cur.pos, o.pos);
    const sameScale  = sameXY(cur.scale, o.scale);
    const sameBounds = sameXY(cur.bounds, o.bounds);
    const sameFlags  = cur.visible === o.visible && cur.locked === o.locked;
    const sameCrop   = cur.crop_left === o.crop_left && cur.crop_top === o.crop_top
                    && cur.crop_right === o.crop_right && cur.crop_bottom === o.crop_bottom;
    const sameMisc   = cur.scale_filter === o.scale_filter && cur.bounds_align === o.bounds_align;
    if (!(samePos && sameScale && sameBounds && sameFlags && sameCrop && sameMisc)) out.push(cur.name);
  });
  // Plus any widget with customizations
  for (const slug of Object.keys(state.customizations)) {
    if (Object.keys(state.customizations[slug]).length) out.push(`*${slug}`);
  }
  return out;
}

function updateDiff () {
  const mod = modifiedItemNames();
  const total = state.items.length;
  els.diff().innerHTML = mod.length
    ? `<span class="modified">${mod.length} modified</span> / ${total} total`
    : `${total} items, no changes`;
}

function applyChangesToCollection () {
  // Clone original, then mutate items + browser-source URLs.
  const clone = structuredClone(state.original);
  const scene = (clone.sources || []).find(s => s.id === 'scene' && s.name === state.sceneName);
  if (scene && scene.settings) scene.settings.items = state.items;
  // Apply customizations to browser-source URLs
  (clone.sources || []).forEach(src => {
    if (!isWidgetSrc(src)) return;
    const slug = widgetSlugOf(src);
    const cust = state.customizations[slug];
    const hasBindings = cust && cust.bindings && Object.keys(cust.bindings).length > 0;
    if (!cust || (!Object.keys(cust).filter(k => k !== 'bindings').length && !hasBindings)) return;
    const base = src.settings.url.split('?')[0];
    const params = new URLSearchParams();
    for (const k of CUST_KEYS) if (cust[k]) params.set(k, cust[k]);
    if (hasBindings) {
      for (const id of Object.keys(cust.bindings)) {
        const v = cust.bindings[id];
        if (v) params.set('bind.' + id, v);
      }
    }
    src.settings.url = params.toString() ? `${base}?${params.toString()}` : base;
  });
  return clone;
}

// Server's SAFE_NAME regex is /^[a-zA-Z0-9_\-. ]{1,64}$/. Any other char
// (most commonly `<` and `>` left over from unsubstituted `<VERSION>`
// placeholders, or `/` `:` from user free-text) makes the save fail with
// "invalid name". Replace disallowed chars with `_`, collapse runs, and
// clamp to 64 chars so save flows always succeed.
function sanitizeSceneName (raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '')
    .slice(0, 64);
}

async function onSave () {
  if (!state.original) return window.toast('Nothing loaded', 'error');
  const raw = prompt('Save scene as:', '');
  if (!raw) return;
  const name = sanitizeSceneName(raw);
  if (!name) return window.toast('Save failed: name had no usable characters', 'error');
  const out = applyChangesToCollection();
  const r = await fetch('/api/obs/scenes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, json: out }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ok) window.toast(`Saved as "${name}"`); else window.toast('Save failed: ' + (j.error || ''), 'error');
}

async function onDownload () {
  if (!state.original) return window.toast('Nothing loaded', 'error');
  const out = applyChangesToCollection();
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fname = (state.original.name || 'bambuboard-scene').replace(/[^a-z0-9_\-]/gi, '_') + '.json';
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
  window.toast('Downloaded ' + fname);
}

// Workflow Step 3 → Step 4 transition. Saves the current scene with a default
// timestamped name (so the user doesn't have to think of one), then navigates
// to the Export page (/) where they can download it for OBS.
async function onSaveAndContinue () {
  if (!state.original) return window.toast('Nothing to save — load a template first', 'error');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  // Sanitize against the server's SAFE_NAME regex (no `<` `>` `:` etc).
  // Older loaded templates may still have a literal `<VERSION>` baked
  // into state.original.name and the server would 400 those.
  const name = sanitizeSceneName((state.original.name || 'MyScene') + '-' + stamp);
  const out = applyChangesToCollection();
  try {
    const r = await fetch('/api/obs/scenes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, json: out }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      window.toast('Save failed: ' + (j.error || ''), 'error');
      return;
    }
  } catch (e) {
    window.toast('Save failed: ' + e.message, 'error');
    return;
  }
  // Pass the just-saved slug via hash so the Export page can highlight it.
  location.href = '/#saved=' + encodeURIComponent(name);
}

function escape (s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

function showMediaPlaceholder (body, name, hint) {
  const setupSteps = [
    'On the printer touchscreen:',
    'Settings → Network → LAN Only Liveview → ON',
    'Reboot the printer after toggling',
    'Firmware 01.06+ required for RTSP',
  ];
  const setupHtml = `<div style="margin-top:8px;font-size:9px;line-height:1.5;opacity:0.55;text-align:left;max-width:280px;margin-left:auto;margin-right:auto">${setupSteps.map(s => s).join('<br>')}</div>`;
  const hintHtml = hint
    ? `<div class="ptype" style="margin-top:6px;font-size:10px;color:#e2a04a">${escape(hint)}</div>${setupHtml}`
    : `<div class="ptype" style="margin-top:4px;font-size:10px;opacity:0.6">Click to set a manual preview URL in the inspector</div>${setupHtml}`;
  body.innerHTML = `
    <div class="pname">📹 ${escape(name)}</div>
    <div class="ptype">Camera / video feed</div>
    ${hintHtml}
  `;
  body.parentElement?.classList.add('placeholder');
}

// Surface the active canvas resolution in the toolbar. Clicking it lets the
// user pick a preset (matching the common OBS Base Canvas Resolutions) or
// type a custom value. The resolution is round-tripped on Download/Save —
// applies to the JSON's top-level `resolution` field.
function updateCanvasInfoBtn () {
  const btn = document.getElementById('canvas-res-btn');
  if (btn) btn.textContent = `${CANVAS_W}×${CANVAS_H}`;
}

function pickCanvasResolution () {
  const presets = [
    '1920×1080 (Full HD)',
    '2560×1440 (2K / QHD)',
    '3840×2160 (4K / UHD)',
    '1280×720 (HD)',
    '1280×800 (720p widescreen)',
    'Custom…',
  ];
  const labels = presets.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const cur = `${CANVAS_W}×${CANVAS_H}`;
  const choice = prompt(`Set canvas resolution\n(current: ${cur}; this must match your OBS Settings → Video → Base (Canvas) Resolution)\n\n${labels}`, '1');
  if (!choice) return;
  const idx = parseInt(choice, 10) - 1;
  let w = CANVAS_W, h = CANVAS_H;
  if (idx === 0)      { w = 1920; h = 1080; }
  else if (idx === 1) { w = 2560; h = 1440; }
  else if (idx === 2) { w = 3840; h = 2160; }
  else if (idx === 3) { w = 1280; h = 720;  }
  else if (idx === 4) { w = 1280; h = 800;  }
  else if (idx === 5) {
    const custom = prompt(`Enter custom resolution (e.g. "1920x1080")`, cur.replace('×', 'x'));
    if (!custom) return;
    const m = custom.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) { window.toast && window.toast('Invalid format. Use WIDTHxHEIGHT.', 'error'); return; }
    w = parseInt(m[1], 10);
    h = parseInt(m[2], 10);
    if (!w || !h || w < 320 || h < 240 || w > 8000 || h > 8000) {
      window.toast && window.toast('Resolution out of range (320×240 to 8000×8000)', 'error');
      return;
    }
  }
  if (w === CANVAS_W && h === CANVAS_H) return;
  snapshot();

  // Scale all widget positions and sizes proportionally to the new resolution.
  const scaleX = w / CANVAS_W;
  const scaleY = h / CANVAS_H;
  state.items.forEach(item => {
    if (item.pos) {
      item.pos = { x: item.pos.x * scaleX, y: item.pos.y * scaleY };
    }
    // Scale bounds (bounds_type items)
    if (item.bounds_type && item.bounds_type !== 0 && item.bounds) {
      item.bounds = { x: item.bounds.x * scaleX, y: item.bounds.y * scaleY };
    } else if (item.scale) {
      // Scale-driven items: multiply scale by the ratio.
      item.scale = { x: item.scale.x * scaleX, y: item.scale.y * scaleY };
    }
  });

  CANVAS_W = w;
  CANVAS_H = h;
  // Reflect the change in the loaded JSON so Save/Download round-trips it.
  state.original.resolution = { x: w, y: h };
  state.original.migration_resolution = { x: w, y: h };
  updateCanvasInfoBtn();
  fitZoom();
  render();
  window.toast && window.toast(`Canvas: ${w}×${h}. Widgets scaled proportionally.`);
}

// ---- Auto-layout ----
//
// Role-aware layout engine. Each widget has an implicit "role" derived from
// its source URL slug (or source type for non-widget items). The layout uses
// these roles to decide placement zones and pairing rules rather than blind
// column clustering.
//
// Layout zones (for a typical BambuBoard OBS overlay):
//   TOP:    progress bar (full-width, y=0)
//   LEFT:   print stats column (~400px wide, anchored to left edge)
//   CENTER: profile, printer info (between left column and right column)
//   RIGHT:  model image, logo (anchored to right edge)
//   BOTTOM: notes bar (full-width, anchored to bottom)
//   CORNER: version (bottom-right corner)
//
// Pairing: nozzle-temp + nozzle-temp-2 sit side by side (half-column each).
// Same for ams + ams2 (half-column each).

const AUTO_LAYOUT_GAP = 4;
const AUTO_LAYOUT_GRID = 10;

// Widget slug → layout role. Items not in this map get 'unknown' and are
// placed after known items in whatever column they were closest to.
const LAYOUT_ROLES = {
  // Full-width anchors
  'progress-info': { zone: 'top',    order: 0 },
  'notes':         { zone: 'bottom', order: 0 },
  'version':       { zone: 'corner', order: 0 },
  // Left column — single items (stacked top to bottom in this order)
  'print-info':    { zone: 'left', order: 1 },
  'chamber-temp':  { zone: 'left', order: 2 },
  'bed-temp':      { zone: 'left', order: 3 },
  'ams-temp':      { zone: 'left', order: 4 },
  'ams-temp-2':    { zone: 'left', order: 5 },
  // Left column — paired items (side by side)
  'nozzle-temp-2': { zone: 'left-pair-a', order: 6, pair: 'nozzle-temp' },
  'nozzle-temp':   { zone: 'left-pair-b', order: 6, pair: 'nozzle-temp-2' },
  'ams':           { zone: 'left-pair-a', order: 7, pair: 'ams2' },
  'ams2':          { zone: 'left-pair-b', order: 7, pair: 'ams' },
  // Left column — bottom
  'fans':          { zone: 'left', order: 8 },
  // Center column
  'profile-info':  { zone: 'center', order: 1 },
  'printer-info':  { zone: 'center', order: 2 },
  // Right column
  'model-image':   { zone: 'right', order: 1 },
};

function autoLayout () {
  if (!state.items.length) return;
  snapshot();
  const snap = (n) => Math.round(n / AUTO_LAYOUT_GRID) * AUTO_LAYOUT_GRID;
  const GAP = AUTO_LAYOUT_GAP;

  // Measure all items.
  const measured = state.items.map((item, idx) => {
    const src = state.sources[item.name];
    const sz = itemSize(item, src);
    const slug = src && isWidgetSrc(src) ? widgetSlugOf(src) : null;
    const sourceId = src?.id || '';
    return {
      item, idx, slug, sourceId,
      x: item.pos?.x || 0, y: item.pos?.y || 0,
      w: sz.w, h: sz.h,
    };
  });

  // Assign roles.
  const getRole = (m) => {
    if (m.slug && LAYOUT_ROLES[m.slug]) return LAYOUT_ROLES[m.slug];
    // Non-widget items: color_source → background, media sources → camera layer
    if (m.sourceId === 'color_source') return { zone: 'background', order: -1 };
    // Media sources (camera feed) — keep in place as a background layer
    if (m.sourceId === 'ffmpeg_source' || m.sourceId === 'vlc_source' || m.sourceId === 'rtsp_source')
      return { zone: 'camera', order: 0 };
    // Full-width items are anchors
    if (m.w >= CANVAS_W * 0.7) return { zone: 'top', order: 99 };
    // Items on the right side of canvas → right column
    if (m.x > CANVAS_W * 0.6) return { zone: 'right', order: 99 };
    // Items in center → center
    if (m.x > CANVAS_W * 0.2 && m.x < CANVAS_W * 0.6) return { zone: 'center', order: 99 };
    // Everything else → left
    return { zone: 'left', order: 99 };
  };

  // Separate by zone.
  const zones = {};
  measured.forEach(m => {
    const role = getRole(m);
    m.role = role;
    if (!zones[role.zone]) zones[role.zone] = [];
    zones[role.zone].push(m);
  });

  // Sort each zone by order, then by current Y.
  for (const z in zones) {
    zones[z].sort((a, b) => (a.role.order - b.role.order) || (a.y - b.y));
  }

  // Define column geometry (relative to canvas).
  const LEFT_X = 0;
  const LEFT_W = Math.round(CANVAS_W * 0.21); // ~400px at 1920
  const CENTER_X = LEFT_W + GAP;
  const RIGHT_X = Math.round(CANVAS_W * 0.83); // ~1600 at 1920
  const BOTTOM_NOTES_H = 60;

  // Find progress bar height to know where content starts.
  const topItems = zones['top'] || [];
  let contentTop = 0;
  topItems.forEach(m => {
    m.item.pos = { x: snap(m.x), y: snap(m.y) }; // keep top items where they are
    contentTop = Math.max(contentTop, m.y + m.h + GAP);
  });
  contentTop = snap(contentTop) || snap(100); // default below a typical progress bar

  // Place background items (color source) at 0,0 full canvas.
  (zones['background'] || []).forEach(m => {
    m.item.pos = { x: 0, y: 0 };
  });

  // Camera / media sources — keep in their current position (they're a
  // background layer behind widgets, not something to rearrange).
  (zones['camera'] || []).forEach(m => {
    m.item.pos = { x: snap(m.x), y: snap(m.y) };
  });

  // --- LEFT COLUMN ---
  let leftY = contentTop;
  const leftSingles = (zones['left'] || []);
  const leftPairA = (zones['left-pair-a'] || []);
  const leftPairB = (zones['left-pair-b'] || []);
  const halfW = Math.round((LEFT_W - GAP) / 2);

  // Interleave singles and pairs by order number.
  const leftAll = [
    ...leftSingles.map(m => ({ ...m, type: 'single' })),
    ...leftPairA.map(m => ({ ...m, type: 'pair-a' })),
  ].sort((a, b) => (a.role.order - b.role.order) || (a.y - b.y));

  // Group by order to handle pairs.
  const orderGroups = {};
  leftAll.forEach(m => {
    const key = m.role.order;
    if (!orderGroups[key]) orderGroups[key] = [];
    orderGroups[key].push(m);
  });
  // Also index pair-b items by order for pairing.
  const pairBByOrder = {};
  leftPairB.forEach(m => { pairBByOrder[m.role.order] = m; });

  const orderKeys = Object.keys(orderGroups).map(Number).sort((a, b) => a - b);
  orderKeys.forEach(order => {
    const group = orderGroups[order];
    group.forEach(m => {
      if (m.type === 'single') {
        // Full-width single item in the left column.
        m.item.pos = { x: snap(LEFT_X), y: snap(leftY) };
        leftY = snap(leftY + m.h + GAP);
      } else if (m.type === 'pair-a') {
        // Left half of a pair.
        const partner = pairBByOrder[order];
        const pairH = partner ? Math.max(m.h, partner.h) : m.h;
        m.item.pos = { x: snap(LEFT_X), y: snap(leftY) };
        if (partner) {
          partner.item.pos = { x: snap(LEFT_X + halfW + GAP), y: snap(leftY) };
        }
        leftY = snap(leftY + pairH + GAP);
      }
    });
  });

  // --- CENTER COLUMN ---
  let centerY = contentTop;
  (zones['center'] || []).forEach(m => {
    m.item.pos = { x: snap(CENTER_X), y: snap(centerY) };
    centerY = snap(centerY + m.h + GAP);
  });

  // --- RIGHT COLUMN ---
  // Logo stays at top-right if present; model image below it.
  let rightY = 0;
  // Find logo (non-widget browser source at top-right, or any item in right zone with small height)
  const rightItems = (zones['right'] || []).sort((a, b) => a.y - b.y);
  rightItems.forEach(m => {
    // Anchor to right edge.
    const rx = snap(CANVAS_W - m.w);
    if (rightY < contentTop && m.h < 100) {
      // Small item (logo) — place at very top right.
      m.item.pos = { x: rx, y: snap(rightY) };
      rightY = snap(rightY + m.h + GAP);
      if (rightY < contentTop) rightY = contentTop;
    } else {
      if (rightY < contentTop) rightY = contentTop;
      m.item.pos = { x: rx, y: snap(rightY) };
      rightY = snap(rightY + m.h + GAP);
    }
  });

  // --- BOTTOM ---
  (zones['bottom'] || []).forEach(m => {
    m.item.pos = { x: snap(m.x), y: snap(CANVAS_H - m.h) };
  });

  // --- CORNER (version) ---
  (zones['corner'] || []).forEach(m => {
    m.item.pos = { x: snap(CANVAS_W - m.w), y: snap(CANVAS_H - m.h - BOTTOM_NOTES_H) };
  });

  render();
  const count = measured.filter(m => m.role.zone !== 'background').length;
  window.toast && window.toast(`Auto-layout: arranged ${count} items`);
}

// ---- Widget drawer (right slide-out panel) ----
// Lists all available widgets. Users drag tiles from the drawer onto the canvas
// to add new browser sources to their scene.

function toggleWidgetDrawer () {
  const drawer = document.getElementById('widget-drawer');
  drawer.classList.toggle('open');
}
function closeWidgetDrawer () {
  document.getElementById('widget-drawer').classList.remove('open');
}

async function populateWidgetDrawer () {
  const list = document.getElementById('widget-drawer-list');
  if (!list) return;
  let widgets = [];
  try { widgets = await fetch('/api/widgets').then(r => r.json()); } catch (_) {}
  // Stash the full manifest list so the inspector can look up `bindings`
  // declarations without re-fetching. Keyed by slug.
  state.widgetManifests = state.widgetManifests || {};
  widgets.forEach(w => { state.widgetManifests[w.slug] = w; });
  list.innerHTML = '';
  widgets.forEach(w => {
    const tile = document.createElement('div');
    tile.className = 'drawer-widget';
    tile.draggable = true;
    tile.title = `Drag to add ${w.name || w.slug} to the canvas`;

    const preview = document.createElement('div');
    preview.className = 'dw-preview';
    const iframe = document.createElement('iframe');
    iframe.src = `/widgets/${w.slug}/`;
    iframe.loading = 'lazy';
    iframe.tabIndex = -1;
    preview.appendChild(iframe);

    const info = document.createElement('div');
    info.className = 'dw-info';
    const name = document.createElement('div');
    name.className = 'dw-name';
    name.textContent = w.name || w.slug;
    const size = document.createElement('div');
    size.className = 'dw-size';
    const rw = w.recommendedSize?.w || 400;
    const rh = w.recommendedSize?.h || 200;
    size.textContent = `${rw}×${rh}`;
    info.appendChild(name);
    info.appendChild(size);

    tile.appendChild(preview);
    tile.appendChild(info);

    // Drag data: slug + recommended dimensions
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-bambuboard-widget', JSON.stringify({
        slug: w.slug,
        name: w.name || w.slug,
        width: rw,
        height: rh,
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });

    list.appendChild(tile);
  });
}

function setupCanvasDrop () {
  const canvas = els.canvas();
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-bambuboard-widget')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('drag-over');
  });
  canvas.addEventListener('dragleave', () => {
    canvas.classList.remove('drag-over');
  });
  canvas.addEventListener('drop', (e) => {
    canvas.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('application/x-bambuboard-widget');
    if (!raw) return;
    e.preventDefault();
    if (!state.original) {
      window.toast && window.toast('Load a scene first before adding widgets', 'warn');
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }

    // Compute canvas-space coordinates from the drop point. The canvas is
    // scaled by state.zoom, so we need to un-scale the offset.
    const rect = canvas.getBoundingClientRect();
    const posX = Math.round((e.clientX - rect.left) / state.zoom);
    const posY = Math.round((e.clientY - rect.top) / state.zoom);

    addWidgetToScene(data.slug, data.name, data.width, data.height, posX, posY);
  });
}

// Add a new widget browser source to the current scene.
// Creates both a source entry (in state.sources) and a scene item (in state.items).
function addWidgetToScene (slug, name, width, height, posX, posY) {
  snapshot();

  // Generate a unique source name — avoid collisions with existing sources.
  let srcName = name;
  let suffix = 1;
  while (state.sources[srcName]) {
    suffix++;
    srcName = `${name} ${suffix}`;
  }

  // Build the OBS-compatible source object
  const source = {
    id: 'browser_source',
    name: srcName,
    uuid: crypto.randomUUID ? crypto.randomUUID() : `bb-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: true,
    settings: {
      url: `http://${location.host}/widgets/${slug}/`,
      width: width,
      height: height,
      css: '',
      fps: 30,
      fps_custom: false,
      reroute_audio: false,
      shutdown: false,
    },
    volume: 1,
    balance: 0.5,
    muted: false,
    mixers: 255,
    monitoring_type: 0,
  };

  // Register the source
  state.sources[srcName] = source;

  // Also add the source to the original's sources array so it round-trips
  // on Save/Download.
  if (state.original && Array.isArray(state.original.sources)) {
    state.original.sources.push(source);
  }

  // Build the scene item (transform properties)
  const item = {
    name: srcName,
    pos: { x: posX, y: posY },
    scale: { x: 1, y: 1 },
    bounds: { x: 0, y: 0 },
    bounds_type: 0,
    align: 5, // top-left anchor — most intuitive for drag-and-drop
    visible: true,
    locked: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    rot: 0,
    blend_type: 'normal',
  };

  state.items.push(item);
  render();
  updateDiff();

  // Select the new item and open the inspector
  const newIdx = state.items.length - 1;
  selectItem(newIdx);

  window.toast && window.toast(`Added "${srcName}" at ${posX},${posY}`);
}
