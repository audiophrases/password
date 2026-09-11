// relay/library.js — the cloud copy of a teacher's saved games, so the same
// library opens on every computer they teach from.
//
// Why a Durable Object with SQLite, and not KV or D1:
//   - KV is eventually consistent (~60s, list() included). Saving on the laptop
//     and opening on the desktop a moment later would show the OLD game — which
//     is precisely the bug this exists to fix.
//   - D1 would work and even has Time Travel, but it needs `wrangler d1 create`
//     and a database_id pasted into wrangler.jsonc per install. install.bat
//     exists to spare teachers exactly that, and it rewrites js/config.js
//     wholesale, so per-install config is the one thing to avoid.
//   - A DO is already deployed here for the phone relay, so this adds no new
//     provisioning at all — just a second class and a migration tag. It is also
//     single-threaded per library, which is what makes the version counter below
//     correct with no locking.
//
// Addressing: the DO instance name is sha256(library key). The raw key never
// reaches a URL or a log, and there is no server-side secret to deploy — each
// key simply opens its own private library.

import { DurableObject } from 'cloudflare:workers';
// The SAME validator the browser uses (js/ai.js is pure logic — no DOM), so a
// round is normalized identically on both sides and the client's content-hash
// ids keep matching what is stored here.
import { validateGame } from '../js/ai.js';

// A plain 26-letter round is ~4 KB, but "➕ Add circles" appends a word set per
// player, so a round reworked over a year is legitimately far bigger. This is a
// runaway guard, not a quota — storage is the cheapest thing here.
const MAX_GAME_BYTES = 512 * 1024;
const MAX_BATCH = 200;
const MAX_TITLE = 200;
const MAX_ID = 128;

export class Library extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS games (
        id         TEXT PRIMARY KEY,
        version    INTEGER NOT NULL,
        title      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        client_at  INTEGER NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0,
        json       TEXT NOT NULL
      )`);
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS games_by_version ON games(version)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)');
    });
  }

  // A library that has never been written to. Distinguishing this from "empty"
  // is what lets the client warn about a mistyped key instead of silently
  // starting a second, parallel library that never merges with the first.
  isFresh() {
    return [...this.sql.exec("SELECT v FROM meta WHERE k = 'seq'")].length === 0;
  }

  seq() {
    const row = [...this.sql.exec("SELECT v FROM meta WHERE k = 'seq'")][0];
    return row ? Number(row.v) : 0;
  }

  bumpSeq() {
    const next = this.seq() + 1;
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = ?", next, next);
    return next;
  }

  // Everything changed since the client's cursor. Steady state returns nothing,
  // which is what keeps a per-load sync essentially free.
  pull(since, limit) {
    const rows = [
      ...this.sql.exec(
        'SELECT id, version, title, updated_at, deleted, json FROM games WHERE version > ? ORDER BY version LIMIT ?',
        since,
        limit,
      ),
    ];
    return {
      fresh: this.isFresh(),
      cursor: this.seq(),
      // Resume exactly where this page ended; a full pull leaves it at cursor.
      nextSince: rows.length ? Number(rows[rows.length - 1].version) : this.seq(),
      more: rows.length === limit,
      games: rows.map((r) => ({
        id: r.id,
        version: Number(r.version),
        title: r.title,
        updatedAt: Number(r.updated_at),
        deleted: Number(r.deleted) === 1,
        game: Number(r.deleted) === 1 ? null : JSON.parse(r.json),
      })),
    };
  }

  // Optimistic concurrency rather than last-write-wins: last-write-wins could
  // only be decided by a client clock, and school machines' clocks are not
  // trustworthy. A stale write is REFUSED and handed back the server's copy, so
  // the client can keep both instead of destroying one.
  push(games) {
    const now = Date.now();
    const applied = [];
    const conflicts = [];
    for (const g of games) {
      const cur = [...this.sql.exec('SELECT version, title, updated_at, deleted, json FROM games WHERE id = ?', g.id)][0];
      const curVersion = cur ? Number(cur.version) : 0;
      if (Number(g.baseVersion || 0) !== curVersion) {
        // `cur` is absent when the client thinks it has a version of a row the
        // server has never seen — still a conflict, just with nothing to hand back.
        conflicts.push({
          id: g.id,
          version: curVersion,
          title: cur ? cur.title : null,
          updatedAt: cur ? Number(cur.updated_at) : 0,
          deleted: cur ? Number(cur.deleted) === 1 : false,
          game: cur && Number(cur.deleted) !== 1 ? JSON.parse(cur.json) : null,
        });
        continue;
      }
      const version = this.bumpSeq();
      const body = g.deleted ? cur?.json || '{}' : JSON.stringify(g.game);
      this.sql.exec(
        `INSERT INTO games (id, version, title, updated_at, client_at, deleted, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = ?, title = ?, updated_at = ?, client_at = ?, deleted = ?, json = ?`,
        g.id, version, g.title, now, Number(g.clientAt) || now, g.deleted ? 1 : 0, body,
        version, g.title, now, Number(g.clientAt) || now, g.deleted ? 1 : 0, body,
      );
      applied.push({ id: g.id, version });
    }
    return { cursor: this.seq(), applied, conflicts };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return jsonResponse(this.pull(since, MAX_BATCH));
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const games = body && Array.isArray(body.games) ? body.games : null;
      if (!games) return jsonResponse({ error: 'Expected { games: [...] }' }, 400);
      if (games.length > MAX_BATCH) return jsonResponse({ error: `At most ${MAX_BATCH} games per request.` }, 413);
      // Triage, never refuse the batch. Rejecting the whole push because ONE
      // round is unusable strands the entire library — which is the opposite of
      // the point. Store what is good and report the rest back by name.
      const good = [];
      const rejected = [];
      for (const g of games) {
        const reason = checkGame(g);
        if (reason) rejected.push({ id: g?.id ?? null, title: typeof g?.title === 'string' ? g.title : null, reason });
        else good.push(g);
      }
      return jsonResponse({ ...this.push(good), rejected });
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
}

// Returns a human-readable reason the round cannot be stored, or null if it can.
// Normalizes g.game in place so what gets stored is always the canonical shape.
function checkGame(g) {
  if (!g || typeof g.id !== 'string' || !g.id || g.id.length > MAX_ID) return 'it has no usable id';
  if (typeof g.title !== 'string' || g.title.length > MAX_TITLE) {
    return `its title is longer than ${MAX_TITLE} characters`;
  }
  if (g.deleted) return null; // a tombstone carries no game to check
  const size = JSON.stringify(g.game ?? null).length;
  if (size > MAX_GAME_BYTES) {
    return `it is ${Math.round(size / 1024)} KB, over the ${Math.round(MAX_GAME_BYTES / 1024)} KB limit`;
  }
  const res = validateGame(g.game);
  if (!res.ok) return res.errors.slice(0, 2).join(' ');
  g.game = res.game;
  return null;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
