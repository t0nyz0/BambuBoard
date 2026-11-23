// Live gcode toolpath visualization.
// Polls /data.json for the current print, fetches the gcode from /api/gcode/current
// when the task changes, and advances the rendered toolpath up to the active
// layer using gcode-preview.
//
// Debug timeline scrubber: append `?debug=1` to the URL to reveal a slider
// that lets you scrub through layers manually and a play/pause button that
// auto-advances. While scrubbing/playing, MQTT layer_num is ignored.

import * as GCodePreview from '../../vendor/gcode-preview.esm.js';
import * as THREE from '../../vendor/three.module.js';
import { openToolpathFramer } from './toolpath-framing.js';
import { createPreviewBudget, PREVIEW_WORKLOAD_LIMITS } from './preview-workload.js';
import { openPackedPreview } from './packed-preview-loader.js';
import { buildPackedRenderer } from './packed-renderer.js';
import { createPackedNozzleRenderer } from './packed-nozzle-renderer.js';
import { createPackedNozzlePlayback } from './packed-nozzle-playback.js';
import { createRecentDepositionRibbon } from './recent-deposition-ribbon.js';
import { createRecentDepositionPath, RECENT_DEPOSITION_SEGMENTS } from './recent-deposition-path.js';
import '../../js/gcode-limits.js';
import '../../js/gcode-view.js';

const POLL_MS = 800;
const PLAY_LAYERS_PER_SEC = 8;
const H3C_MAX_SLICER_FILAMENTS = 32;
// Nozzle simulation speed multiplier vs gcode feedrate. Self-calibrates
// based on observed mc_percent advancement rate so it tracks the real
// printer including filament-swap delays, accel/decel overhead, and any
// speed-mode multiplier. 0.5 is a conservative starting guess — real
// printers rarely exceed commanded feedrate, and accel/decel overhead
// pushes effective speed well below it. The calibrator zeroes in within
// a few samples.
let nozzleSpeedFactor = 0.5;
let calibrationSamples = 0;
// No delay — sync the simulated nozzle directly to the printer's
// mc_percent position. Any lag puts us on the wrong segment / object.
const REPLAY_DELAY_S = 0;

const params = new URLSearchParams(location.search);
const operator = window.BBGcodeUI.operator;
const diagnostics = params.has('debug');
const debug = operator && diagnostics;
// Verification mode: render only the first N layers and walk the nozzle through
// them sequentially so you can compare the nozzle's path against the visible
// gcode lines. Append `?layers=4` (or any small N) to enable.
const verifyLayers = (() => {
  const v = parseInt(params.get('layers') || '', 10);
  return operator && Number.isFinite(v) && v > 0 ? v : 0;
})();

const canvas = document.getElementById('gcodeCanvas');
const debugBar = document.getElementById('gcodeDebug');
const scrubEl = document.getElementById('gcodeScrub');
const playEl = document.getElementById('gcodePlay');
const prevEl = document.getElementById('gcodePrev');
const nextEl = document.getElementById('gcodeNext');
const labelEl = document.getElementById('gcodeLabel');
const pathEl = document.getElementById('gcodePath');
const pathLabelEl = document.getElementById('gcodePathLabel');
const logEl = document.getElementById('gcodeLog');
const detailEl = document.getElementById('gcodeDetail');

// Rolling debug log. Always captured into a ring buffer (cheap, ~240 lines)
// so it can be inspected from the console anytime via window.__log(); mirrored
// to an on-screen panel only when ?debug=1. Use dbg() for one-off events and
// logPhase() for state-machine phases (deduped so an unchanged phase doesn't
// spam a line every 800ms poll).
const _logBuf = [];
const LOG_MAX = 240;
function dbg(msg) {
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  _logBuf.push(`${stamp}  ${msg}`);
  if (_logBuf.length > LOG_MAX) _logBuf.shift();
  if (debug && logEl) {
    logEl.textContent = _logBuf.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }
}
let _lastLoggedPhase = null;
function logPhase(name) {
  if (name === _lastLoggedPhase) return;
  _lastLoggedPhase = name;
  dbg(`▶ ${name}`);
}
window.__log = () => _logBuf.slice();

// Use the connected printer's geometry and filament addressing when available.
async function resolvePrinter() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const type = data?.printer?.type;
    const bed = (window.PRINTER_CAPS?.[type] || window.PRINTER_CAPS?.X1)?.bedSize;
    if (bed && bed.x && bed.y && bed.z) return { bed, type };
  } catch (_) { /* fall through to default */ }
  return { bed: { x: 256, y: 256, z: 256 }, type: 'X1' };
}
const { bed, type: printerType } = await resolvePrinter();
const neutralFilament = '#888888';

const preview = GCodePreview.init({
  canvas,
  extrusionColor: printerType === 'H3C' ? neutralFilament : 'hotpink',
  backgroundColor: '#1a1c20', // overridden to transparent below; kept here so gcode-preview's fog still has a base color
  // Keep travel moves out of the deposited material.
  renderTravel: false,
  buildVolume: { x: bed.x, y: bed.y, z: bed.z },
  initialCameraPosition: [-120, 130, 150],
});
// Our camera/nozzle loop below owns drawing. The library's default loop would
// otherwise draw the same large geometry a second time every animation frame.
preview.cancelAnimation();
preview.controls.enabled = false;

// Make the canvas transparent so the widget composites over whatever sits
// underneath it (camera feed in OBS, dashboard background on the web). The
// vendored gcode-preview was patched to create its WebGLRenderer with
// alpha:true; here we drop the scene background and zero the clear alpha.
preview.scene.background = null;
preview.scene.fog = null;
preview.renderer?.setClearColor(0x000000, 0);

// Hotend modeled on the Bambu finned-heatsink assembly. From the print up:
//   tip    — black conical nozzle, narrow at the bottom, wider at the base
//   block  — silver aluminum heatbreak block (uniform width, no taper)
//   sink   — black finned heatsink (alternating thick/thin slabs for the
//            cooling fin look), uniform width
// Each part has a constant width across its height — no upward widening — so
// the silhouette reads as "straight down" past the heatsink.
const nozzleGroup = new THREE.Group();
const SCALE = 1.6;
function metal(hex, spec = 0xffffff, shininess = 90) {
  return new THREE.MeshPhongMaterial({ color: hex, specular: spec, shininess });
}
function matte(hex) { return new THREE.MeshLambertMaterial({ color: hex }); }
const matAlu   = metal(0xd2d6dc, 0xffffff, 110); // silver aluminum block
const matSink  = matte(0x121418);                // matte black finned heatsink
const matTip   = metal(0xc9ced8, 0xffffff, 130); // polished steel tip — same family as the body

let y = 0;

// Nozzle tip — tapered cone, narrow at the print, wider where it bolts in.
{
  const h = 2.0 * SCALE;
  const g = new THREE.CylinderGeometry(1.05 * SCALE, 0.35 * SCALE, h, 24);
  g.translate(0, y + h / 2, 0);
  nozzleGroup.add(new THREE.Mesh(g, matTip));
  y += h;
}

