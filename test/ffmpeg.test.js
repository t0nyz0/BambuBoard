const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findFfmpeg } = require('../src/lib/ffmpeg');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambuboard-ffmpeg-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extension = process.platform === 'win32' ? '.exe' : '';
  const system = path.join(directory, 'ffmpeg' + extension);
  const override = path.join(directory, 'configured encoder' + extension);
  for (const file of [system, override]) fs.writeFileSync(file, '', { mode: 0o700 });
  return { directory, system, override };
}

test('FFmpeg uses the installed executable on PATH or an explicit path', t => {
  const { directory, system, override } = fixture(t);
  assert.equal(findFfmpeg({ PATH: directory }), system);
  assert.equal(findFfmpeg({ PATH: directory, FFMPEG_BIN: override }), override);
});

test('FFmpeg reports unavailable when the configured binary is missing or invalid', t => {
  const { directory } = fixture(t);
  assert.equal(findFfmpeg({ PATH: '' }), null);
  assert.equal(findFfmpeg({ PATH: directory, FFMPEG_BIN: path.join(directory, 'missing') }), null);
  assert.equal(findFfmpeg({ PATH: directory, FFMPEG_BIN: directory }), null);
});
