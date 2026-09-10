// library.js — keeps this browser's saved games in step with the cloud copy, so
// the same library opens on every computer the teacher uses.
//
// Offline-first on purpose: localStorage stays the working copy, so the setup
// screen renders instantly and a round plays with no network at all. The cloud
// is a mirror that is reconciled on load and after each save; every call here
// can fail and the only consequence is a line in the status bar.
//
// The endpoint is the SAME Worker origin as the phone relay (relay/worker.js),
// so there is nothing new to configure — if a relay is deployed, so is this.

const KEY_KEY = 'password.libraryKey.v1';
const CURSOR_KEY = 'password.libraryCursor.v1'; // { fp, cursor } — scoped to the key
const PULL_FLOOR_MS = 30_000; // the phone relay shares the daily request budget

const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/0/1 look-alikes
const KEY_LEN = 26; // ~129 bits — must match KEY_RE in relay/worker.js

let lastPullAt = 0;
let backedOff = false; // set after a 429; stays off for the session
let pushTimer = null;

export function getKey() {
  return (localStorage.getItem(KEY_KEY) || '').trim().toLowerCase();
}

export function setKey(key) {
  const k = String(key || '').trim().toLowerCase();
  localStorage.setItem(KEY_KEY, k);
  localStorage.removeItem(CURSOR_KEY); // a different library means a different cursor
  return k;
}

export function validKey(key) {
  return new RegExp(`^[${KEY_ALPHABET}]{${KEY_LEN}}$`).test(String(key || '').trim().toLowerCase());
}

// Generated, never invented: with no server-side secret a wrong key does not
// fail, it silently opens a DIFFERENT empty library — so the key has to carry
// enough entropy that nobody ever reaches one by accident. crypto.getRandomValues
// (not randomUUID) because this page is often served over plain http from a LAN
// IP, where the secure-context APIs are undefined.
export function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  return Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
}

// A short, stable label so two machines can be compared at a glance — a typo
// shows a different fingerprint and an empty library instead of looking broken.
// Local only; unrelated to the sha256 the Worker uses to address the library.
export function fingerprint(key, hash128) {
  return key ? hash128(key).slice(0, 6) : '';
}

function readCursor(fp) {
  try {
    const c = JSON.parse(localStorage.getItem(CURSOR_KEY));
    return c && c.fp === fp ? Number(c.cursor) || 0 : null; // null = never synced here
  } catch {
    return null;
  }
}

function writeCursor(fp, cursor) {
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify({ fp, cursor }));
  } catch {
    /* quota — the store layer already surfaces this */
  }
}

