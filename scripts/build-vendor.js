// Local, deterministic assets. Versions and bytes come from package-lock.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(root, to));
copy('node_modules/jquery/dist/jquery.min.js', 'public/assets/js/jquery.min.js');
copy('node_modules/three/build/three.module.js', 'public/vendor/three.module.js');
copy('node_modules/three/build/three.core.js', 'public/vendor/three.core.js');
copy('node_modules/lil-gui/dist/lil-gui.esm.js', 'public/vendor/lil-gui.esm.js');
// Preserve the renderer's transparent canvas patch used by existing overlays.
let gcode = fs.readFileSync(path.join(root, 'node_modules/gcode-preview/dist/gcode-preview.es.js'), 'utf8');
const renderer = 'preserveDrawingBuffer:!0';
if (gcode.split(renderer).length !== 3) throw new Error('gcode-preview renderer changed; review transparency patch');
gcode = gcode.replaceAll(renderer, renderer + ',alpha:!0');
// Three r166+ separates batch geometry registration from visible instances.
if (!gcode.includes('e.addGeometry(n)')) throw new Error('Review gcode-preview BatchedMesh compatibility');
gcode = gcode.replace('e.addGeometry(n)', 'e.addInstance(e.addGeometry(n))');
fs.writeFileSync(path.join(root, 'public/vendor/gcode-preview.esm.js'), gcode);
for (const [name, dir] of [['jquery', 'public/assets/js'], ['three', 'public/vendor'], ['lil-gui', 'public/vendor'], ['gcode-preview', 'public/vendor']]) {
  const source = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(file => fs.existsSync(path.join(root, 'node_modules', name, file)));
  if (source) copy(`node_modules/${name}/${source}`, `${dir}/${name}-LICENSE.txt`);
}
const files = ['public/assets/js/jquery.min.js', 'public/assets/js/jsmpeg.min.js', 'public/vendor/three.module.js', 'public/vendor/three.core.js', 'public/vendor/lil-gui.esm.js', 'public/vendor/gcode-preview.esm.js'];
const versions = Object.fromEntries(['jquery', 'three', 'lil-gui', 'gcode-preview'].map(name => [name, require(path.join(root, 'node_modules', name, 'package.json')).version]));
const sha256 = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(path.join(root, 'public/vendor/manifest.json'), JSON.stringify({ versions, jsmpeg: { repository: 'https://github.com/phoboslab/jsmpeg', commit: '924acfbd96fdf15e6748d1368a36d79d8f4cecf6' }, patches: ['gcode-preview: WebGLRenderer alpha=true', 'gcode-preview: BatchedMesh addInstance for current Three.js'], sha256 }, null, 2) + '\n');
console.log('Bundled', versions);
