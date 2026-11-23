import * as THREE from '../../vendor/three.module.js';

// Keep the tip-side path readable at normal widget zoom. The physical and
// chord limits bound the accent when the camera is far away or the path is
// made of very small segments.
export const RECENT_DEPOSITION_SEGMENTS = 512;
const TARGET_SCREEN_LENGTH = 34;
const MAX_PATH_LENGTH = 48;
const JOIN_TOLERANCE = 0.0005;

export function createRecentDepositionPath(camera, modelMatrix, width, height, tip = null) {
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (modelMatrix) matrix.multiply(modelMatrix);
  const segments = [];
  const start = new THREE.Vector4();
  const end = new THREE.Vector4();
  let remaining = MAX_PATH_LENGTH;
  let pixels = TARGET_SCREEN_LENGTH;
  let following = tip;

  return {
    // Feed real segments from the tip backward. Stop at the first gap rather
    // than connecting two extrusion moves across intervening travel.
    add(from, to, color) {
      if (!from.every(Number.isFinite) || !to.every(Number.isFinite)) return false;
      if (following && Math.hypot(following[0] - to[0], following[1] - to[1], following[2] - to[2]) > JOIN_TOLERANCE) {
        return false;
      }
      const length = Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
      if (length === 0) return true;
      start.set(from[0], from[1], from[2], 1).applyMatrix4(matrix);
      end.set(to[0], to[1], to[2], 1).applyMatrix4(matrix);
      if (!(start.w > 0 && end.w > 0)) return false;
      const projected = Math.hypot(
        (start.x / start.w - end.x / end.w) * width / 2,
        (start.y / start.w - end.y / end.w) * height / 2,
      );
      if (!Number.isFinite(projected)) return false;

      const screenPortion = projected > pixels ? pixels / projected : 1;
      // Convert the screen-space clip to a point on the actual 3D chord.
      const pathPortion = screenPortion * end.w / ((1 - screenPortion) * start.w + screenPortion * end.w);
      const portion = Math.min(1, remaining / length, pathPortion);
      const tail = portion === 1 ? from : to.map((value, axis) => value + (from[axis] - value) * portion);
      segments.push({ from: tail, to, color });
      following = from;
      remaining -= length;
      pixels -= projected;
      return remaining > 0 && pixels > 0 && segments.length < RECENT_DEPOSITION_SEGMENTS;
    },
    segments: () => segments.slice().reverse(),
  };
}
