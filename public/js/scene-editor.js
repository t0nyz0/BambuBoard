// OBS scene-collection editor.
//   Loads a template, saved draft, or uploaded JSON and renders the selected scene
//   as a scaled 1920×1080 canvas with live widget iframes positioned at their
//   real OBS coordinates. Drag to move, drag the bottom-right handle to
//   resize. Click a widget tile to open the inspector for theme/accent/font
//   plus exact position and size. Save the draft independently of Live.
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
  sceneName: null,       // currently-selected OBS scene name *inside* the collection
  savedSlug: null,       // stable storage ID of this collection
  savedRevision: null,
  savedName: '',
  draftName: '',
  draftConflict: false,
  liveSceneName: null,   // scene in this collection chosen for live output
  live: null,            // current output metadata from the server
  sources: {},           // name → source object (lookup)
  items: [],             // scene items, in render order
  selectedIndex: -1,
  customizations: {},    // source UUID/name → { theme, accent, fontSize, bindings }
  zoom: 1,
  // Scene edits and whole-draft edits have separate scope in the undo history.
  history: [],
  future: [],
  pendingEdit: null,
  savedCollection: null,
  savedFingerprint: null,
  loaderValue: null,
  loading: false,
  saving: false,
};

const SNAP_GRID = 10;       // px when shift held during drag
const SNAP_PROXIMITY = 8;   // px — snap to widget edges when within this distance
const compactEditor = window.matchMedia('(max-width: 700px)');

const els = {
  canvas:    () => document.getElementById('canvas'),
  wrap:      () => document.getElementById('canvas-wrap'),
  shell:     () => document.getElementById('canvas-shell'),
  loader:    () => document.getElementById('loader'),
  scenes:    () => document.getElementById('scene-picker'),
  liveScenes: () => document.getElementById('live-scene-picker'),
  draftName: () => document.getElementById('draft-name'),
  fileIn:    () => document.getElementById('file-input'),
  inspector: () => document.getElementById('inspector'),
  diff:      () => document.getElementById('diff'),
  zoomLbl:   () => document.getElementById('zoom-label'),
  layersPanel: () => document.getElementById('layers-panel'),
  layersList:  () => document.getElementById('layers-panel-list'),
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
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.inert = true;
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

// A scene's history records only the fields its own edit changed. An undo in
// one scene must not restore earlier copies of other scenes or shared sources.
function captureDraft () {
  const { sources, ...collection } = structuredClone(state.original);
  const byKey = Object.create(null);
  const counts = new Map();
  for (const source of sources) {
    const name = source?.name;
    const occurrence = (counts.get(name) || 0) + 1;
    counts.set(name, occurrence);
    const key = JSON.stringify([name, occurrence]);
    if (source?.id === 'scene' && name === state.sceneName) source.settings.items = structuredClone(state.items);
    byKey[key] = source;
  }
  return { collection, sources: byKey, customizations: structuredClone(state.customizations), draftName: state.draftName, liveSceneName: state.liveSceneName };
}

function sameEditValue (a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectEditChanges (before, after, path, changes) {
  if (sameEditValue(before, after)) return;
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      collectEditChanges(Object.hasOwn(before, key) ? before[key] : undefined, Object.hasOwn(after, key) ? after[key] : undefined, [...path, key], changes);
    }
  } else {
    changes.push({ path, before, after });
  }
}

function finishEdit () {
  const pending = state.pendingEdit;
  if (!pending) return;
  state.pendingEdit = null;
  const changes = [];
  collectEditChanges(pending.before, captureDraft(), [], changes);
  if (!changes.length) return;
  state.history.push({ scope: pending.scope, changes });
  if (state.history.length > 100) state.history.shift();
  state.future = state.future.filter(entry => pending.scope !== null && entry.scope !== null && entry.scope !== pending.scope);
}

function snapshot (scope = state.sceneName) {
  if (!state.original) return;
  finishEdit();
  state.pendingEdit = { scope, before: captureDraft() };
  updateUndoButtons();
}

function historyIndex (stack) {
  return stack.findLastIndex(entry => entry.scope === null || entry.scope === state.sceneName);
}

function replayEdit (from, to, expected, replacement) {
  const index = historyIndex(state[from]);
  if (index < 0) return updateUndoButtons();
  const entry = state[from][index];
  const edit = captureDraft();
  for (const change of entry.changes) {
    const path = change.path;
    const parent = path.slice(0, -1).reduce((obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined, edit);
    const key = path.at(-1);
    const value = parent && Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (!parent || !sameEditValue(value, change[expected])) {
      window.toast('A later edit changed one of the same settings. Undo that edit first.', 'error');
      return updateUndoButtons();
    }
    if (change[replacement] === undefined) delete parent[key];
    else Object.defineProperty(parent, key, { value: structuredClone(change[replacement]), writable: true, enumerable: true, configurable: true });
  }
  const item = state.items[state.selectedIndex];
  const selection = item && {
    id: item.id,
    name: item.name,
    occurrence: state.items.slice(0, state.selectedIndex).filter(other => other.name === item.name).length,
  };
  state[from].splice(index, 1);
  state[to].push(entry);
  hydrateCollection({ ...edit.collection, sources: Object.values(edit.sources) }, { draftName: edit.draftName, liveSceneName: edit.liveSceneName, sceneName: state.sceneName, customizations: edit.customizations, selection });
  updateUndoButtons();
}

function undo () {
  finishEdit();
  replayEdit('history', 'future', 'after', 'before');
}

function redo () {
  finishEdit();
  replayEdit('future', 'history', 'before', 'after');
}

function updateUndoButtons () {
  const pending = state.pendingEdit?.scope;
  const currentEdit = pending === null || pending === state.sceneName;
  document.getElementById('undo-btn').disabled = !state.original || (!currentEdit && historyIndex(state.history) < 0);
  document.getElementById('redo-btn').disabled = !state.original || currentEdit || historyIndex(state.future) < 0;
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
    if (e.defaultPrevented || e.target.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape' && e.target.closest('.editor-workspace')) {
      const fromInspector = Boolean(e.target.closest('#inspector'));
      deselectItem();
      if (fromInspector) focusLayersButton();
      return;
    }
    if (state.selectedIndex < 0 || !e.target.closest('#canvas, .layer-row.selected .lr-name')) return;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft')  dx = -step;
    if (e.key === 'ArrowRight') dx =  step;
    if (e.key === 'ArrowUp')    dy = -step;
    if (e.key === 'ArrowDown')  dy =  step;
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    if (state.items[state.selectedIndex]?.locked) return;
    snapshot();
    const item = state.items[state.selectedIndex];
    item.pos = { x: (item.pos?.x || 0) + dx, y: (item.pos?.y || 0) + dy };
    applyToDom(state.selectedIndex);
    refreshInspector();
    updateDiff();
  });

  els.fileIn().addEventListener('change', onFileUpload);
  document.getElementById('save-btn').addEventListener('click', onSave);
  document.getElementById('save-copy-btn').addEventListener('click', onSaveCopy);
  document.getElementById('preview-btn').addEventListener('click', onPreview);
  document.getElementById('golive-btn').addEventListener('click', onGoLive);
  document.getElementById('restore-live-btn').addEventListener('click', restoreLive);
  document.getElementById('reset-btn').addEventListener('click', resetDraft);
  els.draftName().addEventListener('input', event => {
    if (!state.nameEditing) { snapshot(null); state.nameEditing = true; }
    state.draftName = event.target.value;
    updateDiff();
  });
  els.draftName().addEventListener('blur', () => {
    if (!state.nameEditing) return;
    state.nameEditing = false;
    finishEdit();
    updateUndoButtons();
  });
  els.liveScenes().addEventListener('change', event => {
    snapshot(null);
    state.liveSceneName = event.target.value;
    finishEdit();
    updateUndoButtons();
    updateDiff();
  });
  document.getElementById('undo-btn').addEventListener('click', undo);
  document.getElementById('redo-btn').addEventListener('click', redo);
  document.getElementById('autolayout-btn').addEventListener('click', autoLayout);
  document.getElementById('canvas-res-btn').addEventListener('click', pickCanvasResolution);
  updateCanvasInfoBtn();

  // Keep each iframe’s measurements separate, including repeated widget types.
  state.measuredFrames = new WeakSet();
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.origin !== location.origin || message?.type !== 'bambuboard:size') return;
    const { slug, w, h } = message;
    if (!slug || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const frame = Array.from(els.canvas().querySelectorAll('.scene-item iframe')).find(iframe => iframe.contentWindow === event.source);
    if (!frame || !frame.getAttribute('src')?.startsWith(`/widgets/${slug}/`)) return;
    state.measuredFrames.add(frame);
    const item = state.items[state.selectedIndex];
    const source = state.sources[item?.name];
    if (state.selectedIndex === Number(frame.closest('.scene-item').dataset.idx)) refreshAutoSizeButton(item, source);
  });
  document.getElementById('inspector-close').addEventListener('click', () => {
    deselectItem();
    focusLayersButton();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.canvas-shell') && !e.target.closest('.scene-item')) deselectItem();
  });

  for (const panel of ['layers', 'widgets', 'inspector']) {
    const toggle = panelControl(panel);
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      showPanel(open ? (panel === 'layers' ? 'none' : 'layers') : panel);
    });
  }
  document.getElementById('widget-drawer-close').addEventListener('click', () => {
    showPanel('layers');
    panelControl('widgets').focus();
  });
  document.getElementById('layers-panel-close').addEventListener('click', () => {
    showPanel('none');
    focusLayersButton();
  });
  document.getElementById('layer-front').addEventListener('click', () => moveItemFromTo(state.selectedIndex, state.items.length - 1));
  document.getElementById('layer-back').addEventListener('click', () => moveItemFromTo(state.selectedIndex, 0));
  compactEditor.addEventListener('change', updatePanelButtons);
  updatePanelButtons();
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
  const startingRequest = loadRequest;
  const active = await refreshPublicationState();
  if (startingRequest !== loadRequest || state.loaderValue) return;
  const saved = scnR.find(scene => scene.slug === active?.slug) || scnR[0];
  if (saved) {
    sel.value = `scn:${saved.slug}`;
    sel.dispatchEvent(new Event('change'));
    return;
  }
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

