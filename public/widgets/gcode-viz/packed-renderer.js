import * as THREE from '../../vendor/three.module.js';
import { PreviewWorkloadError } from './preview-workload.js';

function colorTable(palette) {
  const defaults = new THREE.Color('hotpink');
  return Array.from({ length: 256 }, (_, tool) => {
    const color = (Array.isArray(palette) ? palette[tool] : palette) || defaults;
    return [color.r, color.g, color.b].map(value => Math.round(Math.max(0, Math.min(1, value)) * 255));
  });
}

function fillColors(colors, tools, table) {
  for (let index = 0; index < tools.length; index++) {
    const [r, g, b] = table[tools[index]];
    const at = index * 6;
    colors[at] = colors[at + 3] = r;
    colors[at + 1] = colors[at + 4] = g;
    colors[at + 2] = colors[at + 5] = b;
  }
}

export async function buildPackedRenderer(data, preview, bed, signal, yieldTask, onProgress) {
  const group = new THREE.Group();
  group.name = 'packed-toolpath';
  group.rotation.x = -Math.PI / 2;
  group.position.set(-bed.x / 2, 0, bed.y / 2);
  const staging = new THREE.Scene();
  const material = new THREE.LineBasicMaterial({ vertexColors: true });
  const batches = [];
  let visibleSegments = 0, visibleBatches = 0, paletteRevision = 0;
  let table = colorTable(preview.extrusionColor);
  const dispose = () => {
    group.removeFromParent();
    for (const { lines } of batches) lines.geometry.dispose();
    staging.clear();
    group.clear();
    material.dispose();
  };

  try {
    for (const { positions, start, count, tools } of data.chunks) {
      signal.throwIfAborted();
      const geometry = new THREE.BufferGeometry();
      const lines = new THREE.LineSegments(geometry, material);
      const ids = tools.subarray(0, count);
      const colors = new Uint8Array(count * 6);
      batches.push({ lines, start, count, ids, colors });
      fillColors(colors, ids, table);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, count * 6), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
      // Issue the upload on the existing WebGL context in small pieces.
      // Nothing from the new job is shown until all its chunks are ready.
      geometry.computeBoundingSphere();
      geometry.setDrawRange(0, 0);
      lines.frustumCulled = false;
      staging.add(lines);
      preview.renderer.render(staging, preview.camera);
      lines.frustumCulled = true;
      group.add(lines);
      onProgress(batches.length, data.chunks.length);
      if (batches.length % 4 === 0) await yieldTask();
    }
    signal.throwIfAborted();
    const gl = preview.renderer.getContext();
    if (gl.getError() === gl.OUT_OF_MEMORY) {
      throw new PreviewWorkloadError('This viewer ran out of graphics memory while preparing the plate.');
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    group,
    bounds: data.bounds,
    get paletteRevision() { return paletteRevision; },
    colorForTool: tool => table[tool] ?? table[0],
    layerRange(index) {
      const layer = data.layers[index];
      if (!layer) return null;
      return { start: data.layers[index - 1]?.end ?? 0, end: layer.end };
    },
    depositionBatches(start, end, limit) {
      const items = [];
      if (start >= end || limit <= 0) return { items, end: start };
      let lo = 0, hi = batches.length;
      while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        const batch = batches[middle];
        if (batch.start + batch.count <= start) lo = middle + 1;
        else hi = middle;
      }
      let reached = start;
      for (let i = lo; i < batches.length && items.length < limit; i++) {
        const batch = batches[i];
        if (batch.start >= end) break;
        const from = Math.max(start, batch.start);
        const to = Math.min(end, batch.start + batch.count);
        if (to <= from) continue;
        items.push({ geometry: batch.lines.geometry, material, start: (from - batch.start) * 2, count: (to - from) * 2 });
        reached = to;
      }
      return { items, end: reached };
    },
    show(layer) {
      visibleSegments = data.layers[layer - 1]?.end || 0;
      visibleBatches = 0;
      for (const { lines, start, count } of batches) {
        const shown = Math.max(0, Math.min(count, visibleSegments - start));
        lines.visible = shown > 0;
        if (lines.visible) visibleBatches++;
        lines.geometry.setDrawRange(0, shown * 2);
      }
    },
    setPalette(palette) {
      table = colorTable(palette);
      paletteRevision++;
      for (const { lines, ids, colors } of batches) {
        fillColors(colors, ids, table);
        lines.geometry.attributes.color.needsUpdate = true;
      }
    },
    stats: () => ({
      segments: data.segmentCount,
      layers: data.layers.length,
      bytes: batches.reduce((sum, batch) =>
        sum + batch.ids.buffer.byteLength + batch.colors.byteLength + batch.lines.geometry.attributes.position.array.buffer.byteLength, 0),
      drawCalls: visibleBatches,
      visibleSegments,
    }),
    dispose,
  };
}
