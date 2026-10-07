const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(t, app) {
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function certificate(dir) {
  // Ephemeral, loopback-only test certificate; never use installation secrets.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { key: await fs.readFile(path.join(dir, 'key.pem')), cert: await fs.readFile(path.join(dir, 'cert.pem')) };
}
async function until(check, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Timed out waiting for test state');
}
module.exports = { temporary, listen, certificate, until };