// Hot glow at the print-contact point: a tight bright core plus a softer
// larger halo, both AdditiveBlending so they read as light rather than
// painted color. Wrapped in a sub-group so we can toggle visibility cleanly
// when the printer isn't actively extruding (PAUSED).
const glowGroup = new THREE.Group();
{
  const glowY = 0.4 * SCALE;
  // Inner core — small, bright but dialed back from the prior take.
  const coreGeo = new THREE.SphereGeometry(0.28 * SCALE, 16, 12);
  coreGeo.translate(0, glowY, 0);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xfff0c0,
    transparent: true, opacity: 0.65,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  glowGroup.add(new THREE.Mesh(coreGeo, coreMat));
  // Inner halo — softer and smaller than before.
  const haloGeo = new THREE.SphereGeometry(0.95 * SCALE, 20, 16);
  haloGeo.translate(0, glowY, 0);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xff5a18,
    transparent: true, opacity: 0.13,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  glowGroup.add(new THREE.Mesh(haloGeo, haloMat));
  // Outer halo — barely visible falloff.
  const halo2Geo = new THREE.SphereGeometry(1.7 * SCALE, 20, 16);
  halo2Geo.translate(0, glowY, 0);
  const halo2Mat = new THREE.MeshBasicMaterial({
    color: 0xff3608,
    transparent: true, opacity: 0.05,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  glowGroup.add(new THREE.Mesh(halo2Geo, halo2Mat));
}
nozzleGroup.add(glowGroup);

// Silver aluminum heatbreak block — uniform cuboid, no taper.
{
  const w = 3.4 * SCALE;
  const d = 3.4 * SCALE;
  const h = 3.0 * SCALE;
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y + h / 2, 0);
  nozzleGroup.add(new THREE.Mesh(g, matAlu));
  y += h;
}

// Finned heatsink — uniform-width stack of alternating wider fin slabs and
// narrower core slabs. Each fin protrudes radially from the core. Five fins
// gives a clean horizontal-grooved look without exploding the mesh count.
{
  const finCount = 5;
  const finH    = 0.55 * SCALE;
  const gapH    = 0.55 * SCALE;
  const finW    = 5.4 * SCALE;
  const coreW   = 4.0 * SCALE;
  for (let i = 0; i < finCount; i++) {
    // fin (wide, thin)
    const fg = new THREE.BoxGeometry(finW, finH, finW);
    fg.translate(0, y + finH / 2, 0);
    nozzleGroup.add(new THREE.Mesh(fg, matSink));
    y += finH;
    // gap / core slab between fins (skip after the last fin)
    if (i < finCount - 1) {
      const cg = new THREE.BoxGeometry(coreW, gapH, coreW);
      cg.translate(0, y + gapH / 2, 0);
      nozzleGroup.add(new THREE.Mesh(cg, matSink));
      y += gapH;
    }
  }
  // Solid cap on top of the heatsink (matches fin width).
  const capH = 0.6 * SCALE;
  const cap = new THREE.BoxGeometry(finW, capH, finW);
  cap.translate(0, y + capH / 2, 0);
  nozzleGroup.add(new THREE.Mesh(cap, matSink));
  y += capH;
}
nozzleGroup.visible = false;
nozzleGroup.renderOrder = 1000;
nozzleGroup.traverse(c => { if (c.isMesh) c.renderOrder = 1000; });

// Bambu-style print plate: matte slab with a slightly lighter rim. Sized to
// the actual connected printer's bed. No surface grid lines — at our orbit
// camera speed thin lines moiré/jitter against subpixel rendering, and a
// clean matte plate reads better as the build surface anyway.
const PLATE_W = bed.x, PLATE_D = bed.y;
const printPlate = new THREE.Group();
const plateSlabGeo = new THREE.BoxGeometry(PLATE_W, 0.6, PLATE_D);
plateSlabGeo.translate(0, -0.3, 0);  // top face at y=0
// Semi-transparent slab so the camera feed (or whatever sits behind the
// widget) shows through the plate while the prints + nozzle stay opaque.
// Lighter slab with a subtle specular highlight so it reads as a
// physical surface and you can see the camera angle / lighting on it.
const plateSlabMat = new THREE.MeshPhongMaterial({
  color: 0x3a4048,
  specular: 0x6a7280,
  shininess: 35,
});
printPlate.add(new THREE.Mesh(plateSlabGeo, plateSlabMat));
// Lighter rim around the edges (4 thin boxes).
const rimMat = new THREE.MeshPhongMaterial({
  color: 0x6a7280,
  specular: 0xa0a8b0,
  shininess: 60,
});
const rimT = 1.2, rimH = 0.2;
const mkRim = (w, d, x, z) => {
  const g = new THREE.BoxGeometry(w, rimH, d);
  g.translate(x, rimH / 2, z);
  printPlate.add(new THREE.Mesh(g, rimMat));
};
mkRim(PLATE_W, rimT, 0, +PLATE_D / 2 - rimT / 2);
mkRim(PLATE_W, rimT, 0, -PLATE_D / 2 + rimT / 2);
mkRim(rimT, PLATE_D, +PLATE_W / 2 - rimT / 2, 0);
mkRim(rimT, PLATE_D, -PLATE_W / 2 + rimT / 2, 0);

// Lights for the whole scene — illuminate both the hotend assembly and
// the gcode-preview toolpath geometry (which uses MeshLambertMaterial).
// Lower ambient + a strong key directional gives the print body visible
// directional shading so curves and overhangs read with depth instead of
// looking like flat outlines.
const nozzleAmbient = new THREE.AmbientLight(0xffffff, 0.25);
const nozzleKey = new THREE.DirectionalLight(0xffffff, 1.6);
nozzleKey.position.set(120, 180, 90);
const nozzleFill = new THREE.DirectionalLight(0xb8c8ff, 0.45);
nozzleFill.position.set(-80, 60, -60);
// Subtle warm rim light from low/behind to catch the back edges of cylindrical
// prints — gives that "lit object on dark BG" look in OBS overlays.
const nozzleRim = new THREE.DirectionalLight(0xffd2a0, 0.35);
nozzleRim.position.set(-40, 30, 110);

const recentDeposition = createRecentDepositionRibbon();
recentDeposition.mesh.renderOrder = 999;

// gcode-preview's render() rebuilds the entire toolpath geometry (parses
// commands up to endLayer, creates a fresh group, and clears the scene).
// That's expensive and almost always wasteful — the geometry only actually
// changes when endLayer changes (i.e., once per layer). For all the in-between
// frames we just need to re-issue a GPU draw with the new camera position
// and updated nozzle/trail positions. Splitting those paths cut CPU
// dramatically.
const _origRender = preview.render.bind(preview);
let lastRenderedEndLayer = -1;
let lastStaticView = null;
let lastDrawAt = -Infinity;
let packedPreview = null;
let packedPlayback = null;
let packedCompositor = null;
let packedViewDirty = true;
let packedFrame = null;
let packedModelLayerCount = 0;
let startupReport = null;
const myExtras = [nozzleAmbient, nozzleKey, nozzleFill, nozzleRim, recentDeposition.mesh, nozzleGroup, printPlate];

function fullRebuild(packedPrefix = preview.endLayer) {
  if (packedPreview) {
    packedPreview.show(packedPrefix);
    if (packedPreview.group.parent !== preview.scene) preview.scene.add(packedPreview.group);
    lastRenderedEndLayer = packedPrefix;
    return;
  }
  // Heavy path: gcode-preview clears the scene + rebuilds layer geometry.
  _origRender();
  // gcode-preview also re-adds its bed grid (LineSegments at y=0) and the
  // build-volume box edges (LineSegments around the bed). Both shimmer/
  // moiré against the dark plate when the camera orbits — pull them out
  // so we only show our matte plate. The actual toolpath geometry is
  // inside a Group child, not a top-level LineSegments, so it's untouched.
  const ours = new Set(myExtras);
  for (let i = preview.scene.children.length - 1; i >= 0; i--) {
    const c = preview.scene.children[i];
    // Remove gcode-preview's bed grid + build-volume box edges (LineSegments
    // at top level) and its built-in ambient + point lights — those flatten
    // the print body. Our directional/ambient lights below give better
    // shape definition. Toolpath geometry lives inside a Group, untouched.
    if (ours.has(c)) continue;
    if (c.type === 'LineSegments' || c.type === 'AmbientLight' || c.type === 'PointLight') {
      preview.scene.remove(c);
    }
  }
  for (const obj of myExtras) {
    if (!preview.scene.children.includes(obj)) preview.scene.add(obj);
  }
  lastRenderedEndLayer = preview.endLayer;
}

// preview.render() is overridden so callers (e.g. setExtrusionColor) trigger
// a rebuild the first time they're called after a real geometry change.
preview.render = function () {
  if (packedPreview) {
    drawPackedFrame();
    return;
  }
  lastStaticView = null;
  fullRebuild();
  updateNozzlePosition();
  preview.renderer?.render(preview.scene, preview.camera);
};

// Lightweight per-frame draw — no geometry rebuild, just nozzle/trail position
// updates and one GPU draw call. Falls back to a full rebuild when the
// rendered endLayer changes.
function fastTick() {
  const rebuild = preview.endLayer !== lastRenderedEndLayer;
  if (rebuild) {
    fullRebuild();
  } else {
    // Make sure our extras are still attached (nothing should be removing
    // them, but be defensive against future scene-clearing callers).
    for (const obj of myExtras) {
      if (!preview.scene.children.includes(obj)) preview.scene.add(obj);
    }
  }
  updateNozzlePosition();
  // A finished plate has no moving nozzle. Keep the camera fit responsive,
  // but avoid flooding a software GPU with millions of identical vertices.
  const still = isPausedForState();
  preview.camera.updateMatrixWorld();
  const view = [...preview.camera.matrixWorld.elements, ...preview.camera.projectionMatrix.elements];
  if (still && !rebuild && lastStaticView) {
    if (view.every((value, index) => Math.abs(value - lastStaticView[index]) < 0.000001)) return;
    if (performance.now() - lastDrawAt < 200) return;
  }
  preview.renderer?.render(preview.scene, preview.camera);
  lastDrawAt = performance.now();
  lastStaticView = still ? view : null;
}

const buildCenter = { x: bed.x / 2, y: bed.y / 2 };

// gcode-preview's layer.height is the LAYER THICKNESS, not absolute Z. Build a
// prefix-sum after gcode loads so we can look up the absolute Z by layer idx.
let cumZ = [];
function recomputeCumZ() {
  cumZ = [];
  let z = 0;
  for (const l of (preview.layers || [])) {
    z += (typeof l.height === 'number' ? l.height : 0);
    cumZ.push(z);
  }
}

// Per-layer simplified path: array of {x, y} points + cumulative travel
// distance so we can interpolate the nozzle position by elapsed time.
let layerPaths = [];
let activeLayerIdx = -1;
let layerStartTime = 0;
// Cumulative extrusion-time prefix sum across all layers. Used to map MQTT's
// global `mc_percent` (0–100) into a (layer, within-layer-elapsed) pair so
// the widget tracks the printer's real position rather than looping freely.
let cumLayerTime = [0];
let totalGcodeTime = 0;
function recomputeCumLayerTime() {
  cumLayerTime = [0];
  let t = 0;
  for (const lp of layerPaths) {
    t += lp.total;
    cumLayerTime.push(t);
  }
  totalGcodeTime = t;
}

// Bambu's MQTT `print.layer_num` is the *model* layer index (1-based),
// counting only real print layers. gcode-preview's parser splits at every Z
// change, so the first few parsed "layers" are the slicer's prep / skirt /
// prime moves with anomalous heights (often 0 / 0.8 / 0.6 mm vs the regular
// 0.12 mm). Find the index of the first parsed layer that looks like a real
// model layer so we can translate model→parsed.
let modelLayerOffset = 0;
function findModelLayerOffset(layers, fallback) {
  const first = layers.findIndex(layer => layer.height >= 0.05 && layer.height <= 0.5);
  return first >= 0 ? first : fallback;
}

// Firmware counts slicer model layers. Parsed previews can include additional
// layers for supports and startup, so keep the same mapping on first load and
// on subsequent live updates.
function hasExactModelLayers(layers) {
  return layers[1]?.modelLayer === 1 && layers.at(-1)?.modelLayer === layers.length - 1;
}

function matchedLayerTiming(job, marked = packedModelLayerCount) {
  if (!job?.layerTiming || !marked || Number(job.totalLayers) !== marked ||
      !Number.isInteger(job.layer) || job.layer < 1 || job.layer > marked) return job?.layerTiming;
  return { ...job.layerTiming, pace: job.layerPace ?? {} };
}

function modelToParsed(layer, mqttTotal, count = totalLayers, offset = modelLayerOffset, marked = packedModelLayerCount) {
  if (layer <= 0) return 0;
  if (marked && (!mqttTotal || mqttTotal === marked) && Number.isInteger(layer) && layer <= marked) return layer + 1;
  if (mqttTotal > 0 && count > 0) {
    return Math.min(count, Math.round((layer / mqttTotal) * (count - offset) + offset));
  }
  return Math.min(count, layer + offset);
}

async function buildLayerPaths(layers, signal) {
  // Build a per-layer list of segments. Each segment carries:
  //   ax,ay → bx,by   start/end positions in gcode coords
  //   ext             true for extrusion moves (G1 with positive E in M83 mode,
  //                   or increasing E in M82); false for travels (move-only G0/G1)
  //   dur             segment duration in seconds at the gcode's own feedrate,
  //                   including travels between extrusion segments.
  // Per-layer total = total movement time, which becomes the loop length for
  // the simulated nozzle walk so it moves at real print speed.
  const paths = [];
  let commands = 0, yieldAt = performance.now() + 8;
  let curX = 0, curY = 0;
  let curF = 6000;          // mm/min, initial guess
  let absoluteE = false;    // M83 (relative) is the Bambu default
  let prevE = 0;
  let tool = 0;
  // Helper: append one tessellated segment to the layer's segs array.
  // Both extrusion and travel moves get their real duration at the
  // commanded feedrate. Previously travels were instant (dur=0) which
  // underestimated totalGcodeTime by 20-50% — the calibrator then
  // converged to a speed factor that was too high, making the animation
  // visibly outpace the real printer (especially on multi-color H2D
  // prints with frequent tool-change travels).
  function pushSeg(segs, ax, ay, bx, by, isExt) {
    if (ax === bx && ay === by) return;
    const dist = Math.hypot(bx - ax, by - ay);
    const dur = dist / (curF / 60);
    segs.push({ ax, ay, bx, by, ext: isExt, tool, dur });
  }
  for (const layer of layers) {
    const segs = [];
    const cmds = (layer && layer.commands) || [];
    for (const c of cmds) {
      if (++commands % 512 === 0 && performance.now() >= yieldAt) {
        await yieldTask();
        signal.throwIfAborted();
        yieldAt = performance.now() + 8;
      }
      const g = c.gcode;
      const p = c.params || {};
      if (g === 'm82') { absoluteE = true; continue; }
      if (g === 'm83') { absoluteE = false; continue; }
      if (g === 'g92' && typeof p.e === 'number') { prevE = p.e; continue; }
      if (g.startsWith('t') && /^t-?\d+$/.test(g)) {
        tool = Number(g.slice(1));
        continue;
      }
      if (g === 'g0' || g === 'g1') {
        if (typeof p.f === 'number' && p.f > 0) curF = p.f;
        const nx = (typeof p.x === 'number') ? p.x : curX;
        const ny = (typeof p.y === 'number') ? p.y : curY;
        // Detect extrusion: in M83, any positive E param. In M82, E that exceeds
        // the previous absolute E.
        let isExtrusion = false;
        if (typeof p.e === 'number') {
          isExtrusion = g === 'g1' && (absoluteE ? p.e > prevE : p.e > 0);
          prevE = absoluteE ? p.e : prevE + p.e;
        }
        if (nx !== curX || ny !== curY) {
          pushSeg(segs, curX, curY, nx, ny, isExtrusion);
          curX = nx; curY = ny;
        }
      } else if (g === 'g2' || g === 'g3') {
        // Arc move. Bambu emits these heavily for curved perimeters; without
        // tessellation the simulated nozzle would teleport across each arc
        // as a straight chord (e.g. drawing a triangle across an open cup).
        // Tessellate into short line segments so the nozzle traces the curve.
        if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        if (typeof p.i !== 'number' || typeof p.j !== 'number') continue; // R-form not supported; rare in slicer output
        if (typeof p.f === 'number' && p.f > 0) curF = p.f;
        let isExtrusion = false;
        if (typeof p.e === 'number') {
          isExtrusion = absoluteE ? p.e > prevE : p.e > 0;
          prevE = absoluteE ? p.e : prevE + p.e;
        }
        const cw = (g === 'g2');
        const cx = curX + p.i;
        const cy = curY + p.j;
        const r  = Math.hypot(p.i, p.j);
        const a0 = Math.atan2(curY - cy, curX - cx);
        let a1 = Math.atan2(p.y - cy, p.x - cx);
        let dA = a1 - a0;
        // Force the angular sweep to go in the correct direction.
        if (cw && dA > 0) dA -= Math.PI * 2;
        if (!cw && dA < 0) dA += Math.PI * 2;
        // Tessellation: ~11° per chord (12 chords per full circle), bounded.
        const nSegs = Math.max(2, Math.min(24, Math.ceil(Math.abs(dA) / (Math.PI / 16))));
        let prevX = curX, prevY = curY;
        for (let s = 1; s <= nSegs; s++) {
          const t = s / nSegs;
          const a = a0 + dA * t;
          const nx = cx + r * Math.cos(a);
          const ny = cy + r * Math.sin(a);
          pushSeg(segs, prevX, prevY, nx, ny, isExtrusion);
          prevX = nx; prevY = ny;
        }
        curX = p.x; curY = p.y;
      }
    }
    let total = 0;
    const cumTime = [0];
    for (const s of segs) {
      total += s.dur;
      cumTime.push(total);
    }
    paths.push({ segs, cumTime, total });
  }
  return paths;
}

function nozzleXYAt(path, elapsedSec) {
  const targetT = path.total > 0 ? elapsedSec % path.total : 0;
  let first = 0, last = path.segs.length - 1;
  while (first < last) {
    const center = (first + last) >>> 1;
    if (path.cumTime[center + 1] < targetT) first = center + 1;
    else last = center;
  }
  const segment = path.segs[first];
  const fraction = segment.dur > 0 ? Math.min(1, Math.max(0, (targetT - path.cumTime[first]) / segment.dur)) : 1;
  return {
    x: segment.ax + (segment.bx - segment.ax) * fraction,
    y: segment.ay + (segment.by - segment.ay) * fraction,
    index: first,
  };
}

// When set, the nozzle's within-layer position is pinned to this fraction
// (0..1) instead of being driven by elapsed wall-clock time.
let pathHoldFraction = null;

function updateNozzlePosition() {
  const path = layerPaths[activeLayerIdx];
  if (isPausedForState() || !path?.segs.length) {
    nozzleGroup.visible = false;
    recentDeposition.setSegments([]);
    return;
  }
  const elapsed = pathHoldFraction !== null ? pathHoldFraction * path.total
    : (performance.now() - layerStartTime) / 1000 * nozzleSpeedFactor;
  const tip = nozzleXYAt(path, elapsed);
  const z = cumZ[activeLayerIdx] ?? 0;
  const toWorld = (x, y) => [x - buildCenter.x, z, buildCenter.y - y];
  // Mirror gcode-preview's bed-centred transform so both draws share the
  // same point where the nozzle contacts the material.
  nozzleGroup.position.fromArray(toWorld(tip.x, tip.y));
  nozzleGroup.visible = true;
  const current = path.segs[tip.index];
  glowGroup.visible = current.ext;
  if (!current.ext) {
    recentDeposition.setSegments([]);
    return;
  }
  const palette = preview.extrusionColor;
  const color = new THREE.Color(Array.isArray(palette) ? palette[current.tool] ?? palette[0] : palette).toArray();
  const width = canvas.clientWidth, height = canvas.clientHeight;
  preview.camera.updateMatrixWorld();
  const bead = createRecentDepositionPath(preview.camera, null, width, height);
  for (let i = tip.index; i >= Math.max(0, tip.index - RECENT_DEPOSITION_SEGMENTS + 1); i--) {
    const segment = path.segs[i];
    if (!segment.ext || segment.tool !== current.tool) break;
    const from = toWorld(segment.ax, segment.ay);
    const to = i === tip.index ? toWorld(tip.x, tip.y) : toWorld(segment.bx, segment.by);
    if (!bead.add(from, to, color)) break;
  }
  recentDeposition.setViewport(width, height);
  recentDeposition.setSegments(bead.segments());
}

// Sets which layer the nozzle should walk along. Position itself comes from
// the time-driven animation in updateNozzlePosition().
function setNozzleLayer(endLayer) {
  const layers = preview.layers || [];
  if (endLayer <= 0 || !layers.length) {
    activeLayerIdx = -1;
    return;
  }
  const idx = Math.min(endLayer, layers.length) - 1;
  if (idx !== activeLayerIdx) {
    activeLayerIdx = idx;
    layerStartTime = performance.now();
  }
}

// Verify mode: auto-advance the nozzle's active layer through 0..verifyLayers-1
// when each layer's total extrusion time elapses. Renders all N layers up
// front so the user can compare the nozzle's path against the static toolpath.
let verifyManualHold = false;
function verifyAdvanceTick() {
  if (!verifyLayers || verifyManualHold || pathHoldFraction !== null || activeLayerIdx < 0 || !layerPaths.length) return;
  const cap = Math.min(verifyLayers, layerPaths.length);
  const p = layerPaths[activeLayerIdx];
  if (!p || p.total === 0) {
    // Empty layer — skip immediately
    const next = (activeLayerIdx + 1) % cap;
    setNozzleLayer(next + 1);
    return;
  }
  const elapsed = (performance.now() - layerStartTime) / 1000;
  if (elapsed >= p.total) {
    const next = (activeLayerIdx + 1) % cap;
    setNozzleLayer(next + 1);
    setLabel(next + 1, cap);
  }
}

let currentTaskKey = null;
// Bound retries per job, keep polling telemetry, and cancel obsolete loads.
let failure = null;
let wantedTaskKey = null;
let wantedJob = null;
let canRequestToolpath = false;
let loadController = null;
let loadSerial = 0;
let rendererUnavailable = false;
let telemetryFailures = 0;
let lastEndLayer = -1;
let inFlight = false;
let showingCalibration = false;
let forceNocache = false;  // set by lifecycle detection to bust server cache

let totalLayers = 0;
let scrubActive = false;     // user is dragging or playing
let scrubLayer = 0;
let playing = false;
let playTimer = null;
let lastGcodeState = null;   // most recent gcode_state from MQTT
let lastSubStage = -1;       // most recent stg_cur (0=printing, nonzero=sub-stage/prep)
// Previous tick's state for new-print lifecycle detection. Tracked separately
// from lastGcodeState (which is overwritten early in tick()) so we can detect
// FINISH→RUNNING transitions and mc_percent resets that signal a new job.
let prevTickState = null;
let prevTickMcPct = -1;
// MQTT sync state for the within-layer animation. We re-anchor only when
// fresh mc_percent or layer_num data arrives — between ticks the animation
// runs free at gcode-real speed (using gcode F values), so it stays smooth
// instead of jittering on the 1% mc_percent integer steps.
let mcPercentLastSeen = null;
let mqttSyncedLayer = null;
// Adaptive speed calibration: track when we last saw a new mc_percent
// value so we can measure how much wall-clock time elapses per percent
// of gcode-time. The ratio tells us the true effective speed factor.
let lastMcPctChangeWall = null;
let lastMcPctChangeValue = null;
// In production (no ?debug / ?layers), pause all motion when the printer
// isn't actively printing. The toolpath stays on screen as a finished snapshot.
function isPausedForState() {
  if (verifyLayers || scrubActive) return false;
  if (['FINISH', 'IDLE', 'FAILED', 'PAUSED'].includes(lastGcodeState)) return true;
  // Preview state: model is shown but printer is still calibrating — freeze
  // the nozzle so it doesn't animate over the static preview.
  if (lastGcodeState === 'RUNNING' && lastSubStage !== 0) return true;
  return false;
}

function h3cTrayHex(print, { amsIndex, trayIndex }) {
  const units = print?.ams?.ams;
  if (!Array.isArray(units) || (amsIndex === 255 && trayIndex === 255)) return neutralFilament;
  const unit = units.find(candidate => BBAms.unitId(candidate) === amsIndex);
  const rgba = unit && BBAms.trayAt(print, unit, trayIndex)?.tray_color;
  if (typeof rgba !== 'string' || !/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(rgba) || rgba === '00000000') return neutralFilament;
  const hex = '#' + rgba.slice(0, 6).toUpperCase();
  return hex === '#000000' ? '#404040' : hex;
}

// The slicer writes filament indices into T commands. H3C reports their
// physical spool addresses in print.mapping; AMS array order is unrelated.
function buildTrayPalette(print) {
  if (printerType === 'H3C') {
    if (!Array.isArray(print?.mapping) || !print.mapping.length) return null;
    return Array.from({ length: H3C_MAX_SLICER_FILAMENTS }, (_, index) => h3cTrayHex(print, BBAms.decodeAddress(print, print.mapping[index])));
  }
  const ams = print?.ams?.ams;
  if (!Array.isArray(ams) || !ams.length) return null;
  const slots = [];
  ams.forEach((unit, ai) => {
    (unit.tray || []).forEach((tray, ti) => {
      slots[ai * 4 + ti] = tray;
    });
  });
  if (!slots.length) return null;
  const palette = [];
  for (let i = 0; i < slots.length; i++) {
    const t = slots[i];
    let hex = (t && typeof t.tray_color === 'string' && t.tray_color.length >= 6 && t.tray_color !== '00000000')
      ? '#' + t.tray_color.slice(0, 6).toUpperCase()
      : '#888888';
    if (hex === '#000000') hex = '#404040';  // pure black washes out on dark plate
    palette.push(hex);
  }
  return palette;
}

let lastPaletteSig = null;
function syncFilamentColor(print) {
  const palette = buildTrayPalette(print);
  if (!palette && printerType !== 'H3C') return;
  const sig = palette ? palette.join('|') : neutralFilament;
  if (sig !== lastPaletteSig) {
    preview.extrusionColor = palette || neutralFilament;
    lastPaletteSig = sig;
    if (packedPreview) packedPreview.setPalette(preview.extrusionColor);
    // The compact geometry already exists. Invalidate the draw, including
    // the static camera's skip-unchanged-frame optimization.
    lastRenderedEndLayer = -1;
  }
}

// kind: 'hint' (small bottom hint, default), 'loading' (centered pill with
// pulsing dot), 'error' (small red bottom hint).
// Dedupes by tracking last text+kind so it's safe to call every tick — the
// active-print branch calls setOverlay('') each poll to ensure stale prep
// text doesn't linger after the printer starts depositing material.
let _lastOverlayText = null;
let _lastOverlayKind = null;
function setOverlay(text, kind = 'hint') {
  if (text === _lastOverlayText && kind === _lastOverlayKind) return;
  _lastOverlayText = text;
  _lastOverlayKind = kind;
  window.BBGcodeUI.message(text, kind, kind === 'loading' && inFlight);
}

function setLabel(layer, total) {
  if (labelEl) labelEl.textContent = `layer ${layer} / ${total}`;
}

// Wipe the rendered toolpath + animation state to a clean "no print loaded"
// baseline. Called when a new task_id is detected so the old print's
// geometry doesn't stay on screen while we fetch the new gcode (which can
// take 1-2 s for a fresh print, longer if the printer hasn't written the
// file to /cache/ yet and we have to retry).
function clearPackedPreview() {
  packedPlayback?.dispose();
  packedPlayback = null;
  packedCompositor?.dispose();
  packedCompositor = null;
  packedFrame = null;
  packedModelLayerCount = 0;
  packedViewDirty = true;
  pathEl.disabled = false;
  playEl.disabled = false;
  packedPreview?.dispose();
  packedPreview = null;
  detailEl.hidden = true;
}

function clearScene() {
  clearPackedPreview();
  scrubActive = false;
  scrubLayer = 0;
  playing = false;
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  playEl.textContent = '▶';
  pathHoldFraction = null;
  pathEl.value = '0';
  pathLabelEl.textContent = '0%';
  verifyManualHold = false;
  nozzleGroup.visible = false;
  recentDeposition.setSegments([]);
  preview.clear();                         // reset parser + geometry — old layers are gone
  preview.endLayer = 0;
  layerPaths = [];
  cumZ = [];
  cumLayerTime = [0];
  totalGcodeTime = 0;
  totalLayers = 0;
  modelLayerOffset = 0;
  activeLayerIdx = -1;
  lastEndLayer = -1;
  lastRenderedEndLayer = -1;
  smoothedNozzleInit = false;
  mcPercentLastSeen = null;                 // force a fresh sync on next tick
  mqttSyncedLayer = null;
  lastMcPctChangeWall = null;
  lastMcPctChangeValue = null;
  calibrationSamples = 0;
  nozzleSpeedFactor = 0.5;                 // reset to initial guess for new print
  cameraDistance = 0;                       // re-fit on next camera tick
  modelCorners.length = 0;
  fastTick();                               // commit the empty state to the GPU
}

const { archiveMiB, toolpathMiB, transferIdleMs, transferPollMs } = window.BBGcodeLimits;
const PREVIEW_MAX_BYTES = toolpathMiB * 1024 * 1024;
const MAX_AUTO_ATTEMPTS = 5;
function previewLimit(detail) {
  return Object.assign(new Error(`${detail} Open this plate in Bambu Studio. Retrying or loading the same file will not change this limit.`), {
    retryable: false, recovery: false,
  });
}
function archiveLimit(detail) {
  return Object.assign(new Error(detail), { retryable: false, rawFallback: true });
}
// Browsers can suspend animation frames in an obscured/offscreen iframe.
// Give visible status a chance to paint without making loading depend on it.
function paintLoading() {
  return new Promise(resolve => {
    let frame;
    const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
    const timer = setTimeout(finish, 100);
    frame = requestAnimationFrame(() => setTimeout(finish, 0));
  });
}
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
function invalidateLoad() {
  loadSerial++;
  loadController?.abort();
  loadController = null;
  inFlight = false;
  failure = null;
}
function showFailure() {
  if (!failure) return;
  if (!operator) {
    const text = failure.code === 'PREVIEW_COMPLEXITY'
      ? 'This plate exceeds the 3D preview limits. Open it in Bambu Studio.'
      : 'Print preview unavailable.';
    setOverlay(text, 'error');
    return;
  }
  const seconds = Math.max(0, Math.ceil((failure.nextAt - Date.now()) / 1000));
  const automatic = failure.retryable && failure.attempts < MAX_AUTO_ATTEMPTS && lastGcodeState !== 'FINISH';
  const recovery = failure.recovery !== false;
  const next = failure.rawFallback ? ' Load the exact .gcode file or open this plate in Bambu Studio.'
    : automatic ? ` Retrying in ${seconds}s.` : recovery ? ' Use Retry now or load the exact sliced file.' : '';
  setOverlay(failure.detail + next, 'error');
  window.BBGcodeUI.recovery(recovery, recovery && !failure.rawFallback);
}
function transferWatchdog(controller) {
  let timer;
  function touch() {
    clearTimeout(timer);
    if (!controller.signal.aborted) timer = setTimeout(() => {
      controller.abort(new Error(`No file data received for ${Math.round(transferIdleMs / 1000)} seconds. Check the printer connection and retry.`));
    }, transferIdleMs);
  }
  touch();
  return { touch, stop() { clearTimeout(timer); } };
}

function byteProgress(bytes, total) {
  const received = (bytes / (1024 * 1024)).toFixed(1);
  if (!total) return `${received} MiB received`;
  return `${Math.min(100, Math.floor(bytes / total * 100))}% (${received} / ${(total / (1024 * 1024)).toFixed(1)} MiB)`;
}

function watchPrinterTransfer(job, signal, onProgress) {
  let timer, activity;
  const watcher = new AbortController();
  const abort = () => { clearTimeout(timer); watcher.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  async function poll() {
    try {
      const reply = await fetch('/api/gcode/progress?' + new URLSearchParams({ job }), {
        cache: 'no-store', signal: AbortSignal.any([watcher.signal, AbortSignal.timeout(3000)]),
      });
      if (reply.ok && !watcher.signal.aborted) {
        const status = await reply.json();
        if (!watcher.signal.aborted && Number.isSafeInteger(status.activity) && activity !== status.activity) {
          activity = status.activity;
          onProgress(status);
        }
      }
    } catch (_) { /* A status poll is optional; the file request has its own deadline. */ }
    if (!watcher.signal.aborted) timer = setTimeout(poll, transferPollMs);
  }
  timer = setTimeout(poll, transferPollMs);
  return () => { signal.removeEventListener('abort', abort); abort(); };
}

// XHR exposes actual upload progress; using a Blob keeps the validated
// response compatible with the same streaming decoder as an automatic GET.
function uploadToolpath(url, file, signal, onProgress) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'blob';
    xhr.upload.onprogress = event => onProgress('upload', event.loaded, file.size);
    xhr.upload.onload = () => onProgress('validate');
    xhr.onprogress = event => onProgress('download', event.loaded, event.lengthComputable ? event.total : 0);
    xhr.onload = () => {
      const headers = new Headers();
      for (const name of ['Content-Length', 'Content-Encoding', 'Content-Type', 'X-Gcode-Job', 'Retry-After']) {
        const value = xhr.getResponseHeader(name);
        if (value !== null) headers.set(name, value);
      }
      resolve(new Response(xhr.response, { status: xhr.status, headers }));
    };
    xhr.onabort = () => reject(signal.reason || new Error('Toolpath upload canceled.'));
    xhr.onerror = () => reject(new Error('The file upload connection was interrupted.'));
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

// Preserve the existing animated preview for smaller jobs. Keep a bounded
// prefix so a denser plate can switch to compact geometry using the same
// download. At the switch the original parser no longer retains commands.
function adaptivePreview(parser, signal) {
  const native = createPreviewBudget(parser, { inches: preview.inches });
  const prefix = [];
  let commands = 0, characters = 0, packed;
  return {
    async parseBatch(lines) {
      if (packed) return packed.parseBatch(lines);
      commands += lines.length;
      for (const line of lines) characters += line.length;
      prefix.push(lines);
      if (commands <= 200_000 && characters <= 12 * 1024 * 1024) {
        try {
          native.parseBatch(lines.filter(line => line[0] !== ';'));
          return;
        } catch (error) {
          if (!error.canPack) throw error;
        }
      }
      packed = await openPackedPreview(parser, signal, yieldTask);
      parser.layers.length = 0;
      parser.preamble.commands.length = 0;
      let yieldAt = performance.now() + 8;
      for (const batch of prefix) {
        signal.throwIfAborted();
        await packed.parseBatch(batch);
        if (performance.now() >= yieldAt) {
          await yieldTask();
          yieldAt = performance.now() + 8;
        }
      }
      prefix.length = 0;
    },
    packed: () => packed?.finish(),
    reader: () => packed?.reader ?? 'native',
    close: () => packed?.close(),
  };
}

async function readToolpath(res, budget, signal, onBytes) {
  const encoding = res.headers.get('Content-Encoding');
  const total = !encoding || encoding === 'identity' ? Number(res.headers.get('Content-Length')) || 0 : 0;
  if (total > PREVIEW_MAX_BYTES) {
    await res.body.cancel().catch(() => {});
    throw previewLimit(`This toolpath exceeds the ${toolpathMiB} MiB preview limit.`);
  }
  if (!res.body) throw new Error('BambuBoard returned no toolpath data.');
  const reader = res.body.getReader();
  let bytes = 0, framer, yieldAt = performance.now() + 8;
  async function parse(lines) {
    for (let offset = 0; offset < lines.length; offset += 512) {
      signal.throwIfAborted();
      await budget.parseBatch(lines.slice(offset, offset + 512));
      if (performance.now() >= yieldAt) {
        await yieldTask();
        yieldAt = performance.now() + 8;
      }
    }
  }
  try {
    framer = await openToolpathFramer(PREVIEW_WORKLOAD_LIMITS.commandCharacters, signal);
    for (;;) {
      signal.throwIfAborted();
      let result;
      try { result = await reader.read(); }
      catch (_) {
        signal.throwIfAborted();
        throw new Error('The file download was interrupted. Retry the transfer.');
      }
      const { done, value } = result;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PREVIEW_MAX_BYTES) throw previewLimit(`This toolpath exceeds the ${toolpathMiB} MiB preview limit.`);
      onBytes(bytes, total);
      await parse(await framer.frame(value));
    }
    if (total && bytes !== total) throw new Error('The file transfer ended before all toolpath bytes arrived. Retry the transfer.');
    await parse(await framer.frame(undefined, true));
    return bytes;
  } finally {
    framer?.close();
    await reader.cancel().catch(() => {});
  }
}

async function loadGcode(taskKey, overlayMsg = 'Getting print file…', file = null, manual = false) {
  const serial = ++loadSerial;
  loadController?.abort();
  const controller = loadController = new AbortController();
  const watchdog = transferWatchdog(controller);
  let stopWatching = () => {};
  let budget, provisionalPlayback;
  const startup = startupReport = { startedAt: performance.now(), reader: 'native' };
  const elapsed = () => performance.now() - startup.startedAt;
  const attempts = manual ? 1 : (failure?.attempts || 0) + 1;
  inFlight = true;
  dbg(`loadGcode START job=${wantedJob?.task || 'LAN'} attempt=${attempts} source=${file ? 'manual' : 'printer'}`);
  canvas.style.visibility = 'hidden';
  clearScene();
  const parser = new preview.parser.constructor(preview.minLayerThreshold);
  setOverlay(overlayMsg, 'loading');
  let stage = 'fetch';
  try {
    await paintLoading();
    if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
    const query = new URLSearchParams({ job: taskKey });
    if (forceNocache) query.set('nocache', '1');
    if (manual) query.set('retry', '1');
    forceNocache = false;
    if (file) {
      if (/\.3mf$/i.test(file.name) && file.size > archiveMiB * 1024 * 1024) {
        throw archiveLimit(`This archive exceeds the ${archiveMiB} MiB upload limit.`);
      }
      if (file.size > PREVIEW_MAX_BYTES) throw previewLimit(`This file exceeds the ${toolpathMiB} MiB upload limit.`);
    }
    const url = '/api/gcode/current?' + query;
    let res;
    if (file) {
      res = await uploadToolpath(url, file, controller.signal, (phase, bytes, total) => {
        if (serial !== loadSerial || controller.signal.aborted) return;
        watchdog.touch();
        if (phase === 'validate') setOverlay('BambuBoard is validating the uploaded file…', 'loading');
        else {
          const label = phase === 'upload' ? 'Uploading sliced file' : 'Downloading print file';
          setOverlay(`${label}… ${byteProgress(bytes, total)}`, 'loading');
        }
      });
    } else {
      stopWatching = watchPrinterTransfer(taskKey, controller.signal, status => {
        if (serial !== loadSerial || controller.signal.aborted) return;
        watchdog.touch();
        if (status.phase === 'download') setOverlay(`Reading file from printer… ${byteProgress(status.bytes || 0, status.total || 0)}`, 'loading');
        else if (status.phase === 'extract') setOverlay(`Unpacking and checking the plate… ${byteProgress(status.bytes || 0, status.total || 0)}`, 'loading');
        else setOverlay(status.phase === 'cache' ? 'Saving the verified toolpath…' : overlayMsg, 'loading');
      });
      res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    }
    startup.responseMs = elapsed();
    stopWatching();
    watchdog.touch();
    if (!res.ok) {
      let report = {};
      try { report = await res.json(); } catch (_) {}
      dbg(`loadGcode HTTP ${res.status} code=${report.code || 'unknown'} stage=${report.stage || 'unknown'} — ${report.detail || report.error || ''}`);
      if (report.code === 'CALIBRATING') {
        if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
        canRequestToolpath = false;
        window.BBGcodeUI.allowFile(false);
        setOverlay('Calibrating', 'calibration');
        return;
      }
      const friendly = report.code === 'FILE_NOT_FOUND'
        ? 'The printer cannot expose this print file. It may be in internal storage. Diagnostics show the paths checked.'
        : report.detail || `File request failed (HTTP ${res.status}).`;
      if (report.code === 'ARCHIVE_TOO_LARGE') throw archiveLimit(friendly);
      throw Object.assign(new Error(friendly), {
        retryable: report.retryable !== false && [404, 409, 429, 500, 502, 503, 504].includes(res.status),
        retryAfterMs: Number(report.retryAfterMs) || Number(res.headers.get('Retry-After')) * 1000 || 0,
        code: report.code,
        recovery: report.code !== 'FILE_TOO_LARGE',
      });
    }
    const header = res.headers.get('X-Gcode-Job');
    if (header && decodeURIComponent(header) !== taskKey) throw Object.assign(new Error('The print changed during download.'), { code: 'JOB_CHANGED' });
    let lastProgressAt = -Infinity;
    budget = adaptivePreview(parser, controller.signal);
    const bytes = await readToolpath(res, budget, controller.signal, (receivedBytes, total) => {
      watchdog.touch();
      if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
      startup.downloadMs = elapsed();
      if (performance.now() - lastProgressAt < 150 && receivedBytes !== total) return;
      lastProgressAt = performance.now();
      setOverlay(`Downloading print file… ${byteProgress(receivedBytes, total)}`, 'loading');
    });
    watchdog.stop();
    if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
    stage = 'parse';
    const packed = await budget.packed();
    startup.reader = budget.reader();
    if (packed) {
      startup.geometryReadyMs = elapsed();
      startup.workerTiming = packed.timing ?? null;
    }
    const layers = packed?.layers ?? [parser.preamble, ...parser.layers];
    if (packed) {
      if (!packed.segmentCount) throw Object.assign(new Error('The file has no printable extrusion toolpath.'), { retryable: false });
      setOverlay('Rendering large 3D preview…', 'loading');
      await paintLoading();
      controller.signal.throwIfAborted();
      stage = 'render';
      provisionalPlayback = createPackedNozzlePlayback(packed.motion, yieldTask);
      if (lastGcodeState === 'RUNNING' && wantedJob?.layerTiming?.advancing && !wantedJob.effectivelyDone) {
        const marked = hasExactModelLayers(layers) ? layers.length - 1 : 0;
        const first = modelToParsed(Number(wantedJob.layer) || 0, Number(wantedJob.totalLayers) || 0,
          layers.length, findModelLayerOffset(layers, 1), marked);
        if (first > 0) provisionalPlayback.prime(first - 1, matchedLayerTiming(wantedJob, marked));
      }
      const packingPalette = preview.extrusionColor;
      const stageStart = performance.now();
      const renderer = await buildPackedRenderer(packed, preview, bed, controller.signal, yieldTask, (done, total) => {
        setOverlay(`Rendering large 3D preview… ${Math.floor(done / total * 100)}%`, 'loading');
      });
      startup.gpuStageMs = performance.now() - stageStart;
      if (serial !== loadSerial || wantedTaskKey !== taskKey || controller.signal.aborted) {
        renderer.dispose();
        return;
      }
      packedPreview = renderer;
      packedModelLayerCount = hasExactModelLayers(layers) ? layers.length - 1 : 0;
      if (preview.extrusionColor !== packingPalette) renderer.setPalette(preview.extrusionColor);
      parser.preamble = layers[0];
      parser.layers = layers.slice(1);
      packedPlayback = provisionalPlayback;
      provisionalPlayback = null;
      packedCompositor = createPackedNozzleRenderer(preview, nozzleGroup, {
        lights: [nozzleAmbient, nozzleKey, nozzleFill, nozzleRim], packed: packedPreview,
      });
      layerPaths = [];
    } else {
      setOverlay('Processing toolpath… Building layer paths', 'loading');
      await paintLoading();
      controller.signal.throwIfAborted();
      const paths = await buildLayerPaths(layers, controller.signal);
      controller.signal.throwIfAborted();
      setOverlay('Rendering 3D preview…', 'loading');
      await paintLoading();
      if (serial !== loadSerial || wantedTaskKey !== taskKey || controller.signal.aborted) return;
      if (!parser.layers.length || !paths.some(layer => layer.segs.some(seg => seg.ext))) {
        throw Object.assign(new Error('The file has no printable extrusion toolpath. Choose the exact sliced .3mf or .gcode.'), { retryable: false });
      }
      layerPaths = paths;
      startup.geometryReadyMs = elapsed();
    }
    preview.parser = parser;
    recomputeCumZ(); recomputeCumLayerTime();
    modelLayerOffset = findModelLayerOffset(layers, packedPreview ? 1 : 0);
    totalLayers = layers.length;
    stage = 'render';
    cameraDistance = 0; lastEndLayer = -1;
    const renderCap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
    if (scrubEl) { scrubEl.max = String(renderCap); scrubEl.value = String(renderCap); scrubLayer = renderCap; }
    if (verifyLayers) {
      scrubActive = true;
      if (packedPlayback) packedPlayback.play(renderCap > 1 ? 1 : 0);
      advanceTo(renderCap); setNozzleLayer(1);
    } else {
      const reportedLayer = Number(wantedJob?.layer) || 0;
      const showWhole = ['FINISH', 'PREPARE', 'SLICING'].includes(lastGcodeState) ||
        (packed && (!reportedLayer || wantedJob?.effectivelyDone));
      const initial = modelToParsed(reportedLayer, Number(wantedJob?.totalLayers) || 0);
      if (packedPlayback && !showWhole && initial > 0) {
        if (lastGcodeState === 'RUNNING' && (wantedJob?.layerTiming?.advancing ?? lastSubStage === 0)) {
          packedPlayback.live(initial - 1, matchedLayerTiming(wantedJob));
        } else {
          packedPlayback.pause(initial - 1, matchedLayerTiming(wantedJob));
        }
      }
      advanceTo(showWhole ? totalLayers : Math.max(1, initial));
    }
    if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
    currentTaskKey = taskKey;
    failure = null;
    setLabel(verifyLayers ? 1 : lastEndLayer, renderCap);
    canvas.style.visibility = 'visible';
    if (!packed) startup.firstGeometryMs = elapsed();
    setOverlay('');
    dbg(`loadGcode OK layers=${totalLayers} bytes=${bytes} source=${file ? 'manual' : 'printer'}`);
  } catch (error) {
    if (serial !== loadSerial || wantedTaskKey !== taskKey) return;
    currentTaskKey = null;
    if (error.code === 'PREVIEW_COMPLEXITY' && error.recovery !== false) {
      error = Object.assign(previewLimit(error.message), { code: error.code });
    }
    if (packedPreview) clearPackedPreview();
    const detail = controller.signal.aborted ? controller.signal.reason.message : error.message;
    const retryable = stage === 'fetch' && error.retryable !== false && error.code !== 'TOOLPATH_ENCODING';
    const backoff = [5000, 15000, 30000, 60000, 120000][Math.min(attempts - 1, 4)];
    failure = { taskKey, attempts, detail, retryable, code: error.code, recovery: error.recovery, rawFallback: error.rawFallback, nextAt: Date.now() + Math.max(backoff, error.retryAfterMs || 0) };
    dbg(`loadGcode FAIL stage=${stage} attempts=${attempts} retryable=${retryable}: ${detail}`);
    showFailure();
  } finally {
    provisionalPlayback?.dispose();
    budget?.close();
    stopWatching();
    watchdog.stop();
    if (serial === loadSerial) { inFlight = false; loadController = null; }
  }
}

function advanceTo(layerNum) {
  if (layerNum === lastEndLayer) return;
  preview.endLayer = layerNum;
  setNozzleLayer(layerNum);
  if (packedPlayback && !scrubActive) {
    scrubLayer = layerNum;
    scrubEl.value = String(layerNum);
  }
  preview.render();
  lastEndLayer = layerNum;
  setLabel(layerNum, totalLayers);
}

// Fit the print at the chosen angle and smoothly follow the visible nozzle.
const defaultDistance = 100 / Math.cos(THREE.MathUtils.degToRad(30));
const defaultFarPlane = preview.camera.far;
const bedDiagonal = Math.hypot(bed.x, bed.y, bed.z);
let cameraDistance = 0;
let orbitTarget    = new THREE.Vector3(0, 0, 0); // current (smoothed) lookAt
let bboxCenter     = new THREE.Vector3(0, 0, 0); // print bbox center anchor
let smoothedNozzle = new THREE.Vector3(0, 0, 0); // EMA of nozzle position
let smoothedNozzleInit = false;
const modelCorners = [];
const cameraOut = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
let cameraView, cameraZoom;
const cornerOffset = new THREE.Vector3();
const NOZZLE_FOLLOW_BIAS = 1.0;
const NOZZLE_SMOOTH_LERP = 0.015;
const TARGET_LERP        = 0.045;
const _scratchDesired    = new THREE.Vector3();

function fittedDistance(target) {
  // Fit every model corner into the actual perspective frustum. A guessed
  // footprint radius clips long/tall prints and portrait widget canvases.
  const tanY = Math.tan(THREE.MathUtils.degToRad(preview.camera.fov / 2)) * 0.85;
  const tanX = tanY * Math.max(0.01, preview.camera.aspect);
  // Use the unzoomed frustum so 100% fits and larger zooms can crop in.
  let distance = defaultDistance / 2;
  for (const corner of modelCorners) {
    cornerOffset.copy(corner).sub(target);
    const depth = cornerOffset.dot(cameraOut);
    distance = Math.max(distance,
      depth + preview.camera.near * 1.1,
      depth + Math.abs(cornerOffset.dot(cameraRight)) / tanX,
      depth + Math.abs(cornerOffset.dot(cameraUp)) / tanY);
  }
  return distance;
}

function setCameraView(view, zoom) {
  const settings = BBGcodeView.normalize(view, zoom);
  if (settings.view !== cameraView) {
    cameraView = settings.view;
    packedViewDirty = true;
    const preset = BBGcodeView.presets[cameraView];
    const azimuth = THREE.MathUtils.degToRad(preset.azimuth);
    const elevation = THREE.MathUtils.degToRad(preset.elevation);
    cameraOut.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    cameraRight.set(Math.cos(azimuth), 0, -Math.sin(azimuth));
    cameraUp.crossVectors(cameraOut, cameraRight);
    // A top-down camera needs an up vector in the plane of the bed.
    preview.camera.up.copy(cameraUp);
    if (modelCorners.length) cameraDistance = fittedDistance(orbitTarget);
  }
  if (settings.zoom !== cameraZoom) {
    cameraZoom = settings.zoom;
    packedViewDirty = true;
    preview.camera.zoom = cameraZoom / 100;
    preview.camera.updateProjectionMatrix();
  }
}

setCameraView(params.get('view'), params.get('zoom'));
if (window.parent !== window) {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'bambuboard:gcode-view') return;
    setCameraView(event.data.view, event.data.zoom);
  });
  window.parent.postMessage({ type: 'bambuboard:gcode-view-ready' }, location.origin);
}

