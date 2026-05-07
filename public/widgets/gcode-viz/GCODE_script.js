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

const POLL_MS = 800;
const PLAY_LAYERS_PER_SEC = 8;
const ROTATE_DEG_PER_SEC = 6; // ~60s per full revolution
// Nozzle simulation speed multiplier vs real gcode feedrate. 1.0 = realtime.
// Print speeds are typically 100–300 mm/s, so realtime feels right.
const NOZZLE_SPEED_FACTOR = 1.0;
// Hot-extrusion trail: how long a freshly-deposited segment glows before
// fading to the cold print color, and the geometry buffer cap. The buffer is
// scaled so it can hold the full trail at ~60 fps without dropping points.
const TRAIL_SECONDS = 35;
const TRAIL_MAX_POINTS = 3000;
const TRAIL_BREAK_DIST = 25; // mm jump that splits the trail (e.g. layer change)

const params = new URLSearchParams(location.search);
const debug = params.has('debug');
// Verification mode: render only the first N layers and walk the nozzle through
// them sequentially so you can compare the nozzle's path against the visible
// gcode lines. Append `?layers=4` (or any small N) to enable.
const verifyLayers = (() => {
  const v = parseInt(params.get('layers') || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

const canvas = document.getElementById('gcodeCanvas');
const overlay = document.getElementById('gcodeOverlay');
const debugBar = document.getElementById('gcodeDebug');
const scrubEl = document.getElementById('gcodeScrub');
const playEl = document.getElementById('gcodePlay');
const prevEl = document.getElementById('gcodePrev');
const nextEl = document.getElementById('gcodeNext');
const labelEl = document.getElementById('gcodeLabel');
const pathEl = document.getElementById('gcodePath');
const pathLabelEl = document.getElementById('gcodePathLabel');

// Resolve bed size from the connected printer's caps so the visualization
// works for any Bambu model (X1/X1C/P1/A1/A1M/H2D/…), not just the H2D it was
// developed against. Falls back to a sensible default if /api/status is
// unreachable.
async function resolveBedSize() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const data = await res.json();
    const t = data?.printer?.type;
    const bed = (window.PRINTER_CAPS?.[t] || window.PRINTER_CAPS?.X1)?.bedSize;
    if (bed && bed.x && bed.y && bed.z) return bed;
  } catch (_) { /* fall through to default */ }
  return { x: 256, y: 256, z: 256 }; // X1-class default
}
const bed = await resolveBedSize();

const preview = GCodePreview.init({
  canvas,
  extrusionColor: 'hotpink',
  backgroundColor: '#1a1c20',
  // Travels are visualized via the trail (short-lived gray streak) rather than
  // baked into the static toolpath — keeps the build plate uncluttered.
  renderTravel: false,
  buildVolume: { x: bed.x, y: bed.y, z: bed.z },
  initialCameraPosition: [-120, 130, 150],
});

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
const matTip   = matte(0x0a0c10);                // near-black nozzle tip

let y = 0;

// Nozzle tip — tapered cone, narrow at the print, wider where it bolts in.
{
  const h = 2.0 * SCALE;
  const g = new THREE.CylinderGeometry(1.05 * SCALE, 0.35 * SCALE, h, 24);
  g.translate(0, y + h / 2, 0);
  nozzleGroup.add(new THREE.Mesh(g, matTip));
  y += h;
}

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

// Bambu-style print plate: matte slab with a slightly lighter rim. Sized to
// the actual connected printer's bed. No surface grid lines — at our orbit
// camera speed thin lines moiré/jitter against subpixel rendering, and a
// clean matte plate reads better as the build surface anyway.
const PLATE_W = bed.x, PLATE_D = bed.y;
const printPlate = new THREE.Group();
const plateSlabGeo = new THREE.BoxGeometry(PLATE_W, 0.6, PLATE_D);
plateSlabGeo.translate(0, -0.3, 0);  // top face at y=0
const plateSlabMat = new THREE.MeshBasicMaterial({ color: 0x202329 });
printPlate.add(new THREE.Mesh(plateSlabGeo, plateSlabMat));
// Lighter rim around the edges (4 thin boxes).
const rimMat = new THREE.MeshBasicMaterial({ color: 0x4a505a });
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

// Lights for the nozzle group — gcode-preview's ambient is too dim for the
// dark hotend assembly to read clearly. Attach our own so the nozzle pops
// regardless of scene lighting.
const nozzleAmbient = new THREE.AmbientLight(0xffffff, 0.55);
const nozzleKey = new THREE.DirectionalLight(0xffffff, 1.1);
nozzleKey.position.set(80, 120, 60);
const nozzleFill = new THREE.DirectionalLight(0xc8d4ff, 0.4);
nozzleFill.position.set(-60, 40, -40);

// Hot-extrusion trail: vertex-colored LineSegments drawn on top of the cold
// gcode-preview toolpath. We append the nozzle's world position each frame
// and emit one segment between consecutive extrusion samples — but skip the
// segment whenever the nozzle teleports across a travel (jump=true), so
// travel "bridges" never render. Color ramp on age: yellow-white fresh →
// orange → red → cold filament color.
// Buffer holds 2 vertices per potential segment.
const trailGeo = new THREE.BufferGeometry();
const trailPositions = new Float32Array(TRAIL_MAX_POINTS * 2 * 3);
const trailColors    = new Float32Array(TRAIL_MAX_POINTS * 2 * 3);
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setAttribute('color',    new THREE.BufferAttribute(trailColors, 3));
trailGeo.setDrawRange(0, 0);
const trailMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, linewidth: 2,
});
const trailLine = new THREE.LineSegments(trailGeo, trailMat);
const trailBuf = []; // ring of { x, y, z, t, jump } — jump=true means start of a new run
let lastTrailPos = null;

function lerpColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const COLOR_HOT  = [1.00, 0.95, 0.55]; // yellow-white
const COLOR_MID  = [1.00, 0.42, 0.18]; // orange
const COLOR_WARM = [0.85, 0.18, 0.30]; // deep red
let   COLOR_COLD = [1.00, 0.37, 0.64]; // mutable: matches active filament color

function ageColor(age01) {
  // 0..0.25  hot → mid
  // 0.25..0.6 mid → warm
  // 0.6..1   warm → cold
  if (age01 < 0.25) return lerpColor(COLOR_HOT, COLOR_MID, age01 / 0.25);
  if (age01 < 0.6)  return lerpColor(COLOR_MID, COLOR_WARM, (age01 - 0.25) / 0.35);
  return lerpColor(COLOR_WARM, COLOR_COLD, (age01 - 0.6) / 0.4);
}

function updateTrail() {
  if (activeLayerIdx < 0) return;
  // While paused (FINISH/IDLE) clear the trail so we don't leave hot streaks
  // hanging on a finished print.
  if (isPausedForState()) {
    if (trailBuf.length) {
      trailBuf.length = 0;
      trailGeo.setDrawRange(0, 0);
    }
    lastTrailPos = null;
    return;
  }
  const now = performance.now();
  const x = nozzleGroup.position.x;
  const y = nozzleGroup.position.y;
  const z = nozzleGroup.position.z;

  if (lastTrailPos) {
    const d = Math.hypot(x - lastTrailPos.x, y - lastTrailPos.y, z - lastTrailPos.z);
    if (d > 0.05) {                    // moved enough to record
      // Big jumps (layer change, scrub) → mark the new point as a break.
      const jump = d > TRAIL_BREAK_DIST;
      trailBuf.push({ x, y, z, t: now, jump });
      lastTrailPos = { x, y, z };
    }
  } else {
    trailBuf.push({ x, y, z, t: now, jump: true });
    lastTrailPos = { x, y, z };
  }

  // Drop expired points.
  while (trailBuf.length && (now - trailBuf[0].t) / 1000 > TRAIL_SECONDS) {
    trailBuf.shift();
  }
  while (trailBuf.length > TRAIL_MAX_POINTS) trailBuf.shift();

  // Build LineSegments: emit one (a, b) segment per consecutive non-jump
  // pair. Travels (jump=true) and the very first sample don't produce a
  // segment, so the trail has real gaps where the nozzle teleported across
  // a travel — no faded "bridge" lines pretending to be filament.
  let segCount = 0;
  for (let i = 1; i < trailBuf.length; i++) {
    const b = trailBuf[i];
    if (b.jump) continue;
    const a = trailBuf[i - 1];
    const off = segCount * 2 * 3;
    trailPositions[off]     = a.x; trailPositions[off + 1] = a.y; trailPositions[off + 2] = a.z;
    trailPositions[off + 3] = b.x; trailPositions[off + 4] = b.y; trailPositions[off + 5] = b.z;
    const ageA = (now - a.t) / 1000 / TRAIL_SECONDS;
    const ageB = (now - b.t) / 1000 / TRAIL_SECONDS;
    const cA = ageColor(Math.min(1, Math.max(0, ageA)));
    const cB = ageColor(Math.min(1, Math.max(0, ageB)));
    trailColors[off]     = cA[0]; trailColors[off + 1] = cA[1]; trailColors[off + 2] = cA[2];
    trailColors[off + 3] = cB[0]; trailColors[off + 4] = cB[1]; trailColors[off + 5] = cB[2];
    segCount++;
  }
  trailGeo.setDrawRange(0, segCount * 2);
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
}
// gcode-preview's render() rebuilds the entire toolpath geometry (parses
// commands up to endLayer, creates a fresh group, and clears the scene).
// That's expensive and almost always wasteful — the geometry only actually
// changes when endLayer changes (i.e., once per layer). For all the in-between
// frames we just need to re-issue a GPU draw with the new camera position
// and updated nozzle/trail positions. Splitting those paths cut CPU
// dramatically.
const _origRender = preview.render.bind(preview);
let lastRenderedEndLayer = -1;
const myExtras = [printPlate, nozzleAmbient, nozzleKey, nozzleFill, trailLine, nozzleGroup];

