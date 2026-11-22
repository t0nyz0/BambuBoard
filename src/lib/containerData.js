const fs = require('node:fs');
const path = require('node:path');

// Only these entries belong to BambuBoard. A bind mount can also hold
// NAS metadata, external files or backups owned by the host user.
const APP_FILES = /^(?:config|data|note|accessToken|active-scene|gcode-diagnostics|stream-diagnostics)\.json(?:\.tmp|\.[^.]+\.tmp)?$/;
const APP_DIRECTORIES = new Map([
  ['scenes', /\.json(?:\.[^.]+\.tmp)?$/],
  ['gcode-cache', /\.gcode(?:\.[^.]+\.tmp)?$/],
]);

function dataEntries(dir) {
  const entries = [{ file: dir, info: fs.statSync(dir) }];
  for (const name of fs.readdirSync(dir)) {
    const children = APP_DIRECTORIES.get(name);
    if (!children && !APP_FILES.test(name)) continue;
    const file = path.join(dir, name);
    const info = fs.lstatSync(file);
    entries.push({ file, info });
    if (!children || !info.isDirectory()) continue;
    for (const child of fs.readdirSync(file)) {
      if (!children.test(child)) continue;
      const childPath = path.join(file, child);
      entries.push({ file: childPath, info: fs.lstatSync(childPath) });
    }
  }
  return entries;
}

function checkContainerData(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  for (const { file, info } of dataEntries(dir)) {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK |
      (info.isDirectory() ? fs.constants.X_OK : 0));
  }
}

module.exports = { checkContainerData, dataEntries };
