// server.js — static file server + tiny WebSocket relay for the phone remote.
// Dependency-free (Node built-ins only): just run `node server.js`.
//
// Flow:  phone /remote  ──ws──▶  relay (here)  ──ws──▶  game tab on the laptop
// The game tab connects as the "host"; phones connect as "remote" and their
// button presses are forwarded to the host. The host pushes game state back so
// the phone can show the current letter/clue/score.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const tls = require('tls');

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------- Microsoft edge-tts (real neural voices) ----------------
// Reverse-engineered Edge "Read Aloud" endpoint — no key, no dependency. Gives
// the same neural voices as Edge (e.g. ca-ES-JoanaNeural), played in any browser.
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const TTS_HOST = 'speech.platform.bing.com';
const TTS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_VERSION = '143.0.3650.75';

// Security token Microsoft now requires: SHA-256 of (Windows-filetime ticks
// rounded down to 5 min) + the trusted client token. `skew` corrects a wrong
// system clock (seconds to add), discovered from Microsoft's Date header.
function secMsGec(skew = 0) {
  let ticks = Math.floor(Date.now() / 1000 + skew) + 11644473600; // unix -> seconds since 1601
  ticks -= ticks % 300; // round down to 5 minutes
  ticks *= 10000000; // seconds -> 100-nanosecond units
  return crypto.createHash('sha256').update(`${BigInt(ticks)}${TRUSTED_TOKEN}`).digest('hex').toUpperCase();
}

