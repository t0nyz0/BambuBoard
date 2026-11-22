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
//   /live              → published snapshot, or the matching default template
//   /live?scene=<slug> → a specific scene
//
// In OBS you add ONE Browser Source pointing at this URL, sized to the scene
// resolution — no per-widget sources, no camera media source, no SDP.

(function () {
  const stage = document.getElementById('stage');
  const msg = document.getElementById('live-msg');
  let mountedItems = new Map();

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

  function looksLikeImageUrl(url) {
    if (!url) return false;
    const p = url.split(/[?#]/)[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(p)) return true;
    if (/^https?:\/\/[^/]*\.s3[.-]?[a-z0-9-]*\.amazonaws\.com\/[^/?#]+$/.test(url)) return true;
    return false;
  }

  // Inject OBS browser-source settings.css into same-origin widget iframes,
  // matching how OBS injects it (and how the editor previews it).
  function applyObsCss(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc?.head) return;
      let style = doc.getElementById('bb-live-obs-css');
      const css = iframe.dataset.obsCss;
      if (!css) { style?.remove(); return; }
      if (!style) {
        style = doc.createElement('style');
        style.id = 'bb-live-obs-css';
        doc.head.appendChild(style);
      }
      style.textContent = css;
    } catch (_) { /* cross-origin */ }
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

  // Explicit ?scene= override for opening a particular saved scene; when set,
  // we pin to that scene and disable active-scene polling.
  const FORCED_SCENE = new URLSearchParams(location.search).get('scene');

  function activeSceneOf(json) {
    const scenes = (json.sources || []).filter(s => s.id === 'scene');
    if (!scenes.length) return null;
    const wantName = json.current_program_scene || json.current_scene;
    return scenes.find(s => s.name === wantName) || scenes[0];
  }

  function sourceContent(src) {
    const { id } = src;
    const settings = src.settings || {};
    const css = typeof settings.css === 'string' ? settings.css : '';
    if (id === 'color_source') return { kind: 'color', value: obsColorToCss(settings.color) };
    if (id === 'image_source' || id === 'image_source_v2') {
      return { kind: 'image', url: settings.file || settings.url || '', css };
    }
    if (id === 'ffmpeg_source' || id === 'rtsp_source' || id === 'vlc_source') {
      // Swap the OBS media source for the configured printer's camera widget.
      return { kind: 'camera', url: '/widgets/camera/index.html' };
    }
    if (id !== 'browser_source' || typeof settings.url !== 'string') return null;
    const parsed = parseBrowserSourceUrl(settings.url);
    if (!parsed) return null;
    const url = /^\/(widgets|assets)\//.test(parsed.pathname)
      ? location.origin + parsed.pathname + parsed.search + parsed.hash
      : parsed.href;
    if (looksLikeImageUrl(url)) {
      // The old H2D logo used an opaque trademark JPEG. Keep the local
      // transparent replacement without reapplying that image's old backdrop.
      if (/019117180|eu-trademark\.s3\.amazonaws\.com/.test(url)) {
        return { kind: 'image', url: '/assets/logo-h2d.png' };
      }
      return { kind: 'image', url, css };
    }

    const content = { kind: 'widget', url, css };
    if (/^\/widgets\/gcode-viz(?:\/(?:index\.html)?)?$/.test(parsed.pathname)) {
      // The G-code widget accepts these two options without losing its model.
      const frameUrl = new URL(url);
      const { searchParams } = frameUrl;
      searchParams.delete('mode');
      searchParams.delete('layers');
      content.url = frameUrl.href;
      content.gcodeView = { view: searchParams.get('view'), zoom: searchParams.get('zoom') };
      searchParams.delete('view');
      searchParams.delete('zoom');
      content.identityUrl = frameUrl.href;
    }
    return content;
  }

  function sendGcodeView(mounted) {
    mounted.element.firstElementChild?.contentWindow?.postMessage({
      type: 'bambuboard:gcode-view', ...mounted.gcodeView,
    }, location.origin);
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'bambuboard:gcode-view-ready') return;
    const mounted = [...mountedItems.values()].find(item => item.gcodeView && item.element.firstElementChild?.contentWindow === event.source);
    if (mounted) sendGcodeView(mounted);
  });

  const blendModes = ['lighten', 'multiply', 'screen', 'darken', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'overlay'];

  function renderItem(item, src, previous, layer) {
    const content = sourceContent(src);
    if (!content) return null;
    const { kind, url, css, value, identityUrl, gcodeView } = content;
    const signature = JSON.stringify([kind, identityUrl || url, kind === 'image' ? css : null, value]);
    const reuse = previous?.signature === signature;
    const wrap = reuse ? previous.element : document.createElement('div');
    const mounted = { element: wrap, signature, gcodeView, css };
    const sz = itemSize(item, src);
    const { ox, oy } = alignOffsets(item.align);
    const pos = item.pos || { x: 0, y: 0 };

    wrap.className = 'live-item';
    wrap.style.left = ((pos.x || 0) - ox * sz.w) + 'px';
    wrap.style.top = ((pos.y || 0) - oy * sz.h) + 'px';
    wrap.style.width = sz.w + 'px';
    wrap.style.height = sz.h + 'px';
    wrap.style.zIndex = layer;

    // Rotation around the alignment anchor (OBS rot is degrees, +ve clockwise
    // = CSS). Mirrors scene-editor.js renderItem.
    wrap.style.transformOrigin = item.rot ? `${(ox * 100).toFixed(2)}% ${(oy * 100).toFixed(2)}%` : '';
    wrap.style.transform = item.rot ? `rotate(${item.rot}deg)` : '';
    // Blend mode. OBS "default"/"normal" = CSS default; apply only known-safe
    // mix-blend-mode values so an unknown name can't break layout.
    wrap.style.mixBlendMode = blendModes.includes(item.blend_type) ? item.blend_type : '';
    // Crop: clip the cropped edges. OBS crop values are in source (natural)
    // pixels; convert to rendered pixels via the item's scale factors.
    const cl = item.crop_left || 0, ct = item.crop_top || 0;
    const cr = item.crop_right || 0, cb = item.crop_bottom || 0;
    wrap.style.clipPath = cl || ct || cr || cb
      ? `inset(${ct * sz.scaleY}px ${cr * sz.scaleX}px ${cb * sz.scaleY}px ${cl * sz.scaleX}px)` : '';

    if (!reuse) {
      if (kind === 'color') wrap.style.background = value;
      if (kind === 'image') {
        if (css) applyObsCssApprox(wrap, css);
        const image = document.createElement('img');
        image.src = url;
        image.style.width = '100%';
        image.style.height = '100%';
        image.style.objectFit = 'contain';
        wrap.appendChild(image);
      }
      if (kind === 'camera' || kind === 'widget') {
        const frame = document.createElement('iframe');
        frame.src = url;
        if (kind === 'camera') {
          frame.title = 'Live camera';
          frame.style.width = '100%';
          frame.style.height = '100%';
        } else {
          frame.addEventListener('load', () => applyObsCss(frame));
        }
        wrap.appendChild(frame);
      }
    }
    if (kind === 'widget') {
      const frame = wrap.firstElementChild;
      // Paint at the source's natural viewport, then scale to the rendered box.
      frame.title = item.name || 'widget';
      frame.style.width = sz.naturalW + 'px';
      frame.style.height = sz.naturalH + 'px';
      frame.style.transform = `scale(${sz.scaleX}, ${sz.scaleY})`;
      if (!reuse || css !== previous.css) {
        frame.dataset.obsCss = css || '';
        applyObsCss(frame);
      }
      if (reuse && gcodeView && (gcodeView.view !== previous.gcodeView?.view || gcodeView.zoom !== previous.gcodeView?.zoom)) {
        sendGcodeView(mounted);
      }
    }
    return mounted;
  }

  function fitStage() {
    const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
    stage.style.transform = `scale(${scale})`;
    // Center the scaled stage in the viewport.
    const sw = CANVAS_W * scale, sh = CANVAS_H * scale;
    stage.style.left = Math.round((window.innerWidth - sw) / 2) + 'px';
    stage.style.top = Math.round((window.innerHeight - sh) / 2) + 'px';
  }

  async function render(outputName, signal) {
    const label = FORCED_SCENE || outputName || 'Published output';
    let json;
    try {
      const url = FORCED_SCENE ? `/api/obs/scenes/${encodeURIComponent(FORCED_SCENE)}` : '/api/obs/published';
      const res = await fetch(url, { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      if (!mountedItems.size) showMsg('Could not load scene: ' + e.message);
      return;
    }

    CANVAS_W = (json.resolution && json.resolution.x) || 1920;
    CANVAS_H = (json.resolution && json.resolution.y) || 1080;
    stage.style.width = CANVAS_W + 'px';
    stage.style.height = CANVAS_H + 'px';

    const scene = activeSceneOf(json);
    if (!scene) { showMsg(`Scene "${label}" has no renderable scene source.`); return; }

    const sourcesByName = new Map((json.sources || []).filter(src => src?.name).map(src => [src.name, src]));
    const next = new Map();
    const occurrences = new Map();
    const items = (scene.settings && scene.settings.items) || [];
    items.forEach((item, layer) => {
      // Some older layouts have no item IDs. Separate repeated occurrences of
      // those sources too, including hidden items when counting occurrences.
      const identity = item.id == null ? `source:${item.source_uuid || item.name}` : `item:${item.id}`;
      const count = occurrences.get(identity) || 0;
      occurrences.set(identity, count + 1);
      const key = JSON.stringify([identity, count]);
      if (item.visible === false) return;
      const src = sourcesByName.get(item.name);
      if (!src || src.enabled === false) return;
      const previous = mountedItems.get(key);
      const mounted = renderItem(item, src, previous, layer);
      if (!mounted) return;
      // Moving a mounted iframe in the DOM reloads it. Keep stable nodes in
      // place and use z-index to follow OBS's bottom-to-top item order.
      if (mounted.element !== previous?.element) stage.appendChild(mounted.element);
      next.set(key, mounted);
    });
    for (const [key, previous] of mountedItems) {
      if (next.get(key)?.element !== previous.element) previous.element.remove();
    }
    mountedItems = next;

    fitStage();
    if (mountedItems.size > 0) hideMsg();
    else showMsg(`Scene "${label}" loaded but has no renderable items.`);
    return true;
  }

  window.addEventListener('resize', fitStage);

  // Poll the publication identity and reconcile only when it changes. A
  // pinned ?scene= preview renders once and doesn't poll the active scene.
  const POLL_MS = 4000;
  const FETCH_TIMEOUT_MS = 8000;
  let lastKey = null;
  let polling = false;

  async function tick() {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      let key, label;
      if (FORCED_SCENE) key = `forced:${FORCED_SCENE}`;
      else {
        const response = await fetch('/api/obs/active', { cache: 'no-store', signal });
        if (!response.ok) return;
        const active = await response.json();
        if (!active || !Object.hasOwn(active, 'slug')) return;
        key = `${active.slug ?? 'default'}@${active.updatedAt ?? 0}`;
        label = active.name || active.label || active.slug;
      }
      if (key !== lastKey && await render(label, signal)) lastKey = key;
    } catch (_) {
      // Keep the current render after transient failures and retry next tick.
    } finally {
      polling = false;
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
