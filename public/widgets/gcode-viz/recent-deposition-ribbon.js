import * as THREE from '../../vendor/three.module.js';
import { MAX_RECENT_DEPOSITION_SEGMENTS } from './hot-deposition-history.js';
import { RECENT_DEPOSITION_SEGMENTS } from './recent-deposition-path.js';

const OUTLINE_RADIUS = 3.6; // CSS pixels
const CORE_RADIUS = 1.8;

export function createRecentDepositionRibbon({ thermal = false } = {}) {
  const capacity = thermal ? MAX_RECENT_DEPOSITION_SEGMENTS : RECENT_DEPOSITION_SEGMENTS;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0,
  ], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.instanceCount = 0;
  const attribute = (name, size) => {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size)
      .setUsage(THREE.DynamicDrawUsage);
    buffer.onUpload(() => buffer.clearUpdateRanges());
    geometry.setAttribute(name, buffer);
    return buffer;
  };
  const start = attribute('segmentStart', 3);
  const end = attribute('segmentEnd', 3);
  const color = attribute('filamentColor', 3);
  const times = thermal ? attribute('depositedAt', 2) : null;
  const attributes = thermal ? [start, end, color, times] : [start, end, color];
  const elapsed = { value: 0 };
  let previousSegments = null;

  const viewport = new THREE.Vector2(1, 1);
  const depthSize = new THREE.Vector2(1, 1);
  const bufferSize = new THREE.Vector2(1, 1);
  const depth = {
    usePackedDepth: { value: false },
    opaqueDepth: { value: null },
    plateDepth: { value: null },
    depositionDepth: { value: null },
    depthSize: { value: depthSize },
    beadProjection: { value: new THREE.Matrix4() },
    bufferSize: { value: bufferSize },
  };
  function capsule(radius, outline) {
    const material = new THREE.ShaderMaterial({
      defines: thermal ? { THERMAL_RECENT_DEPOSITION: 1 } : {},
      uniforms: { ...depth, elapsed, viewport: { value: viewport }, radius: { value: radius }, outline: { value: outline } },
      vertexShader: `
        attribute vec3 segmentStart;
        attribute vec3 segmentEnd;
        attribute vec3 filamentColor;
        #ifdef THERMAL_RECENT_DEPOSITION
          attribute vec2 depositedAt;
        #endif
        uniform vec2 viewport;
        uniform float radius;
        varying vec4 segment;
        varying vec4 endpointHeightsAndW;
        varying vec4 expanded;
        varying vec3 toolColor;
        #ifdef THERMAL_RECENT_DEPOSITION
          varying vec2 birth;
        #endif
        void main() {
          vec4 viewFrom = modelViewMatrix * vec4(segmentStart, 1.0);
          vec4 viewTo = modelViewMatrix * vec4(segmentEnd, 1.0);
          vec4 from = projectionMatrix * viewFrom;
          vec4 to = projectionMatrix * viewTo;
          vec2 a = from.xy / max(from.w, 0.00001) * 0.5 * viewport;
          vec2 b = to.xy / max(to.w, 0.00001) * 0.5 * viewport;
          vec2 heading = b - a;
          float span = length(heading);
          vec2 direction = span > 0.0001 ? heading / span : vec2(1.0, 0.0);
          vec2 side = vec2(-direction.y, direction.x);
          // Expand the bounding quad by a radius past each endpoint. The
          // fragment uses the distance to the actual segment for round joins.
          vec2 offset = 2.0 * radius * (direction * (2.0 * position.x - 1.0) + side * position.y) / viewport;
          vec4 viewCenter = mix(viewFrom, viewTo, position.x);
          vec4 center = mix(from, to, position.x);
          vec3 delta = vec3(offset.x / projectionMatrix[0][0], offset.y / projectionMatrix[1][1], 0.0);

          // Reproject each widened vertex on its endpoint's physical XY
          // plane so a thin higher surface still occludes the ribbon.
          vec3 worldUpInView = viewMatrix[1].xyz;
          gl_Position = center;
          gl_Position.xy += offset * center.w;
          if (projectionMatrix[2][3] != 0.0) {
            vec3 ray = viewCenter.xyz + delta * center.w;
            float angle = dot(worldUpInView, ray);
            if (abs(angle) > 0.00001) {
              float distance = dot(worldUpInView, viewCenter.xyz) / angle;
              if (distance > 0.0) gl_Position = projectionMatrix * vec4(ray * distance, 1.0);
            }
          } else if (abs(worldUpInView.z) > 0.00001) {
            delta.z = -dot(worldUpInView, delta) / worldUpInView.z;
            gl_Position = projectionMatrix * vec4(viewCenter.xyz + delta, 1.0);
          }
          segment = vec4(a, b);
          endpointHeightsAndW = vec4(dot(worldUpInView, viewFrom.xyz), dot(worldUpInView, viewTo.xyz), from.w, to.w);
          expanded = gl_Position;
          toolColor = filamentColor;
          #ifdef THERMAL_RECENT_DEPOSITION
            birth = depositedAt;
          #endif
        }
      `,
      fragmentShader: `
        uniform vec2 viewport;
        uniform float radius;
        uniform bool outline;
        #ifdef THERMAL_RECENT_DEPOSITION
          uniform float elapsed;
        #endif
        uniform bool usePackedDepth;
        uniform sampler2D opaqueDepth;
        uniform sampler2D plateDepth;
        uniform sampler2D depositionDepth;
        uniform vec2 depthSize;
        uniform vec2 bufferSize;
        uniform mat4 beadProjection;
        varying vec4 segment;
        varying vec4 endpointHeightsAndW;
        varying vec4 expanded;
        varying vec3 toolColor;
        #ifdef THERMAL_RECENT_DEPOSITION
          varying vec2 birth;
        #endif
        float depthOnLayer(vec2 uv, float height) {
          vec2 ndc = 2.0 * uv - 1.0;
          vec3 up = viewMatrix[1].xyz;
          vec3 point;
          if (beadProjection[2][3] != 0.0) {
            vec3 ray = vec3((ndc.x + beadProjection[2][0]) / beadProjection[0][0],
                            (ndc.y + beadProjection[2][1]) / beadProjection[1][1], -1.0);
            float angle = dot(up, ray);
            if (abs(angle) < 0.00001) return gl_FragCoord.z;
            point = ray * (height / angle);
          } else {
            if (abs(up.z) < 0.00001) return gl_FragCoord.z;
            point = vec3((ndc.x - beadProjection[3][0]) / beadProjection[0][0],
                         (ndc.y - beadProjection[3][1]) / beadProjection[1][1], 0.0);
            point.z = (height - dot(up, point)) / up.z;
          }
          vec4 clip = beadProjection * vec4(point, 1.0);
          return 0.5 + 0.5 * clip.z / clip.w;
        }

        #ifdef THERMAL_RECENT_DEPOSITION
        vec3 coolingColor(float age) {
          vec3 hot = vec3(1.0, 0.05, 0.02);
          vec3 orange = vec3(1.0, 0.45, 0.0);
          vec3 yellow = vec3(0.95, 0.85, 0.10);
          vec3 green = vec3(0.10, 0.85, 0.20);
          if (age <= 7.2) return hot;
          if (age < 28.8) return mix(hot, orange, (age - 7.2) / 21.6);
          if (age < 57.6) return mix(orange, yellow, (age - 28.8) / 28.8);
          if (age < 100.8) return mix(yellow, green, (age - 57.6) / 43.2);
          return mix(green, toolColor, clamp((age - 100.8) / 43.2, 0.0, 1.0));
        }
        #endif

        void main() {
          vec2 uv = usePackedDepth ? gl_FragCoord.xy / bufferSize : expanded.xy / expanded.w * 0.5 + 0.5;
          vec2 v = segment.zw - segment.xy;
          vec2 q = (uv - 0.5) * viewport - segment.xy;
          float along = clamp(dot(q, v) / max(dot(v, v), 0.00000001), 0.0, 1.0);
          float distance = length(q - along * v);
          float alpha = 1.0 - smoothstep(radius - 0.75, radius, distance);
          vec4 endpoints = endpointHeightsAndW;
          float fromWeight = (1.0 - along) / max(endpoints.z, 0.00001);
          float toWeight = along / max(endpoints.w, 0.00001);
          float totalWeight = fromWeight + toWeight;
          #ifdef THERMAL_RECENT_DEPOSITION
            // Interpolate when the tool laid down each point. The weights
            // undo perspective so age follows the physical chord.
            float age = max(0.0, elapsed - dot(vec2(fromWeight, toWeight), birth) / totalWeight);
            alpha *= 1.0 - smoothstep(129.6, 144.0, age);
          #endif
          if (alpha <= 0.0) discard;
          if (usePackedDepth) {
            // Evaluate the physical ribbon plane at the sampled texel, not
            // the rasterizer's interpolant for a widened subpixel chord.
            vec2 texel = (floor(uv * depthSize) + 0.5) / depthSize;
            float height = (fromWeight * endpoints.x + toWeight * endpoints.y) / totalWeight;
            float z = depthOnLayer(texel, height);
            float quantization = 1.0 / 16777215.0;
            if (z > texture2D(opaqueDepth, texel).r + quantization) discard;
            // GL_LINES can put same-plane depths slightly ahead of the
            // outline within their one-pixel raster footprint. Tolerate
            // that footprint on toolpath textures only; opaque surfaces
            // above have already been tested at full depth precision.
            float tolerance = abs(depthOnLayer(texel + vec2(1.0 / depthSize.x, 0.0), height) - z) +
              abs(depthOnLayer(texel + vec2(0.0, 1.0 / depthSize.y), height) - z) + quantization;
            if (z > min(texture2D(plateDepth, texel).r, texture2D(depositionDepth, texel).r) + tolerance) discard;
          }
          #ifdef THERMAL_RECENT_DEPOSITION
            vec3 hotColor = coolingColor(age);
            // A tinted edge keeps the rounded joins visible over the model.
            vec3 edge = mix(toolColor, hotColor, 0.78);
            gl_FragColor = vec4(outline ? edge : hotColor, outline ? alpha * 0.8 : alpha);
          #else
            float luminance = dot(toolColor, vec3(0.2126, 0.7152, 0.0722));
            vec3 edge = luminance > 0.20 ? vec3(0.025) : vec3(0.64);
            gl_FragColor = vec4(outline ? edge : toolColor, alpha);
          #endif
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = outline ? 998 : 999;
    return mesh;
  }

  // Rounded edges are drawn before the center so overlapping neighbors
  // preserve a continuous path.
  const outline = capsule(OUTLINE_RADIUS, true);
  const core = capsule(CORE_RADIUS, false);
  const mesh = new THREE.Group();
  mesh.add(outline, core);
  mesh.renderOrder = 998;
  mesh.visible = false;

  return {
    mesh,
    setViewport(width, height) {
      viewport.set(Math.max(1, width), Math.max(1, height));
    },
    setOcclusion(occlusion) {
      depth.usePackedDepth.value = Boolean(occlusion);
      outline.material.depthTest = core.material.depthTest = !occlusion;
      outline.material.polygonOffset = core.material.polygonOffset = !occlusion;
      depth.opaqueDepth.value = occlusion?.opaque ?? null;
      depth.plateDepth.value = occlusion?.plate ?? null;
      depth.depositionDepth.value = occlusion?.deposition ?? null;
      if (occlusion) {
        depthSize.set(occlusion.width, occlusion.height);
        bufferSize.set(occlusion.bufferWidth, occlusion.bufferHeight);
        depth.beadProjection.value.copy(occlusion.projectionMatrix);
      }
    },
    setElapsed(seconds) {
      if (Number.isFinite(seconds)) elapsed.value = seconds;
    },
    setSegments(segments) {
      // The caller can submit the last immutable path while only time
      // advances; this makes age-only frames a uniform update.
      if (segments === previousSegments) return geometry.instanceCount;
      previousSegments = segments;
      const changed = attributes.map(() => ({ start: Infinity, end: 0 }));
      let count = 0;
      function write(buffer, range, component, value) {
        const stored = Math.fround(value);
        const index = count * buffer.itemSize + component;
        if (buffer.array[index] === stored) return;
        buffer.array[index] = stored;
        range.start = Math.min(range.start, index);
        range.end = Math.max(range.end, index + 1);
      }
      for (const { from, to, color: rgb, fromTime, toTime } of segments) {
        if (count >= capacity) break;
        if (thermal && (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime)) continue;
        if (!from.every(Number.isFinite) || !to.every(Number.isFinite) || !rgb.every(Number.isFinite) ||
            from.every((value, axis) => value === to[axis])) continue;
        for (let axis = 0; axis < 3; axis++) {
          write(start, changed[0], axis, from[axis]);
          write(end, changed[1], axis, to[axis]);
          write(color, changed[2], axis, rgb[axis]);
        }
        if (thermal) {
          write(times, changed[3], 0, fromTime);
          write(times, changed[3], 1, toTime);
        }
        count++;
      }
      mesh.visible = count > 0;
      geometry.instanceCount = count;
      for (const [index, buffer] of attributes.entries()) {
        const { start, end } = changed[index];
        if (end > start) {
          const pending = buffer.updateRanges[0];
          const first = pending ? Math.min(start, pending.start) : start;
          const last = pending ? Math.max(end, pending.start + pending.count) : end;
          buffer.clearUpdateRanges();
          buffer.addUpdateRange(first, last - first);
          buffer.needsUpdate = true;
        }
      }
      return count;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      outline.material.dispose();
      core.material.dispose();
    },
  };
}