function autoFitCamera() {
  if (packedPreview) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = packedPreview.bounds;
    bboxCenter.set(
      (minX + maxX) / 2 - buildCenter.x, (minZ + maxZ) / 2, buildCenter.y - (minY + maxY) / 2,
    );
    orbitTarget.copy(bboxCenter);
    modelCorners.length = 0;
    for (const x of [minX, maxX]) for (const y of [minZ, maxZ]) for (const z of [minY, maxY]) {
      modelCorners.push(new THREE.Vector3(x - buildCenter.x, y, buildCenter.y - z));
    }
    cameraDistance = fittedDistance(orbitTarget);
    return;
  }
  // Compute bbox of just the "real" model extrusions, ignoring Bambu's prep
  // / priming / purge passes which can span the whole bed and blow up the
  // framing. We approximate "real model layer" as one whose layer thickness
  // is in the normal slicer range (0.05–0.5 mm).
  if (!layerPaths.length || !preview.layers?.length) return;
  let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
  const cap = verifyLayers ? Math.min(verifyLayers, layerPaths.length) : layerPaths.length;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < cap; i++) {
      const h = preview.layers[i]?.height || 0;
      if (pass === 0 && (h < 0.05 || h > 0.5)) continue;
      for (const s of layerPaths[i].segs) {
        if (!s.ext) continue;
        minX = Math.min(minX, s.ax, s.bx); maxX = Math.max(maxX, s.ax, s.bx);
        minY = Math.min(minY, s.ay, s.by); maxY = Math.max(maxY, s.ay, s.by);
      }
    }
    if (isFinite(minX)) break; // Fall back for unusual layer thicknesses.
  }
  if (!isFinite(minX) || !isFinite(minY)) return;
  const cxg = (minX + maxX) / 2, cyg = (minY + maxY) / 2;
  const sz = (cumZ[Math.min(cap, cumZ.length) - 1] || 0);
  // Map gcode (cxg, cyg, sz/2) to three world coords for the bbox anchor.
  bboxCenter.set(
    cxg - buildCenter.x,
    sz / 2,
    buildCenter.y - cyg,
  );
  // Snap the smoothed target to the new anchor on first frame so we don't
  // start orbiting around (0,0,0) and lerp-pan into place.
  orbitTarget.copy(bboxCenter);
  modelCorners.length = 0;
  for (const x of [minX, maxX]) for (const y of [0, sz]) for (const z of [minY, maxY]) {
    modelCorners.push(new THREE.Vector3(x - buildCenter.x, y, buildCenter.y - z));
  }
  cameraDistance = fittedDistance(orbitTarget);
}

