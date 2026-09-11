// relay/assign.js — a game handed to students.
//
// An assignment is a FROZEN COPY of one round, addressed by a short share code.
// It is deliberately a separate Durable Object from the teacher's library:
//
//   teacher  → /api/assign      (needs the library key)  → writes here
//   student  → /api/assignment  (needs only the code)    → reads here
//
// So the read path has no library key anywhere near it. A student who has a
// code can fetch exactly one round and nothing else — they cannot list the
// library, reach another assignment, edit, or delete. Revoking is the one
// write a student can never make, because it re-checks the owner.
//
// The copy is frozen on purpose: editing the round in the library afterwards
// must not silently change what a class is part-way through playing.

import { DurableObject } from 'cloudflare:workers';

export class Assignment extends DurableObject {
  async load() {
    return (await this.ctx.storage.get('a')) || null;
  }

  async fetch(request) {
    const method = request.method;

    if (method === 'GET') {
      const a = await this.load();
      if (!a || a.revoked) return json({ error: 'That code is not active.' }, 404);
      if (a.expiresAt && Date.now() > a.expiresAt) return json({ error: 'That assignment has expired.' }, 410);
      // Only what a student needs. ownerHash never leaves the object.
      return json({ code: a.code, title: a.title, game: a.game, settings: a.settings });
    }

    if (method === 'PUT') {
      const body = await request.json();
      const existing = await this.load();
      // A code already in use by a DIFFERENT library is never overwritten.
      if (existing && existing.ownerHash !== body.ownerHash) return json({ error: 'taken' }, 409);
      await this.ctx.storage.put('a', { ...body, revoked: false });
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const a = await this.load();
      if (!a) return json({ ok: true }); // already gone; revoking twice is not an error
      if (a.ownerHash !== body.ownerHash) return json({ error: 'Not yours to revoke.' }, 403);
      await this.ctx.storage.put('a', { ...a, revoked: true });
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
