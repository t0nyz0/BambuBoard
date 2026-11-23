const pathStart = 46;
const pathEnd = 206;
const firstY = 103;
const secondY = 142;
const activeLayer = 6;
const layerCount = 7;
const z = activeLayer * 0.2;
const firstFeedMmPerSecond = 50;
const retractLength = 2;
const renderPace = 1.25;

function fixture() {
  const header = 'G90\nM83\n' + 'M400\n'.repeat(200_001);
  const raster = Array.from({ length: 340 }, (_, row) =>
    `G0 X45 Y${(38 + row * 0.44).toFixed(2)}\nG1 X226 E1\n`).join('');
  const firstPath = Array.from({ length: pathEnd - pathStart }, (_, i) =>
    `G1 X${pathStart + i + 1} E0.04 F3000\n`).join('');
  const secondPath = Array.from({ length: pathEnd - pathStart }, (_, i) =>
    `G1 X${pathEnd - i - 1} E0.04 F60\n`).join('');
  return Buffer.from(header + Array.from({ length: layerCount }, (_, i) => {
    const layer = i + 1;
    const height = (layer * 0.2).toFixed(1);
    const marker = `; CHANGE_LAYER\n; Z_HEIGHT: ${height}\n; layer num/total_layer_count: ${layer}/${layerCount}\n`;
    if (layer === activeLayer) {
      return marker + `G0 X${pathStart} Y${firstY} Z${height} F6000\n` + firstPath +
        `G1 E-${retractLength} F60\nG0 Y${secondY} F60\nG1 E${retractLength} F60\n` + secondPath;
    }
    return marker + `G0 Z${height} F6000\n` + raster + `G0 X${pathStart} Y${firstY} F6000\n`;
  }).join(''));
}

module.exports = {
  fixture, pathStart, pathEnd, firstY, secondY, activeLayer, layerCount, z,
  firstFeedMmPerSecond, retractLength, renderPace,
};
