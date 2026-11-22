import * as THREE from '../../vendor/three.module.js';

const MAX_CACHE_PIXELS = 1920 * 1080;
const NOZZLE_LAYER = 1;

export function createPackedNozzleRenderer(preview, nozzle, { lights = [], extras = [] } = {}) {
  const { renderer, scene, camera } = preview;
  const bufferSize = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, {
    colorSpace: renderer.outputColorSpace,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  const material = new THREE.ShaderMaterial({
    uniforms: {
      cachedColor: { value: target.texture },
      cachedDepth: { value: target.depthTexture },
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
      varying vec2 screenUv;
      void main() {
        gl_FragColor = texture2D( cachedColor, screenUv );
        #include <colorspace_fragment>
        gl_FragDepth = texture2D( cachedDepth, screenUv ).r;
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

  let cached = false, available = true;
  let staticDraws = 0, compositeDraws = 0, nozzleDraws = 0, staticLines = 0;
  function invalidate() {
    cached = false;
  }

  function resizeCache() {
    renderer.getDrawingBufferSize(bufferSize);
    const width = bufferSize.x, height = bufferSize.y;
    if (width < 1 || height < 1) return false;
    const edge = renderer.capabilities.maxTextureSize;
    const scale = Math.min(1, edge / width, edge / height, Math.sqrt(MAX_CACHE_PIXELS / (width * height)));
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
      invalidate();
    }
    return true;
  }

  return {
    get available() { return available; },
    draw({ refreshStatic = false, drawNozzle = true } = {}) {
      if (available && !resizeCache()) return;
      const previousTarget = renderer.getRenderTarget();
      const previousFace = renderer.getActiveCubeFace();
      const previousMipmap = renderer.getActiveMipmapLevel();
      const previousAutoClear = renderer.autoClear;
      const previousCameraLayers = camera.layers.mask;
      function drawDirect() {
        renderer.setRenderTarget(null);
        renderer.autoClear = true;
        camera.layers.mask = previousCameraLayers;
        camera.layers.disable(NOZZLE_LAYER);
        renderer.render(scene, camera);
        staticLines = renderer.info.render.lines;
        staticDraws++;
        cached = true;
      }
      function fallBackToStatic() {
        available = false;
        renderer.setRenderTarget(null);
        target.dispose();
        drawDirect();
      }
      try {
        if (!available) {
          if (!cached || refreshStatic) drawDirect();
          return;
        }
        if (!cached || refreshStatic) {
          // Static geometry and its depth are regenerated only when its
          // visible layers, camera, colors, or resolution change.
          invalidate();
          camera.layers.disable(NOZZLE_LAYER);
          renderer.autoClear = true;
          renderer.setRenderTarget(target);
          const gl = renderer.getContext();
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            fallBackToStatic();
            return;
          }
          renderer.render(scene, camera);
          staticLines = renderer.info.render.lines;
          staticDraws++;
          cached = true;
        }
        // The quad restores both color and depth, so the existing 3D nozzle
        // still interacts with the bed and printed geometry when it moves.
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
          fallBackToStatic();
          return;
        }
        compositeDraws++;
        if (drawNozzle && nozzle.visible) {
          camera.layers.set(NOZZLE_LAYER);
          renderer.render(scene, camera);
          nozzleDraws++;
        }
      } finally {
        camera.layers.mask = previousCameraLayers;
        renderer.autoClear = previousAutoClear;
        renderer.setRenderTarget(previousTarget, previousFace, previousMipmap);
      }
    },
    invalidate,
    stats: () => ({
      staticDraws, compositeDraws, nozzleDraws, staticLines,
      cacheWidth: target.width, cacheHeight: target.height,
      cacheBytes: available ? target.width * target.height * 8 : 0,
    }),
    dispose() {
      for (const [object, layers] of savedLayers) object.layers.mask = layers;
      savedLayers.clear();
      geometry.dispose();
      material.dispose();
      target.dispose();
    },
  };
}