async function api(origin, key, path, init) {
  const res = await fetch(`${origin}/api/library${path}`, {
    ...init,
    credentials: 'omit', // capability token, never ambient authority
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${key}` },
  });
  if (res.status === 429) {
    backedOff = true;
    throw new Error('The relay is rate-limiting; sync paused for this session.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Sync failed (${res.status}).`);
  return body;
}

// Reconcile once. `deps` is the storage layer from app.js, passed in rather than
// imported so this module stays testable and app.js keeps owning localStorage.
export async function sync(deps, { manual = false } = {}) {
  const { origin, loadStore, persistStore, gameId, hash128, onStatus, confirmAdopt } = deps;
  const key = getKey();
  if (!origin || !key) return { skipped: true };
  if (!validKey(key)) return { skipped: true, error: 'That library key is not a valid one.' };
  if (backedOff && !manual) return { skipped: true };
  if (!manual && Date.now() - lastPullAt < PULL_FLOOR_MS) return { skipped: true };
  lastPullAt = Date.now();

  const fp = fingerprint(key, hash128);
  const storedCursor = readCursor(fp);
  const firstSync = storedCursor === null;
  let since = storedCursor || 0;

  onStatus?.({ state: 'syncing', fp });

  // ---- pull -----------------------------------------------------------
  let pulled = await api(origin, key, `?since=${since}`);
  let store = loadStore();
  const live = Object.values(store).filter((e) => e && !e.deleted && e.game);

  // A key that opens a never-written library, on a machine that already has
  // games, is far more likely to be a typo than a deliberate fresh start — and
  // pushing into it would fork the library in two, permanently.
  if (pulled.fresh && live.length && firstSync) {
    const ok = await confirmAdopt?.(live.length, fp);
    if (!ok) {
      onStatus?.({ state: 'idle', fp, note: 'Not synced — check the library key.' });
      return { skipped: true };
    }
  }

  let resurrected = 0;
  const applyPage = (page) => {
    for (const r of page.games) {
      const local = store[r.id];
      // A local edit that has not been pushed yet always survives the pull; it
      // will be sent below and, if the server moved on, forked rather than lost.
      if (local?.dirty) continue;
      // First sync only: this machine's own copy outranks a delete made
      // elsewhere, because we cannot tell "never uploaded its work" from
      // "behind". A resurrected game is visible and deletable; a lost one is not.
      if (r.deleted && firstSync && local && !local.deleted && local.game) {
        store[r.id] = { ...local, version: r.version, dirty: 1 };
        resurrected++;
        continue;
      }
      store[r.id] = {
        id: r.id,
        title: r.title ?? local?.title ?? 'Untitled round',
        clientAt: r.updatedAt,
        deleted: r.deleted ? 1 : 0,
        version: r.version,
        dirty: 0,
        game: r.deleted ? local?.game || null : r.game,
      };
    }
    since = page.nextSince;
  };

  applyPage(pulled);
  while (pulled.more) {
    pulled = await api(origin, key, `?since=${since}`);
    applyPage(pulled);
  }

  // ---- push -----------------------------------------------------------
  const dirty = Object.values(store).filter((e) => e && e.dirty);
  let pushed = 0;
  let forked = 0;
  if (dirty.length) {
    const out = dirty.slice(0, 200).map((e) => ({
      id: e.id,
      baseVersion: e.version || 0,
      title: e.title,
      clientAt: e.clientAt || Date.now(),
      deleted: !!e.deleted,
      game: e.deleted ? null : e.game,
    }));
    const res = await api(origin, key, '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games: out }),
    });
    for (const a of res.applied) {
      if (store[a.id]) {
        store[a.id] = { ...store[a.id], version: a.version, dirty: 0 };
        pushed++;
      }
    }
    // Refused because the server moved on. Keep BOTH: adopt the server's copy
    // under its own id, and re-save this machine's edit as a new game. Two
    // visible rows beat one silently overwritten one for hand-authored content.
    for (const c of res.conflicts) {
      const mine = store[c.id];
      if (!mine) continue;
      if (mine.game && !mine.deleted) {
        const title = `${mine.title} (from this laptop)`;
        const copy = { ...mine.game, title };
        const newId = gameId(copy);
        if (!store[newId]) {
          store[newId] = { id: newId, title, clientAt: Date.now(), deleted: 0, version: 0, dirty: 1, game: copy };
          forked++;
        }
      }
      store[c.id] = {
        id: c.id,
        title: c.title ?? mine.title,
        clientAt: c.updatedAt || Date.now(),
        deleted: c.deleted ? 1 : 0,
        version: c.version,
        dirty: 0,
        game: c.deleted ? null : c.game,
      };
    }
    since = res.cursor;
  }

  persistStore(store);
  writeCursor(fp, since);
  onStatus?.({ state: 'idle', fp, at: Date.now(), pushed, forked, resurrected, count: Object.values(store).filter((e) => e && !e.deleted && e.game).length });
  return { pushed, forked, resurrected };
}

// Saves fire per keystroke-ish (the "➕ Append" button calls saveLocal on every
// click), so never sync straight from a handler — coalesce and let it run late.
export function syncSoon(deps) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    lastPullAt = 0; // a local change is worth a round trip now
    sync(deps).catch((e) => deps.onStatus?.({ state: 'error', error: e.message }));
  }, 2000);
}