let loadRequest = 0;
async function onLoaderChange (e) {
  const select = e.target;
  const v = select.value;
  if (!v) return;
  if (state.saving || (hasUnsavedChanges() && !confirm('Discard unsaved draft changes and load another layout?'))) {
    select.value = state.loaderValue || '';
    return;
  }
  if (v === 'upload') { els.fileIn().value = ''; els.fileIn().click(); select.value = state.loaderValue || ''; return; }
  const requestId = ++loadRequest;
  const divider = v.indexOf(':');
  const kind = v.slice(0, divider), slug = v.slice(divider + 1);
  const label = select.selectedOptions[0]?.textContent || slug;
  const beforeLoad = draftFingerprint();
  state.loading = true;
  updateDiff();
  try {
    const url = kind === 'tpl' ? `/api/obs/templates/${encodeURIComponent(slug)}/raw` : `/api/obs/scenes/${encodeURIComponent(slug)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Request returned ${r.status}`);
    const json = await r.json();
    if (requestId !== loadRequest) return;
    if (beforeLoad !== draftFingerprint() && !confirm('Discard edits made while this layout was loading?')) {
      select.value = state.loaderValue || '';
      return;
    }
    loadCollection(json, {
      savedSlug: kind === 'scn' ? slug : null,
      savedRevision: r.headers.get('X-Draft-Revision'),
      name: kind === 'scn' ? r.headers.get('X-Draft-Name') || label : label,
    });
    state.loaderValue = v;
  } catch (error) {
    if (requestId !== loadRequest) return;
    select.value = state.loaderValue || '';
    window.toast('Load failed: ' + error.message, 'error');
  } finally {
    if (requestId === loadRequest) { state.loading = false; updateDiff(); }
  }
}

function onFileUpload (e) {
  const f = e.target.files[0];
  if (!f || state.saving) return;
  const beforeLoad = draftFingerprint();
  const requestId = ++loadRequest;
  state.loading = true;
  updateDiff();
  const fr = new FileReader();
  fr.onload = () => {
    if (requestId !== loadRequest) return;
    try {
      if (beforeLoad !== draftFingerprint() && !confirm('Discard edits made while this file was loading?')) return;
      loadCollection(JSON.parse(fr.result), { name: (f.name || '').replace(/\.[^.]+$/, '') });
      state.loaderValue = '';
      els.loader().value = '';
    } catch (err) { window.toast('Invalid JSON: ' + err.message, 'error'); }
    finally { state.loading = false; updateDiff(); }
  };
  fr.onerror = () => {
    if (requestId !== loadRequest) return;
    state.loading = false;
    updateDiff();
    window.toast('Could not read that file.', 'error');
  };
  fr.readAsText(f);
}

function loadCollection (json, identity = {}) {
  const scenes = Array.isArray(json?.sources) ? json.sources.filter(s => s?.id === 'scene') : [];
  if (!scenes.length || scenes.some(s => !s.name || !Array.isArray(s.settings?.items))) {
    throw new Error('The file must contain an OBS scene with a sources and items array.');
  }
  state.history = [];
  state.future = [];
  state.pendingEdit = null;
  state.nameEditing = false;
  state.savedSlug = identity.savedSlug || null;
  state.savedRevision = identity.savedRevision || null;
  state.savedName = (state.savedSlug ? identity.name : sanitizeSceneName(identity.name)) || sanitizeSceneName(scenes[0].name);
  state.draftConflict = false;
  hydrateCollection(json, { draftName: state.savedName });
  state.savedCollection = applyChangesToCollection();
  state.savedFingerprint = draftFingerprint();
  updateDiff();
  refreshPublicationState();
}

function hydrateCollection (json, { draftName, liveSceneName, sceneName, customizations, selection } = {}) {
  const scenes = json.sources.filter(source => source?.id === 'scene');
  const pickScene = names => names.find(name => scenes.some(scene => scene.name === name)) || scenes[0].name;
  state.original = json;
  state.draftName = draftName;
  state.liveSceneName = pickScene([liveSceneName, json.current_program_scene, json.current_scene]);
  state.sceneName = pickScene([sceneName, json.current_scene, state.liveSceneName]);
  state.sources = Object.fromEntries(json.sources.filter(source => source && source.name).map(source => [source.name, source]));
  state.items = structuredClone(state.sources[state.sceneName].settings.items);
  state.selectedIndex = -1;
  if (selection) {
    let remaining = selection.occurrence;
    state.selectedIndex = state.items.findIndex(item => item.name === selection.name
      && (selection.id == null ? remaining-- === 0 : item.id === selection.id));
  }
  if (state.selectedIndex < 0) closeInspector();
  CANVAS_W = json.resolution?.x || 1920;
  CANVAS_H = json.resolution?.y || 1080;
  updateCanvasInfoBtn();
  state.customizations = customizations || customizationsFrom(json);
  els.draftName().value = state.draftName;
  populateScenePicker(scenes);
  fitZoom();
  render();
  if (state.selectedIndex >= 0) openInspector();
  updateUndoButtons();
}

function customizationsFrom (json) {
  const customizations = Object.create(null);
  for (const src of json.sources) {
    if (!isWidgetSrc(src)) continue;
    const key = customizationKeyOf(src);
    const url = (src.settings && src.settings.url) || '';
    if (!url.includes('?')) continue;
    const params = new URLSearchParams(queryOf(url));
    const cust = customizations[key] = customizations[key] || {};
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
  }
  return customizations;
}

