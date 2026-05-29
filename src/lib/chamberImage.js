// Chamber-image camera protocol for P1 / A1-class printers.
//
// These printers don't expose RTSP (that's X1 / X1C / H2D / P2S). Instead the
// chamber camera streams a sequence of JPEG frames over a TLS socket on port
// 6000, gated by a `bblp` + LAN-access-code handshake. This is a direct port
// of ha-bambulab's ChamberImageThread (pybambu/bambu_client.py).
//
// Wire format after the auth packet:
//   16-byte header, delivered first:
//     bytes 0..2  = little-endian JPEG payload size (excludes this header)
//     bytes 3..15 = fixed marker bytes (unused here)
//   then `payload_size` bytes: a full JPEG (ff d8 ff e0 … ff d9)
//   repeat. New frames arrive roughly every 1–2s.
const tls = require('tls');
const { EventEmitter } = require('events');

const PORT = 6000;
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const RECONNECT_MS = 3000;

// 80-byte auth packet: 16-byte header (0x40, 0x3000, 0, 0) + 32-byte username
// + 32-byte access code, both NUL-padded.
function buildAuthPacket(accessCode) {
  const buf = Buffer.alloc(16 + 32 + 32, 0);
  buf.writeUInt32LE(0x40, 0);
  buf.writeUInt32LE(0x3000, 4);
  buf.write('bblp', 16, 'ascii');
  buf.write(String(accessCode || ''), 48, 'ascii');
  return buf;
}

class ChamberImageStream extends EventEmitter {
  constructor({ host, accessCode }) {
    super();
    this.host = host;
    this.accessCode = accessCode;
    this.lastFrame = null;
    this._stopped = false;
    this._sock = null;
    this._reconnect = null;
  }

  start() { this._stopped = false; this._connect(); return this; }

  stop() {
    this._stopped = true;
    if (this._reconnect) { clearTimeout(this._reconnect); this._reconnect = null; }
    if (this._sock) { try { this._sock.destroy(); } catch (_) {} this._sock = null; }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnect) return;
    this._reconnect = setTimeout(() => { this._reconnect = null; this._connect(); }, RECONNECT_MS);
  }

  _connect() {
    if (this._stopped) return;
    let img = null;        // accumulating JPEG buffer, or null while awaiting a header
    let payloadSize = 0;
    let buf = Buffer.alloc(0);

    const sock = tls.connect({ host: this.host, port: PORT, rejectUnauthorized: false, timeout: 8000 }, () => {
      sock.write(buildAuthPacket(this.accessCode));
      this.emit('connect');
    });
    this._sock = sock;

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // TCP can coalesce/split, so drive a state machine off the buffer rather
      // than assuming one recv == one logical message.
      for (;;) {
        if (img === null) {
          if (buf.length < 16) break;            // need the full header first
          payloadSize = buf.readUIntLE(0, 3);    // low 3 bytes, little-endian
          buf = buf.subarray(16);
          img = Buffer.alloc(0);
        }
        const need = payloadSize - img.length;
        if (need <= 0) { img = null; continue; }
        const take = Math.min(need, buf.length);
        if (take > 0) { img = Buffer.concat([img, buf.subarray(0, take)]); buf = buf.subarray(take); }
        if (img.length < payloadSize) break;     // wait for more
        const frame = img;
        img = null;
        if (frame.subarray(0, 4).equals(JPEG_START) && frame.subarray(-2).equals(JPEG_END)) {
          this.lastFrame = frame;
          this.emit('frame', frame);
        } else {
          this.emit('warn', 'JPEG magic bytes missing');
        }
      }
    });

    sock.on('error', (e) => { this.emit('error', e); try { sock.destroy(); } catch (_) {} this._scheduleReconnect(); });
    sock.on('timeout', () => { try { sock.destroy(); } catch (_) {} this._scheduleReconnect(); });
    sock.on('close', () => { if (!this._stopped) this._scheduleReconnect(); });
  }
}

module.exports = { ChamberImageStream, buildAuthPacket };
