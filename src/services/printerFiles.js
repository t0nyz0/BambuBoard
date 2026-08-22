// FTPS download + 3MF unzip for live print gcode.
//
// Bambu firmware places sliced jobs at /cache/<subtask_name>.gcode.3mf on the
// printer's FTPS server (port 990, implicit TLS, user 'bblp', password = the
// LAN access code). Inside that 3MF zip the gcode lives at
// Metadata/plate_<plate_idx>.gcode. We don't get raw gcode anywhere else over
// FTPS — /data/Metadata/ is firmware-internal.

const ftp = require('basic-ftp');
const yauzl = require('yauzl');
const { Writable } = require('stream');

async function downloadGcode3mf({ host, port = 990, accessCode, remotePath }) {
  const client = new ftp.Client(15000);
  client.ftp.verbose = false;
  const chunks = [];
  try {
    await client.access({
      host,
      port,
      user: 'bblp',
      password: accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false },
    });
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    await client.downloadTo(sink, remotePath);
  } finally {
    client.close();
  }
  return Buffer.concat(chunks);
}

function extractEntryFromZip(zipBuffer, entryPath) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let found = false;
      zip.on('entry', (entry) => {
        if (entry.fileName !== entryPath) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          const parts = [];
          stream.on('data', (c) => parts.push(c));
          stream.on('end', () => resolve(Buffer.concat(parts)));
          stream.on('error', reject);
        });
      });
      zip.on('end', () => {
        if (!found) reject(new Error(`entry not found in 3mf: ${entryPath}`));
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function fetchPlateGcode({ host, port, accessCode, subtaskName, plateIdx }) {
  // basic-ftp takes the literal path — don't URL-encode (that's HTTP territory).
  const remote = `/cache/${subtaskName}.gcode.3mf`;

  // Enrich errors so the widget's debug log shows WHAT failed, not just that
  // "something" did. basic-ftp attaches `.code` on both connection failures
  // (ECONNREFUSED / ETIMEDOUT / DEPTH_ZERO_SELF_SIGNED_CERT …) and FTP reply
  // errors (e.g. 550 = file not found). A 550 here almost always means the
  // sliced job isn't at /cache/<subtask>.gcode.3mf — typical when the print
  // was started from Bambu Handy / MakerWorld (cloud) rather than Bambu Studio
  // over LAN. A connection error usually means FTPS (port 990) is unreachable.
  let zipBuf;
  try {
    zipBuf = await downloadGcode3mf({ host, port, accessCode, remotePath: remote });
  } catch (e) {
    const code = e && e.code != null ? e.code : (e && e.message) || 'unknown';
    const hint = String(code) === '550'
      ? ' — sliced file not found on printer (cloud/Handy prints may not land in /cache/)'
      : (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|CERT/i.test(String(code))
          ? ' — could not reach FTPS on port 990 (LAN file transfer blocked or disabled?)'
          : '');
    throw new Error(`FTPS download of ${remote} failed [${code}]${hint}`);
  }

  const entry = `Metadata/plate_${plateIdx}.gcode`;
  try {
    return await extractEntryFromZip(zipBuf, entry);
  } catch (e) {
    throw new Error(`${e.message} (plate ${plateIdx}, from ${remote})`);
  }
}

module.exports = { fetchPlateGcode };