function populateScenePicker (scenes) {
  for (const [picker, value] of [[els.scenes(), state.sceneName], [els.liveScenes(), state.liveSceneName]]) {
    picker.replaceChildren(...scenes.map(scene => new Option(scene.name, scene.name, false, scene.name === value)));
  }
  els.scenes().onchange = event => selectScene(event.target.value);
}

function selectScene (name) {
  if (name === state.sceneName || state.sources[name]?.id !== 'scene') return;
  finishEdit();
  const previous = state.sources[state.sceneName];
  if (previous?.settings) previous.settings.items = structuredClone(state.items);
  state.sceneName = name;
  state.selectedIndex = -1;
  closeInspector();
  els.scenes().value = name;
  const scene = state.sources[name];
  if (!scene) return;
  // Deep-clone — state.items mutations (drag, resize, auto-layout) must NOT
  // mutate state.original. A shallow slice keeps each item's `pos`/`scale`/
  // `bounds` objects shared with the original, which silently breaks the
  // modified-vs-original diff counter and the Reset button.
  state.items = structuredClone(scene.settings?.items || []);
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
  const maxW = Math.max(40, avail.width - (compactEditor.matches ? 18 : 26));
  const maxH = Math.max(40, compactEditor.matches ? Math.min(window.innerHeight * 0.28, 240) : avail.height - 26);
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
function hasSizeBounds(item) {
  return !!item.bounds_type && item.bounds?.x > 0 && item.bounds?.y > 0;
}

function setLayerRenderSize(item, size, width, height) {
  if (hasSizeBounds(item)) item.bounds = { ...item.bounds, x: width, y: height };
  else item.scale = { ...item.scale, x: width / size.naturalW, y: height / size.naturalH };
}

function itemSize (item, src) {
  const nat = naturalDimsFor(src);
  const naturalW = nat.w, naturalH = nat.h;

  if (hasSizeBounds(item)) {
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
  renderLayersPanel();
}

function renderItem (item, idx, replacing) {
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
      const iframe = mkIframe(widgetUrlForPreview(slug, src), item.name, sz);
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
    handle.title = 'Scale widget proportionally';
    attachDrag(handle, idx, /*resize*/ true);

    node.appendChild(body);
    node.appendChild(label);
    if (isWidgetSrc(src)) { node.appendChild(move); node.appendChild(handle); }
    node.addEventListener('click', (e) => { e.stopPropagation(); selectItem(idx); });
    if (replacing) replacing.replaceWith(node);
    else c.appendChild(node);
}

function redrawPreviewItem(idx) {
  const node = els.canvas().querySelector(`.scene-item[data-idx="${idx}"]`);
  if (node) renderItem(state.items[idx], idx, node);
}

const CUST_KEYS = ['theme', 'accent', 'fontSize', 'title', 'pad'];
function customizationKeyOf(source) { return source?.uuid || source?.name || widgetSlugOf(source); }

function queryOf(url) {
  const beforeFragment = url.split('#', 1)[0];
  const start = beforeFragment.indexOf('?');
  return start < 0 ? '' : beforeFragment.slice(start + 1);
}

function widgetParams(slug, source) {
  const url = source?.settings?.url || '';
  const params = new URLSearchParams(queryOf(url));
  const cust = state.customizations[customizationKeyOf(source)];
  if (cust) {
    for (const key of CUST_KEYS) {
      if (cust[key] != null && cust[key] !== '') params.set(key, cust[key]); else params.delete(key);
    }
    for (const key of [...params.keys()]) if (key.startsWith('bind.')) params.delete(key);
    for (const [id, value] of Object.entries(cust.bindings || {})) if (value) params.set('bind.' + id, value);
  }
  return params;
}
function widgetUrlForPreview(slug, source = state.sources[state.items[state.selectedIndex]?.name]) {
  const qs = widgetParams(slug, source).toString();
  return `/widgets/${slug}/` + (qs ? '?' + qs : '');
}

function widgetLayers(source) {
  return state.original.sources.flatMap(scene => {
    if (scene?.id !== 'scene' && scene?.id !== 'group') return [];
    const items = scene.name === state.sceneName ? state.items : scene.settings?.items;
    return (items || []).filter(layer => layer.name === source.name);
  });
}

function resizeWidgetContent(source, layers, width, height) {
  snapshot(layers.length === 1 ? state.sceneName : null);
  for (const layer of layers) {
    if (hasSizeBounds(layer)) {
      const { scaleX, scaleY } = itemSize(layer, source);
      layer.bounds = { ...layer.bounds, x: width * scaleX, y: height * scaleY };
    }
  }
  source.settings.width = width;
  source.settings.height = height;
  state.items.forEach((layer, index) => {
    if (layer.name === source.name) applyToDom(index);
  });
  finishEdit();
  refreshInspector();
  updateUndoButtons();
  updateDiff();
}

function selectedWidgetFrame() {
  return els.canvas().querySelector(`.scene-item[data-idx="${state.selectedIndex}"] iframe`);
}

async function measureWidgetFit(frame, size) {
  const doc = frame.contentDocument;
  let width = size.naturalW;
  let height = size.naturalH;
  const detectOverflow = () => ({
    right: Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth) - width,
    bottom: Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) - height,
  });
  const originalWidth = frame.style.width;
  const originalHeight = frame.style.height;
  let probeWidth = originalWidth, probeHeight = originalHeight;
  try {
    let overflow = detectOverflow();
    // Responsive widget rows can reflow after gaining room. Recheck the
    // viewport a few times before accepting the size as a single undoable edit.
    for (let pass = 0; pass < 4 && (overflow.right > 0 || overflow.bottom > 0); pass++) {
      if (overflow.right > 0) width += Math.max(overflow.right, Math.ceil(width / 8));
      if (overflow.bottom > 0) height += Math.max(overflow.bottom, Math.ceil(height / 8));
      frame.style.width = probeWidth = `${width}px`;
      frame.style.height = probeHeight = `${height}px`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!frame.isConnected || frame.contentDocument !== doc) return null;
      if (frame.style.width !== probeWidth || frame.style.height !== probeHeight) return null;
      overflow = detectOverflow();
    }
    return { width, height, stillClipped: overflow.right > 0 || overflow.bottom > 0 };
  } finally {
    if (frame.style.width === probeWidth) frame.style.width = originalWidth;
    if (frame.style.height === probeHeight) frame.style.height = originalHeight;
  }
}

function refreshAutoSizeButton(item, source, layers = widgetLayers(source)) {
  const button = document.getElementById('autosize-btn');
  const frame = selectedWidgetFrame();
  button.disabled = item.locked || layers.some(layer => layer.locked) || !state.measuredFrames.has(frame) || state.fittingFrame === frame;
}

function refreshWidgetPreview(source) {
  const url = widgetUrlForPreview(widgetSlugOf(source), source);
  for (const item of els.canvas().querySelectorAll('.scene-item')) {
    if (state.sources[state.items[Number(item.dataset.idx)]?.name] !== source) continue;
    const frame = item.querySelector('iframe');
    if (frame && frame.getAttribute('src') !== url) {
      state.measuredFrames.delete(frame);
      frame.src = url;
    }
  }
  refreshAutoSizeButton(state.items[state.selectedIndex], source);
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

let shownBindingSource, shownBindings, bindingSamples, bindingFetch;
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
  const item = state.items[state.selectedIndex];
  const source = state.sources[item?.name];
  if (shownBindingSource !== source || shownBindings !== bindings) {
    shownBindingSource = source;
    shownBindings = bindings;
    bindingSamples = renderBindingsRows(bindings, source);
  }
  const overrides = state.customizations[customizationKeyOf(source)]?.bindings || {};
  for (const { input, binding, updatePreview } of bindingSamples) {
    input.disabled = item.locked === true;
    if (document.activeElement !== input) input.value = overrides[binding.id] || binding.default || '';
    updatePreview();
  }
  // Update just the sample values when telemetry returns. Replacing the form
  // here would discard input and focus while the user is typing.
  if (!bindingFetch && (!state._dataCacheAt || Date.now() - state._dataCacheAt > 1000)) {
    bindingFetch = fetch('/data.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        state._dataCache = data;
        for (const { updatePreview } of bindingSamples) updatePreview();
      })
      .catch(() => {})
      .finally(() => { state._dataCacheAt = Date.now(); bindingFetch = null; });
  }
}

