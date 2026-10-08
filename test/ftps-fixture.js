const tls = require('node:tls');
const { once } = require('node:events');
const { temporary, certificate } = require('./helpers');
function crc32(body) {
  let crc = -1;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ -1) >>> 0;
}
function archive(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value), filename = Buffer.from(name), crc = crc32(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, filename, body); central.push(record, filename); offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function ftpsFixture(t, options = {}) {
  const cert = await certificate(await temporary(t));
  const settings = { ...cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', sessionIdContext: 'bb-fixture' };
  const sockets = new Set(), servers = [], commands = [], protocols = [], reused = [];
  const files = options.files || {};
  let connections = 0, downloads = 0;
  const track = s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); };
  const control = tls.createServer(settings, socket => {
    connections++; track(socket); protocols.push(socket.getProtocol());
    socket.write('220 Loopback FTPS fixture\r\n');
    let pending = '', dataSocket = null, transfer = null;
    function deliver() {
      if (!transfer || !dataSocket) return;
      const body = transfer; transfer = null;
      socket.write('150 Data connection\r\n');
      const data = dataSocket; dataSocket = null;
      data.once('close', () => { if (!socket.destroyed && !options.stallCompletion) socket.write('226 Complete\r\n'); });
      data.end(options.truncate ? body.subarray(0, Math.max(1, body.length - 5)) : body);
    }
    async function passive(command) {
      const server = tls.createServer(settings, s => { track(s); reused.push(s.isSessionReused()); dataSocket = s; deliver(); });
      server.setTicketKeys(control.getTicketKeys());
      servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const port = server.address().port;
      socket.write(command === 'EPSV' ? `229 Entering Extended Passive Mode (|||${port}|)\r\n` : `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})\r\n`);
    }
    socket.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), line = pending.slice(0, end); pending = pending.slice(end + 2);
        const split = line.indexOf(' '), verb = split < 0 ? line : line.slice(0, split), arg = split < 0 ? '' : line.slice(split + 1);
        commands.push({ verb, arg: verb === 'PASS' ? '[redacted]' : arg });
        if (verb === 'USER') socket.write('331 Password required\r\n');
        else if (verb === 'PASS') socket.write(options.authFailure ? '530 Login incorrect\r\n' : '230 Logged in\r\n');
        else if (verb === 'FEAT') socket.write('211-Features\r\n EPSV\r\n UTF8\r\n211 End\r\n');
        else if (verb === 'EPSV' && options.epsvUnsupported) socket.write('502 EPSV unsupported\r\n');
        else if (verb === 'EPSV' || verb === 'PASV') void passive(verb);
        else if (verb === 'SIZE') socket.write(Object.hasOwn(files, arg) ? `213 ${files[arg].length}\r\n` : '550 Not found\r\n');
        else if (verb === 'RETR') {
          if (!Object.hasOwn(files, arg)) socket.write('550 Not found\r\n');
          else { downloads++; transfer = files[arg]; deliver(); }
        } else if (verb === 'LIST') {
          const directory = arg.replace(/^-a\s*/, '') || '/';
          const prefix = directory === '/' ? '/' : directory.replace(/\/$/, '') + '/';
          const rows = Object.entries(files).filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).map(([name, body]) => `-rw-r--r-- 1 bblp bblp ${body.length} Oct 07 12:00 ${name.slice(prefix.length)}\r\n`).join('');
          transfer = Buffer.from(rows); deliver();
        } else if (verb === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('200 OK\r\n');
      }
    });
  });
  servers.push(control); control.listen(0, '127.0.0.1'); await once(control, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
  return { port: control.address().port, commands, protocols, reused, get connections() { return connections; }, get downloads() { return downloads; } };
}
module.exports = { archive, ftpsFixture };
