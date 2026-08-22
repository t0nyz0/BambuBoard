#!/usr/bin/env node
// BambuBoard gcode-viz FTP self-test.
//
// Checks whether BambuBoard can reach the printer's FTPS file service and
// whether the current print's sliced .gcode.3mf is where the app looks for it
// (/cache/<subtask_name>.gcode.3mf). This reproduces exactly what the Gcode
// Toolpath widget's server-side fetch does, so it isolates the two common
// failure modes: FTP blocked/unreachable vs. the file not being in /cache/
// (typical of cloud / Bambu Handy / MakerWorld prints, or a name mismatch).
//
// Run inside the Docker container:
//   docker exec bambuboard node scripts/ftp-test.js
// Or locally from the repo root:
//   node scripts/ftp-test.js
//
// Prints filenames only — no secrets (the access code is never echoed).

const path = require('path');
const fs = require('fs');
const ftp = require('basic-ftp');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).printer || {};
    return { host: c.url, accessCode: c.accessCode };
  } catch (_) {
    return { host: process.env.BAMBUBOARD_PRINTER_URL, accessCode: process.env.BAMBUBOARD_PRINTER_ACCESS_CODE };
  }
}

function currentPrint() {
  try {
    const p = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data.json'), 'utf8')) || {}).print || {};
    return { subtask: p.subtask_name, plate: p.plate_idx || p.plate_id || 1, state: p.gcode_state };
  } catch (_) {
    return {};
  }
}

(async () => {
  const { host, accessCode } = loadCfg();
  if (!host || !accessCode) {
    console.log('❌ No printer host / access code found (data/config.json or BAMBUBOARD_PRINTER_* env).');
    process.exit(1);
  }
  const { subtask, plate, state } = currentPrint();
  console.log(`printer ${host}:990   print state: ${state || '?'}   current subtask: "${subtask || '(none)'}"  plate ${plate || '?'}`);

  const client = new ftp.Client(12000);
  try {
    await client.access({
      host, port: 990, user: 'bblp', password: accessCode,
      secure: 'implicit', secureOptions: { rejectUnauthorized: false },
    });
    console.log('✅ FTPS connected on port 990 — LAN file transfer is reachable.');
  } catch (e) {
    console.log(`❌ FTPS connect FAILED: ${e.code || e.message}`);
    console.log('   → The printer is not serving FTP on port 990 from here (blocked / disabled / unreachable).');
    console.log('     This is the "camera/file transfer" side of LAN mode — separate from MQTT (8883).');
    client.close();
    process.exit(2);
  }

  try {
    const list = await client.list('/cache');
    console.log(`\n/cache/ contains ${list.length} file(s):`);
    list.forEach(f => console.log(`   ${f.name}   ${(f.size / 1048576).toFixed(1)}MB`));
    if (subtask) {
      const want = `${subtask}.gcode.3mf`;
      const hit = list.find(f => f.name === want);
      console.log(`\nexpected file for the current print: ${want}`);
      if (hit) {
        console.log('   ✅ FOUND — BambuBoard should be able to fetch and render this print.');
      } else {
        console.log('   ❌ NOT in /cache/ — the sliced file is not where the app looks.');
        console.log('      Common when the job was sent from Bambu Handy / MakerWorld (cloud) rather');
        console.log('      than Bambu Studio over LAN, or the filename differs (compare the list above).');
      }
    } else {
      console.log('\n(No active print detected — start a print, then run this again to check the file.)');
    }
  } catch (e) {
    console.log(`\n❌ Could not list /cache/: ${e.code || e.message}`);
  }
  client.close();
})();
