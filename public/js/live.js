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

  // ---- Scene loading ----

  async function pickSceneSlug() {
    const params = new URLSearchParams(location.search);
    const want = params.get('scene');
    if (want) return want;
    // No scene specified — use the most recently updated saved scene.
    const res = await fetch('/api/obs/scenes', { cache: 'no-store' });
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    return list[0].slug; // API already sorts by updatedAt desc
  }

  function activeSceneOf(json) {
    const scenes = (json.sources || []).filter(s => s.id === 'scene');
    if (!scenes.length) return null;
    const wantName = json.current_program_scene || json.current_scene;
    return scenes.find(s => s.name === wantName) || scenes[0];
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

    const id = src.id;
    const settings = src.settings || {};

    if (id === 'color_source') {
      wrap.style.background = obsColorToCss(settings.color);
    } else if (id === 'image_source' || id === 'image_source_v2') {
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
    let slug;
    try {
      slug = await pickSceneSlug();
    } catch (e) {
      showMsg('Could not list scenes: ' + e.message);
      return;
    }
    if (!slug) {
      showMsg('No saved scenes yet. Design one in the <a href="/scene-editor">scene editor</a>, then load <code>/live?scene=&lt;name&gt;</code>.');
      return;
    }

    let json;
    try {
      const res = await fetch(`/api/obs/scenes/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = JSON.parse(await res.text());
    } catch (e) {
      showMsg(`Could not load scene "${slug}": ${e.message}`);
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

    const items = (scene.settings && scene.settings.items) || [];
    // OBS renders items bottom-to-top in array order; later items sit on top.
    let placed = 0;
    items.forEach(item => {
      if (item.visible === false) return;
      const src = sourcesByName[item.name];
      if (!src) return;
      const el = buildItem(item, src);
      if (el) { stage.appendChild(el); placed++; }
    });

    fitStage();
    if (placed > 0) hideMsg();
    else showMsg(`Scene "${slug}" loaded but has no renderable items.`);
  }

  window.addEventListener('resize', fitStage);
  render();
})();