function renderBindingsRows (bindings, source) {
  const list = document.getElementById('bindings-list');
  list.replaceChildren();
  return bindings.map(b => {
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
    input.setAttribute('aria-label', b.label || b.id);
    input.className = 'input';
    input.style.cssText = 'font-family: var(--font-mono); font-size: 11px; padding: 4px 6px; width: 100%; box-sizing: border-box';
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

    input.addEventListener('input', updatePreview);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    input.addEventListener('change', () => {
      const selected = state.items[state.selectedIndex];
      if (!selected || selected.locked || state.sources[selected.name] !== source) return;
      const key = customizationKeyOf(source);
      const value = input.value.trim();
      const override = value === b.default ? '' : value;
      if ((state.customizations[key]?.bindings?.[b.id] || '') === override) return;
      snapshot();
      const cust = state.customizations[key] ||= {};
      const overrides = cust.bindings ||= {};
      if (override) overrides[b.id] = override;
      else delete overrides[b.id];
      input.value = override || b.default || '';
      refreshWidgetPreview(source);
      updateDiff();
      updatePreview();
    });

    row.appendChild(label);
    row.appendChild(input);
    list.appendChild(row);
    return { input, binding: b, updatePreview };
  });
}

// ---- drag / resize ----
function attachDrag (handle, idx, resize) {
  handle.addEventListener('pointerdown', (e) => {
    if (state.items[idx]?.locked) return;
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
        // Project the drag onto the existing diagonal to scale both axes together.
        if (baseSize.w <= 0 || baseSize.h <= 0) return;
        const minimum = Math.max(40 / baseSize.w, 20 / baseSize.h);
        const delta = (dx * baseSize.w + dy * baseSize.h) / (baseSize.w ** 2 + baseSize.h ** 2);
        let factor = 1 + delta;
        if (ev.shiftKey) factor = Math.round(baseSize.w * factor / SNAP_GRID) * SNAP_GRID / baseSize.w;
        factor = Math.max(minimum, factor);
        setLayerRenderSize(item, baseSize, baseSize.w * factor, baseSize.h * factor);
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
  const align = alignOffsets(item.align);
  node.style.left = ((item.pos?.x || 0) - sz.w * align.ox) + 'px';
  node.style.top  = ((item.pos?.y || 0) - sz.h * align.oy) + 'px';
  node.style.width = sz.w + 'px';
  node.style.height = sz.h + 'px';
  const iframe = node.querySelector('iframe');
  if (iframe) {
    iframe.style.width  = sz.naturalW + 'px';
    iframe.style.height = sz.naturalH + 'px';
    iframe.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
  }
  const body = node.querySelector('.body');
  const crop = [item.crop_top, item.crop_right, item.crop_bottom, item.crop_left];
  if (body) body.style.clipPath = crop.some(Boolean)
    ? `inset(${crop.map((value, i) => `${(value || 0) * (i % 2 === 0 ? sz.scaleY : sz.scaleX)}px`).join(' ')})`
    : '';
  const lbl = node.querySelector('.label');
  if (lbl) lbl.textContent = `${item.name} · ${Math.round(sz.w)}×${Math.round(sz.h)} (natural ${Math.round(sz.naturalW)}×${Math.round(sz.naturalH)})`;
}

// ---- layers panel (OBS Sources-style dock) ----
// Move a layer by dragging or using its Up and Down buttons.
function moveItemFromTo (from, to) {
  const items = state.items;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
  if (!items[from] || !items[to] || items[from].locked) return;
  snapshot();
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
  // Keep the selection pinned to the same item if it was the one moving;
  // otherwise adjust the index so the previously-selected item stays
  // selected after the splice shifts everything around it.
  if (state.selectedIndex === from) {
    state.selectedIndex = to;
  } else if (from < state.selectedIndex && to >= state.selectedIndex) {
    state.selectedIndex--;
  } else if (from > state.selectedIndex && to <= state.selectedIndex) {
    state.selectedIndex++;
  }
  render();
  refreshInspector();
  updateDiff();
}

// Render the rows whenever the scene changes. One row per item, displayed
// top-to-bottom in REVERSE array order so top-of-list = top-of-stack
// (matches OBS Sources convention). Called from render().
function renderLayersPanel () {
  const list = els.layersList();
  if (!list) return;
  updateLayerStackActions();
  const active = document.activeElement;
  const oldRow = list.contains(active) ? active.closest('.layer-row') : null;
  const oldItem = oldRow?._layerItem;
  const oldIndex = Number(oldRow?.dataset.idx);
  const action = oldRow && active.dataset.action;
  list.innerHTML = '';
  if (!state.items.length) {
    list.innerHTML = '<div class="empty-hint">No scene loaded.</div>';
    if (oldRow) focusLayersButton();
    return;
  }
  const total = state.items.length;
  for (let i = total - 1; i >= 0; i--) {
    const item = state.items[i];
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.dataset.idx = i;
    row._layerItem = item;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `${item.name || 'Unnamed'} layer`);
    if (i === state.selectedIndex) row.classList.add('selected');
    if (item.visible === false) row.classList.add('lr-hidden');
    row.draggable = !item.locked;
    const label = item.name || 'Unnamed layer';
    const addButton = (action, text, description, handler, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.textContent = text;
      button.title = description;
      button.setAttribute('aria-label', description);
      button.disabled = disabled;
      button.addEventListener('click', handler);
      row.appendChild(button);
      return button;
    };
    const name = addButton('select', label, `Select ${label}`, () => selectItem(i));
    name.className = 'lr-name';
    name.setAttribute('aria-pressed', String(i === state.selectedIndex));
    const visible = item.visible !== false;
    const eye = addButton('visibility', visible ? 'Hide' : 'Show', `${visible ? 'Hide' : 'Show'} ${label}`,
      () => setLayerVisibility(i, !visible), item.locked === true);
    eye.className = 'lr-toggle';
    const lock = addButton('lock', item.locked ? 'Unlock' : 'Lock', `${item.locked ? 'Unlock' : 'Lock'} ${label}`,
      () => setLayerLock(i, !item.locked));
    lock.className = 'lr-toggle';
    addButton('up', 'Up', `Move ${label} up`, () => moveItemFromTo(i, i + 1), item.locked === true || i === total - 1);
    addButton('down', 'Down', `Move ${label} down`, () => moveItemFromTo(i, i - 1), item.locked === true || i === 0);

    // Drag-to-reorder using native HTML5 Drag API with a custom mime type
    // so the canvas's drop handler (which accepts widget tiles from the
    // drawer) doesn't accidentally consume our row drags.
    row.addEventListener('dragstart', (e) => {
      if (item.locked || e.target !== row) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-bambuboard-layer', String(i));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drop-above, .drop-below').forEach(n => {
        n.classList.remove('drop-above', 'drop-below');
      });
    });
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-bambuboard-layer')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      list.querySelectorAll('.drop-above, .drop-below').forEach(n => {
        if (n !== row) n.classList.remove('drop-above', 'drop-below');
      });
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-above', 'drop-below');
    });
    row.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-bambuboard-layer');
      if (raw === '') return;
      e.preventDefault();
      const from = parseInt(raw, 10);
      const rect = row.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      // List is reversed (top-of-list = highest array index). Dropping ABOVE
      // this row means inserting at i + 1 (just after this slot in the
      // array); BELOW means inserting at i. Adjust for the splice shift
      // when the source comes from a lower index than the target.
      let target = above ? (i + 1) : i;
      if (from < target) target -= 1;
      moveItemFromTo(from, target);
    });

    list.appendChild(row);
  }
  if (action) {
    const itemIndex = state.items.indexOf(oldItem);
    const row = list.querySelector(`.layer-row[data-idx="${itemIndex < 0 ? oldIndex : itemIndex}"]`);
    const exact = row?.querySelector(`button[data-action="${action}"]:not(:disabled)`);
    (exact || row?.querySelector('.lr-name') || panelControl('layers')).focus({ preventScroll: true });
    if (exact && itemIndex !== oldIndex) exact.scrollIntoView({ block: 'nearest' });
  }
}

