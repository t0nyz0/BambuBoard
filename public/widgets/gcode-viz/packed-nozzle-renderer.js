import * as THREE from '../../vendor/three.module.js';
import { createPackedDepositionRenderer } from './packed-deposition-renderer.js';

const MAX_CACHE_PIXELS = 1920 * 1080;
const NOZZLE_LAYER = 1;
const CHUNKS_PER_FRAME = 2;

export function createPackedNozzleRenderer(preview, nozzle, { lights = [], extras = [], packed } = {}) {
  const { renderer, scene, camera } = preview;
  const bufferSize = new THREE.Vector2();
  const logicalSize = new THREE.Vector2();
  const createTarget = () => new THREE.WebGLRenderTarget(1, 1, {
    colorSpace: renderer.outputColorSpace,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  let front = createTarget();
  let back = createTarget();
  let depositionRenderer = packed ? createPackedDepositionRenderer(renderer, packed) : null;
  let opaqueDepth = packed ? new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RedFormat,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  }) : null;
  let opaqueView = null;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      cachedColor: { value: front.texture },
      cachedDepth: { value: front.depthTexture },
      showDeposition: { value: false },
      depositedColor: { value: null },
      depositedDepth: { value: null },
    },
    vertexShader: `
      varying vec2 screenUv;
      void main() {
        screenUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: `
      uniform sampler2D cachedColor;
      uniform sampler2D cachedDepth;
      uniform bool showDeposition;
      uniform sampler2D depositedColor;
      uniform sampler2D depositedDepth;
      varying vec2 screenUv;
      void main() {
        vec4 color = texture2D( cachedColor, screenUv );
        float depth = texture2D( cachedDepth, screenUv ).r;
        if ( showDeposition ) {
          vec4 filament = texture2D( depositedColor, screenUv );
          float filamentDepth = texture2D( depositedDepth, screenUv ).r;
          if ( filament.a > 0.0 && filamentDepth <= depth ) {
            color = filament;
            depth = filamentDepth;
          }
        }
        gl_FragColor = color;
        #include <colorspace_fragment>
        gl_FragDepth = depth;
      }
    `,
    blending: THREE.NoBlending,
    depthFunc: THREE.AlwaysDepth,
    toneMapped: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const screen = new THREE.Mesh(geometry, material);
  screen.frustumCulled = false;
  const composite = new THREE.Scene();
  composite.add(screen);
  const screenCamera = new THREE.Camera();
  const savedLayers = new Map();
  for (const root of [nozzle, ...extras]) {
    root.traverse(object => {
      if (!savedLayers.has(object)) savedLayers.set(object, object.layers.mask);
      object.layers.set(NOZZLE_LAYER);
    });
  }
  for (const light of lights) {
    if (!savedLayers.has(light)) savedLayers.set(light, light.layers.mask);
    light.layers.enable(NOZZLE_LAYER);
  }

  let dirty = true, available = true, hasFront = false;
  let building = null, pending = null, requestedSize = null;
  let frontView = null, frontEnd = 0, frontPalette;
  let staticDraws = 0, compositeDraws = 0, nozzleDraws = 0, staticLines = 0;

  function displaySize() {
    renderer.getDrawingBufferSize(bufferSize);
    const width = bufferSize.x, height = bufferSize.y;
    const edge = renderer.capabilities.maxTextureSize;
    const scale = Math.min(1, edge / width, edge / height, Math.sqrt(MAX_CACHE_PIXELS / (width * height)));
    return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
  }

  function snapshot(size) {
    const group = scene.getObjectByName('packed-toolpath');
    scene.updateMatrixWorld();
    camera.updateWorldMatrix(true, false);
    const view = camera.clone();
    // Preserve the world pose exactly even if the scene camera is parented.
    view.matrixWorldAutoUpdate = false;
    const children = group?.children ?? [];
    const projection = new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    const center = new THREE.Vector4();
    const items = [];
    let lines = 0;
    for (const object of children) {
      if (!object.visible) continue;
      const { geometry } = object;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const { start, count } = geometry.drawRange;
      const depth = center.copy(geometry.boundingSphere.center).applyMatrix4(object.matrixWorld).applyMatrix4(projection).z;
      items.push({ object, start, count, depth, colorVersion: geometry.getAttribute('color')?.version });
      lines += count / 2;
    }
    // Packed batches use one opaque line material. Preserve Three's depth
    // ordering for ties at the same raster depth, even across slices.
    if (renderer.sortObjects) {
      items.sort((a, b) => a.object.renderOrder - b.object.renderOrder ||
        a.object.material.id - b.object.material.id || a.depth - b.depth || a.object.id - b.object.id);
    }
    return { size, view, group, items, lines, palette: packed?.paletteRevision, index: 0, processed: 0, rendered: 0 };
  }

  function renderSlice(job, direct = false) {
    const { items, view, group } = job;
    const first = job.index === 0;
    const end = Math.min(items.length, job.index + CHUNKS_PER_FRAME);
    const oldMask = view.layers.mask;
    const restored = [];
    const setVisible = (object, value) => {
      if (object.visible === value) return;
      restored.push(() => { object.visible = !value; });
      object.visible = value;
    };
    let lines = 0;
    try {
      view.layers.disable(NOZZLE_LAYER);
      renderer.autoClear = first;
      renderer.setRenderTarget(direct ? null : back);

      const selected = new Set(items.slice(job.index, end).map(item => item.object));
      for (const object of group?.children ?? []) setVisible(object, selected.has(object));
      for (const { object, start, count } of items.slice(job.index, end)) {
        const { geometry } = object;
        const range = { ...geometry.drawRange };
        restored.push(() => { geometry.setDrawRange(range.start, range.count); });
        geometry.setDrawRange(start, count);
        lines += count / 2;
      }
      if (!first) {
        // Preserve the bed and lighting from the first slice. Subsequent
        // draws accumulate only packed lines against the existing depth.
        for (const child of scene.children) {
          if (child !== group && !child.isLight) setVisible(child, false);
        }
      }
      renderer.render(scene, view);
    } finally {
      for (let i = restored.length - 1; i >= 0; i--) restored[i]();
      view.layers.mask = oldMask;
    }
    job.index = end;
    job.processed += lines;
    job.rendered += renderer.info.render.lines;
  }

  function beadOcclusion(view, shown) {
    if (!opaqueDepth) return null;
    if (opaqueView !== view || opaqueDepth.width !== shown.width || opaqueDepth.height !== shown.height) {
      opaqueDepth.setSize(shown.width, shown.height);
      renderer.setRenderTarget(opaqueDepth);
      const gl = renderer.getContext();
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        opaqueDepth.dispose();
        opaqueDepth = null;
        return null;
      }
      // Retain a depth-only view of the bed and all external scene
      // objects. They need strict occlusion even where wide, same-plane
      // GL_LINES call for a limited raster tolerance.
      const group = scene.getObjectByName('packed-toolpath');
      const previousVisibility = group?.visible;
      const oldMask = view.layers.mask;
      try {
        if (group) group.visible = false;
        view.layers.disable(NOZZLE_LAYER);
        renderer.autoClear = true;
        renderer.render(scene, view);
      } finally {
        if (group) group.visible = previousVisibility;
        view.layers.mask = oldMask;
      }
      opaqueView = view;
    }
    return {
      opaque: opaqueDepth.depthTexture,
      plate: shown.depthTexture,
      deposition: depositionRenderer.visible ? depositionRenderer.target.depthTexture : shown.depthTexture,
      width: shown.width,
      height: shown.height,
      bufferWidth: bufferSize.x,
      bufferHeight: bufferSize.y,
      projectionMatrix: view.projectionMatrix,
    };
  }

  function complete(job, direct = false) {
    staticDraws++;
    staticLines = job.rendered;
    frontView = job.view;
    frontEnd = job.lines;
    frontPalette = job.palette;
    if (!direct) [front, back] = [back, front];
    hasFront = true;
    building = null;
  }

  function useDirectFallback(job) {
    available = false;
    renderer.setRenderTarget(null);
    front.dispose();
    back.dispose();
    depositionRenderer?.dispose();
    depositionRenderer = null;
    opaqueDepth?.dispose();
    opaqueDepth = null;
    hasFront = false;
    // The widget's renderer preserves its drawing buffer. In that mode a
    // device that rejects the depth target can still show exact slices.
    if (renderer.getContext().getContextAttributes()?.preserveDrawingBuffer) {
      building = { ...job, index: 0, processed: 0, rendered: 0 };
      renderSlice(building, true);
      if (building.index === building.items.length) complete(building, true);
    } else {
      renderer.autoClear = true;
      const oldMask = job.view.layers.mask;
      try {
        job.view.layers.disable(NOZZLE_LAYER);
        renderer.render(scene, job.view);
        job.rendered = renderer.info.render.lines;
      } finally {
        job.view.layers.mask = oldMask;
      }
      complete(job, true);
    }
  }

  return {
    get available() { return available; },
    get building() { return Boolean(building || pending || depositionRenderer?.building); },
    draw({ refreshStatic = false, drawNozzle = true, deposition = null } = {}) {
      const size = displaySize();
      if (bufferSize.x < 1 || bufferSize.y < 1) return;
      const previousTarget = renderer.getRenderTarget();
      const previousFace = renderer.getActiveCubeFace();
      const previousMipmap = renderer.getActiveMipmapLevel();
      const previousAutoClear = renderer.autoClear;

      try {
        const sizeChanged = !requestedSize || size[0] !== requestedSize[0] || size[1] !== requestedSize[1];
        const recolored = building?.items.some(({ object, colorVersion }) =>
          object.geometry.getAttribute('color')?.version !== colorVersion);
        if (recolored) {
          // Color buffers are shared with the visible toolpath. A newer
          // palette invalidates incomplete pixels but leaves front intact.
          building = null;
        }
        if (dirty || refreshStatic || sizeChanged || recolored) {
          pending = snapshot(size);
          requestedSize = size;
          dirty = false;
        }
        if (!building && pending) {
          building = pending;
          pending = null;
          if (available) {
            back.setSize(...building.size);
            renderer.setRenderTarget(back);
            const gl = renderer.getContext();
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
              useDirectFallback(building);
              return;
            }
          }
        }
        if (building) {
          renderSlice(building, !available);
          if (building.index === building.items.length) complete(building, !available);
        }
        if (!available) return;

        // Publish accurate partial geometry only for a cold start. When
        // rebuilding, keep the last completed color and depth buffer on
        // screen until its replacement is fully drawn.
        const shown = hasFront ? front : back;
        const view = hasFront ? frontView : building?.view;
        const display = {
          view, end: hasFront ? frontEnd : building?.lines,
          palette: hasFront ? frontPalette : building?.palette,
          size: [shown.width, shown.height],
        };
        camera.updateWorldMatrix(true, false);
        // Draw moving geometry against the same projection and pixel
        // dimensions that produced the displayed color and depth.
        const matchesCurrent = view && shown.width === size[0] && shown.height === size[1] &&
          view.projectionMatrix.equals(camera.projectionMatrix) && view.matrixWorld.equals(camera.matrixWorld);
        if (depositionRenderer && !depositionRenderer.update(deposition, display, matchesCurrent, Boolean(building || pending))) {
          useDirectFallback(building ?? snapshot(size));
          return;
        }
        const showBead = matchesCurrent && deposition && deposition.highlight !== false &&
          (deposition.partial || deposition.end > deposition.start) &&
          drawNozzle && nozzle.visible && depositionRenderer?.ready;
        const occlusion = showBead ? beadOcclusion(view, shown) : null;
        material.uniforms.cachedColor.value = shown.texture;
        material.uniforms.cachedDepth.value = shown.depthTexture;
        material.uniforms.showDeposition.value = Boolean(depositionRenderer?.visible);
        material.uniforms.depositedColor.value = depositionRenderer?.target.texture ?? null;
        material.uniforms.depositedDepth.value = depositionRenderer?.target.depthTexture ?? null;
        renderer.setRenderTarget(null);
        renderer.autoClear = false;
        const previousShaderError = renderer.debug.onShaderError;
        let failedShader = false;
        renderer.debug.onShaderError = (...args) => {
          failedShader = true;
          previousShaderError?.(...args);
        };
        try { renderer.render(composite, screenCamera); }
        finally { renderer.debug.onShaderError = previousShaderError; }
        if (failedShader) {
          useDirectFallback(building ?? snapshot(size));
          return;
        }
        compositeDraws++;

        if (matchesCurrent) {
          depositionRenderer?.drawPartial(view);
          if (showBead) {
            renderer.getSize(logicalSize);
            depositionRenderer.drawRecent(view, logicalSize.x, logicalSize.y, occlusion);
          }
          if (drawNozzle && nozzle.visible && (depositionRenderer?.ready ?? true)) {
            const oldMask = view.layers.mask;
            try {
              view.layers.set(NOZZLE_LAYER);
              renderer.render(scene, view);
              nozzleDraws++;
            } finally {
              view.layers.mask = oldMask;
            }

          }
        }
      } finally {
        renderer.autoClear = previousAutoClear;
        renderer.setRenderTarget(previousTarget, previousFace, previousMipmap);
      }
    },
    invalidate() {
      dirty = true;
      opaqueView = null;
    },
    stats() {
      const current = hasFront ? front : back;
      const deposition = depositionRenderer?.stats();
      return {
        ...deposition,
        staticDraws, compositeDraws, nozzleDraws, staticLines,
        staticReady: hasFront && !building && !pending,
        staticBuiltLines: building?.processed ?? staticLines,
        staticPendingLines: building?.lines ?? pending?.lines ?? staticLines,
        cacheWidth: current.width, cacheHeight: current.height,
        cacheBytes: available ? current.width * current.height * 8 : 0,
        totalCacheBytes: available
          ? (front.width * front.height + back.width * back.height) * 8 + (deposition?.depositionCacheBytes ?? 0) +
            (opaqueDepth ? opaqueDepth.width * opaqueDepth.height * 5 : 0)
          : 0,
      };
    },
    dispose() {
      building = null;
      pending = null;
      frontView = null;
      depositionRenderer?.dispose();
      depositionRenderer = null;
      opaqueDepth?.dispose();
      opaqueDepth = null;
      opaqueView = null;
      for (const [object, layers] of savedLayers) object.layers.mask = layers;
      savedLayers.clear();
      geometry.dispose();
      material.dispose();
      front.dispose();
      back.dispose();
    },
  };
}