function packedStatus(frame) {
  if (frame.state === 'buffering') return 'Buffering nozzle preview…';
  if (frame.state === 'awaiting-layer') return 'Waiting for next layer';
  if (frame.state === 'waiting') return 'Waiting for layer timing';
  if (frame.unavailable === 'unsupported-arc') return 'Nozzle playback cannot follow an arc in this layer';
  if (frame.unavailable === 'decode') return 'Could not decode nozzle movement for this layer';
  if (frame.state === 'unavailable') return 'Nozzle path unavailable for this layer';
  if (frame.state === 'untimed') return 'Nozzle timing unavailable for this layer';
  return '';
}

function drawPackedFrame() {
  const timing = performance.now();
  const dirty = packedViewDirty;
  if (dirty) {
    if (!cameraDistance) autoFitCamera();
    cameraDistance = (modelCorners.length ? fittedDistance(orbitTarget) : defaultDistance) || defaultDistance;
    const far = Math.max(defaultFarPlane, Math.ceil((cameraDistance + bedDiagonal) / 1000) * 1000);
    if (far !== preview.camera.far) {
      preview.camera.far = far;
      preview.camera.updateProjectionMatrix();
    }
    preview.camera.position.copy(orbitTarget).addScaledVector(cameraOut, cameraDistance);
    preview.camera.lookAt(orbitTarget);
    packedViewDirty = false;
  }
  const frame = packedPlayback.frame();
  const active = packedCompositor.available && frame.layer >= 0 ? packedPreview.layerRange(frame.layer) : null;
  const prefix = active ? frame.layer : preview.endLayer;
  const rebuild = prefix !== lastRenderedEndLayer;
  if (rebuild) fullRebuild(prefix);

  const point = packedCompositor.available ? frame.position : null;
  const pose = frame.deposition;
  const deposition = active ? {
    start: active.start,
    end: Math.max(active.start, Math.min(active.end, pose?.deposited ?? active.start)),
    highlight: Boolean(point?.extruding),
    tip: point ? [point.x, point.y, point.z] : null,
    partial: pose?.partial && pose.deposited >= active.start && pose.deposited < active.end ? {
      from: [pose.partial.x, pose.partial.y, pose.partial.z],
      to: [pose.x, pose.y, pose.z],
      tool: pose.partial.tool,
    } : null,
  } : null;
  const previous = packedFrame?.position;
  const moved = Boolean(point) !== Boolean(previous) ||
    (point && (point.x !== previous.x || point.y !== previous.y || point.z !== previous.z || point.extruding !== previous.extruding));
  const former = packedFrame?.deposition;
  const deposited = deposition?.start !== former?.start || deposition?.end !== former?.end ||
    Boolean(deposition?.partial) !== Boolean(former?.partial) ||
    (deposition?.partial && (deposition.partial.tool !== former.partial.tool ||
      deposition.partial.from.some((value, axis) => value !== former.partial.from[axis]) ||
      deposition.partial.to.some((value, axis) => value !== former.partial.to[axis])));
  if (dirty || rebuild || !packedFrame || packedCompositor.building ||
      ((moved || deposited) && (Boolean(point) !== Boolean(previous) || timing - lastDrawAt >= 33))) {
    if (point) {
      nozzleGroup.position.set(point.x - buildCenter.x, point.z, buildCenter.y - point.y);
      glowGroup.visible = point.extruding;
    }
    nozzleGroup.visible = Boolean(point);
    packedCompositor.draw({ refreshStatic: dirty || rebuild, drawNozzle: nozzleGroup.visible, deposition });
    if (startupReport && (startupReport.fullGeometryMs === undefined || startupReport.firstNozzleMs === undefined)) {
      const { staticLines, staticBuiltLines, staticReady, nozzleDraws, depositedSegments,
        partialDeposited, depositionReady } = packedCompositor.stats();
      const elapsed = performance.now() - startupReport.startedAt;
      const drawnGeometry = staticLines > 0 || staticBuiltLines > 0 || depositedSegments > 0 || partialDeposited;
      if (drawnGeometry) startupReport.firstGeometryMs ??= elapsed;
      if (staticReady && drawnGeometry && (depositionReady ?? true)) startupReport.fullGeometryMs ??= elapsed;
      if (nozzleDraws > 0) startupReport.firstNozzleMs ??= elapsed;
    }
    if (!packedCompositor.available) {
      packedPlayback.hide();
      nozzleGroup.visible = false;
      pathEl.disabled = true;
      playEl.disabled = true;
      if (active) lastRenderedEndLayer = -1;
    }
    packedFrame = { position: nozzleGroup.visible ? point : null, deposition };
    lastDrawAt = timing;
  }
  let status = packedCompositor.available ? packedStatus(frame) : 'Nozzle playback unavailable on this graphics device';
  if (packedCompositor.building && startupReport?.fullGeometryMs === undefined) {
    status = status ? `Rendering plate… ${status}` : 'Rendering plate…';
  }
  if (detailEl.textContent !== status) detailEl.textContent = status;
  detailEl.hidden = !status;
  if (packedCompositor.available && frame.mode === 'replay' && frame.ended && (playing || (verifyLayers && !verifyManualHold))) {
    const cap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
    const next = frame.layer + 1 < cap ? frame.layer + 1 : (cap > 1 ? 1 : 0);
    if (next === frame.layer) return;
    packedPlayback.play(next);
    setNozzleLayer(next + 1);
    scrubLayer = next + 1;
    scrubEl.value = String(scrubLayer);
    if (!verifyLayers) preview.endLayer = scrubLayer;
    lastEndLayer = preview.endLayer;
    setLabel(scrubLayer, cap);
  }
}