// ---- selection / inspector ----
function updateLayerStackActions () {
  const index = state.selectedIndex;
  const item = state.items[index];
  const actions = document.getElementById('layer-stack-actions');
  const front = document.getElementById('layer-front');
  const back = document.getElementById('layer-back');
  actions.hidden = !item;
  front.disabled = !item || item.locked || index === state.items.length - 1;
  back.disabled = !item || item.locked || index === 0;
  if (actions.contains(document.activeElement) && document.activeElement.disabled) {
    const alternative = document.activeElement === front ? back : front;
    if (!alternative.disabled) alternative.focus({ preventScroll: true });
    else els.layersList().querySelector(`.layer-row[data-idx="${index}"] .lr-name`)?.focus({ preventScroll: true });
  }
}

function redrawLayerFlags(idx) {
  const item = state.items[idx];
  const node = els.canvas().querySelector(`.scene-item[data-idx="${idx}"]`);
  node?.classList.toggle('item-hidden', item.visible === false);
  node?.classList.toggle('locked', item.locked === true);
  renderLayersPanel();
  if (idx === state.selectedIndex) refreshInspector();
  updateDiff();
}
function setLayerVisibility(idx, visible) {
  const item = state.items[idx];
  if (!item || item.locked || (item.visible !== false) === visible) return;
  snapshot();
  item.visible = visible;
  redrawLayerFlags(idx);
}
function setLayerLock(idx, locked) {
  const item = state.items[idx];
  if (!item || Boolean(item.locked) === locked) return;
  snapshot();
  item.locked = locked;
  redrawLayerFlags(idx);
}
function updateSelection () {
  document.querySelectorAll('.scene-item, .layer-row').forEach(node => {
    const selected = Number(node.dataset.idx) === state.selectedIndex;
    node.classList.toggle('selected', selected);
    node.querySelector('.lr-name')?.setAttribute('aria-pressed', String(selected));
  });
  updateLayerStackActions();
}
function deselectItem () {
  state.selectedIndex = -1;
  updateSelection();
  closeInspector();
  if (compactEditor.matches && els.shell().parentElement.dataset.panel === 'inspector') showPanel('layers');
}
function selectItem (idx) {
  state.selectedIndex = idx;
  updateSelection();
  openInspector();
  if (compactEditor.matches) {
    showPanel('inspector');
    document.getElementById('inspector-heading').focus({ preventScroll: true });
    els.inspector().scrollIntoView({ block: 'start' });
  }
}

function openInspector () {
  const idx = state.selectedIndex;
  if (!state.items[idx]) return closeInspector();
  els.inspector().classList.add('open');
  document.getElementById('inspector-empty').hidden = true;
  document.getElementById('inspector-fields').hidden = false;
  refreshInspector();
}

function refreshInspector () {
  const idx = state.selectedIndex;
  if (idx < 0) return;
  const item = state.items[idx];
  if (!item) return closeInspector();
  const src = state.sources[item.name];
  const sz = itemSize(item, src);
  const inspector = els.inspector();
  const sameLayer = inspector._sceneItem === item;
  inspector._sceneItem = item;
  const setValue = (id, value) => {
    const input = document.getElementById(id);
    if (!sameLayer || document.activeElement !== input) input.value = value;
  };
  for (const input of inspector.querySelectorAll('#inspector-fields input, #inspector-fields select, #media-clear')) {
    input.disabled = item.locked === true && input.id !== 'insp-locked';
  }
  document.getElementById('locked-help').hidden = !item.locked;
  document.getElementById('insp-name').textContent = item.name;
  setValue('insp-x', Math.round(item.pos?.x || 0));
  setValue('insp-y', Math.round(item.pos?.y || 0));
  const widget = isWidgetSrc(src);
  const layers = widget ? widgetLayers(src) : [];
  const viewportLocked = layers.some(layer => layer.locked);
  const sharedHelp = document.getElementById('shared-size-help');
  document.getElementById('size-legend').textContent = widget ? 'Widget size' : 'Layer size';
  document.getElementById('size-help').hidden = !widget;
  document.getElementById('autosize-btn').hidden = !widget;
  for (const axis of ['w', 'h']) {
    const input = document.getElementById('insp-' + axis);
    const natural = axis === 'w' ? sz.naturalW : sz.naturalH;
    setValue(input.id, Math.round(widget ? natural : sz[axis]));
    input.disabled = item.locked || viewportLocked;
  }
  sharedHelp.hidden = layers.length < 2;
  if (!sharedHelp.hidden) sharedHelp.textContent = viewportLocked
    ? 'Unlock all layers using this widget to change its content size.'
    : 'Content size changes apply wherever this widget is used.';
  document.getElementById('widget-scale-block').hidden = !widget;
  const stretched = Math.abs(sz.scaleX - sz.scaleY) > 0.005;
  setValue('widget-scale', stretched ? '' : Math.round(sz.scaleX * 1000) / 10);
  document.getElementById('widget-scale').placeholder = stretched ? 'Stretched' : '';
  const resetStretch = document.getElementById('reset-stretch');
  resetStretch.hidden = !widget || !stretched;
  resetStretch.disabled = item.locked;
  const cust = widget ? (state.customizations[customizationKeyOf(src)] || {}) : null;
  document.getElementById('cust-block').style.display = cust ? '' : 'none';
  if (cust !== null) {
    setValue('cust-title', cust.title || '');
    setValue('cust-theme', cust.theme || '');
    setValue('cust-accent', cust.accent ? '#' + cust.accent : '#51a34f');
    setValue('cust-font', cust.fontSize || '');
    setValue('cust-pad', cust.pad || '');
    const slug = widgetSlugOf(src);
    refreshAutoSizeButton(item, src, layers);
    renderBindings(slug);
  } else {
    renderBindings(null);
  }

  document.getElementById('insp-visible').checked = item.visible !== false;
  document.getElementById('insp-locked').checked  = item.locked === true;
  setValue('insp-scale-filter', item.scale_filter || '');
  setValue('insp-bounds-align', String(item.bounds_align ?? 0));
  setValue('insp-crop-l', item.crop_left || 0);
  setValue('insp-crop-t', item.crop_top || 0);
  setValue('insp-crop-r', item.crop_right || 0);
  setValue('insp-crop-b', item.crop_bottom || 0);

  // Media-source override block: only shown for ffmpeg / vlc / rtsp sources.
  // Stored in localStorage so the preview URL persists per source UUID.
  const mediaBlock = document.getElementById('media-block');
  const isMedia = src && (src.id === 'ffmpeg_source' || src.id === 'vlc_source' || src.id === 'rtsp_source');
  mediaBlock.style.display = isMedia ? '' : 'none';
  if (isMedia) {
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    setValue('media-url', localStorage.getItem(overrideKey) || '');
  }
}

function closeInspector () {
  const inspector = els.inspector();
  inspector.classList.remove('open');
  inspector._sceneItem = null;
  document.getElementById('inspector-empty').hidden = false;
  document.getElementById('inspector-fields').hidden = true;
}

