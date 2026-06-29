// link.js — WebSocket client shared by the game (host) and the phone (remote).
// Auto-reconnects, so a phone that sleeps/wakes rejoins on its own.

export function connect({ role, room = 'main', onCmd, onState, onPeers, onStatus }) {
  let ws = null;
  let retry = null;
  let closed = false;

  function open() {
    if (closed) return;
    try {
      ws = new WebSocket(`ws://${location.host}/ws`);
    } catch {
      onStatus?.('error');
      schedule();
      return;
    }
    ws.onopen = () => {
      onStatus?.('open');
      ws.send(JSON.stringify({ t: 'hello', role, room }));
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'cmd') onCmd?.(m.action);
      else if (m.t === 'state') onState?.(m);
      else if (m.t === 'peers') onPeers?.(m);
    };
    ws.onclose = () => {
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close: () => {
      closed = true;
      clearTimeout(retry);
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
