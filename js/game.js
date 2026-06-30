// game.js — the engine. Each player owns a full letter circle and a time bank. In
// multiplayer, turns rotate one question at a time so the active player's circle
// can take the big center spot while the others wait in the corners.

export class Game extends EventTarget {
  constructor(data, players) {
    super();
    this.data = data;
    this.order = data.letters.map((l) => l.letter);
    this.byLetter = new Map(data.letters.map((l) => [l.letter, l]));
    this.duration = data.settings.durationSec;

    this.players = players.map((p) => ({
      name: p.name,
      color: p.color,
      results: Object.fromEntries(this.order.map((l) => [l, 'pending'])),
      queue: [...this.order],
      timeLeft: this.duration,
      done: false,
    }));

    this.activeIndex = 0;
    this.running = false;
    this.paused = false;
    this._timer = null;
  }

  get active() {
    return this.players[this.activeIndex];
  }

  get currentLetter() {
    return this.active.queue[0] || null;
  }

  get currentEntry() {
    const l = this.currentLetter;
    return l ? this.entryFor(this.activeIndex, l) : null;
  }

  // Each player gets their own variant for a letter, so players in the same
  // room don't share words. Wraps if there are fewer variants than players.
  entryFor(playerIndex, letter) {
    const e = this.byLetter.get(letter);
    if (!e) return null;
    const v = e.variants[playerIndex % e.variants.length];
    return { letter: e.letter, type: e.type, answer: v.answer, accept: v.accept, clue: v.clue };
  }

  score(player = this.active) {
    return Object.values(player.results).filter((s) => s === 'correct').length;
  }

  start() {
    this.running = true;
    this.paused = false;
    this._tick();
    this.emit('update');
  }

  togglePause() {
    this.paused = !this.paused;
    this.emit('update');
  }

  _tick() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (!this.running || this.paused) return;
      const p = this.active;
      p.timeLeft = Math.max(0, p.timeLeft - 1);
      if (p.timeLeft === 0) {
        this._finishPlayer(p);
        if (!this.ended) this.emit('update');
      }
      this.emit('tick');
    }, 1000);
  }

  _finishPlayer(p) {
    p.done = true;
    p.queue = [];
    if (this.players.every((x) => x.done)) {
      this._end();
    } else {
      this._rotate();
    }
  }

  _end() {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    clearInterval(this._timer);
    this.emit('end');
  }

  _rotate() {
    if (this.players.length === 1) return;
    let next = this.activeIndex;
    for (let i = 0; i < this.players.length; i++) {
      next = (next + 1) % this.players.length;
      if (!this.players[next].done) break;
    }
    this.activeIndex = next;
  }

  _resolve(state) {
    const p = this.active;
    const letter = this.currentLetter;
    if (!letter || p.done) return;
    p.results[letter] = state;
    p.queue.shift();
    if (p.queue.length === 0) {
      this._finishPlayer(p); // marks done, then rotates or ends
    } else {
      this._rotate();
    }
    if (!this.ended) this.emit('update');
  }

  correct() {
    this._resolve('correct');
  }

  wrong() {
    this._resolve('wrong');
  }

  // pass: requeue this letter at the back, no penalty, pass the turn.
  pass() {
    const p = this.active;
    const letter = this.currentLetter;
    if (!letter || p.done) return;
    if (p.results[letter] === 'pending') p.results[letter] = 'passed';
    p.queue.push(p.queue.shift());
    this._rotate();
    if (!this.ended) this.emit('update');
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  results() {
    return this.players
      .map((p) => ({ name: p.name, color: p.color, score: this.score(p), timeLeft: p.timeLeft }))
      .sort((a, b) => b.score - a.score || b.timeLeft - a.timeLeft);
  }
}