// Wire inspector inputs
document.addEventListener('DOMContentLoaded', () => {
  ['x','y','w','h'].forEach(k => {
    document.getElementById('insp-' + k).addEventListener('change', (e) => {
      const idx = state.selectedIndex;
      const item = state.items[idx];
      if (!item || item.locked) return;
      const src = state.sources[item.name];
      const cur = itemSize(item, src);
      const isDimension = k === 'w' || k === 'h';
      const widgetDimension = isDimension && isWidgetSrc(src);
      const width = widgetDimension ? cur.naturalW : cur.w;
      const height = widgetDimension ? cur.naturalH : cur.h;
      const current = Math.round({ x: item.pos?.x || 0, y: item.pos?.y || 0, w: width, h: height }[k]);
      const v = e.target.valueAsNumber;
      if (!Number.isFinite(v) || (isDimension && v < 1) || (widgetDimension && !Number.isSafeInteger(v))) {
        e.target.value = current;
        return;
      }
      if (v === current) return;
      if (widgetDimension) {
        const layers = widgetLayers(src);
        if (layers.some(layer => layer.locked)) return;
        resizeWidgetContent(src, layers, k === 'w' ? v : width, k === 'h' ? v : height);
        return;
      }
      snapshot();
      if (isDimension) setLayerRenderSize(item, cur, k === 'w' ? v : width, k === 'h' ? v : height);
      else item.pos = { ...item.pos, [k]: v };
      applyToDom(idx);
      updateDiff();
    });
  });
  ['title','theme','accent','font','pad'].forEach(k => {
    const input = document.getElementById('cust-' + k);
    if (input.type === 'number' || input.type === 'text') {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    }
    input.addEventListener('change', (e) => {
      const item = state.items[state.selectedIndex];
      if (!item || item.locked) return;
      const src = state.sources[item.name];
      if (!isWidgetSrc(src)) return;
      const keyOfSource = customizationKeyOf(src);
      const key = k === 'font' ? 'fontSize' : k;
      let val = e.target.value;
      if (k === 'accent') val = val.replace(/^#/, '');
      if ((state.customizations[keyOfSource]?.[key] || '') === (val || '')) return;
      snapshot();
      const cust = state.customizations[keyOfSource] ||= {};
      if (val === '' || val == null) delete cust[key]; else cust[key] = val;
      refreshWidgetPreview(src);
      updateDiff();
    });
  });

  // Visible / locked toggles.
  document.getElementById('insp-visible').addEventListener('change', (e) => {
    setLayerVisibility(state.selectedIndex, e.target.checked);
  });
  document.getElementById('insp-locked').addEventListener('change', (e) => {
    setLayerLock(state.selectedIndex, e.target.checked);
  });

  // Scale filter.
  document.getElementById('insp-scale-filter').addEventListener('change', (e) => {
    const idx = state.selectedIndex;
    const item = state.items[idx];
    if (!item || item.locked) return;
    const v = e.target.value;
    if ((item.scale_filter || '') === v) return;
    snapshot();
    if (v) item.scale_filter = v; else delete item.scale_filter;
    const body = els.canvas().querySelector(`.scene-item[data-idx="${idx}"] .body`);
    if (body) {
      body.style.imageRendering = v === 'point' ? 'pixelated' : '';
      body.querySelectorAll('img, video').forEach(node => { node.style.imageRendering = v === 'point' ? 'pixelated' : ''; });
    }
    updateDiff();
  });

  // Bounds align.
  document.getElementById('insp-bounds-align').addEventListener('change', (e) => {
    const idx = state.selectedIndex;
    const item = state.items[idx];
    const value = Number(e.target.value);
    if (!item || item.locked || (item.bounds_align ?? 0) === value) return;
    snapshot();
    item.bounds_align = value;
    applyToDom(idx);
    updateDiff();
  });

  // Crop fields.
  [['l','crop_left'],['t','crop_top'],['r','crop_right'],['b','crop_bottom']].forEach(([k, field]) => {
    document.getElementById('insp-crop-' + k).addEventListener('change', (e) => {
      const idx = state.selectedIndex;
      const item = state.items[idx];
      if (!item || item.locked) return;
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      e.target.value = v;
      if ((item[field] || 0) === v) return;
      snapshot();
      if (v) item[field] = v; else delete item[field];
      applyToDom(idx);
      updateDiff();
    });
  });

  document.getElementById('autosize-btn').addEventListener('click', async () => {
    const item = state.items[state.selectedIndex];
    const src = state.sources[item?.name];
    const frame = selectedWidgetFrame();
    if (!item || item.locked || !isWidgetSrc(src) || !state.measuredFrames.has(frame) || state.fittingFrame) return;
    if (!frame.contentDocument?.body) return;
    const layers = widgetLayers(src);
    if (layers.some(layer => layer.locked)) return;
    const size = itemSize(item, src);
    state.fittingFrame = frame;
    refreshAutoSizeButton(item, src, layers);
    let fit;
    try { fit = await measureWidgetFit(frame, size); }
    finally {
      state.fittingFrame = null;
      if (selectedWidgetFrame() === frame) refreshAutoSizeButton(item, src);
    }
    if (!fit || selectedWidgetFrame() !== frame || widgetLayers(src).some(layer => layer.locked)) return;
    const current = naturalDimsFor(src);
    if (current.w !== size.naturalW || current.h !== size.naturalH) return;
    const { width, height, stillClipped } = fit;
    if (width === size.naturalW && height === size.naturalH) {
      window.toast('The preview found no content outside the widget’s current size.');
      return;
    }
    resizeWidgetContent(src, layers, width, height);
    window.toast(stillClipped ? `Expanded ${src.name}. Check the preview for any remaining clipping.` : `Expanded ${src.name} to fit its content`);
  });

  const scaleInput = document.getElementById('widget-scale');
  function setWidgetScale(reset) {
    const index = state.selectedIndex;
    const item = state.items[index];
    const src = state.sources[item?.name];
    if (!item || item.locked || !isWidgetSrc(src)) return;
    const size = itemSize(item, src);
    const scale = reset ? Math.min(size.scaleX, size.scaleY) : scaleInput.valueAsNumber / 100;
    if (!Number.isFinite(scale) || scale <= 0 || (scale === size.scaleX && scale === size.scaleY)) return;
    snapshot();
    setLayerRenderSize(item, size, size.naturalW * scale, size.naturalH * scale);
    applyToDom(index);
    finishEdit();
    refreshInspector();
    updateUndoButtons();
    updateDiff();
  }
  scaleInput.addEventListener('change', () => setWidgetScale(false));
  document.getElementById('reset-stretch').addEventListener('click', () => setWidgetScale(true));

  // Media source override input — saves to localStorage, re-renders the item.
  document.getElementById('media-url').addEventListener('change', (e) => {
    const idx = state.selectedIndex;
    const item = state.items[idx];
    if (!item || item.locked) return;
    const src = state.sources[item.name];
    if (!src) return;
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    if (e.target.value) localStorage.setItem(overrideKey, e.target.value);
    else localStorage.removeItem(overrideKey);
    state.items.forEach((layer, i) => { if (layer.name === item.name) redrawPreviewItem(i); });
  });
  document.getElementById('media-clear').addEventListener('click', () => {
    const idx = state.selectedIndex;
    const item = state.items[idx];
    if (!item || item.locked) return;
    const src = state.sources[item.name];
    if (!src) return;
    const overrideKey = `bb-media-override:${src.uuid || src.name}`;
    localStorage.removeItem(overrideKey);
    document.getElementById('media-url').value = '';
    state.items.forEach((layer, i) => { if (layer.name === item.name) redrawPreviewItem(i); });
  });
});

// ---- draft and Live actions ----
function draftFingerprint (collection = state.original && applyChangesToCollection(), name = state.draftName) {
  return collection && JSON.stringify([name, collection]);
}

function hasUnsavedChanges () {
  return !!state.original && state.savedFingerprint !== draftFingerprint();
}

let liveRequest = 0;
async function refreshPublicationState () {
  const request = ++liveRequest;
  try {
    const active = await editorRequest('/api/obs/active');
    if (request === liveRequest) state.live = active;
    return active;
  } catch (_) {
    if (request === liveRequest) state.live = null;
    return null;
  } finally {
    if (request === liveRequest) updateDiff();
  }
}

function updateDiff () {
  const loaded = !!state.original;
  const busy = state.saving || state.loading;
  const changed = loaded && hasUnsavedChanges();
  const nameValid = !!sanitizeSceneName(state.draftName);
  const live = state.live;
  const current = !!live?.revision && live.slug === state.savedSlug && live.revision === state.savedRevision;
  const sceneCount = els.scenes().options.length;
  const badge = document.getElementById('draft-state');
  const summary = document.getElementById('live-state');
  const hint = document.getElementById('apply-live-hint');
  const restore = document.getElementById('restore-live-btn');

  if (loaded) els.diff().textContent = `${state.items.length} ${state.items.length === 1 ? 'layer' : 'layers'}`;
  const draftStatus = state.loading ? 'Loading draft…' : state.draftConflict ? 'Draft changed elsewhere' : !loaded ? 'No draft loaded' : changed ? 'Unsaved changes' : current ? 'Draft saved · Live' : state.savedSlug ? 'Draft saved' : 'New draft';
  if (badge.textContent !== draftStatus) badge.textContent = draftStatus;
  badge.className = 'pill ' + (changed || state.draftConflict ? 'pill-warn' : current ? 'pill-ok' : '');
  const liveName = live?.name || live?.label || live?.slug || 'Default scene';
  const liveScene = live?.sceneName ? ` / ${live.sceneName}` : '';
  const liveRevision = live?.revision ? ` · revision ${String(live.revision).slice(0, 8)}` : '';
  const outputStatus = live ? `Live now: ${liveName}${liveScene}${liveRevision}` : 'Live status unavailable';
  if (summary.textContent !== outputStatus) summary.textContent = outputStatus;
  summary.title = live?.revision ? `Live revision ${live.revision}` : '';
  restore.hidden = !live?.canRollback;
  restore.disabled = busy || !live?.canRollback;

  const target = loaded ? `${state.savedName} / ${state.liveSceneName}` : '';
  const hintText = !loaded ? 'Load a layout to get started.'
    : state.draftConflict ? 'Refresh the editor to reload this draft, or save your edits as a copy.'
      : changed || !state.savedRevision ? 'Save your draft to apply it to Live.'
        : !live ? 'Reload the editor to check Live before applying this draft.'
          : current ? 'This saved draft is already Live.'
            : `Ready to apply: ${target} · revision ${String(state.savedRevision).slice(0, 8)}`;
  hint.textContent = hintText;
  hint.title = state.savedRevision ? `Saved draft revision ${state.savedRevision}` : '';

  document.getElementById('save-btn').disabled = busy || !loaded || !nameValid || state.draftConflict;
  document.getElementById('save-copy-btn').disabled = busy || !loaded;
  document.getElementById('golive-btn').disabled = busy || !loaded || changed || !state.savedRevision || !live || current || state.draftConflict;
  document.getElementById('reset-btn').disabled = busy || !loaded || !changed;
  els.draftName().disabled = busy || !loaded;
  els.scenes().disabled = busy || sceneCount < 2;
  els.liveScenes().disabled = busy || sceneCount < 2;
  els.loader().disabled = state.saving;
}
window.addEventListener('beforeunload', event => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });

