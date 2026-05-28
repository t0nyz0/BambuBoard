// Composited broadcast renderer.
//
// Loads a saved OBS scene collection (data/scenes/<slug>.json, served by
// /api/obs/scenes/:slug) and renders it as a single full-page view: every
// scene item placed at its exact pos/scale/align on the scene's native
// canvas, with the camera ffmpeg_source swapped for the in-browser camera
// widget. The geometry mirrors public/js/scene-editor.js so what you design
// in the editor is what renders here.
//
// Usage:
//   /live              → most-recently-updated saved scene
//   /live?scene=<slug> → a specific scene
//
// In OBS you add ONE Browser Source pointing at this URL, sized to the scene
// resolution — no per-widget sources, no camera media source, no SDP.

(function () {
  const stage = document.getElementById('stage');
  const msg = document.getElementById('live-msg');

  // `?transparent=1` makes the page + stage backgrounds transparent so an OBS
  // Browser Source composites /live over whatever's behind it (and per-widget
  // semi-transparent backdrops blend with the OBS canvas/other sources).
  // Default is opaque black — better for viewing /live directly in a browser.
  const TRANSPARENT = /^(1|true|yes)$/i.test(new URLSearchParams(location.search).get('transparent') || '');
  if (TRANSPARENT) {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    stage.style.background = 'transparent';
  }

  let CANVAS_W = 1920;
  let CANVAS_H = 1080;

  function showMsg(html) { msg.innerHTML = html; msg.classList.remove('hidden'); }
  function hideMsg() { msg.classList.add('hidden'); }

  // ---- OBS geometry helpers (ported verbatim from scene-editor.js) ----

  function naturalDimsFor(src) {
    const settings = (src && src.settings) || {};
    const id = src && src.id;
    if (settings.width && settings.height) return { w: settings.width, h: settings.height };
    if (id === 'color_source') return { w: settings.width || CANVAS_W, h: settings.height || CANVAS_H };
    if (id === 'image_source' || id === 'image_source_v2') return { w: settings.width || 600, h: settings.height || 400 };
    if (id === 'text_ft2_source') return { w: 400, h: 80 };
    if (id === 'ffmpeg_source' || id === 'vlc_source' || id === 'rtsp_source') return { w: settings.width || 1920, h: settings.height || 1080 };
    return { w: settings.width || 400, h: settings.height || 200 };
  }

  function itemSize(item, src) {
    const nat = naturalDimsFor(src);
    const naturalW = nat.w, naturalH = nat.h;
    const bt = item.bounds_type || 0;
    if (bt !== 0 && item.bounds && item.bounds.x > 0 && item.bounds.y > 0) {
      const w = item.bounds.x, h = item.bounds.y;
      return { naturalW, naturalH, w, h, scaleX: w / naturalW, scaleY: h / naturalH };
    }
    const scaleX = item.scale && item.scale.x != null ? item.scale.x : 1;
    const scaleY = item.scale && item.scale.y != null ? item.scale.y : 1;
    return { naturalW, naturalH, w: naturalW * scaleX, h: naturalH * scaleY, scaleX, scaleY };
  }

  // OBS align bitfield: 1=left, 2=right, 4=top, 8=bottom, 0/none=center.
  function alignOffsets(align) {
    const a = align || 0;
    let ox = 0.5, oy = 0.5;
    if (a & 1) ox = 0; else if (a & 2) ox = 1;
    if (a & 4) oy = 0; else if (a & 8) oy = 1;
    return { ox, oy };
  }

  // OBS color_source.color is packed 32-bit ABGR.
  function obsColorToCss(n) {
    if (typeof n !== 'number') return '#000';
    const a = ((n >>> 24) & 0xFF) / 255;
    const b = (n >>> 16) & 0xFF;
    const g = (n >>> 8) & 0xFF;
    const r = n & 0xFF;
    return `rgba(${r},${g},${b},${a})`;
  }

  const widgetSlugRe = /\/widgets\/([a-zA-Z0-9_\-]+)\//;
  function looksLikeImageUrl(url) {
    if (!url) return false;
    const p = url.split(/[?#]/)[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(p)) return true;
    if (/^https?:\/\/[^/]*\.s3[.-]?[a-z0-9-]*\.amazonaws\.com\/[^/?#]+$/.test(url)) return true;
    return false;
  }

  // Inject OBS browser-source settings.css into same-origin widget iframes,
  // matching how OBS injects it (and how the editor previews it).
  function injectObsCss(iframe, css) {
    if (!css) return;
    iframe.addEventListener('load', () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const style = doc.createElement('style');
        style.textContent = css;
        doc.head.appendChild(style);
      } catch (_) { /* cross-origin */ }
    });
  }

  // For cross-origin image sources (e.g. the trademark logo on S3) we can't
  // reach into contentDocument, so approximate OBS's body-level settings.css
  // by applying the common backdrop properties (background, border-radius,
  // padding, …) to the wrapper element. Without this, a transparent PNG with
  // dark artwork (the H2D logo is black text on transparency) renders
  // black-on-black against the page — the OBS css supplies the dark rounded
  // backdrop that makes it legible. Ported from scene-editor.js.
  function applyObsCssApprox(wrapper, css) {
    if (!css) return;
    const bodyMatch = css.match(/body\s*\{([^}]*)\}/);
    const rules = (bodyMatch ? bodyMatch[1] : css).trim();
    if (!rules) return;
    const ALLOW = ['background', 'background-color', 'border-radius', 'padding', 'margin', 'box-shadow', 'border'];
    rules.split(';').forEach(decl => {
      const ix = decl.indexOf(':');
      if (ix < 0) return;
      const prop = decl.slice(0, ix).trim().toLowerCase();
      const val = decl.slice(ix + 1).trim();
      if (ALLOW.includes(prop) && val) wrapper.style.setProperty(prop, val);
    });
    wrapper.style.boxSizing = 'border-box';
  }

  // ---- Scene loading ----

  // Explicit ?scene= override (used by the editor's "Preview live"); when set,
  // we pin to that scene and disable active-scene polling.
  const FORCED_SCENE = new URLSearchParams(location.search).get('scene');

  async function pickSceneSlug() {
    if (FORCED_SCENE) return FORCED_SCENE;
    // Default: the published ("active") scene. Falls back to the most recently
    // updated saved scene when nothing has been published yet.
    try {
      const a = await (await fetch('/api/obs/active', { cache: 'no-store' })).json();
      if (a && a.slug) return a.slug;
    } catch (_) { /* fall through to most-recent */ }
    try {
      const list = await (await fetch('/api/obs/scenes', { cache: 'no-store' })).json();
      if (Array.isArray(list) && list.length) return list[0].slug; // sorted updatedAt desc
    } catch (_) { /* none */ }
    return null;
  }

  function activeSceneOf(json) {
    const scenes = (json.sources || []).filter(s => s.id === 'scene');
    if (!scenes.length) return null;
    const wantName = json.current_program_scene || json.current_scene;
    return scenes.find(s => s.name === wantName) || scenes[0];
  }

  // Default layout when nothing has been published/saved. Picks the shipped
  // template for the detected printer type; the download endpoint substitutes
  // <HOST> so widget URLs are concrete.
  async function loadDefaultJson() {
    let type = 'X1';
    try {
      const st = await (await fetch('/api/status', { cache: 'no-store' })).json();
      type = (st.printer && st.printer.type) || 'X1';
    } catch (_) { /* default to X1 */ }
    const slug = type === 'H2D' ? 'default-h2d' : 'default-x1';
    const res = await fetch(`/api/obs/templates/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`default template "${slug}" HTTP ${res.status}`);
    return JSON.parse(await res.text());
  }

  function buildItem(item, src) {
    const sz = itemSize(item, src);
    const { ox, oy } = alignOffsets(item.align);
    const pos = item.pos || { x: 0, y: 0 };
    const left = (pos.x || 0) - ox * sz.w;
    const top = (pos.y || 0) - oy * sz.h;

    const wrap = document.createElement('div');
    wrap.className = 'live-item';
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    wrap.style.width = sz.w + 'px';
    wrap.style.height = sz.h + 'px';

    // Rotation around the alignment anchor (OBS rot is degrees, +ve clockwise
    // = CSS). Mirrors scene-editor.js renderItem.
    if (item.rot) {
      wrap.style.transformOrigin = `${(ox * 100).toFixed(2)}% ${(oy * 100).toFixed(2)}%`;
      wrap.style.transform = `rotate(${item.rot}deg)`;
    }
    // Blend mode. OBS "default"/"normal" = CSS default; apply only known-safe
    // mix-blend-mode values so an unknown name can't break layout.
    const bt = item.blend_type;
    if (bt && bt !== 'normal' && bt !== 'default') {
      const safe = ['lighten', 'multiply', 'screen', 'darken', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'overlay'];
      if (safe.includes(bt)) wrap.style.mixBlendMode = bt;
    }
    // Crop: clip the cropped edges. OBS crop values are in source (natural)
    // pixels; convert to rendered pixels via the item's scale factors.
    const cl = item.crop_left || 0, ct = item.crop_top || 0;
    const cr = item.crop_right || 0, cb = item.crop_bottom || 0;
    if (cl || ct || cr || cb) {
      wrap.style.clipPath = `inset(${ct * sz.scaleY}px ${cr * sz.scaleX}px ${cb * sz.scaleY}px ${cl * sz.scaleX}px)`;
    }

    const id = src.id;
    const settings = src.settings || {};

    if (id === 'color_source') {
      wrap.style.background = obsColorToCss(settings.color);
    } else if (id === 'image_source' || id === 'image_source_v2') {
      applyObsCssApprox(wrap, settings.css);
      const img = document.createElement('img');
      img.src = settings.file || settings.url || '';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      wrap.appendChild(img);
    } else if (id === 'ffmpeg_source' || id === 'rtsp_source' || id === 'vlc_source') {
      // Swap the OBS camera media source for our in-browser camera widget.
      const iframe = document.createElement('iframe');
      iframe.src = '/widgets/camera/index.html';
      iframe.title = 'Live camera';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      wrap.appendChild(iframe);
    } else if (id === 'browser_source' && typeof settings.url === 'string') {
      const url = settings.url;
      if (looksLikeImageUrl(url)) {
        // Back-compat shim: the old default H2D logo was an external
        // black-on-white JPEG (eu-trademark.s3.amazonaws.com/019117180) with
        // no transparency. Swap it for the local transparent white PNG and
        // DON'T apply the source's dark-backdrop CSS, so the logo floats over
        // the scene. Fixes existing saved scenes without editing user data.
        if (/019117180|eu-trademark\.s3\.amazonaws\.com/.test(url)) {
          const img = document.createElement('img');
          img.src = '/assets/logo-h2d.png';
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = 'contain';
          wrap.appendChild(img);
          return wrap;
        }
        // Other cross-origin images: apply the OBS css backdrop to the wrapper
        // so a transparent logo/badge gets its designed box.
        applyObsCssApprox(wrap, settings.css);
        const img = document.createElement('img');
        img.src = url;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        wrap.appendChild(img);
      } else {
        // Paint at the source's natural viewport, then scale to the rendered
        // box — mirrors OBS browser-source semantics + the editor.
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.title = item.name || 'widget';
        iframe.style.width = sz.naturalW + 'px';
        iframe.style.height = sz.naturalH + 'px';
        iframe.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
        injectObsCss(iframe, settings.css);
        wrap.appendChild(iframe);
      }
    } else {
      return null; // unknown/unsupported source type — skip
    }
    return wrap;
  }

  function fitStage() {
    const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
    stage.style.transform = `scale(${scale})`;
    // Center the scaled stage in the viewport.
    const sw = CANVAS_W * scale, sh = CANVAS_H * scale;
    stage.style.left = Math.round((window.innerWidth - sw) / 2) + 'px';
    stage.style.top = Math.round((window.innerHeight - sh) / 2) + 'px';
  }

  async function render() {
    let slug, json;
    try {
      slug = await pickSceneSlug();
      if (slug) {
        const res = await fetch(`/api/obs/scenes/${encodeURIComponent(slug)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = JSON.parse(await res.text());
      } else {
        // Nothing published or saved yet — show a sensible default so a fresh
        // install isn't blank. Templates are host-substituted by the download
        // endpoint and the camera ffmpeg_source is swapped for our widget.
        json = await loadDefaultJson();
      }
    } catch (e) {
      showMsg('Could not load scene: ' + e.message);
      return;
    }

    CANVAS_W = (json.resolution && json.resolution.x) || 1920;
    CANVAS_H = (json.resolution && json.resolution.y) || 1080;
    stage.style.width = CANVAS_W + 'px';
    stage.style.height = CANVAS_H + 'px';

    const scene = activeSceneOf(json);
    if (!scene) { showMsg(`Scene "${slug}" has no renderable scene source.`); return; }

    const sourcesByName = {};
    (json.sources || []).forEach(s => { if (s && s.name) sourcesByName[s.name] = s; });

    // Rebuild from scratch (this runs on first load AND whenever the published
    // scene changes). Clearing here — only after a successful fetch/parse —
    // means a transient network blip never blanks an already-good render.
    stage.innerHTML = '';

    const items = (scene.settings && scene.settings.items) || [];
    // OBS renders items bottom-to-top in array order; later items sit on top.
    let placed = 0;
    items.forEach(item => {
      if (item.visible === false) return;
      const src = sourcesByName[item.name];
      if (!src) return;
      if (src.enabled === false) return; // OBS source disabled — skip
      const el = buildItem(item, src);
      if (el) { stage.appendChild(el); placed++; }
    });

    fitStage();
    if (placed > 0) hideMsg();
    else showMsg(`Scene "${slug}" loaded but has no renderable items.`);
  }

  window.addEventListener('resize', fitStage);

  // Auto-update: poll the published scene's identity (slug + mtime) and only
  // re-render when it actually changes. Critical — re-rendering rebuilds the
  // camera iframe, and reconnecting every poll would trip the printer's RTSP
  // connection limit, so an unchanged scene must leave the DOM (and the live
  // camera) untouched. A pinned ?scene= preview renders once and doesn't poll.
  const POLL_MS = 4000;
  let lastKey = null;

  async function tick() {
    if (document.hidden) return;
    let key;
    if (FORCED_SCENE) {
      key = `forced:${FORCED_SCENE}`;
    } else {
      try {
        const a = await (await fetch('/api/obs/active', { cache: 'no-store' })).json();
        key = a && a.slug ? `${a.slug}@${a.updatedAt || 0}` : 'fallback';
      } catch (_) {
        return; // transient — keep current render, try next tick
      }
    }
    if (key !== lastKey) {
      lastKey = key;
      await render();
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
