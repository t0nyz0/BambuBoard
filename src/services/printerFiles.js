// Read-only implicit FTPS + bounded, validated 3MF extraction. No printer commands.
const ftp = require('basic-ftp');
const yauzl = require('yauzl');
const { Writable } = require('node:stream');
const { createHash } = require('node:crypto');
const { describe } = require('../../public/js/gcode-job');

const LIMITS = { archive: 128 * 1024 * 1024, gcode: 64 * 1024 * 1024, entries: 20000, listing: 1024 * 1024, timeout: 15000, deadline: 90000 };
class GcodeError extends Error {
  constructor(code, message, { retryable = false, status = 502, stage = 'download' } = {}) {
    super(message); Object.assign(this, { code, retryable, status, stage });
  }
}
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f\x7f\\]/.test(value)
      || value.split('/').some(s => s === '..' || s === '.')) return null;
  return value.startsWith('/') ? value : '/' + value;
}
function stem(name) { return name.replace(/(?:\.gcode\.3mf|\.3mf|\.gcode)$/i, ''); }
function normalized(name) { return stem(name).normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ''); }
function candidates(job, model) {
  const paths = [], names = new Set();
  const add = p => { const safe = safePath(p); if (safe && !paths.includes(safe)) paths.push(safe); };
  for (const p of [job.url, job.file]) {
    if (!/\.(?:3mf|gcode)$/i.test(p) || /(?:^|\/)Metadata\//i.test(p)) continue;
    add(p);
    if (/^\/(?:sdcard|data)\//i.test(p)) add(p.replace(/^\/(?:sdcard|data)/i, ''));
    names.add(p.split('/').pop());
  }
  if (job.name && !/[\x00-\x1f\x7f/\\]/.test(job.name)) {
    const base = stem(job.name);
    names.add(base + '.gcode.3mf'); names.add(base + '.3mf');
    // An extracted raw plate in /cache can have this specific filename.
    names.add(base + `_plate_${job.plate}.gcode`);
    if (/\.gcode$/i.test(job.name)) names.add(job.name);
  }
  for (const name of [...names]) if (name.includes(' ')) names.add(name.replaceAll(' ', '_'));
  const dirs = /H2|X2/i.test(model || '') ? ['/cache', '', '/model'] : ['', '/cache', '/model'];
  for (const dir of dirs) for (const name of names) add(`${dir}/${name}`);
  return { paths: paths.slice(0, 36), dirs, names };
}
function validateGcode(data) {
  let readable = false;
  for (let offset = 0; offset < data.length && !readable; offset += 65536) {
    readable = /^(?:N\d+\s+)?(?:G0?[0123]|G9[012]|M8[23])(?:\s|$)/im.test(data.subarray(Math.max(0, offset - 64), offset + 65536).toString('utf8'));
  }
  if (!data.length || data.includes(0) || !readable) {
    throw new GcodeError('GCODE_INVALID', 'The downloaded file does not contain readable G-code.', { stage: 'validate' });
  }
  return data;
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) {
  let crc = -1;
  for (const value of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ value) & 255];
  }
  return (crc ^ -1) >>> 0;
}
async function extractPlateGcode(buffer, { plate = 1, plateKnown = true, onEvent = () => {}, limits = LIMITS } = {}) {
  if (buffer.length > limits.archive) throw new GcodeError('FILE_TOO_LARGE', 'The sliced file exceeds the 128 MiB download limit.', { stage: 'validate', status: 413 });
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    if (buffer.length > limits.gcode) throw new GcodeError('FILE_TOO_LARGE', 'The G-code exceeds the 64 MiB extraction limit.', { stage: 'validate', status: 413 });
    return validateGcode(buffer);
  }
  const invalidArchive = () => new GcodeError('ARCHIVE_INVALID', 'The sliced archive is damaged or unsupported. Re-export the exact sliced plate.', { stage: 'extract' });
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (err, value) => err ? reject(invalidArchive()) : resolve(value)));
  try {
    const entries = await new Promise((resolve, reject) => {
      const found = [];
      const onEntry = entry => {
        found.push(entry);
        if (found.length > limits.entries) return fail(new GcodeError('ARCHIVE_LIMIT', 'This archive contains too many entries.', { stage: 'extract' }));
        zip.readEntry();
      };
      const done = () => { cleanup(); resolve(found); };
      const fail = err => { cleanup(); reject(err); };
      function cleanup() { zip.removeListener('entry', onEntry); zip.removeListener('end', done); zip.removeListener('error', fail); }
      zip.on('entry', onEntry); zip.once('end', done); zip.once('error', fail); zip.readEntry();
    });
    const toolpaths = entries.filter(e => /^Metadata\/plate_\d+\.gcode$/i.test(e.fileName));
    let chosen = toolpaths.find(e => e.fileName.toLowerCase() === `metadata/plate_${plate}.gcode`);
    if (!plateKnown && toolpaths.length === 1) chosen = toolpaths[0];
    if (!plateKnown && toolpaths.length > 1) throw new GcodeError('PLATE_AMBIGUOUS', 'The printer has not identified its plate and the archive has multiple plates.', { stage: 'extract', retryable: true });
    if (!chosen) {
      const available = toolpaths.map(e => Number(e.fileName.match(/plate_(\d+)/i)[1])).sort((a, b) => a - b);
      throw new GcodeError('PLATE_NOT_FOUND', available.length
        ? `Plate ${plate} is absent; available plates: ${available.join(', ')}. The viewer will not substitute another plate.`
        : 'The 3MF has no sliced plate G-code. Export a sliced plate from Bambu Studio.', { stage: 'extract' });
    }
    if (toolpaths.filter(entry => entry.fileName.toLowerCase() === chosen.fileName.toLowerCase()).length > 1) throw new GcodeError('PLATE_AMBIGUOUS', 'The sliced archive contains duplicate toolpaths for the selected plate.', { stage: 'extract' });
    const read = (entry, max) => new Promise((resolve, reject) => {
      if (entry.uncompressedSize > max || entry.generalPurposeBitFlag & 1) return reject(new GcodeError('ARCHIVE_LIMIT', 'The selected archive entry is too large or encrypted.', { stage: 'extract' }));
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const parts = []; let count = 0;
        stream.on('data', chunk => {
          count += chunk.length;
          if (count > max) stream.destroy(new GcodeError('ARCHIVE_LIMIT', 'The extracted entry exceeds its limit.', { stage: 'extract' }));
          else parts.push(chunk);
        });
        stream.once('error', reject);
        stream.once('end', () => {
          const data = Buffer.concat(parts, count);
          if (count !== entry.uncompressedSize || crc32(data) !== entry.crc32) return reject(new GcodeError('FILE_CORRUPT', 'The sliced archive failed its length/CRC integrity check.', { stage: 'validate', retryable: true }));
          resolve(data);
        });
      });
    });
    const data = await read(chosen, limits.gcode);
    const checksum = entries.find(e => e.fileName.toLowerCase() === chosen.fileName.toLowerCase() + '.md5');
    if (checksum) {
      const expected = (await read(checksum, 128)).toString('ascii').trim();
      if (!/^[a-f\d]{32}$/i.test(expected) || createHash('md5').update(data).digest('hex') !== expected.toLowerCase()) {
        throw new GcodeError('FILE_CORRUPT', 'The plate G-code does not match its slicer MD5 checksum.', { stage: 'validate', retryable: true });
      }
    }
    onEvent({ stage: 'extract', result: 'ok', entry: chosen.fileName, bytes: data.length, checksum: checksum ? 'CRC32 + MD5' : 'CRC32' });
    return validateGcode(data);
  } catch (err) {
    throw err instanceof GcodeError ? err : invalidArchive();
  } finally { zip.close(); }
}
function transportError(err, stage) {
  if (err instanceof GcodeError) return err;
  const code = String(err?.code || '');
  if (code === '530') return new GcodeError('FTPS_AUTH', 'Printer file login failed (530). Check the current LAN access code in Setup.', { stage });
  if (code === '550') return new GcodeError('FILE_NOT_FOUND', 'The printer did not expose that file (550).', { stage, retryable: true });
  if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new GcodeError('FTPS_DNS', 'The printer hostname could not be resolved. Check its address in Setup.', { stage, retryable: true });
  if (code === 'ECONNREFUSED') return new GcodeError('FTPS_REFUSED', 'The printer refused FTPS on port 990. Check LAN file access, printer mode and firewall rules.', { stage, retryable: true });
  if (/TLS|SSL|CERT|EPROTO/i.test(code + ' ' + (err?.message || ''))) return new GcodeError('FTPS_TLS', 'The printer FTPS TLS handshake failed. TLS 1.2 and protected data transfer were used.', { stage, retryable: true });
  if (/timeout|timed out/i.test(err?.message || '') || code === 'ETIMEDOUT') return new GcodeError('FTPS_TIMEOUT', `Printer file transfer timed out during ${stage}. Check port 990 and passive data ports between BambuBoard and the printer.`, { stage, retryable: true });
  return new GcodeError('FTPS_TRANSFER', `Printer file transfer failed during ${stage}${code ? ` (${code.replace(/[^\w-]/g, '').slice(0, 30)})` : ''}. Check the diagnostic log.`, { stage, retryable: true });
}
async function fetchPlateGcode(options) {
  const { host, port = 990, accessCode, model, signal, onEvent = () => {}, limits = LIMITS } = options;
  const job = options.job || describe({ subtask_name: options.subtaskName, plate_idx: options.plateIdx });
  const plan = candidates(job, model);
  let client, stage = 'connect', expired = false;
  const abort = () => client?.close();
  const deadline = setTimeout(() => { expired = true; abort(); }, limits.deadline);
  signal?.addEventListener('abort', abort);
  const event = data => onEvent({ ...data, stage: data.stage || stage });
  const check = () => {
    if (signal?.aborted) throw new GcodeError('JOB_CHANGED', 'The print changed during download. Loading the current print instead.', { status: 409, retryable: true });
    if (expired) throw new GcodeError('FTPS_TIMEOUT', 'The printer file lookup exceeded its 90 second deadline.', { retryable: true, stage });
  };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      check();
      client = new ftp.Client(limits.timeout, { maxListingBytes: limits.listing });
      client.ftp.verbose = false;
      try {
        stage = 'connect'; event({ result: 'start', attempt, port, tls: 'TLSv1.2', data: 'protected', passive: 'EPSV with PASV fallback' });
        await client.access({ host, port, user: 'bblp', password: accessCode, secure: 'implicit', secureOptions: { rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } });
        // basic-ftp reuses the control TLS session on its protected data channel.
        event({ result: 'ok', protocol: client.ftp.socket.getProtocol?.() });
        const tried = new Set();
        const download = async remote => {
          check(); stage = 'size'; tried.add(remote);
          let size;
          try { size = await client.size(remote); }
          catch (err) { if (![500, 502, 504].includes(Number(err.code))) throw err; }
          if (size > limits.archive) throw new GcodeError('FILE_TOO_LARGE', 'The sliced file exceeds the 128 MiB download limit.', { stage, status: 413 });
          stage = 'download'; event({ result: 'start', path: remote, expectedBytes: size });
          const chunks = []; let count = 0;
          const sink = new Writable({ write(chunk, _enc, callback) {
            count += chunk.length;
            if (count > limits.archive) callback(new GcodeError('FILE_TOO_LARGE', 'The sliced file exceeds the 128 MiB download limit.', { status: 413 }));
            else { chunks.push(chunk); callback(); }
          } });
          await client.downloadTo(sink, remote); check();
          if (!count || (size != null && count !== size)) throw new GcodeError('FILE_TRUNCATED', 'The printer returned an empty or incomplete sliced file.', { retryable: true, stage });
          stage = 'extract';
          const data = await extractPlateGcode(Buffer.concat(chunks, count), { plate: job.plate, plateKnown: job.plateKnown, onEvent: event, limits });
          check();
          event({ stage: 'download', result: 'ok', path: remote, bytes: data.length });
          return data;
        };
        let extractionFailure;
        const tryPath = async remote => {
          try { return await download(remote); }
          catch (err) {
            const failure = transportError(err, stage);
            event({ result: 'failed', path: remote, code: failure.code });
            if (failure.code === 'FILE_NOT_FOUND') return null;
            // An unsliced .3mf / wrong plate can coexist with the sliced copy.
            if (['PLATE_NOT_FOUND', 'PLATE_AMBIGUOUS', 'GCODE_INVALID'].includes(failure.code)) { extractionFailure = failure; return null; }
            throw failure;
          }
        };
        for (const remote of plan.paths) { const result = await tryPath(remote); if (result) return result; }
        // Only exact/normalized job-name matches. Never pick the newest/random
        // archive from a printer: it could show an entirely different print.
        for (const dir of plan.dirs) {
          check(); stage = 'list';
          let files;
          try { files = await client.list(dir || '/'); }
          catch (err) { const failure = transportError(err, stage); event({ result: 'failed', directory: dir || '/', code: failure.code }); if (failure.code === 'FILE_NOT_FOUND') continue; throw failure; }
          const targets = new Set([...plan.names].map(normalized));
          const matches = files.filter(f => f.isFile && /\.(?:3mf|gcode)$/i.test(f.name) && targets.has(normalized(f.name)) && safePath(f.name) && !f.name.includes('/'));
          event({ result: 'ok', directory: dir || '/', entries: files.length, matches: matches.length });
          if (matches.length > 3) throw new GcodeError('FILE_AMBIGUOUS', 'Several printer files match this job. Load the exact sliced file manually.', { stage });
          for (const file of matches) {
            const remote = `${dir}/${file.name}`;
            if (!tried.has(remote)) { const result = await tryPath(remote); if (result) return result; }
          }
        }
        if (extractionFailure) throw extractionFailure;
        throw new GcodeError('FILE_NOT_FOUND', 'The active print file is not available in the printer FTPS root, /cache or /model. Cloud/profile names may differ from filenames; some firmware keeps jobs in inaccessible internal storage. Load the exact sliced .3mf or .gcode, or send it to external printer storage from Bambu Studio.', { retryable: true, stage: 'discovery' });
      } catch (err) {
        check();
        const failure = transportError(err, stage);
        event({ result: 'failed', code: failure.code, attempt });
        // Retry a failed connection/transfer once using a fresh TLS session.
        // Missing files and login errors do not trigger another folder sweep.
        if (attempt === 2 || !['FTPS_TIMEOUT', 'FTPS_TRANSFER', 'FTPS_TLS', 'FILE_TRUNCATED', 'FILE_CORRUPT'].includes(failure.code)) throw failure;
      } finally { client.close(); }
    }
  } catch (err) {
    if (err instanceof GcodeError) throw err;
    throw new GcodeError('ARCHIVE_INVALID', 'The sliced archive is damaged or unsupported. Re-export the exact sliced plate.', { stage: 'extract' });
  } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); client?.close(); }
}
module.exports = { fetchPlateGcode, extractPlateGcode, GcodeError, LIMITS, describe, safePath };