function applyChangesToCollection () {
  const clone = structuredClone(state.original);
  // Editing scene selection is local to the workspace. Only the deliberate
  // live-scene choice controls the OBS program scene in the saved draft.
  clone.current_program_scene = state.liveSceneName;
  const scene = clone.sources.find(source => source?.id === 'scene' && source.name === state.sceneName);
  if (scene) scene.settings.items = structuredClone(state.items);
  clone.sources.forEach(source => {
    if (!isWidgetSrc(source)) return;
    const cust = state.customizations[customizationKeyOf(source)];
    if (!cust) return;
    const params = widgetParams(widgetSlugOf(source), source);
    const [base] = source.settings.url.split(/[?#]/, 1);
    const hashAt = source.settings.url.indexOf('#');
    source.settings.url = base + (params.size ? `?${params}` : '') + (hashAt < 0 ? '' : source.settings.url.slice(hashAt));
  });
  return clone;
}

function sanitizeSceneName (raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '')
    .slice(0, 64);
}

async function editorRequest (endpoint, payload) {
  const options = payload === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  };
  const response = await fetch(endpoint, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (payload !== undefined && data.ok !== true)) {
    throw Object.assign(new Error(data.error || `Request returned ${response.status}`), { code: data.code });
  }
  return data;
}

async function persistDraft (name, copy = false) {
  if (!state.original || state.loading || state.saving || (!copy && state.draftConflict)) return;
  if (!name) return window.toast('Give your draft a name first.', 'error');
  finishEdit();
  const json = applyChangesToCollection();
  const prior = !copy && state.savedSlug ? { slug: state.savedSlug, revision: state.savedRevision } : {};
  state.saving = true;
  updateDiff();
  try {
    const saved = await editorRequest('/api/obs/scenes', { name, json, ...prior });
    state.savedSlug = saved.slug;
    state.savedRevision = saved.revision;
    state.savedName = saved.name;
    state.savedCollection = json;
    state.savedFingerprint = draftFingerprint(json, saved.name);
    state.draftConflict = false;
    state.draftName = saved.name;
    els.draftName().value = saved.name;
    await refreshSavedScenes(saved.slug);
    window.toast(copy ? `Saved a copy as “${saved.name}”` : `Draft “${saved.name}” saved`);
  } catch (error) {
    if (['DRAFT_CONFLICT', 'DRAFT_NOT_FOUND'].includes(error.code)) state.draftConflict = true;
    window.toast(`Save failed: ${error.message}`, 'error');
  } finally {
    state.saving = false;
    updateDiff();
  }
}

function onSave () {
  return persistDraft(sanitizeSceneName(state.draftName));
}

function onSaveCopy () {
  if (state.saving || state.loading || !state.original) return;
  const value = prompt('Name the new draft copy', `${(sanitizeSceneName(state.draftName) || 'Draft').slice(0, 59)} copy`);
  if (value !== null) return persistDraft(sanitizeSceneName(value), true);
}

function resetDraft () {
  if (state.saving || state.loading || !state.savedCollection || !hasUnsavedChanges()) return;
  const baseline = state.savedSlug ? 'its last saved state' : 'the starting layout';
  if (!confirm(`Reset this draft to ${baseline}? You can undo the reset.`)) return;
  snapshot(null);
  hydrateCollection(structuredClone(state.savedCollection), { draftName: state.savedName, sceneName: state.sceneName });
  finishEdit();
  updateUndoButtons();
  updateDiff();
}

function onPreview () {
  window.open('/live', '_blank', 'noopener');
}

async function changeLive (endpoint, payload, success, failure) {
  state.saving = true;
  ++liveRequest;
  updateDiff();
  try {
    state.live = await editorRequest(endpoint, payload);
    window.dispatchEvent(new Event('bambuboard:published'));
    window.toast(success);
  } catch (error) {
    if (['DRAFT_CONFLICT', 'DRAFT_NOT_FOUND'].includes(error.code)) state.draftConflict = true;
    if (['LIVE_CONFLICT', 'NO_PREVIOUS_LIVE'].includes(error.code)) await refreshPublicationState();
    window.toast(`${failure}: ${error.message}`, 'error');
  } finally {
    state.saving = false;
    updateDiff();
  }
}

function onGoLive () {
  if (state.saving || state.loading || !state.savedSlug || !state.savedRevision || !state.live || state.draftConflict || hasUnsavedChanges()) return;
  return changeLive('/api/obs/active', { slug: state.savedSlug, revision: state.savedRevision, expectedUpdatedAt: state.live.updatedAt ?? null },
    `Applied “${state.liveSceneName}” to Live`, 'Apply to Live failed');
}

