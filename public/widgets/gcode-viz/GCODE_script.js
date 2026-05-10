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
// Fixed view angle around the print (radians). Aimed to match the direction
// the H2D's chamber camera looks at the bed — same prints, same left/right
// orientation across both views.
const ORBIT_THETA_FIXED = Math.PI * 1.7;        // ~306° / -54° — looks from the opposite side of the bed vs the previous take
// Nozzle simulation speed multiplier vs gcode feedrate. Self-calibrates
// based on observed mc_percent advancement rate so it tracks the real
// printer including filament-swap delays, accel/decel overhead, and any
// speed-mode multiplier. 0.5 is a conservative starting guess — real
// printers rarely exceed commanded feedrate, and accel/decel overhead
// pushes effective speed well below it. The calibrator zeroes in within
// a few samples.
let nozzleSpeedFactor = 0.5;
let calibrationSamples = 0;
// Hot-extrusion trail: how long a freshly-deposited segment glows before
// fading to the cold print color, and the geometry buffer cap. Long window
// + wide cooling bands so the red→orange→yellow→cold gradient is actually
// visible across the trail rather than red-dominating up front.
const TRAIL_SECONDS = 144;
const TRAIL_MAX_POINTS = 8800;
const TRAIL_BREAK_DIST = 25;    // mm jump that splits the trail (e.g. layer change)
// No delay — sync the simulated nozzle directly to the printer's
// mc_percent position. Any lag puts us on the wrong segment / object.
const REPLAY_DELAY_S = 0;

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
  backgroundColor: '#1a1c20', // overridden to transparent below; kept here so gcode-preview's fog still has a base color
  // Travels are visualized via the trail (short-lived gray streak) rather than
  // baked into the static toolpath — keeps the build plate uncluttered.
  renderTravel: false,
  buildVolume: { x: bed.x, y: bed.y, z: bed.z },
  initialCameraPosition: [-120, 130, 150],
});

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

// Hot-extrusion trail: vertex-colored ribbon mesh drawn on top of the
// toolpath with depthTest disabled so it's always visible.
const trailMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});
// Trail rendered as a thin ribbon mesh (two triangles per segment) instead
// of LineSegments. WebGL lines are always 1px which is invisible against
// the dense toolpath wireframe. A ribbon with ~1mm height has real visual
// volume that reads clearly even with white filament.
const RIBBON_H = 0.15;  // half-height of ribbon in world units
const trailIdxBuf = new Uint32Array(TRAIL_MAX_POINTS * 6);
const trailRibbonPos = new Float32Array(TRAIL_MAX_POINTS * 4 * 3);
const trailRibbonCol = new Float32Array(TRAIL_MAX_POINTS * 4 * 3);
const trailGeoRibbon = new THREE.BufferGeometry();
trailGeoRibbon.setAttribute('position', new THREE.BufferAttribute(trailRibbonPos, 3));
trailGeoRibbon.setAttribute('color', new THREE.BufferAttribute(trailRibbonCol, 3));
trailGeoRibbon.setIndex(new THREE.BufferAttribute(trailIdxBuf, 1));
trailGeoRibbon.setDrawRange(0, 0);
const trailLine = new THREE.Mesh(trailGeoRibbon, trailMat);
trailLine.renderOrder = 999;
trailLine.frustumCulled = false;
const trailBuf = []; // ring of { x, y, z, t, jump } — jump=true means start of a new run
let lastTrailPos = null;
let lastTrailSegIdx = -1;
let lastTrailLayerIdx = -1;

function lerpColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
// Trail color ramp: just-extruded filament is bright red, cools through
// orange to green, then settles to the actual filament color.
const COLOR_HOT  = [1.00, 0.05, 0.02]; // vivid red — just out of the nozzle
const COLOR_ORG  = [1.00, 0.45, 0.00]; // orange — cooling
const COLOR_YEL  = [0.95, 0.85, 0.10]; // yellow — warm
const COLOR_GRN  = [0.10, 0.85, 0.20]; // green — almost set
let   COLOR_COLD = [1.00, 0.37, 0.64]; // mutable: matches active filament color

