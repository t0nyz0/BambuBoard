const pathStart = 45;
const pathEnd = 225;
const pathStartY = 106;
const travelEndY = 148;
const activeLayer = 8;
const layerCount = 9;
const activeZ = activeLayer * 0.2;
const chordSteps = [0.08, 0.29, 0.13, 0.34, 0.07, 0.21, 0.38, 0.15, 0.23];
const trim = value => Number(value.toFixed(4));

function curveY(x) {
  const distance = x - pathStart;
  return pathStartY + 0.018 * distance + 0.19 * Math.sin(distance * 1.45) + 0.12 * Math.sin(distance * 4.7);
}

function chordPath() {
  const points = [[pathStart, pathStartY, activeZ]];
  let x = pathStart;
  let i = 0;
  while (x < pathEnd) {
    x = Math.min(pathEnd, trim(x + chordSteps[i++ % chordSteps.length]));
    points.push([x, trim(curveY(x)), activeZ]);
  }
  return points;
}

const trace = chordPath();
const travelStartY = trace.at(-1)[1];

function fixture() {
  const header = 'G90\nM83\n' + 'M400\n'.repeat(200_001);
  const raster = Array.from({ length: 487 }, (_, row) => {
    const y = trim(35 + row * 0.34);
    return `G0 X45 Y${y}\nG1 X225 E1\n`;
  }).join('');
  const active = trace.slice(1).map(([x, y]) => `G1 X${x} Y${y} E0.06\n`).join('');
  return Buffer.from(header + Array.from({ length: layerCount }, (_, i) => {
    const layer = i + 1;
    const z = (layer * 0.2).toFixed(1);
    const marker = `; CHANGE_LAYER\n; Z_HEIGHT: ${z}\n; layer num/total_layer_count: ${layer}/${layerCount}\n`;
    if (layer === activeLayer) {
      return marker + `G0 X${pathStart} Y${pathStartY} Z${z} F60\n` + active +
        `G0 Y${travelEndY}\nG1 X45 E1\n`;
    }
    return marker + `G0 Z${z} F6000\n` + raster + `G0 X${pathStart} Y${pathStartY}\n`;
  }).join(''));
}

module.exports = { trace, fixture, pathEnd, travelStartY, activeLayer, layerCount };
