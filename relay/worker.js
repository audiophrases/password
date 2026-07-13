// relay/worker.js — optional cloud relay for the phone remote, for networks
// where the phone can't reach the laptop at all (locked-down work machines,
// Wi-Fi client isolation). Same message protocol as the local relay in
// server.js, but rooms are keyed by a code so many games can share it:
//
//   phone /remote?room=CODE ──wss──▶ RelayRoom (one DO per code) ◀──wss── game tab
//
// Both sides connect OUTBOUND, so inbound firewalls never matter. The Worker
// also serves the static site (see wrangler.jsonc "assets"), so phones load
// the remote page straight from the public URL. Deploy: `npx wrangler deploy`.

import { DurableObject } from 'cloudflare:workers';

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answer link.js's keepalive pings at the edge, without waking a hibernated DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  fetch(request) {
    // Role comes from the URL, not the hello message, so it can be a hibernation
    // tag — getWebSockets('host') then still works after the DO was evicted and
    // recreated around a sleeping socket.
    const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'remote';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    this.notifyPeers();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const role = this.ctx.getTags(ws)[0];
    // Forward the whole message verbatim, same as server.js — a per-field
    // whitelist has already silently dropped a new command's payload once.
    if (msg.t === 'cmd' && role === 'remote') this.broadcast('host', raw);
    else if (msg.t === 'state' && role === 'host') this.broadcast('remote', raw);
    // 'hello' is only meaningful to the local relay (role lives in the URL here).
  }

  webSocketClose(ws) {
    this.notifyPeers(ws);
  }

  webSocketError(ws) {
    this.notifyPeers(ws);
  }

  broadcast(tag, raw, except) {
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws === except) continue;
      try {
        ws.send(raw);
      } catch {
        /* peer mid-close */
      }
    }
  }

  // `leaving` excludes a socket that is closing but may still be listed.
  notifyPeers(leaving) {
    const count = (tag) => this.ctx.getWebSockets(tag).filter((w) => w !== leaving).length;
    const msg = JSON.stringify({ t: 'peers', host: count('host') > 0, remotes: count('remote') });
    this.broadcast('host', msg, leaving);
    this.broadcast('remote', msg, leaving);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        // Plain GET: used by the game to probe "is this origin the relay?" (426
        // here vs 404 on a static host), and by humans poking around.
        return new Response('expected a websocket', { status: 426 });
      }
      const room = (url.searchParams.get('room') || '').toLowerCase();
      if (!/^[a-z0-9-]{1,32}$/.test(room)) return new Response('bad room', { status: 400 });
      return env.ROOMS.getByName(room).fetch(request);
    }
    // Static files are served by the assets layer before this runs; whatever
    // falls through (e.g. /lan-info, /tts) has no cloud equivalent — the game
    // detects that and falls back (browser voices, no LAN URL).
    return new Response('not found', { status: 404 });
  },
};
