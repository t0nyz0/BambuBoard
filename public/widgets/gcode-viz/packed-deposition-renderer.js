import * as THREE from '../../vendor/three.module.js';
import { createRecentDepositionRibbon } from './recent-deposition-ribbon.js';
import { createHotDepositionHistory } from './hot-deposition-history.js';

const BATCHES_PER_FRAME = 2;

function matchesView(a, b) {
  return a.projectionMatrix.equals(b.projectionMatrix) && a.matrixWorld.equals(b.matrixWorld);
}

function copyTransform(target, source) {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
}

function readCompletedDeposition(packed, start, end) {
  const { items, end: reached } = packed.depositionBatches(start, end, end - start);
  if (reached !== end) return null;
  const segments = [];
  const xyz = (attribute, vertex) => [attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex)];
  for (const item of items) {
    const positions = item.geometry.getAttribute('position');
    const colors = item.geometry.getAttribute('color');
    for (let vertex = item.start; vertex < item.start + item.count; vertex += 2) {
      segments.push({ from: xyz(positions, vertex), to: xyz(positions, vertex + 1), color: xyz(colors, vertex) });
    }
  }
  return segments;
}

export function createPackedDepositionRenderer(renderer, packed) {
  const active = new THREE.WebGLRenderTarget(1, 1, {
    colorSpace: renderer.outputColorSpace,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  const activeScene = new THREE.Scene();
  const activeGroup = new THREE.Group();
  copyTransform(activeGroup, packed.group);
  activeScene.add(activeGroup);

  const partialScene = new THREE.Scene();
  const partialGeometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Uint8Array(6), 3, true).setUsage(THREE.DynamicDrawUsage);
  partialGeometry.setAttribute('position', positions);
  partialGeometry.setAttribute('color', colors);
  const partialMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  const partialLine = new THREE.LineSegments(partialGeometry, partialMaterial);
  partialLine.frustumCulled = false;
  copyTransform(partialLine, packed.group);
  partialScene.add(partialLine);

  const highlightScene = new THREE.Scene();
  const highlight = createRecentDepositionRibbon({ thermal: true });
  const history = createHotDepositionHistory(
    (start, end) => readCompletedDeposition(packed, start, end),
    tool => packed.colorForTool(tool).map(component => component / 255),
  );
  copyTransform(highlight.mesh, packed.group);
  highlightScene.add(highlight.mesh);

  let cache = null;
  let displayed = null;
  let visible = false;
  let partial = null;
  let partialDrawn = false;
  let pending = false;
  let ready = true;
  let draws = 0;
  let segmentsDrawn = 0;
  let heatAt = 0;
  let recentSegments = 0;
  let highlightDraws = 0;

  function cacheMatches(display) {
    return cache && display?.view && cache.start === display.end &&
      cache.palette === display.palette && active.width === display.size[0] &&
      active.height === display.size[1] && matchesView(cache.view, display.view);
  }

  function append(view, start, end) {
    const next = packed.depositionBatches(start, end, BATCHES_PER_FRAME);
    const oldRanges = [];
    try {
      for (const [index, item] of next.items.entries()) {
        let proxy = activeGroup.children[index];
        if (!proxy) {
          proxy = new THREE.LineSegments(item.geometry, item.material);
          activeGroup.add(proxy);
        }
        proxy.geometry = item.geometry;
        proxy.material = item.material;
        proxy.visible = true;
        const range = { ...item.geometry.drawRange };
        oldRanges.push([item.geometry, range]);
        item.geometry.setDrawRange(item.start, item.count);
      }
      for (let index = next.items.length; index < activeGroup.children.length; index++) {
        activeGroup.children[index].visible = false;
      }
      if (next.items.length) {
        renderer.render(activeScene, view);
        draws++;
        segmentsDrawn += next.end - start;
      }
      return next.end;
    } finally {
      for (const [geometry, range] of oldRanges) geometry.setDrawRange(range.start, range.count);
    }
  }

  return {
    get building() { return pending; },
    get ready() { return ready; },
    get visible() { return visible; },
    get hasRecent() { return history.size > 0; },
    target: active,
    update(deposition, display, matchesCurrent, holdDisplayed) {
      pending = false;
      partial = null;
      partialDrawn = false;
      history.update(deposition);
      if (Number.isFinite(deposition?.at)) heatAt = deposition.at;
      recentSegments = 0;
      displayed = null;
      ready = !deposition;
      const matches = cacheMatches(display);
      if (!deposition) {
        if (!holdDisplayed || !matches) cache = null;
        visible = Boolean(cache && cache.end > cache.start);
        displayed = visible ? cache : null;
        return true;
      }

      // Keep the old coherent plate while a new static prefix or view
      // builds. Only render current motion over the requested background.
      if (!matchesCurrent || deposition.start !== display.end || packed.paletteRevision !== display.palette) {
        visible = Boolean(matches && cache.end > cache.start);
        displayed = visible ? cache : null;
        return true;
      }

      const end = Math.max(deposition.start, deposition.end);
      const reset = !matches || end < cache.end;
      if (reset) cache = { start: deposition.start, end: deposition.start, palette: display.palette, view: display.view };
      if (end > cache.end) {
        active.setSize(...display.size);
        renderer.setRenderTarget(active);
        const gl = renderer.getContext();
        if (reset) {
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
          const clearAlpha = renderer.getClearAlpha();
          renderer.setClearAlpha(0);
          try { renderer.clear(true, true, false); }
          finally { renderer.setClearAlpha(clearAlpha); }
        }
        renderer.autoClear = false;
        cache.end = append(display.view, cache.end, end);
        pending = cache.end < end;
      } else if (reset) {
        // No allocated pixels are needed for the initial empty prefix.
        // Force initialization before its first addition.
        cache = null;
      }

      ready = !pending;
      partial = ready && deposition.partial?.from.every(Number.isFinite) &&
        deposition.partial.to.every(Number.isFinite) ? deposition.partial : null;
      visible = Boolean(cache && cache.end > cache.start);
      displayed = { start: deposition.start, end: visible ? cache.end : deposition.start };
      return true;
    },
    drawPartial(view) {
      if (!partial) return;
      const color = packed.colorForTool(partial.tool);
      positions.array.set(partial.from, 0);
      positions.array.set(partial.to, 3);
      colors.array.set(color, 0);
      colors.array.set(color, 3);
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      renderer.render(partialScene, view);
      partialDrawn = true;
    },
    drawRecent(view, width, height, occlusion) {
      if (!history.size) return;
      highlight.setViewport(width, height);
      highlight.setOcclusion(occlusion);
      highlight.setElapsed(heatAt);
      recentSegments = highlight.setSegments(history.segments());
      if (!recentSegments) return;
      renderer.render(highlightScene, view);
      highlightDraws++;
    },
    stats: () => ({
      depositionStart: displayed?.start ?? null,
      depositedSegments: displayed ? displayed.end - displayed.start : 0,
      depositedEnd: displayed?.end ?? null,
      depositionReady: ready,
      depositionDraws: draws,
      depositionSegmentsDrawn: segmentsDrawn,
      partialDeposited: partialDrawn,
      recentDepositedSegments: recentSegments,
      highlightDraws,
      depositionCacheBytes: active.width * active.height * 8,
    }),
    dispose() {
      active.dispose();
      activeGroup.clear();
      highlight.dispose();
      partialGeometry.dispose();
      partialMaterial.dispose();
    },
  };
}