function buildSsml(text, voice, isSsml = false) {
  // When isSsml, `text` is a ready inner-SSML fragment (client pre-escaped the
  // dynamic parts); otherwise escape it as plain text.
  const inner = isSsml ? text : String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lang = voice.slice(0, 5); // e.g. "ca-ES"
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${inner}</prosody></voice></speak>`
  );
}

// Masked client WebSocket frame (client->server frames must be masked).
function maskedFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function synthesize(text, voice, skew = 0, retried = false, isSsml = false) {
  return new Promise((resolve, reject) => {
    const connId = crypto.randomUUID().replace(/-/g, '');
    const query =
      `?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec(skew)}&Sec-MS-GEC-Version=1-${EDGE_VERSION}&ConnectionId=${connId}`;
    const key = crypto.randomBytes(16).toString('base64');
    const socket = tls.connect({ host: TTS_HOST, port: 443, servername: TTS_HOST }, () => {
      socket.write(
        [
          `GET ${TTS_PATH + query} HTTP/1.1`,
          `Host: ${TTS_HOST}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Pragma: no-cache',
          'Cache-Control: no-cache',
          '',
          '',
        ].join('\r\n')
      );
    });

    let handshake = false;
    let buf = Buffer.alloc(0);
    let fragOp = 0;
    let frag = Buffer.alloc(0);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error('tts timeout')), 15000);

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    }

    function onMessage(opcode, payload) {
      if (opcode === 0x2) {
        const headerLen = payload.readUInt16BE(0);
        const audio = payload.slice(2 + headerLen);
        if (audio.length) chunks.push(audio);
      } else if (opcode === 0x1) {
        if (payload.toString('utf8').includes('Path:turn.end')) finish();
      } else if (opcode === 0x8) {
        finish();
      } else if (opcode === 0x9) {
        socket.write(maskedFrame(payload, 0xa)); // pong
      }
    }

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshake) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        if (!/ 101 /.test(head)) {
          // Auth rejected: if the clock is off, read Microsoft's Date header and retry once.
          const dm = head.match(/^Date:\s*(.+)$/im);
          const serverMs = dm ? Date.parse(dm[1]) : NaN;
          if (!retried && /\b403\b/.test(head) && !Number.isNaN(serverMs)) {
            done = true;
            clearTimeout(timer);
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
            synthesize(text, voice, serverMs / 1000 - Date.now() / 1000, true, isSsml).then(resolve, reject);
            return;
          }
          return finish(new Error('handshake: ' + head.split('\r\n')[0]));
        }
        handshake = true;
        buf = buf.slice(idx + 4);
        const ts = new Date().toString();
        socket.write(
          maskedFrame(
            `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
              `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
          )
        );
        socket.write(
          maskedFrame(
            `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
              buildSsml(text, voice, isSsml)
          )
        );
      }
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (masked) off += 4;
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 0x0) {
          frag = Buffer.concat([frag, payload]);
          if (fin) {
            onMessage(fragOp, frag);
            frag = Buffer.alloc(0);
            fragOp = 0;
          }
        } else if (!fin) {
          fragOp = opcode;
          frag = payload;
        } else {
          onMessage(opcode, payload);
        }
      }
    });
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(chunks.length ? undefined : new Error('closed early')));
  });
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const mime = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function lanIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) candidates.push(ni.address);
    }
  }
  // prefer typical private LAN ranges
  return (
    candidates.find((a) => a.startsWith('192.168.')) ||
    candidates.find((a) => a.startsWith('10.')) ||
    candidates.find((a) => a.startsWith('172.')) ||
    candidates[0] ||
    'localhost'
  );
}

// ---------------- static + lan-info ----------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/remote' || p === '/remote/') p = '/remote.html';
  if (p === '/lan-info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip: lanIP(), port: Number(PORT) }));
    return;
  }
  if (p === '/tts') {
    const voice = u.searchParams.get('voice') || 'en-US-AvaNeural';
    const text = u.searchParams.get('text') || '';
    const isSsml = u.searchParams.get('ssml') === '1';
    if (!text) {
      res.writeHead(400);
      res.end('no text');
      return;
    }
    synthesize(text, voice, 0, false, isSsml)
      .then((audio) => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
        res.end(audio);
      })
      .catch((e) => {
        console.warn('TTS error:', e.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('tts failed: ' + e.message);
      });
    return;
  }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime(file) });
    res.end(data);
  });
});

// ---------------- minimal WebSocket (RFC 6455) ----------------
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrames(conn) {
  const frames = [];
  let buf = conn.buf;
  for (;;) {
    if (buf.length < 2) break;
    const b1 = buf[1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    let mask;
    if (masked) {
      if (buf.length < offset + 4) break;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) break;
    let payload = buf.slice(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    frames.push({ opcode: buf[0] & 0x0f, payload });
    buf = buf.slice(offset + len);
  }
  conn.buf = buf;
  return frames;
}

const conns = new Set();
const rooms = new Map(); // id -> { host: conn|null, remotes: Set }

const getRoom = (id) => {
  if (!rooms.has(id)) rooms.set(id, { host: null, remotes: new Set() });
  return rooms.get(id);
};

function notifyPeers(room) {
  const r = rooms.get(room);
  if (!r) return;
  const msg = JSON.stringify({ t: 'peers', host: !!r.host, remotes: r.remotes.size });
  if (r.host) r.host.send(msg);
  r.remotes.forEach((c) => c.send(msg));
}

function handleMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.t === 'hello') {
    conn.role = msg.role === 'host' ? 'host' : 'remote';
    conn.room = msg.room || 'main';
    const r = getRoom(conn.room);
    if (conn.role === 'host') r.host = conn;
    else r.remotes.add(conn);
    notifyPeers(conn.room);
  } else if (msg.t === 'cmd' && conn.role === 'remote') {
    const r = rooms.get(conn.room);
    if (r && r.host) r.host.send(JSON.stringify({ t: 'cmd', action: msg.action }));
  } else if (msg.t === 'state' && conn.role === 'host') {
    const r = rooms.get(conn.room);
    if (r) r.remotes.forEach((c) => c.send(raw));
  }
}

function dropConn(conn) {
  if (!conns.has(conn)) return;
  conns.delete(conn);
  const r = conn.room && rooms.get(conn.room);
  if (r) {
    if (r.host === conn) r.host = null;
    r.remotes.delete(conn);
    notifyPeers(conn.room);
    if (!r.host && r.remotes.size === 0) rooms.delete(conn.room);
  }
}

server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = {
    socket,
    buf: Buffer.alloc(0),
    role: null,
    room: 'main',
    send: (s) => {
      if (socket.writable) {
        try {
          socket.write(encodeFrame(s));
        } catch {
          /* socket closing */
        }
      }
    },
  };
  conns.add(conn);

  socket.on('data', (d) => {
    conn.buf = Buffer.concat([conn.buf, d]);
    for (const f of parseFrames(conn)) {
      if (f.opcode === 0x8) {
        dropConn(conn);
        socket.destroy();
        return;
      }
      if (f.opcode === 0x9) {
        if (socket.writable) socket.write(Buffer.from([0x8a, 0])); // pong
        continue;
      }
      if (f.opcode === 0x1 || f.opcode === 0x0) handleMessage(conn, f.payload.toString('utf8'));
    }
  });
  socket.on('close', () => dropConn(conn));
  socket.on('error', () => {
    dropConn(conn);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });
});

// keepalive ping (some networks drop idle sockets)
setInterval(() => {
  for (const c of conns) {
    if (c.socket.writable) {
      try {
        c.socket.write(Buffer.from([0x89, 0]));
      } catch {
        /* ignore */
      }
    }
  }
}, 25000);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Password running:`);
    console.log(`  Game (this laptop):  http://localhost:${PORT}`);
    console.log(`  Phone remote:        http://${lanIP()}:${PORT}/remote   (same Wi-Fi / hotspot)`);
  });
}

module.exports = { synthesize, secMsGec };