function orbitTick() {
  // Skip all work when the tab/iframe isn't visible (OBS preview hidden,
  // user switched tabs, etc). RAF already throttles in this case but
  // returning early avoids the full pipeline (camera math, nozzle update,
  // trail rebuild, GPU draw) on the throttled ticks that do fire.
  if (document.hidden) {
    requestAnimationFrame(safeOrbitTick);
    return;
  }
  if (packedPreview) {
    drawPackedFrame();
    requestAnimationFrame(safeOrbitTick);
    return;
  }
  if (preview.camera) {
    if (cameraDistance === 0) {
      autoFitCamera();
      cameraDistance ||= defaultDistance;
    }

    // Viewport-aware framing: project the nozzle into NDC (-1..1) using
    // the *previous* frame's camera so we know where it currently appears
    // on screen. If it's in the outer fringe, boost follow speed and zoom
    // so it never clips. Computed up front so both the radius and target
    // lerps can react.
    let nozzleEdge = 0;      // 0..1+ — how close to the viewport edge
    if (nozzleGroup.visible && preview.camera) {
      const _ndc = nozzleGroup.position.clone().project(preview.camera);
      nozzleEdge = Math.max(Math.abs(_ndc.x), Math.abs(_ndc.y));
    }

    if (nozzleGroup.visible) {
      if (!smoothedNozzleInit) {
        smoothedNozzle.copy(nozzleGroup.position);
        smoothedNozzleInit = true;
      } else {
        smoothedNozzle.lerp(nozzleGroup.position, NOZZLE_SMOOTH_LERP);
      }
      // Follow the nozzle across the bed and up the active layer while
      // preserving the selected camera angle.
      _scratchDesired.copy(bboxCenter).lerp(smoothedNozzle, NOZZLE_FOLLOW_BIAS);
    } else {
      _scratchDesired.copy(bboxCenter);
      smoothedNozzleInit = false;
    }
    orbitTarget.lerp(_scratchDesired, TARGET_LERP);

    // Turbo-follow: when the nozzle is near the viewport edge, push the
    // orbit target directly toward the nozzle position — bypasses the
    // two-stage smoothing so the camera re-centers faster and the nozzle
    // doesn't clip. The effect is proportional: gentle nudge at 0.65,
    // strong snap at 1.0+.
    if (nozzleEdge > 0.65 && nozzleGroup.visible) {
      const urgency = Math.min(1, (nozzleEdge - 0.65) / 0.35);
      orbitTarget.lerp(nozzleGroup.position, urgency * 0.08);
    }

    // Refit after nozzle following and viewport resizing. Grow immediately
    // to avoid clipping; ease back in when less space is needed. Keep the
    // elevation angle stable for tall prints as well as finished models.
    const goalDistance = modelCorners.length ? fittedDistance(orbitTarget) : defaultDistance;
    cameraDistance = Math.max(goalDistance, cameraDistance + (goalDistance - cameraDistance) * 0.02);
    // Very narrow canvases can push the fitted view beyond the default far plane.
    const farPlane = Math.max(defaultFarPlane, Math.ceil((cameraDistance + bedDiagonal) / 1000) * 1000);
    if (farPlane !== preview.camera.far) {
      preview.camera.far = farPlane;
      preview.camera.updateProjectionMatrix();
    }
    preview.camera.position.copy(orbitTarget).addScaledVector(cameraOut, cameraDistance);
    preview.camera.lookAt(orbitTarget);
    verifyAdvanceTick();
    // fastTick: skips the heavy gcode-preview geometry rebuild unless the
    // rendered endLayer actually changed. ~10× cheaper for the steady-state
    // orbit-and-walk frames.
    fastTick();
  }
  requestAnimationFrame(safeOrbitTick);
}
function safeOrbitTick() {
  if (rendererUnavailable) return;
  try { orbitTick(); }
  catch (error) {
    rendererUnavailable = true;
    invalidateLoad();
    clearPackedPreview();
    canvas.style.visibility = 'hidden';
    window.BBGcodeUI.allowFile(false);
    window.BBGcodeUI.fail(error);
  }
}
requestAnimationFrame(safeOrbitTick);

