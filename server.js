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

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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

server.listen(PORT, () => {
  console.log(`Password running:`);
  console.log(`  Game (this laptop):  http://localhost:${PORT}`);
  console.log(`  Phone remote:        http://${lanIP()}:${PORT}/remote   (same Wi-Fi / hotspot)`);
});