function ageColor(age01) {
  //   0.00..0.05  HOT (red) — brief flash right at the nozzle
  //   0.05..0.20  HOT → ORG  (red → orange)
  //   0.20..0.40  ORG → YEL  (orange → yellow)
  //   0.40..0.70  YEL → GRN  (yellow → green)
  //   0.70..1.00  GRN → COLD (green → filament color)
  if (age01 < 0.05) return COLOR_HOT.slice();
  if (age01 < 0.20) return lerpColor(COLOR_HOT, COLOR_ORG, (age01 - 0.05) / 0.15);
  if (age01 < 0.40) return lerpColor(COLOR_ORG, COLOR_YEL, (age01 - 0.20) / 0.20);
  if (age01 < 0.70) return lerpColor(COLOR_YEL, COLOR_GRN, (age01 - 0.40) / 0.30);
  return                   lerpColor(COLOR_GRN, COLOR_COLD, (age01 - 0.70) / 0.30);
}

function updateTrail() {
  if (activeLayerIdx < 0) return;
  // When the print is truly done (FINISH/IDLE/FAILED), clear the trail so
  // hot streaks don't hang on a finished print. During mid-print sub-stage
  // checks (stg_cur briefly nonzero) we just stop adding points — don't
  // wipe what we've built up.
  if (!verifyLayers && !scrubActive) {
    if (lastGcodeState === 'FINISH' || lastGcodeState === 'IDLE' || lastGcodeState === 'FAILED') {
      if (trailBuf.length) {
        trailBuf.length = 0;
        trailGeoRibbon.setDrawRange(0, 0);
      }
      lastTrailPos = null;
      return;
    }
    if (isPausedForState()) {
      return;
    }
  }
  const now = performance.now();
  const x = nozzleGroup.position.x;
  const y = nozzleGroup.position.y;
  const z = nozzleGroup.position.z;

  if (lastTrailPos) {
    const d = Math.hypot(x - lastTrailPos.x, y - lastTrailPos.y, z - lastTrailPos.z);
    if (d > 0.05) {                    // moved enough to record
      // A "jump" should break the trail. Detect it three ways:
      //   1) Big distance (layer change, scrub teleport) — TRAIL_BREAK_DIST.
      //   2) Layer changed since last sample.
      //   3) The simulated nozzle skipped over a travel segment in the
      //      parsed gcode between this frame and the last. Travels have
      //      them. The nozzle moves smoothly through travels now (they
      //      carry real duration), but no filament is deposited so we
      //      mustn't draw a trail across the repositioning gap.
      let jump = (d > TRAIL_BREAK_DIST) || (activeLayerIdx !== lastTrailLayerIdx);
      if (!jump && currentSegIdx >= 0) {
        const segs = layerPaths[activeLayerIdx]?.segs || [];
        // Break the trail when the nozzle is currently on a travel
        // segment — no filament is being deposited during repositioning.
        // Also break when any travel segment was crossed since the last
        // frame so the trail doesn't bridge an air gap.
        if (segs[currentSegIdx] && !segs[currentSegIdx].ext) {
          jump = true;
        } else if (lastTrailSegIdx >= 0 && currentSegIdx !== lastTrailSegIdx) {
          const lo = Math.min(lastTrailSegIdx, currentSegIdx);
          const hi = Math.max(lastTrailSegIdx, currentSegIdx);
          for (let k = lo + 1; k <= hi; k++) {
            if (segs[k] && !segs[k].ext) { jump = true; break; }
          }
        }
      }
      trailBuf.push({ x, y, z, t: now, jump });
      lastTrailPos = { x, y, z };
      lastTrailSegIdx = currentSegIdx;
      lastTrailLayerIdx = activeLayerIdx;
    }
  } else {
    trailBuf.push({ x, y, z, t: now, jump: true });
    lastTrailPos = { x, y, z };
    lastTrailSegIdx = currentSegIdx;
    lastTrailLayerIdx = activeLayerIdx;
  }

  // Drop expired points.
  while (trailBuf.length && (now - trailBuf[0].t) / 1000 > TRAIL_SECONDS) {
    trailBuf.shift();
  }
  while (trailBuf.length > TRAIL_MAX_POINTS) trailBuf.shift();

  // Build ribbon mesh: each segment is a quad (2 triangles) offset
  // perpendicular to the path in the XZ plane so the ribbon lies flat
  // on the print surface — visible from the side camera angle.
  let segCount = 0;
  for (let i = 1; i < trailBuf.length; i++) {
    const b = trailBuf[i];
    if (b.jump) continue;
    const a = trailBuf[i - 1];
    const v = segCount * 4;   // 4 vertices per quad
    const p = v * 3;
    // Perpendicular offset in XZ plane (flat ribbon on the print surface)
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * RIBBON_H, pz = (dx / len) * RIBBON_H;
    trailRibbonPos[p]      = a.x + px; trailRibbonPos[p + 1]  = a.y; trailRibbonPos[p + 2]  = a.z + pz;
    trailRibbonPos[p + 3]  = a.x - px; trailRibbonPos[p + 4]  = a.y; trailRibbonPos[p + 5]  = a.z - pz;
    trailRibbonPos[p + 6]  = b.x + px; trailRibbonPos[p + 7]  = b.y; trailRibbonPos[p + 8]  = b.z + pz;
    trailRibbonPos[p + 9]  = b.x - px; trailRibbonPos[p + 10] = b.y; trailRibbonPos[p + 11] = b.z - pz;
    const ageA = (now - a.t) / 1000 / TRAIL_SECONDS;
    const ageB = (now - b.t) / 1000 / TRAIL_SECONDS;
    const cA = ageColor(Math.min(1, Math.max(0, ageA)));
    const cB = ageColor(Math.min(1, Math.max(0, ageB)));
    trailRibbonCol[p]      = cA[0]; trailRibbonCol[p + 1]  = cA[1]; trailRibbonCol[p + 2]  = cA[2];
    trailRibbonCol[p + 3]  = cA[0]; trailRibbonCol[p + 4]  = cA[1]; trailRibbonCol[p + 5]  = cA[2];
    trailRibbonCol[p + 6]  = cB[0]; trailRibbonCol[p + 7]  = cB[1]; trailRibbonCol[p + 8]  = cB[2];
    trailRibbonCol[p + 9]  = cB[0]; trailRibbonCol[p + 10] = cB[1]; trailRibbonCol[p + 11] = cB[2];
    // Two triangles: (0,1,2) and (1,3,2)
    const idx = segCount * 6;
    trailIdxBuf[idx]     = v;     trailIdxBuf[idx + 1] = v + 1; trailIdxBuf[idx + 2] = v + 2;
    trailIdxBuf[idx + 3] = v + 1; trailIdxBuf[idx + 4] = v + 3; trailIdxBuf[idx + 5] = v + 2;
    segCount++;
  }
  trailGeoRibbon.setDrawRange(0, segCount * 6);
  trailGeoRibbon.attributes.position.needsUpdate = true;
  trailGeoRibbon.attributes.color.needsUpdate = true;
  trailGeoRibbon.index.needsUpdate = true;
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
const myExtras = [nozzleAmbient, nozzleKey, nozzleFill, nozzleRim, trailLine, nozzleGroup, printPlate];

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
// Index of the segment the simulated nozzle is currently on within its
// active layer's path. Set by nozzleXYAt(); used by updateTrail() to detect
// when consecutive frames straddle a travel (so we don't draw a faux trail
// line spanning the air gap).
let currentSegIdx = -1;

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
  // Helper: append one tessellated segment to the layer's segs array.
  // Both extrusion and travel moves get their real duration at the
  // commanded feedrate. Previously travels were instant (dur=0) which
  // underestimated totalGcodeTime by 20-50% — the calibrator then
  // converged to a speed factor that was too high, making the animation
  // visibly outpace the real printer (especially on multi-color H2D
  // prints with frequent tool-change travels).
  function pushSeg(segs, ax, ay, bx, by, isExt, curFRef) {
    if (ax === bx && ay === by) return;
    const dist = Math.hypot(bx - ax, by - ay);
    const f = curFRef.f || 6000;
    const dur = dist / (f / 60);
    segs.push({ ax, ay, bx, by, ext: isExt, dist, dur });
  }
  for (const layer of layers) {
    const segs = [];
    const cmds = (layer && layer.commands) || [];
    for (const c of cmds) {
      const g = c.gcode;
      if (g === 'm82') { absoluteE = true; prevE = 0; continue; }
      if (g === 'm83') { absoluteE = false; continue; }
      const p = c.params || {};
      if (g === 'g0' || g === 'g1') {
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
          pushSeg(segs, curX, curY, nx, ny, isExtrusion, { f: curF });
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
          if (absoluteE) { isExtrusion = p.e > prevE; prevE = p.e; }
          else { isExtrusion = p.e > 0; }
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
          pushSeg(segs, prevX, prevY, nx, ny, isExtrusion, { f: curF });
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
    layerPaths.push({ segs, cumTime, total });
  }
}

function nozzleXYAt(layerIdx, elapsedSec) {
  const p = layerPaths[layerIdx];
  if (!p || p.segs.length === 0) { currentSegIdx = -1; return null; }
  if (p.total === 0) { currentSegIdx = 0; return { x: p.segs[0].bx, y: p.segs[0].by }; }
  const targetT = elapsedSec % p.total;
  // Find the segment whose cumulative end-time crosses targetT. Travels
  // now carry their real duration so the nozzle smoothly moves through
  // them (matching how the real printhead repositions).
  let i = 0;
  while (i < p.segs.length && p.cumTime[i + 1] < targetT) i++;
  if (i >= p.segs.length) i = p.segs.length - 1;
  currentSegIdx = i;
  const s = p.segs[i];
  if (s.dur === 0) return { x: s.bx, y: s.by };
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
  // Glow is only on when the printer is actually extruding. PAUSED keeps the
  // nozzle visible (so you can see where it is) but kills the glow since no
  // hot filament is coming out. Verify/scrub modes leave the glow on so the
  // visualization still reads as "active" while testing.
  glowGroup.visible = (verifyLayers || scrubActive)
    ? true
    : (lastGcodeState === 'RUNNING');
  let elapsed;
  if (pathHoldFraction !== null) {
    const total = layerPaths[activeLayerIdx]?.total || 0;
    elapsed = pathHoldFraction * total;
  } else {
    elapsed = (performance.now() - layerStartTime) / 1000 * nozzleSpeedFactor;
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
  if (lastGcodeState === 'FINISH' || lastGcodeState === 'IDLE' || lastGcodeState === 'FAILED') return true;
  // Preview state: model is shown but printer is still calibrating — freeze
  // the nozzle so it doesn't animate over the static preview.
  if (lastGcodeState === 'RUNNING' && lastSubStage !== 0) return true;
  return false;
}

// Build an array of hex colors for every AMS tray slot (slot N = global
// index ai*4+ti). gcode-preview accepts this array form and colors each
// extrusion segment by the active tool index from T0/T1/T2 commands in the
// gcode, so multi-color prints render correctly without us tracking the
// switches ourselves.
function buildTrayPalette(print) {
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

function activeTrayHex(print, palette) {
  const trayNow = parseInt(print?.ams?.tray_now ?? '255', 10);
  if (palette && trayNow >= 0 && trayNow < palette.length) return palette[trayNow];
  // Fallback: first loaded tray
  return palette?.find(c => c && c !== '#888888') || null;
}

function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

let lastPaletteSig = null;
let lastActiveHex = null;
function syncFilamentColor(print) {
  const palette = buildTrayPalette(print);
  if (!palette) return;
  const sig = palette.join('|');
  if (sig !== lastPaletteSig) {
    preview.extrusionColor = palette;
    lastPaletteSig = sig;
    // Force a rebuild so per-tool colors apply to existing geometry.
    lastRenderedEndLayer = -1;
  }
  // Trail "cold" color follows the currently-active tray.
  const active = activeTrayHex(print, palette);
  if (active && active !== lastActiveHex) {
    COLOR_COLD = hexToRgb01(active);
    lastActiveHex = active;
  }
}

// kind: 'hint' (small bottom hint, default), 'loading' (centered pill with
// pulsing dot), 'error' (small red bottom hint).
function setOverlay(text, kind = 'hint') {
  overlay.textContent = text;
  overlay.classList.toggle('loading', kind === 'loading');
  overlay.classList.toggle('error',   kind === 'error');
  overlay.style.display = text ? 'block' : 'none';
}

function setLabel(layer, total) {
  if (labelEl) labelEl.textContent = `layer ${layer} / ${total}`;
}

// Wipe the rendered toolpath + animation state to a clean "no print loaded"
// baseline. Called when a new task_id is detected so the old print's
// geometry doesn't stay on screen while we fetch the new gcode (which can
// take 1-2 s for a fresh print, longer if the printer hasn't written the
// file to /cache/ yet and we have to retry).
function clearScene() {
  preview.processGCode('M83\n');           // seed parser with one no-op so layers[] empties
  preview.endLayer = 0;
  layerPaths = [];
  cumZ = [];
  cumLayerTime = [0];
  totalGcodeTime = 0;
  totalLayers = 0;
  modelLayerOffset = 0;
  activeLayerIdx = -1;
  currentSegIdx = -1;
  lastEndLayer = -1;
  lastRenderedEndLayer = -1;
  trailBuf.length = 0;
  lastTrailPos = null;
  lastTrailSegIdx = -1;
  lastTrailLayerIdx = -1;
  smoothedNozzleInit = false;
  mcPercentLastSeen = null;                 // force a fresh sync on next tick
  mqttSyncedLayer = null;
  lastMcPctChangeWall = null;
  lastMcPctChangeValue = null;
  calibrationSamples = 0;
  nozzleSpeedFactor = 0.5;                 // reset to initial guess for new print
  orbitRadius = 0;                          // re-fit on next orbit tick
  fastTick();                               // commit the empty state to the GPU
}

async function loadGcode(taskKey) {
  inFlight = true;
  // Hide the 3D canvas while we fetch + parse so the camera doesn't orbit
  // around an empty scene (looks like random flying). The overlay sits
  // outside the canvas so it stays visible.
  canvas.style.visibility = 'hidden';
  // Drop the previous print's geometry immediately so the user doesn't see
  // it lingering while the new gcode fetches. The overlay then signals
  // we're working on it.
  clearScene();
  setOverlay('Preparing — loading print…', 'loading');
  try {
    const gcodeUrl = forceNocache
      ? '/api/gcode/current?nocache=1'
      : '/api/gcode/current';
    forceNocache = false;
    const res = await fetch(gcodeUrl, { cache: 'no-store' });
    if (!res.ok) {
      // 502 typically means the printer hasn't written the new job's file
      // to /cache/ yet (race between MQTT job_id update and the FTPS file
      // being available). The next tick will retry automatically; show a
      // friendlier message in the meantime.
      const status = res.status;
      const friendly = status === 502
        ? 'Waiting for printer to publish gcode…'
        : `Loading failed (HTTP ${status})`;
      throw new Error(friendly);
    }
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
    // Gcode is parsed, geometry built, and camera auto-fitted — safe to
    // reveal the canvas now. The first rendered frame will already show the
    // correct model at the right zoom level.
    canvas.style.visibility = 'visible';
  } catch (e) {
    currentTaskKey = null;
    // Keep the loading style — we'll be retrying every poll cycle until the
    // file shows up, so this is a "still working on it" state, not a
    // permanent error. The pulsing dot signals activity.
    setOverlay(e.message || 'Loading failed — retrying…', 'loading');
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
// and big prints don't get clipped. orbitTarget is smoothed each frame: the
// camera lazily pursues the nozzle so it stays visually centered, falling
// back to the print bbox center when the printer isn't extruding. The view
// angle around the print is fixed (no orbit rotation) — the smooth follow
// supplies all the visual interest.
let orbitRadius = 0;
let orbitHeight = 0;
let orbitRadiusBase = 0;  // radius computed by autoFit (before finish zoom)
let orbitHeightBase = 0;
let orbitTarget    = new THREE.Vector3(0, 0, 0); // current (smoothed) lookAt
let bboxCenter     = new THREE.Vector3(0, 0, 0); // print bbox center anchor
let smoothedNozzle = new THREE.Vector3(0, 0, 0); // EMA of nozzle position
let smoothedNozzleInit = false;
const NOZZLE_FOLLOW_BIAS = 1.0;
const NOZZLE_SMOOTH_LERP = 0.015;
const TARGET_LERP        = 0.045;
const _scratchDesired    = new THREE.Vector3();

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
  // Wider framing than before (was 0.65+35). The 25° FOV is tight, so large
  // prints need more orbit radius to avoid the nozzle drifting off-screen
  // when it crosses the bed. The frustum-aware code in orbitTick() handles
  // real-time adjustments, but a better starting radius prevents the first
  // few seconds from clipping.
  orbitRadiusBase = Math.max(60, footprint * 0.75 + 40);
  orbitHeightBase = Math.max(30, sz + footprint * 0.2);
  orbitRadius = orbitRadiusBase;
  orbitHeight = orbitHeightBase;
  // Map gcode (cxg, cyg, sz/2) to three world coords for the bbox anchor.
  bboxCenter.set(
    cxg - buildCenter.x,
    sz / 2,
    buildCenter.y - cyg,
  );
  // Snap the smoothed target to the new anchor on first frame so we don't
  // start orbiting around (0,0,0) and lerp-pan into place.
  orbitTarget.copy(bboxCenter);
}

function orbitTick() {
  // Skip all work when the tab/iframe isn't visible (OBS preview hidden,
  // user switched tabs, etc). RAF already throttles in this case but
  // returning early avoids the full pipeline (camera math, nozzle update,
  // trail rebuild, GPU draw) on the throttled ticks that do fire.
  if (document.hidden) {
    requestAnimationFrame(orbitTick);
    return;
  }
  if (preview.camera) {
    if (orbitRadius === 0) {
      autoFitCamera();
      if (orbitRadius === 0) { orbitRadius = 100; orbitHeight = 45; }
    }
    const theta = ORBIT_THETA_FIXED;

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

    // When finished, zoom out to show the full model; while printing,
    // use the tighter nozzle-follow framing.
    const isFinished = isPausedForState() && !verifyLayers && !scrubActive;
    let goalRadius = isFinished ? orbitRadiusBase * 1.6 : orbitRadiusBase;
    let goalHeight = isFinished ? orbitHeightBase * 1.4 : orbitHeightBase;

    // If the nozzle is drifting toward the edge of the viewport, gently
    // zoom out so there's more room. The ramp starts at 0.65 (nozzle in
    // the outer 35%) and maxes at 30% extra radius when fully at the edge.
    if (nozzleEdge > 0.65) {
      const urgency = Math.min(1, (nozzleEdge - 0.65) / 0.35);
      goalRadius = Math.max(goalRadius, orbitRadiusBase * (1 + urgency * 0.3));
      goalHeight = Math.max(goalHeight, orbitHeightBase * (1 + urgency * 0.15));
    }

    orbitRadius += (goalRadius - orbitRadius) * 0.02;
    orbitHeight += (goalHeight - orbitHeight) * 0.02;

    if (nozzleGroup.visible) {
      if (!smoothedNozzleInit) {
        smoothedNozzle.copy(nozzleGroup.position);
        smoothedNozzleInit = true;
      } else {
        smoothedNozzle.lerp(nozzleGroup.position, NOZZLE_SMOOTH_LERP);
      }
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
    const printStage = Number(print.mc_print_stage) || 0;
    const subStage = Number(print.stg_cur) || 0;
    // Capture previous tick's state BEFORE overwriting, so we can detect
    // print lifecycle transitions (FINISH→RUNNING, progress resets).
    const _prevState = prevTickState;
    const _prevMcPct = prevTickMcPct;

    lastGcodeState = state;
    lastSubStage = subStage;
    // Active print = printer is actually depositing model material.
    // Gate on THREE conditions:
    //   1. gcode_state === 'RUNNING'
    //   2. layer_num > 0 — prep stages keep this at 0
    //   3. stg_cur === 0 — any nonzero value means a sub-stage is active
    //      (auto bed leveling, nozzle preheat, extrusion calibration, etc.)
    //      even when mc_print_stage is already 2
    // Preview = RUNNING but still in a sub-stage — show the full model
    // statically so the user sees what's coming.
    const mcPctRaw = Number(print.mc_percent) || 0;
    const mcRemain = Number(print.mc_remaining_time) || 0;

    // Update previous-tick trackers for next iteration.
    prevTickState = state;
    prevTickMcPct = mcPctRaw;

    const isEffectivelyDone = state === 'RUNNING' && mcPctRaw >= 99 && mcRemain <= 0;
    // Active print = RUNNING + stg_cur===0 (no sub-stage). We no longer
    // require layerNum>0 because layer_num can lag behind stg_cur clearing.
    const isActivePrint = state === 'RUNNING' && subStage === 0 && !isEffectivelyDone;
    // Mid-print sub-stage (nozzle switch, bed scan, etc.) — we were already
    // printing and a transient sub-stage kicked in. Don't show "Preparing",
    // just freeze the nozzle. Detected by: RUNNING + subStage nonzero but
    // we've already rendered at least one layer in this job.
    const isMidPrintSubStage = state === 'RUNNING' && subStage !== 0 && !isEffectivelyDone && lastEndLayer > 0;
    // Pre-print preview: RUNNING but haven't printed any layers yet and
    // a sub-stage is active (calibrating/heating). Show the full model.
    const isPreviewState = state === 'RUNNING' && !isActivePrint && !isEffectivelyDone && !isMidPrintSubStage;
    const isHoldState   = state === 'PAUSED' || state === 'FINISH' || isEffectivelyDone || isMidPrintSubStage;

    // ── New-print lifecycle detection ──
    // Detect when a new print starts even if the task_id hasn't changed
    // (reprints of the same file, or firmware that reuses IDs). Two signals:
    //   1. State transition: done/idle/failed → running/prepare
    //   2. Progress reset: mc_percent drops from ≥90 to <50 while state
    //      stays RUNNING (firmware sometimes skips the FINISH state entirely)
    if (currentTaskKey && _prevState != null) {
      const fromDone = _prevState === 'FINISH' || _prevState === 'IDLE' || _prevState === 'FAILED';
      const toActive = state === 'RUNNING' || state === 'PREPARE';
      const justStarted = toActive && fromDone;
      const progressReset = state === 'RUNNING' && mcPctRaw < 50 && _prevMcPct >= 90;
      if (justStarted || progressReset) {
        // Force a fresh gcode load on the next taskKey check. Also flag
        // the fetch to bypass the server-side cache so reprints with the
        // same task_id get fresh gcode from the printer.
        currentTaskKey = null;
        forceNocache = true;
      }
    }

    if (!taskId || (!isActivePrint && !isPreviewState && !isHoldState)) {
      if (currentTaskKey) {
        clearScene();
        currentTaskKey = null;
        mcPercentLastSeen = null;
        mqttSyncedLayer = null;
        lastMcPctChangeWall = null;
        lastMcPctChangeValue = null;
      }
      if (state === 'PREPARE' || state === 'SLICING') {
        setOverlay('Preparing print…', 'loading');
      } else if (state === 'FAILED') {
        setOverlay('Print failed', 'error');
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

    // Preview mode: gcode is loaded, show the full model statically while
    // the printer calibrates / heats. No nozzle, no layer tracking — just
    // the complete toolpath so the user sees what's about to print.
    if (isPreviewState) {
      if (lastEndLayer !== totalLayers && totalLayers > 0) {
        advanceTo(totalLayers);
        setOverlay('Preparing — preview loaded', 'loading');
      }
      return;
    }

    if (scrubActive) return;
    if (state === 'PAUSED') return;
    // Mid-print sub-stage (filament swap, bed scan, etc.): freeze the
    // simulation. Bambu's mc_percent is real-time-based and keeps ticking
    // during the 30-60s physical swap even though gcode position barely
    // advances. Letting the sync run during swaps fast-forwards us past
    // the swap point and onto the wrong object on multi-color prints.
    if (subStage !== 0) {
      // Discard any in-flight calibration sample — it would otherwise mix
      // swap-time wall seconds into the gcode-time-per-wall-time estimate
      // and tank the speed factor.
      lastMcPctChangeWall = null;
      lastMcPctChangeValue = null;
      return;
    }

    const modelToParsed = (n) => Math.min(totalLayers, n + modelLayerOffset);
    const target = state === 'FINISH'
      ? (Number(print.total_layer_num) ? modelToParsed(Number(print.total_layer_num)) : (layerNum || totalLayers))
      : modelToParsed(layerNum);
    advanceTo(target);

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
    setOverlay(`status poll failed: ${e.message}`, 'error');
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
