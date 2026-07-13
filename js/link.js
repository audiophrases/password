// link.js — WebSocket client shared by the game (host) and the phone (remote).
// Auto-reconnects, so a phone that sleeps/wakes rejoins on its own.
//
// By default it talks to the relay on the page's own origin — the local
// server.js, or the cloud Worker when the page was loaded from it. Pass
// `relay` (an http(s) origin) to reach a different relay: the game tab does
// this in ☁ cloud mode, so it can keep running from localhost (neural TTS,
// zero-lag static files) while the phones connect via the cloud.

export function connect({ role, room = 'main', relay = '', onCmd, onState, onPeers, onStatus }) {
  let ws = null;
  let retry = null;
  let ping = null;
  let closed = false;

  const base = (relay || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`)
    .replace(/^http/, 'ws') // http(s):// -> ws(s)://
    .replace(/\/+$/, '');
  // room+role ride in the URL for the cloud relay (which routes on them before
  // any message flows); the local server keeps reading them from `hello`.
  const url = `${base}/ws?room=${encodeURIComponent(room)}&role=${encodeURIComponent(role)}`;

  function open() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      onStatus?.('error');
      schedule();
      return;
    }
    ws.onopen = () => {
      onStatus?.('open');
      ws.send(JSON.stringify({ t: 'hello', role, room }));
      // Keepalive: the cloud edge (and some routers) drops idle sockets. The
      // relay answers with a pong; the local server just ignores these.
      clearInterval(ping);
      ping = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
      }, 25000);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'cmd') onCmd?.(m.action, m); // pass the whole msg for payload commands
      else if (m.t === 'state') onState?.(m);
      else if (m.t === 'peers') onPeers?.(m);
    };
    ws.onclose = () => {
      clearInterval(ping);
      onStatus?.('closed');
      schedule();
    };
    ws.onerror = () => {
      onStatus?.('error');
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  function schedule() {
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(open, 1500);
  }

  open();

  return {
    send: (obj) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      console.warn('[link] not open — dropped', obj); // command lost; caller may be "offline"
      return false;
    },
    close: () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