function restoreLive () {
  if (state.saving || state.loading || !state.live?.canRollback) return;
  if (!confirm('Restore the previous Live output? This will change what viewers see.')) return;
  return changeLive('/api/obs/active/rollback', { expectedUpdatedAt: state.live.updatedAt ?? null }, 'Previous Live output restored', 'Restore failed');
}

// Re-fetch /api/obs/scenes and rebuild just the "Saved scenes" optgroup in
// the loader dropdown. Preserves the current selection unless `selectSlug`
// is supplied — in which case the newly-saved scene is selected (without
// re-triggering the loader's onChange, which would re-load the scene we
// already have in memory).
async function refreshSavedScenes (selectSlug) {
  const sel = els.loader();
  if (!sel) return;
  let scnR = [];
  try { scnR = await fetch('/api/obs/scenes').then(r => r.json()); } catch (_) { return; }
  const prev = sel.value;
  // Replace the existing Saved-scenes optgroup, leaving Templates / Upload alone.
  const oldGroup = Array.from(sel.querySelectorAll('optgroup'))
    .find(g => g.label === 'Saved scenes');
  const newGroupHTML = scnR.length
    ? '<optgroup label="Saved scenes">' + scnR.map(s =>
        `<option value="scn:${s.slug}">${escape(s.name)}</option>`).join('') + '</optgroup>'
    : '';
  if (oldGroup) {
    if (newGroupHTML) {
      const tmp = document.createElement('div');
      tmp.innerHTML = newGroupHTML;
      sel.replaceChild(tmp.firstChild, oldGroup);
    } else {
      oldGroup.remove();
    }
  } else if (newGroupHTML) {
    // Insert before the "From file" group so order stays consistent.
    const fromFile = Array.from(sel.querySelectorAll('optgroup'))
      .find(g => g.label === 'From file');
    const tmp = document.createElement('div');
    tmp.innerHTML = newGroupHTML;
    sel.insertBefore(tmp.firstChild, fromFile || null);
  }
  // Restore selection (suppress the loader change handler so it doesn't
  // re-fetch a scene we already have in state).
  const target = selectSlug ? `scn:${selectSlug}` : prev;
  if (target && Array.from(sel.options).some(o => o.value === target)) {
    sel.value = target;
    state.loaderValue = target;
  }
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

// Canvas size belongs to the whole draft. The browser source reads the applied
// size from Live.
function updateCanvasInfoBtn () {
  const btn = document.getElementById('canvas-res-btn');
  if (btn) btn.textContent = `${CANVAS_W}×${CANVAS_H}`;
}

function pickCanvasResolution () {
  if (!state.original) return;

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
  const choice = prompt(`Draft canvas size\nCurrent: ${cur}\n\n${labels}\n\nAfter applying to Live, match your OBS Browser Source dimensions to this size.`, '1');
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
  snapshot(null);

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
  // Reflect the change in the saved OBS collection.
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
  const movable = state.items.filter(item => !item.locked);
  if (!movable.length) return;
  snapshot();
  const snap = (n) => Math.round(n / AUTO_LAYOUT_GRID) * AUTO_LAYOUT_GRID;
  const GAP = AUTO_LAYOUT_GAP;

  // Leave locked layers in place.
  const measured = movable.map(item => {
    const src = state.sources[item.name];
    const sz = itemSize(item, src);
    const slug = src && isWidgetSrc(src) ? widgetSlugOf(src) : null;
    const sourceId = src?.id || '';
    return {
      item, slug, sourceId,
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

// ---- Widget library (shares the left dock with Layers) ----
// Lists all available widgets. Users drag tiles from the drawer onto the canvas
// to add new browser sources to their scene.

function panelControl(panel) {
  return document.getElementById({ layers: 'layers-panel-btn', widgets: 'widget-drawer-btn', inspector: 'inspector-panel-btn' }[panel]);
}
function focusLayersButton () {
  panelControl('layers').focus({ preventScroll: true });
}
function showPanel(panel) {
  els.shell().parentElement.dataset.panel = panel;
  if (panel !== 'inspector') {
    els.layersPanel().classList.toggle('open', panel === 'layers');
    document.getElementById('widget-drawer').classList.toggle('open', panel === 'widgets');
  }
  updatePanelButtons();
}
function updatePanelButtons () {
  const selected = els.shell().parentElement.dataset.panel;
  const narrow = compactEditor.matches;
  panelControl('layers').setAttribute('aria-expanded', String(narrow ? selected === 'layers' : els.layersPanel().classList.contains('open')));
  panelControl('widgets').setAttribute('aria-expanded', String(narrow ? selected === 'widgets' : document.getElementById('widget-drawer').classList.contains('open')));
  panelControl('inspector').setAttribute('aria-expanded', String(narrow && selected === 'inspector'));
}

async function populateWidgetDrawer () {
  const list = document.getElementById('widget-drawer-list');
  if (!list) return;
  const statusLine = document.createElement('p');
  statusLine.className = 'empty-hint';
  statusLine.setAttribute('role', 'status');
  statusLine.textContent = 'Loading widgets…';
  list.replaceChildren(statusLine);
  let widgets, caps;
  try {
    const [response, status] = await Promise.all([
      fetch('/api/widgets'),
      fetch('/api/status').then(r => r.json()).catch(() => null),
    ]);
    if (!response.ok) throw new Error('Widget catalog unavailable');
    widgets = await response.json();
    if (!Array.isArray(widgets) || !widgets.length) throw new Error('Widget catalog is empty');
    caps = status?.caps || {};
  } catch (_) {
    statusLine.textContent = 'Could not load the widget catalog.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = 'Retry loading widgets';
    retry.addEventListener('click', async () => {
      await populateWidgetDrawer();
      list.querySelector('button, [tabindex="0"]')?.focus();
    });
    list.appendChild(retry);
    return;
  }
  // Stash the full manifest list so the inspector can look up `bindings`
  // declarations without re-fetching. Keyed by slug.
  state.widgetManifests = state.widgetManifests || {};
  widgets.forEach(w => { state.widgetManifests[w.slug] = w; });
  list.innerHTML = '';
  widgets.forEach(w => {
    const tile = document.createElement('div');
    tile.className = 'drawer-widget';
    // Capability gating: dim + disable widgets the connected printer can't use
    // (e.g. chamber-temp on A1/P1, ams2/nozzle-temp-2 on single-AMS/nozzle,
    // camera on non-RTSP models) so they aren't dragged onto a scene where
    // they'd render empty.
    const incompatible = w.requiresCap && caps[w.requiresCap] === false;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-disabled', String(!!incompatible));
    tile.tabIndex = incompatible ? -1 : 0;
    if (incompatible) {
      tile.style.opacity = '0.4';
      tile.draggable = false;
      tile.title = `Not available on this printer (needs ${w.requiresCap})`;
    } else {
      tile.draggable = true;
      tile.title = `Drag to add ${w.name || w.slug} to the canvas`;
    }

    const preview = document.createElement('div');
    preview.className = 'dw-preview';
    const icon = document.createElement('span');
    icon.className = 'nav-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = w.slug === 'camera' ? 'videocam' : 'widgets';
    preview.appendChild(icon);

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
    if (incompatible || w.slug === 'gcode-viz' || ['profile-info', 'model-image'].includes(w.slug)) {
      const note = document.createElement('div'); note.className = 'dw-note';
      note.textContent = incompatible ? 'Unavailable for this printer' : w.slug === 'gcode-viz' ? 'Experimental toolpath' : 'Bambu Cloud content';
      info.appendChild(note);
    }

    tile.appendChild(preview);
    tile.appendChild(info);
    const add = () => { if (!incompatible && state.original) addWidgetToScene(w.slug, w.name || w.slug, rw, rh, Math.max(0, Math.round((CANVAS_W - rw) / 2)), Math.max(0, Math.round((CANVAS_H - rh) / 2))); };
    tile.addEventListener('click', add);
    tile.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } });

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
      url: `${location.origin}/widgets/${slug}/`,
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
