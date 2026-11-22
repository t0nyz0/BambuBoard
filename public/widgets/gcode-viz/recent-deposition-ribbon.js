import * as THREE from '../../vendor/three.module.js';

export const RECENT_DEPOSITION_LENGTH = 16; // mm measured along the laid path
export const RECENT_DEPOSITION_SEGMENTS = 96;
const HALF_WIDTH = 3; // CSS pixels, including the contrasting edge

export function createRecentDepositionRibbon() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0,
  ], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.instanceCount = 0;
  const attribute = name => {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(RECENT_DEPOSITION_SEGMENTS * 3), 3)
      .setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, buffer);
    return buffer;
  };
  const start = attribute('segmentStart');
  const end = attribute('segmentEnd');
  const color = attribute('filamentColor');

  const viewport = new THREE.Vector2(1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      viewport: { value: viewport },
      halfWidth: { value: HALF_WIDTH },
    },
    vertexShader: `
      attribute vec3 segmentStart;
      attribute vec3 segmentEnd;
      attribute vec3 filamentColor;
      uniform vec2 viewport;
      uniform float halfWidth;
      varying vec3 toolColor;
      varying float edgeDistance;
      void main() {
        vec4 viewFrom = modelViewMatrix * vec4(segmentStart, 1.0);
        vec4 viewTo = modelViewMatrix * vec4(segmentEnd, 1.0);
        vec4 from = projectionMatrix * viewFrom;
        vec4 to = projectionMatrix * viewTo;
        vec2 heading = (to.xy / max(to.w, 0.00001) - from.xy / max(from.w, 0.00001)) * viewport;
        float span = length(heading);
        vec2 side = span > 0.001 ? vec2(-heading.y, heading.x) / span : vec2(0.0, 1.0);
        vec2 offset = (2.0 * halfWidth * position.y) * side / viewport;
        vec4 viewCenter = mix(viewFrom, viewTo, position.x);
        vec4 center = mix(from, to, position.x);
        vec3 delta = vec3(offset.x / projectionMatrix[0][0], offset.y / projectionMatrix[1][1], 0.0);

        // Keep the apparent width stable without floating the edges toward
        // the camera at shallow angles. Reproject on the horizontal plane
        // through each path endpoint so a higher surface still occludes it.
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
        toolColor = filamentColor;
        edgeDistance = position.y;
      }
    `,
    fragmentShader: `
      varying vec3 toolColor;
      varying float edgeDistance;
      void main() {
        float edge = abs(edgeDistance);
        float luminance = dot(toolColor, vec3(0.2126, 0.7152, 0.0722));
        vec3 outline = luminance > 0.20 ? vec3(0.025) : vec3(0.72);
        vec3 color = mix(toolColor, outline, smoothstep(0.46, 0.58, edge));
        gl_FragColor = vec4(color, 1.0 - smoothstep(0.78, 1.0, edge));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 998;
  mesh.visible = false;

  return {
    mesh,
    setViewport(width, height) {
      viewport.set(Math.max(1, width), Math.max(1, height));
    },
    setSegments(segments) {
      let count = 0;
      for (const { from, to, color: rgb } of segments) {
        if (count >= RECENT_DEPOSITION_SEGMENTS) break;
        if (!from.every(Number.isFinite) || !to.every(Number.isFinite) || !rgb.every(Number.isFinite) ||
            from.every((value, axis) => value === to[axis])) continue;
        start.array.set(from, count * 3);
        end.array.set(to, count * 3);
        color.array.set(rgb, count * 3);
        count++;
      }
      mesh.visible = count > 0;
      geometry.instanceCount = count;
      if (count > 0) {
        for (const buffer of [start, end, color]) {
          buffer.clearUpdateRanges();
          buffer.addUpdateRange(0, count * 3);
          buffer.needsUpdate = true;
        }
      }
      return count;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