function fullRebuild() {
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
    if (c.type === 'LineSegments' && !ours.has(c)) preview.scene.remove(c);
  }
  for (const obj of myExtras) {
    if (!preview.scene.children.includes(obj)) preview.scene.add(obj);
  }
  lastRenderedEndLayer = preview.endLayer;
}

// preview.render() is overridden so callers (e.g. setExtrusionColor) trigger
// a rebuild the first time they're called after a real geometry change.
preview.render = function () {
  fullRebuild();
  updateNozzlePosition();
  updateTrail();
  preview.renderer?.render(preview.scene, preview.camera);
};

// Lightweight per-frame draw — no geometry rebuild, just nozzle/trail position
// updates and one GPU draw call. Falls back to a full rebuild when the
// rendered endLayer changes.
function fastTick() {
  if (preview.endLayer !== lastRenderedEndLayer) {
    fullRebuild();
  } else {
    // Make sure our extras are still attached (nothing should be removing
    // them, but be defensive against future scene-clearing callers).
    for (const obj of myExtras) {
      if (!preview.scene.children.includes(obj)) preview.scene.add(obj);
    }
  }
  updateNozzlePosition();
  updateTrail();
  preview.renderer?.render(preview.scene, preview.camera);
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
function recomputeModelLayerOffset() {
  modelLayerOffset = 0;
  const ls = preview.layers || [];
  for (let i = 0; i < ls.length; i++) {
    const h = ls[i]?.height || 0;
    if (h >= 0.05 && h <= 0.5) { modelLayerOffset = i; return; }
  }
}

function buildLayerPaths() {
  // Build a per-layer list of segments. Each segment carries:
  //   ax,ay → bx,by   start/end positions in gcode coords
  //   ext             true for extrusion moves (G1 with positive E in M83 mode,
  //                   or increasing E in M82); false for travels (move-only G0/G1)
  //   dur             segment duration in seconds at the gcode's own feedrate.
  //                   Travels resolve to 0 so they're instant — the nozzle
  //                   teleports to the next extrusion start.
  // Per-layer total = total extrusion time, which becomes the loop length for
  // the simulated nozzle walk so it moves at real print speed.
  layerPaths = [];
  const layers = preview.layers || [];
  let curX = 0, curY = 0;
  let curF = 6000;          // mm/min, initial guess
  let absoluteE = false;    // M83 (relative) is the Bambu default
  let prevE = 0;
  for (const layer of layers) {
    const segs = [];
    const cmds = (layer && layer.commands) || [];
    for (const c of cmds) {
      const g = c.gcode;
      if (g === 'm82') { absoluteE = true; prevE = 0; continue; }
      if (g === 'm83') { absoluteE = false; continue; }
      if (g !== 'g0' && g !== 'g1') continue;
      const p = c.params || {};
      if (typeof p.f === 'number' && p.f > 0) curF = p.f;
      const nx = (typeof p.x === 'number') ? p.x : curX;
      const ny = (typeof p.y === 'number') ? p.y : curY;
      // Detect extrusion: in M83, any positive E param. In M82, E that exceeds
      // the previous absolute E.
      let isExtrusion = false;
      if (g === 'g1' && typeof p.e === 'number') {
        if (absoluteE) { isExtrusion = p.e > prevE; prevE = p.e; }
        else { isExtrusion = p.e > 0; }
      }
      if (nx !== curX || ny !== curY) {
        const dist = Math.hypot(nx - curX, ny - curY);
        const dur = isExtrusion ? (dist / (curF / 60)) / NOZZLE_SPEED_FACTOR : 0;
        segs.push({ ax: curX, ay: curY, bx: nx, by: ny, ext: isExtrusion, dist, dur });
        curX = nx; curY = ny;
      }
    }
    let total = 0;
    const cumTime = [0];
    for (const s of segs) {
      total += s.dur;
      cumTime.push(total);
    }
    layerPaths.push({ segs, cumTime, total });
  }
}

function nozzleXYAt(layerIdx, elapsedSec) {
  const p = layerPaths[layerIdx];
  if (!p || p.segs.length === 0) return null;
  if (p.total === 0) return { x: p.segs[0].bx, y: p.segs[0].by };
  const targetT = elapsedSec % p.total;
  // Find the segment whose cumulative end-time crosses targetT. Travel
  // segments have dur=0 so they're skipped; we land on the start of the next
  // extrusion segment.
  let i = 0;
  while (i < p.segs.length && p.cumTime[i + 1] < targetT) i++;
  if (i >= p.segs.length) i = p.segs.length - 1;
  const s = p.segs[i];
  if (!s.ext || s.dur === 0) return { x: s.bx, y: s.by };
  const f = (targetT - p.cumTime[i]) / s.dur;
  return { x: s.ax + (s.bx - s.ax) * f, y: s.ay + (s.by - s.ay) * f };
}

// When set, the nozzle's within-layer position is pinned to this fraction
// (0..1) instead of being driven by elapsed wall-clock time.
let pathHoldFraction = null;

// Called from the wrapped preview.render() so the nozzle position updates on
// every frame the orbit loop produces.
function updateNozzlePosition() {
  // Hide the nozzle entirely when the printer isn't actively printing — no
  // real motion is happening, so the simulated nozzle would mislead the user.
  if (isPausedForState()) {
    nozzleGroup.visible = false;
    return;
  }
  if (activeLayerIdx < 0 || !layerPaths.length) {
    nozzleGroup.visible = false;
    return;
  }
  let elapsed;
  if (pathHoldFraction !== null) {
    const total = layerPaths[activeLayerIdx]?.total || 0;
    elapsed = pathHoldFraction * total;
  } else {
    elapsed = (performance.now() - layerStartTime) / 1000;
  }
  const xy = nozzleXYAt(activeLayerIdx, elapsed);
  if (!xy) { nozzleGroup.visible = false; return; }
  const z = cumZ[activeLayerIdx] ?? 0;
  // gcode-preview rotates its render group -90° around X (so gcode Y maps to
  // negative three.z) and translates by (-bv.x/2, 0, +bv.y/2). Mirror that
  // here so the nozzle lines up with the rendered toolpath, not the
  // bed-centered raw coords. Sign on Z was flipped before — caused prints
  // offset from bed center to appear ~20mm shifted.
  nozzleGroup.position.set(xy.x - buildCenter.x, z, buildCenter.y - xy.y);
  nozzleGroup.visible = true;
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
let lastEndLayer = -1;
let inFlight = false;

let totalLayers = 0;
let scrubActive = false;     // user is dragging or playing
let scrubLayer = 0;
let playing = false;
let playTimer = null;
let lastGcodeState = null;   // most recent gcode_state from MQTT
// In production (no ?debug / ?layers), pause all motion when the printer
// isn't actively printing. The toolpath stays on screen as a finished snapshot.
function isPausedForState() {
  if (verifyLayers || scrubActive) return false;
  return lastGcodeState === 'FINISH' || lastGcodeState === 'IDLE' || lastGcodeState === 'FAILED';
}

// Pull the active filament color from MQTT — Bambu reports it as "RRGGBBAA"
// hex on each tray; tray_now (or mapping) tells us which is feeding. Returns
// "#RRGGBB" or null if nothing usable was found.
function activeFilamentHex(print) {
  const ams = print?.ams?.ams;
  if (!Array.isArray(ams) || !ams.length) return null;
  const trayNow = parseInt(print?.ams?.tray_now ?? '255', 10);
  // Walk all trays; build a global slot list (slot 0–3 = AMS 0, 4–7 = AMS 1, …).
  const slots = [];
  ams.forEach((unit, ai) => {
    (unit.tray || []).forEach((tray, ti) => {
      slots[ai * 4 + ti] = tray;
    });
  });
  let pick = (trayNow >= 0 && trayNow < 255) ? slots[trayNow] : null;
  // Fall back to the first tray that looks loaded (color set, brand or type known).
  if (!pick || !pick.tray_color || pick.tray_color === '00000000') {
    pick = slots.find(t =>
      t && typeof t.tray_color === 'string' &&
      t.tray_color !== '00000000' &&
      (t.tray_type || t.tray_sub_brands || t.tray_id_name)
    );
  }
  if (!pick || !pick.tray_color || pick.tray_color.length < 6) return null;
  return '#' + pick.tray_color.slice(0, 6).toUpperCase();
}

function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

let lastFilamentHex = null;
function syncFilamentColor(print) {
  const hex = activeFilamentHex(print);
  if (!hex || hex === lastFilamentHex) return;
  // Pure black filament reads as invisible on the dark plate — nudge it up
  // so the toolpath stays legible without misrepresenting color.
  let useHex = hex;
  if (hex === '#000000') useHex = '#404040';
  preview.extrusionColor = useHex;
  COLOR_COLD = hexToRgb01(useHex);
  lastFilamentHex = hex;
}

function setOverlay(text, isError = false) {
  overlay.textContent = text;
  overlay.classList.toggle('error', !!isError);
  overlay.style.display = text ? 'block' : 'none';
}

function setLabel(layer, total) {
  if (labelEl) labelEl.textContent = `layer ${layer} / ${total}`;
}

async function loadGcode(taskKey) {
  inFlight = true;
  setOverlay('loading toolpath…');
  try {
    const res = await fetch('/api/gcode/current', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    preview.processGCode(text);
    recomputeCumZ();
    buildLayerPaths();
    recomputeCumLayerTime();
    recomputeModelLayerOffset();
    // Reset auto-fit so the next orbit tick re-frames to this job's bbox.
    orbitRadius = 0;
    // Clear any leftover trail from a previous job.
    trailBuf.length = 0;
    lastTrailPos = null;
    currentTaskKey = taskKey;
    lastEndLayer = -1;
    totalLayers = preview.layers?.length || 0;
    const renderCap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
    if (scrubEl) {
      scrubEl.max = String(renderCap);
      scrubEl.value = String(renderCap);
      scrubLayer = renderCap;
    }
    if (verifyLayers) {
      // Render all N layers up front; nozzle walks them sequentially.
      scrubActive = true;       // freeze tick() from overriding
      advanceTo(renderCap);     // draw all N layers' toolpath
      setNozzleLayer(1);        // start nozzle on layer 1
    }
    setLabel(verifyLayers ? 1 : totalLayers, renderCap);
    setOverlay('');
  } catch (e) {
    currentTaskKey = null;
    setOverlay(`gcode fetch failed: ${e.message}`, true);
  } finally {
    inFlight = false;
  }
}

function advanceTo(layerNum) {
  if (layerNum === lastEndLayer) return;
  preview.endLayer = layerNum;
  setNozzleLayer(layerNum);
  preview.render();
  lastEndLayer = layerNum;
  setLabel(layerNum, totalLayers);
}

// Slow camera orbit — runs continuously while a job is loaded. Radius/height
// auto-fit to the loaded print's bounding box so small prints fill the frame
// and big prints don't get clipped.
let orbitStart = performance.now();
let orbitRadius = 0;
let orbitHeight = 0;
let orbitTarget = new THREE.Vector3(0, 0, 0);

function autoFitCamera() {
  // Compute bbox of just the "real" model extrusions, ignoring Bambu's prep
  // / priming / purge passes which can span the whole bed and blow up the
  // framing. We approximate "real model layer" as one whose layer thickness
  // is in the normal slicer range (0.05–0.5 mm).
  if (!layerPaths.length || !preview.layers?.length) return;
  let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
  const cap = verifyLayers ? Math.min(verifyLayers, layerPaths.length) : layerPaths.length;
  for (let i = 0; i < cap; i++) {
    const h = preview.layers[i]?.height || 0;
    if (h < 0.05 || h > 0.5) continue;     // skip prep / priming / wipe layers
    const lp = layerPaths[i];
    for (const s of lp.segs) {
      if (!s.ext) continue;
      if (s.ax < minX) minX = s.ax; if (s.ax > maxX) maxX = s.ax;
      if (s.bx < minX) minX = s.bx; if (s.bx > maxX) maxX = s.bx;
      if (s.ay < minY) minY = s.ay; if (s.ay > maxY) maxY = s.ay;
      if (s.by < minY) minY = s.by; if (s.by > maxY) maxY = s.by;
    }
  }
  if (!isFinite(minX) || !isFinite(minY)) return;
  const sx = maxX - minX, sy = maxY - minY;
  const cxg = (minX + maxX) / 2, cyg = (minY + maxY) / 2;
  const sz = (cumZ[Math.min(cap, cumZ.length) - 1] || 0);
  const footprint = Math.hypot(sx, sy);
  orbitRadius = Math.max(120, footprint * 1.4 + 100);
  orbitHeight = Math.max(90, sz + footprint * 0.7);
  // Map gcode (cxg, cyg, sz/2) to three world coords for the camera target.
  orbitTarget = new THREE.Vector3(
    cxg - buildCenter.x,
    sz / 2,
    buildCenter.y - cyg,
  );
}

// Latched orbit angle so a paused widget freezes at whatever angle it was
// last showing — instead of snapping back to theta=0 — and resumes from there
// once the printer goes back to RUNNING.
let lastTheta = 0;
let orbitFrozenAt = null; // performance.now() at which we paused
function orbitTick() {
  if (preview.camera && totalLayers > 0) {
    if (orbitRadius === 0) {
      autoFitCamera();
      if (orbitRadius === 0) { orbitRadius = 190; orbitHeight = 130; }
    }
    const paused = isPausedForState();
    let theta;
    if (paused) {
      if (orbitFrozenAt === null) orbitFrozenAt = performance.now();
      theta = lastTheta;
    } else {
      // Resuming from a paused stretch: shift orbitStart so theta picks up
      // where it left off, no jump.
      if (orbitFrozenAt !== null) {
        orbitStart += (performance.now() - orbitFrozenAt);
        orbitFrozenAt = null;
      }
      const t = (performance.now() - orbitStart) / 1000;
      theta = t * (ROTATE_DEG_PER_SEC * Math.PI / 180);
      lastTheta = theta;
    }
    preview.camera.position.set(
      orbitTarget.x + Math.sin(theta) * orbitRadius,
      orbitTarget.y + orbitHeight,
      orbitTarget.z + Math.cos(theta) * orbitRadius,
    );
    preview.camera.lookAt(orbitTarget);
    verifyAdvanceTick();
    // fastTick: skips the heavy gcode-preview geometry rebuild unless the
    // rendered endLayer actually changed. ~10× cheaper for the steady-state
    // orbit-and-walk frames.
    fastTick();
  }
  requestAnimationFrame(orbitTick);
}
requestAnimationFrame(orbitTick);

async function tick() {
  let data;
  try {
    const res = await fetch('/data.json', { cache: 'no-store' });
    const text = await res.text();
    // Empty/partial body happens when MQTT rewrites data.json mid-poll —
    // benign, just skip this tick. Same for non-JSON content.
    if (!text || !text.trim()) return;
    try { data = JSON.parse(text); }
    catch (_) { return; }
  } catch (_) {
    // Network blip — also skip silently; the 800ms loop will retry.
    return;
  }
  try {
    const print = (data && data.print) || {};
    const taskId = print.task_id || print.subtask_id;
    const plateIdx = print.plate_idx || print.plate_id || 1;
    const state = print.gcode_state;
    const layerNum = Number(print.layer_num) || 0;
    lastGcodeState = state;

    if (!taskId || state === 'IDLE') {
      if (currentTaskKey) {
        setOverlay('');
      } else {
        setOverlay('waiting for print…');
      }
      return;
    }

    syncFilamentColor(print);

    const taskKey = `${taskId}_p${plateIdx}`;

    if (taskKey !== currentTaskKey) {
      if (!inFlight) await loadGcode(taskKey);
      return;
    }

    // While scrubbing/playing, the user owns the cursor.
    if (scrubActive) return;

    if (state === 'PAUSED') return;

    // Translate Bambu's model-relative layer count (1-based, ignores prep)
    // to the parser's index space. e.g. if the slicer emitted 3 prep layers
    // before the first model layer, modelLayerOffset = 3, and Bambu
    // layer_num=1 maps to parsed layer index 3 (1-based: 4).
    const modelToParsed = (n) => Math.min(totalLayers, n + modelLayerOffset);
    const target = state === 'FINISH'
      ? (Number(print.total_layer_num) ? modelToParsed(Number(print.total_layer_num)) : (layerNum || totalLayers))
      : modelToParsed(layerNum);
    advanceTo(target);

    // Sync the within-layer animation to mc_percent ONLY when the math lands
    // cleanly within the current layer's duration. mc_percent counts heating
    // / prep / cooldown toward total time, while our gcode time is extrusion-
    // only — so early in a print mc_percent overshoots, which would clamp
    // the nozzle to the end of the layer and freeze it. When out of band,
    // let the natural realtime animation loop through the layer instead;
    // it's close enough.
    if (state === 'RUNNING' && totalGcodeTime > 0 && activeLayerIdx >= 0) {
      const mcPct = Number(print.mc_percent);
      if (Number.isFinite(mcPct)) {
        const targetT = (mcPct / 100) * totalGcodeTime;
        const layerStartT = cumLayerTime[activeLayerIdx] || 0;
        const layerDur = layerPaths[activeLayerIdx]?.total || 0;
        const rel = targetT - layerStartT;
        if (rel >= 0 && rel <= layerDur) {
          layerStartTime = performance.now() - rel * 1000;
        }
      }
    }
  } catch (e) {
    setOverlay(`status poll failed: ${e.message}`, true);
  }
}

if (debug && debugBar) {
  debugBar.classList.add('show');
  window.__preview = preview;
  window.__nozzle = nozzleGroup;
  window.__diag = () => ({
    activeLayerIdx,
    pathHoldFraction,
    totalForActive: layerPaths[activeLayerIdx]?.total,
    segCount: layerPaths[activeLayerIdx]?.segs?.length,
    extCount: (layerPaths[activeLayerIdx]?.segs || []).filter(s => s.ext).length,
    orbit: { radius: orbitRadius, height: orbitHeight, target: orbitTarget?.toArray()?.map(n => +n.toFixed(1)) },
  });

  scrubEl.addEventListener('input', () => {
    scrubActive = true;
    scrubLayer = Number(scrubEl.value) || 0;
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
    if (on) {
      scrubActive = true;
      playTimer = setInterval(() => {
        if (totalLayers <= 0) return;
        const cap = verifyLayers ? Math.min(verifyLayers, totalLayers) : totalLayers;
        scrubLayer = scrubLayer >= cap ? 1 : scrubLayer + 1;
        scrubEl.value = String(scrubLayer);
        if (verifyLayers) {
          setNozzleLayer(scrubLayer);
          setLabel(scrubLayer, cap);
        } else {
          advanceTo(scrubLayer);
        }
      }, Math.max(20, 1000 / PLAY_LAYERS_PER_SEC));
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
      const total = layerPaths[activeLayerIdx]?.total || 0;
      // Re-anchor wall-clock time so the animation continues from the held spot.
      layerStartTime = performance.now() - pathHoldFraction * total * 1000;
      pathHoldFraction = null;
      verifyManualHold = false;
    });
  }
}

tick();
setInterval(tick, POLL_MS);

window.addEventListener('resize', () => preview.resize?.());
