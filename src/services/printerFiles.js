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
  const zipBuf = await downloadGcode3mf({ host, port, accessCode, remotePath: remote });
  const entry = `Metadata/plate_${plateIdx}.gcode`;
  return extractEntryFromZip(zipBuf, entry);
}

module.exports = { fetchPlateGcode };
