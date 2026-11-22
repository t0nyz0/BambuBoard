// Explicit, offline upgrade for app files written by an older root container.
const fs = require('node:fs');
const { dataEntries } = require('../src/lib/containerData');
const target = '/usr/src/app/data';
const uid = 1000;
const gid = 1000;

try {
  if (process.getuid() !== 0) throw new Error('Run this one-time command with docker run --user 0:0.');
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' ')[4]);
  if (!mounts.includes(target) || mounts.some(mount => mount?.startsWith(target + '/'))) {
    throw new Error('Mount one dedicated BambuBoard volume at /usr/src/app/data. Nested mounts are unsupported.');
  }
  const entries = dataEntries(target);
  for (const { file, info } of entries) {
    if ((!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
      throw new Error(`Resolve linked or special app entry before migrating: ${file}`);
    }
  }
  // Validate the full tree before any changes. Process parents last.
  for (const { file, info } of entries.reverse()) {
    const mode = info.isDirectory() ? 0o700 : 0o600;
    if (info.uid === uid && info.gid === gid && (info.mode & mode) === mode) continue;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const current = fs.fstatSync(fd);
      if (current.dev !== info.dev || current.ino !== info.ino || (current.isFile() && current.nlink !== 1)) {
        throw new Error('The volume changed during migration. Stop other writers and retry.');
      }
      if (current.uid !== uid || current.gid !== gid) fs.fchownSync(fd, uid, gid);
      if ((current.mode & mode) !== mode) fs.fchmodSync(fd, (current.mode & 0o777) | mode);
    } finally {
      fs.closeSync(fd);
    }
  }
  console.log('BambuBoard app data is ready for UID 1000 and GID 1000.');
} catch (error) {
  console.error(`BambuBoard data migration: ${error.message}`);
  process.exitCode = 1;
}
