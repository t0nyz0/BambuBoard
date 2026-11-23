const fs = require('node:fs');
const path = require('node:path');

function executableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function findFfmpeg(env = process.env) {
  const configured = env.FFMPEG_BIN;
  const name = configured || 'ffmpeg';
  const isWindows = process.platform === 'win32';
  if (name.includes('/') || (isWindows && name.includes('\\'))) {
    const file = path.resolve(name);
    return executableFile(file) ? file : null;
  }

  const command = isWindows && !path.extname(name) ? name + '.exe' : name;
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const folder = directory.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(folder)) continue;
    const file = path.join(folder, command);
    if (executableFile(file)) return file;
  }
  return null;
}

module.exports = { ffmpeg: findFfmpeg(), findFfmpeg };