function pauseLiveMotion() {
  packedPlayback?.pause();
  lastGcodeState = 'PAUSED';
  mcPercentLastSeen = null;
  mqttSyncedLayer = null;
  lastMcPctChangeWall = null;
  lastMcPctChangeValue = null;
}

function waitForTelemetry(message, kind = currentTaskKey ? 'hint' : 'waiting') {
  pauseLiveMotion();
  canRequestToolpath = false;
  window.BBGcodeUI.allowFile(false);
  if (inFlight) invalidateLoad();
  setOverlay(message, kind);
}

async function tick() {
  if (rendererUnavailable) return;
  let data, telemetryNow;
  try {
    const res = await fetch('/data.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const connection = res.headers.get('X-BambuBoard-Printer-Connection');
    if (connection === 'offline' || connection === 'waiting') {
      telemetryFailures = 0;
      const message = connection === 'offline' ? 'Printer offline' : 'Waiting for printer data';
      waitForTelemetry(message, currentTaskKey ? 'hint' : wantedJob?.available ? 'error' : 'waiting');
      return;
    }
    // The NAS and viewer can have different clocks. Compare a server-side
    // receive timestamp with the HTTP server clock, rather than the viewer's.
    telemetryNow = Date.parse(res.headers.get('Date')) || Date.now();
    data = await res.json();
    if (!data?.print || typeof data.print !== 'object') throw new Error('No printer telemetry');
    telemetryFailures = 0;
  } catch (error) {
    telemetryFailures++;
    if (telemetryFailures === 1) dbg(`telemetry unavailable: ${error.message}`);
    if (telemetryFailures >= 3) {
      waitForTelemetry('Printer telemetry is unavailable. Check the printer connection in Setup. The last preview is paused.', 'error');
    }
    return;
  }
  if (window.BBTelemetry.isStale(data, telemetryNow)) {
    waitForTelemetry('Printer telemetry has stopped updating. Check the printer connection in Setup. The last preview is paused.', 'error');
    return;
  }
  try {
    const print = data.print;
    const job = window.BBGcodeJob.describe(print);
    const state = print.gcode_state === 'PAUSE' ? 'PAUSED' : print.gcode_state;
    if (job.calibration) {
      if (!showingCalibration) {
        showingCalibration = true;
        invalidateLoad();
        wantedJob = null;
        wantedTaskKey = null;
        currentTaskKey = null;
        prevTickState = null;
        prevTickMcPct = -1;
        forceNocache = false;
        scrubActive = false;
        playing = false;
        if (playTimer) clearInterval(playTimer);
        playTimer = null;
        playEl.textContent = '▶';
        pauseLiveMotion();
        clearScene();
        canvas.style.visibility = 'hidden';
      }
      canRequestToolpath = false;
      window.BBGcodeUI.allowFile(false);
      setOverlay(window.BBGcodeJob.calibrationStatus(print, job), 'calibration');
      return;
    }
    showingCalibration = false;
    // An active/finished state can arrive before its job metadata. Keep the
    // prior render and lifecycle counters until the printer confirms the job.
    if (print._bb_job_pending === true || (!job.available && ['RUNNING', 'PREPARE', 'SLICING', 'PAUSED', 'FINISH'].includes(state))) {
      waitForTelemetry('Waiting for print details');
      return;
    }
    const taskId = job.task;
    const reportedLayer = Number(print.layer_num) || 0;
    const sameJob = wantedJob && wantedJob.key === job.key;
    const regressedLayer = sameJob && reportedLayer > 0 && reportedLayer < Number(wantedJob.layer) &&
      (state === 'RUNNING' || state === 'PAUSED');
    const layerTiming = !regressedLayer && Number.isFinite(print._bb_layer_elapsed_ms) && print._bb_layer_elapsed_ms >= 0 &&
      Number.isFinite(data._bb_received_at) && typeof print._bb_layer_advancing === 'boolean'
      ? { elapsedMs: print._bb_layer_elapsed_ms, advancing: print._bb_layer_advancing,
          receivedAt: data._bb_received_at, observedAt: performance.now() }
      : null;
    wantedJob = { ...job, layer: regressedLayer ? wantedJob.layer : reportedLayer,
      totalLayers: regressedLayer ? wantedJob.totalLayers : print.total_layer_num,
      layerTiming, layerPace: print._bb_layer_pace };
    canRequestToolpath = job.available && !['IDLE', 'FAILED'].includes(state);
    window.BBGcodeUI.allowFile(canRequestToolpath);
    const layerNum = wantedJob.layer;
    const printStage = Number(print.mc_print_stage) || 0;
    const subStage = Number(print.stage?._id ?? print.stg_cur) || 0;
    // Capture previous tick's state BEFORE overwriting, so we can detect
    // print lifecycle transitions (FINISH→RUNNING, progress resets).
    const _prevState = prevTickState;
    const _prevMcPct = prevTickMcPct;

    lastGcodeState = state;
    lastSubStage = subStage;
    const reportedProgress = Number(print.mc_percent ?? NaN);
    const hasProgress = Number.isFinite(reportedProgress);
    const mcPctRaw = hasProgress ? reportedProgress : 0;
    const mcRemain = Number(print.mc_remaining_time) || 0;

    // Update previous-tick trackers for next iteration.
    prevTickState = state;
    prevTickMcPct = hasProgress ? reportedProgress : -1;

    // Log raw state changes so the log shows the printer's own lifecycle.
    if (state !== _prevState) {
      dbg(`state ${_prevState ?? '∅'} → ${state}  (task=${taskId ?? '∅'} layer=${layerNum} mc=${mcPctRaw}% stg=${subStage})`);
    }

    // printerStarted: a *printer-side* signal that the job has begun
    // depositing material. layer_num goes 1+ once layer 1 starts; mc_percent
    // ticks up shortly after. Used to distinguish pre-print prep (no material
    // yet) from in-print sub-stages (cleaning, first-layer inspection, swaps)
    // where the printer-reported sub-stage is briefly nonzero even though
    // the print is active. Without this, the overlay text stays "Preparing —
    // preview loaded" while the nozzle is already drawing layer 1.
    const printerStarted = layerNum > 0 || mcPctRaw > 1;
    const isEffectivelyDone = state === 'RUNNING' && mcPctRaw >= 99 && mcRemain <= 0;
    wantedJob.effectivelyDone = isEffectivelyDone;
    // Active print = RUNNING with no blocking sub-stage, OR the print has
    // demonstrably begun (printer reports a layer / progress). The OR-clause
    // covers transient sub-stages mid-print (nozzle clean, first-layer
    // inspect, filament swap) so the layer counter and overlay don't revert
    // to "preview" the moment stg_cur briefly goes nonzero.
    const isActivePrint = state === 'RUNNING' && (subStage === 0 || printerStarted) && !isEffectivelyDone;
    // Mid-print sub-stage (nozzle switch, bed scan, etc.) — already printing,
    // a transient sub-stage kicked in. Animation freezes, model stays. Gated
    // on printerStarted (a printer signal) rather than lastEndLayer (a render
    // signal) so we don't get stuck in the "preview" branch waiting for a
    // render that never happens because we kept early-returning.
    const isMidPrintSubStage = state === 'RUNNING' && subStage !== 0 && !isEffectivelyDone && printerStarted;
    // Pre-print preview: RUNNING but printer hasn't begun depositing. Show
    // full model statically with "Preparing" overlay.
    const isPreviewState = state === 'RUNNING' && !isActivePrint && !isEffectivelyDone && !isMidPrintSubStage;
    // PREPARE/SLICING are firmware prep states — treat them exactly like
    // pre-print preview (load the model proactively, show full toolpath +
    // "Preparing" overlay). Avoids the previous behavior where each transition
    // between PREPARE and RUNNING+subStage during warm-up wiped the scene.
    const isPrepState = state === 'PREPARE' || state === 'SLICING';
    const isHoldState   = state === 'PAUSED' || state === 'FINISH' || isEffectivelyDone || isMidPrintSubStage;

    // ── New-print lifecycle detection ──
    // Detect when a new print starts even if the task_id hasn't changed
    // (reprints of the same file, or firmware that reuses IDs). Two signals:
    //   1. State transition: done/idle/failed → running/prepare
    //   2. Progress reset: mc_percent drops from ≥90 to <50 while state
    //      stays RUNNING (firmware sometimes skips the FINISH state entirely)
    if (wantedTaskKey && _prevState != null) {
      const fromDone = _prevState === 'FINISH' || _prevState === 'IDLE' || _prevState === 'FAILED';
      const toActive = state === 'RUNNING' || state === 'PREPARE';
      const justStarted = toActive && fromDone;
      const progressReset = state === 'RUNNING' && hasProgress && mcPctRaw < 50 && _prevMcPct >= 90;
      if (justStarted || progressReset) {
        // Force a fresh gcode load on the next taskKey check. Also flag
        // the fetch to bypass the server-side cache so reprints with the
        // same task_id get fresh gcode from the printer.
        dbg(`lifecycle: NEW PRINT (${justStarted ? 'justStarted' : 'progressReset'}) → force reload, nocache`);
        currentTaskKey = null;
        invalidateLoad();   // new lifecycle: cancel old work and retry state
        forceNocache = true;
      }
    }

    const taskKey = job.available ? job.key : null;
    if (wantedTaskKey !== taskKey) {
      invalidateLoad();
      wantedTaskKey = taskKey;
      if (currentTaskKey) { clearScene(); currentTaskKey = null; }
    }

    // ── Hard reset only when the task itself goes away or changes ──
    // The previous code wiped the scene on *any* unrecognized state (incl.
    // PREPARE), which caused multi-reload flicker during warm-up because
    // the printer bounces between PREPARE and RUNNING+subStage. Now we only
    // clearScene when there's genuinely no print (taskId gone) or a different
    // print is starting.
    if (!taskKey) {
      if (currentTaskKey) {
        dbg('no taskId — clearing scene');
        clearScene();
        currentTaskKey = null;
        mcPercentLastSeen = null;
        mqttSyncedLayer = null;
        lastMcPctChangeWall = null;
        lastMcPctChangeValue = null;
      }
      if (state === 'FAILED') { logPhase('idle: FAILED (no task)'); setOverlay('Print failed', 'error'); }
      else { logPhase(`idle: ${state ?? '∅'} (no task)`); setOverlay('Waiting for print…', 'waiting'); }
      return;
    }

    if (currentTaskKey && currentTaskKey !== taskKey) {
      dbg(`task changed ${currentTaskKey} → ${taskKey} — clearing scene`);
      clearScene();
      currentTaskKey = null;
      mcPercentLastSeen = null;
      mqttSyncedLayer = null;
      lastMcPctChangeWall = null;
      lastMcPctChangeValue = null;
    }

    if (state === 'FAILED') {
      packedPlayback?.hide();
      invalidateLoad();
      logPhase('FAILED');
      setOverlay('Print failed', 'error');
      return;
    }

    // No recognized state but we have a taskId — wait it out without wiping.
    if (!isPrepState && !isActivePrint && !isPreviewState && !isHoldState) {
      logPhase(`unrecognized: ${state} (task present, holding)`);
      packedPlayback?.hide();
      if (state === 'IDLE') invalidateLoad();
      setOverlay('Waiting for print…', 'waiting');
      return;
    }

    syncFilamentColor(print);

    const awaitingProgress = state === 'RUNNING' && !hasProgress && layerNum <= 0;
    if (awaitingProgress) pauseLiveMotion();

    // Keep telemetry polling while the potentially slow FTPS request runs.
    if (taskKey !== currentTaskKey) {
      if (inFlight) return;
      if (failure) {
        showFailure();
        if (!failure.retryable || failure.attempts >= MAX_AUTO_ATTEMPTS || state === 'FINISH' || Date.now() < failure.nextAt) return;
      }
      const prep = isPrepState || isPreviewState;
      void loadGcode(taskKey, prep ? 'Getting file for upcoming print…' : 'Getting print file…');
      return;
    }
    if (awaitingProgress) {
      setOverlay('Waiting for print progress');
      return;
    }

    // Prep / pre-print preview: model is loaded, show full toolpath statically
    // with a stable "Preparing print…" overlay. Covers PREPARE, SLICING, and
    // RUNNING-with-pre-print-subStage in one branch so transitions between
    // them are seamless — the model never reloads, the overlay text never
    // flickers.
    if (isPrepState || isPreviewState) {
      packedPlayback?.hide();
      logPhase(`prep/preview: ${state} sub=${subStage} (model loaded, ${totalLayers} layers)`);
      if (lastEndLayer !== totalLayers && totalLayers > 0) {
        advanceTo(totalLayers);
      }
      setOverlay('Preparing print…', 'loading');
      return;
    }

    // Active or hold state — clear any leftover prep overlay. setOverlay
    // dedupes internally so calling every tick is cheap.
    logPhase(state === 'FINISH' ? 'finished (showing full model)' : (state === 'PAUSED' ? 'paused' : 'printing'));
    setOverlay('');

    if (scrubActive) return;
    if (packedPlayback) {
      if (state === 'FINISH' || isEffectivelyDone) {
        packedPlayback.hide();
        advanceTo(totalLayers);
      } else {
        const target = modelToParsed(layerNum, Number(wantedJob.totalLayers) || 0);
        if (target > 0 && packedCompositor.available) {
          const timing = matchedLayerTiming(wantedJob);
          if (state === 'RUNNING' && (timing?.advancing ?? subStage === 0)) packedPlayback.live(target - 1, timing);
          else packedPlayback.pause(target - 1, timing);
        }
        if (target > 0) advanceTo(target);
      }
      return;
    }
    if (state === 'PAUSED') return;
    // Mid-print sub-stage (filament swap, bed scan, etc.): freeze the
    // simulation. Bambu's mc_percent is real-time-based and keeps ticking
    // during the 30-60s physical swap even though gcode position barely
    // advances. Letting the sync run during swaps fast-forwards us past
    // the swap point and onto the wrong object on multi-color prints.
    if (state === 'RUNNING' && subStage !== 0) {
      // Discard any in-flight calibration sample — it would otherwise mix
      // swap-time wall seconds into the gcode-time-per-wall-time estimate
      // and tank the speed factor.
      lastMcPctChangeWall = null;
      lastMcPctChangeValue = null;
      return;
    }

    const target = state === 'FINISH'
      ? totalLayers
      : modelToParsed(layerNum, Number(print.total_layer_num) || 0);
    // Hold the previous render during the brief transitional window where
    // we've entered the active branch but layer_num hasn't ticked to 1 yet.
    // Otherwise advanceTo(0) collapses the static prep preview to an empty
    // scene for ~1 tick, which the user sees as a flash.
    if (target > 0) advanceTo(target);

    // Sync the within-layer nozzle animation to MQTT progress, with a
    // configurable replay delay (REPLAY_DELAY_S) so the visualization
    // trails behind the real printer.
    if (state === 'RUNNING' && totalGcodeTime > 0 && activeLayerIdx >= 0) {
      const mcPct = Number(print.mc_percent);
      const layerJustChanged = (mqttSyncedLayer !== activeLayerIdx);
      const pctAdvanced = (mcPct !== mcPercentLastSeen);
      if (Number.isFinite(mcPct) && (layerJustChanged || pctAdvanced)) {
        // Adaptive calibration: when mc_percent advances, measure how much
        // wall-clock time the printer took for that percent change and
        // compare to how much gcode-time it represents. The ratio is the
        // true speed factor (gcode-time per wall-time) including filament
        // swap delays, accel/decel, and any speed-mode multiplier.
        if (pctAdvanced && lastMcPctChangeWall != null && lastMcPctChangeValue != null) {
          const dPct = mcPct - lastMcPctChangeValue;
          const dWallSec = (performance.now() - lastMcPctChangeWall) / 1000;
          if (dPct > 0 && dWallSec > 0.5 && dWallSec < 120) {
            const dGcodeSec = (dPct / 100) * totalGcodeTime;
            const observed = dGcodeSec / dWallSec;
            // Clamp + EMA so a single weird sample (e.g. mid-swap) doesn't
            // wreck the estimate. Range 0.1–1.5 is sane for any printer mode.
            const clamped = Math.max(0.1, Math.min(1.5, observed));
            calibrationSamples++;
            // First few samples use heavier weight (0.5) so the animation
            // converges within ~60s instead of drifting for 5+ minutes at
            // the initial guess. After warm-up, settle to 0.3 for stability.
            const alpha = calibrationSamples <= 3 ? 0.5 : 0.3;
            nozzleSpeedFactor = nozzleSpeedFactor * (1 - alpha) + clamped * alpha;
          }
        }
        if (pctAdvanced) {
          lastMcPctChangeWall = performance.now();
          lastMcPctChangeValue = mcPct;
        }
        const targetT = (mcPct / 100) * totalGcodeTime;
        const layerStartT = cumLayerTime[activeLayerIdx] || 0;
        const layerDur = layerPaths[activeLayerIdx]?.total || 0;
        const rel = targetT - layerStartT;
        if (rel >= 0 && rel <= layerDur) {
          // Offset by REPLAY_DELAY_S so the nozzle animation lags behind
          // what the printer is actually doing.
          const delayedRel = Math.max(0, rel - REPLAY_DELAY_S);
          // Convert gcode-time `delayedRel` to wall-clock time using the
          // current speed factor: elapsed = wall * factor → wall = elapsed / factor.
          const desiredStart = performance.now() - (delayedRel / nozzleSpeedFactor) * 1000;
          // Full snap on every sync — keeps the simulation locked to the
          // real printer's percent-derived position with no smoothing lag.
          layerStartTime = desiredStart;
          mqttSyncedLayer = activeLayerIdx;
        }
        mcPercentLastSeen = mcPct;
      }
    }
  } catch (e) {
    dbg(`tick ERROR: ${e.message}`);
    setOverlay(`status poll failed: ${e.message}`, 'error');
  }
}

// Show the on-screen log panel whenever ?debug=1. Independent of debugBar so
// the log appears even if the scrubber row isn't wired.
if (debug && logEl) {
  logEl.classList.add('show');
  dbg(`gcode-viz debug log ready — bed ${bed.x}×${bed.y}×${bed.z}, poll ${POLL_MS}ms`);
}

function packedMotionDiagnostics() {
  if (!packedPlayback) return null;
  const { state, layer, window, windowMoves, layerMoves, paceFactor } = packedPlayback.frame();
  const point = packedFrame?.position;
  const { staticDraws, nozzleDraws, depositionStart, depositedSegments, depositedEnd,
    depositionReady, partialDeposited } = packedCompositor.stats();
  return {
    ...packedPlayback.stats(), state, layer, window, windowMoves, layerMoves, paceFactor, visible: nozzleGroup.visible,
    position: point ? [point.x, point.y, point.z] : null,
    staticDraws, animationDraws: nozzleDraws, depositionStart, depositedSegments, depositedEnd,
    depositionReady, partialDeposited, reportedLayer: wantedJob?.layer, markerLayerCount: packedModelLayerCount,
  };
}

if (diagnostics) {
  window.__preview = preview;
  window.__nozzle = nozzleGroup;
  window.__diag = () => ({
    compact: packedPreview ? { ...packedPreview.stats(), ...packedCompositor.stats() } : null,
    motion: packedMotionDiagnostics(),
    startup: startupReport ? { ...startupReport } : null,
    activeLayerIdx,
    pathHoldFraction,
    totalForActive: layerPaths[activeLayerIdx]?.total,
    segCount: layerPaths[activeLayerIdx]?.segs?.length,
    extCount: (layerPaths[activeLayerIdx]?.segs || []).filter(s => s.ext).length,
    orbit: { view: cameraView, zoom: cameraZoom, radius: Math.hypot(cameraOut.x, cameraOut.z) * cameraDistance, height: cameraOut.y * cameraDistance, target: orbitTarget.toArray().map(n => +n.toFixed(1)) },
  });
}

if (debug && debugBar) {
  debugBar.classList.add('show');

  scrubEl.addEventListener('input', () => {
    scrubActive = true;
    scrubLayer = Number(scrubEl.value) || 0;
    if (packedCompositor?.available) packedPlayback.seek(Math.max(0, scrubLayer - 1));
    if (verifyLayers) {
      // Keep the full first-N rendered; just retarget the nozzle, and pin it
      // to the user's chosen layer (no auto-advance until they release).
      verifyManualHold = true;
      setNozzleLayer(scrubLayer);
      setLabel(scrubLayer, Math.min(verifyLayers, totalLayers));
    } else {
      advanceTo(scrubLayer);
    }
  });
  if (verifyLayers) {
    // 'change' fires when the user lets go of the slider — resume auto-advance.
    scrubEl.addEventListener('change', () => { verifyManualHold = false; });
  }

  function setPlay(on) {
    playing = on;
    playEl.textContent = on ? '❚❚' : '▶';
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (packedPlayback) {
      scrubActive = true;
      const frame = packedPlayback.frame();
      const index = frame.layer >= 0 ? frame.layer : Math.max(0, scrubLayer - 1);
      if (on) packedPlayback.play(index, frame.fraction);
      else packedPlayback.seek(index, frame.fraction);
      return;
    }
    if (on) {
      scrubActive = true;
      // Walk the nozzle through each layer's full path before advancing.
      const cap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
      if (!scrubLayer) scrubLayer = 1;
      advanceTo(scrubLayer);
      setNozzleLayer(scrubLayer);
      setLabel(scrubLayer, cap);
      playTimer = setInterval(() => {
        if (totalLayers <= 0 || activeLayerIdx < 0) return;
        const lp = layerPaths[activeLayerIdx];
        if (!lp || lp.total === 0) {
          // Empty layer — skip immediately
          scrubLayer = scrubLayer >= cap ? 1 : scrubLayer + 1;
          scrubEl.value = String(scrubLayer);
          advanceTo(scrubLayer);
          setNozzleLayer(scrubLayer);
          setLabel(scrubLayer, cap);
          return;
        }
        const elapsed = (performance.now() - layerStartTime) / 1000;
        if (elapsed >= lp.total) {
          scrubLayer = scrubLayer >= cap ? 1 : scrubLayer + 1;
          scrubEl.value = String(scrubLayer);
          advanceTo(scrubLayer);
          setNozzleLayer(scrubLayer);
          setLabel(scrubLayer, cap);
        }
      }, 100);
    }
  }

  playEl.addEventListener('click', () => setPlay(!playing));

  function stepLayer(delta) {
    if (!totalLayers) return;
    setPlay(false); // never auto-advance while stepping manually
    const cap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
    const cur = Number(scrubEl.value) || 1;
    let nx = cur + delta;
    if (nx < 1) nx = cap;
    if (nx > cap) nx = 1;
    scrubEl.value = String(nx);
    scrubLayer = nx;
    if (packedCompositor?.available) packedPlayback.seek(nx - 1);
    if (verifyLayers) {
      verifyManualHold = true;
      setNozzleLayer(nx);
      setLabel(nx, cap);
    } else {
      scrubActive = true;
      advanceTo(nx);
    }
  }
  prevEl?.addEventListener('click', () => stepLayer(-1));
  nextEl?.addEventListener('click', () => stepLayer(+1));

  // Path slider: scrub the nozzle's position within the active layer.
  if (pathEl) {
    pathEl.addEventListener('input', () => {
      const frac = (Number(pathEl.value) || 0) / 1000;
      if (packedPlayback) {
        setPlay(false);
        verifyManualHold = true;
        const layer = packedPlayback.frame().layer;
        packedPlayback.seek(layer >= 0 ? layer : Math.max(0, scrubLayer - 1), frac);
        pathLabelEl.textContent = `${Math.round(frac * 100)}%`;
        return;
      }
      pathHoldFraction = frac;
      setPlay(false);                 // freeze layer-level autoplay too
      verifyManualHold = true;
      pathLabelEl.textContent = `${Math.round(frac * 100)}%`;
      // Push the new position into the renderer immediately rather than
      // waiting for the next RAF tick so dragging feels responsive.
      updateNozzlePosition();
      preview.renderer?.render(preview.scene, preview.camera);
    });
    // 'change' fires on release — resume animation from current position.
    pathEl.addEventListener('change', () => {
      if (packedPlayback) return;
      const total = layerPaths[activeLayerIdx]?.total || 0;
      // Re-anchor wall-clock time so the animation continues from the held spot.
      layerStartTime = performance.now() - pathHoldFraction * total * 1000;
      pathHoldFraction = null;
      verifyManualHold = false;
    });
  }
}

window.BBGcodeUI.bindRetry(() => {
  if (rendererUnavailable) return location.reload();
  if (!wantedTaskKey || !canRequestToolpath) return void tick();
  invalidateLoad();
  void loadGcode(wantedTaskKey, 'Retrying file transfer…', null, true);
});
window.BBGcodeUI.bindCancel(() => {
  if (!inFlight || !wantedTaskKey) return;
  invalidateLoad();
  failure = { taskKey: wantedTaskKey, detail: 'Toolpath loading canceled.', retryable: false };
  showFailure();
});
const fileInput = document.getElementById('gcodeFile');
let filePickerTaskKey = null;
fileInput.addEventListener('click', () => { filePickerTaskKey = wantedTaskKey; });
fileInput.addEventListener('change', event => {
  const file = event.target.files[0];
  const selectedFor = filePickerTaskKey || wantedTaskKey;
  filePickerTaskKey = null;
  event.target.value = '';
  if (!file || !wantedTaskKey || !canRequestToolpath || rendererUnavailable) return;
  if (selectedFor !== wantedTaskKey) {
    dbg('manual file ignored: print changed while the file picker was open');
    setOverlay('The print changed while you chose the file. Choose the exact sliced file for the new print.', 'error');
    return;
  }
  invalidateLoad();
  void loadGcode(wantedTaskKey, 'Loading sliced file…', file, true);
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  rendererUnavailable = true;
  invalidateLoad();
  clearPackedPreview();
  canvas.style.visibility = 'hidden';
  window.BBGcodeUI.allowFile(false);
  window.BBGcodeUI.fail(new Error('WebGL context lost (GPU reset or resource limit).'));
});
async function pollLoop() {
  await tick();
  setTimeout(pollLoop, POLL_MS);
}
void pollLoop();

window.addEventListener('pagehide', event => {
  if (!event.persisted) {
    invalidateLoad();
    clearPackedPreview();
  }
});

window.addEventListener('resize', () => {
  lastStaticView = null;
  packedViewDirty = true;
  preview.resize?.();
});
