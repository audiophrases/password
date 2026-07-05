// game.js — the engine. Each player owns a full letter circle and a time bank. In
// multiplayer, turns rotate one question at a time so the active player's circle
// can take the big center spot while the others wait in the corners.

export class Game extends EventTarget {
  constructor(data, players) {
    super();
    this.data = data;
    this.order = data.letters.map((l) => l.letter);
    this.byLetter = new Map(data.letters.map((l) => [l.letter, l]));
    // duration 0 (or less) = no timer: time banks are Infinity, which the tick
    // math leaves untouched (Infinity - 1 === Infinity) and never hits 0.
    this.duration = data.settings.durationSec;

    this.players = players.map((p) => ({
      name: p.name,
      color: p.color,
      results: Object.fromEntries(this.order.map((l) => [l, 'pending'])),
      queue: [...this.order],
      timeLeft: this.duration > 0 ? this.duration : Infinity,
      done: false,
    }));

    this.activeIndex = 0;
    this.running = false;
    this.paused = false;
    this._timer = null;
    this.revealMs = 1600; // hold a wrong answer on screen before switching players
    this.passMs = 700; // shorter hold for a pass (yellow) before switching
    this._revealing = false;
    this._revealTimer = null;
    this.lastResolved = null; // { letter, playerIndex, state } of the latest judged answer
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

  // Change the per-player time bank on a running game. Shift each active clock by
  // the delta so a player who has already spent time keeps that elapsed amount
  // (e.g. 150 left of 200 → 250 left of 300). Done players are left as they are.
  setDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const old = this.duration;
    this.duration = sec;
    if (sec === old) return;
    this.players.forEach((p) => {
      if (p.done) return;
      if (sec <= 0) p.timeLeft = Infinity; // timer switched off mid-game
      else if (!Number.isFinite(p.timeLeft) || old <= 0) p.timeLeft = sec; // timer switched on
      else p.timeLeft = Math.max(1, p.timeLeft + (sec - old)); // keep elapsed time
    });
  }

  _tick() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (!this.running || this.paused || this._revealing) return;
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
    // Final repaint BEFORE the results: the last letter must show its real state
    // (red for wrong, white for timed-out) instead of staying active-green.
    this.emit('update');
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

  // Hold the just-marked result on screen for `revealMs`, then hand the turn on.
  // Without `always`, the hold only happens when another player is waiting;
  // `always` forces it (used for wrong answers, whose reveal shows the answer).
  _handOver(p, revealMs, finishing, always = false) {
    const advance = () => {
      if (finishing) this._finishPlayer(p); // marks done, then rotates or ends
      else this._rotate();
      if (!this.ended) this.emit('update');
    };
    const willSwitch = this.players.some((x, i) => i !== this.activeIndex && !x.done);
    if (!willSwitch && !always) {
      advance();
      return;
    }
    this._revealing = true;
    this.emit('reveal');
    clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => {
      this._revealing = false;
      advance();
    }, revealMs);
  }

  // Correct: keep the turn. As long as the player keeps answering correctly it
  // stays their go; only a wrong answer or a pass hands the turn on.
  correct() {
    const p = this.active;
    const letter = this.currentLetter;
    if (!letter || p.done || this._revealing) return;
    p.results[letter] = 'correct';
    this.lastResolved = { letter, playerIndex: this.activeIndex, state: 'correct' };
    p.queue.shift();
    if (p.queue.length === 0) this._finishPlayer(p); // cleared the whole board this turn
    if (!this.ended) this.emit('update');
  }

  // Wrong: always hold the red reveal (the app shows the correct answer during
  // it — even in single player), then hand the turn on.
  wrong() {
    const p = this.active;
    const letter = this.currentLetter;
    if (!letter || p.done || this._revealing) return;
    p.results[letter] = 'wrong';
    this.lastResolved = { letter, playerIndex: this.activeIndex, state: 'wrong' };
    p.queue.shift();
    this._handOver(p, this.revealMs, p.queue.length === 0, true);
  }

  // Pass: requeue this letter at the back (no penalty) and hand the turn on after
  // a shorter yellow reveal (no answer shown — the letter comes back later).
  pass() {
    const p = this.active;
    const letter = this.currentLetter;
    if (!letter || p.done || this._revealing) return;
    if (p.results[letter] === 'pending') p.results[letter] = 'passed';
    this.lastResolved = { letter, playerIndex: this.activeIndex, state: 'passed' };
    p.queue.push(p.queue.shift());
    this._handOver(p, this.passMs, false);
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  results() {
    // Infinity - Infinity is NaN, so guard the time tiebreak for no-timer games.
    return this.players
      .map((p) => ({ name: p.name, color: p.color, score: this.score(p), timeLeft: p.timeLeft }))
      .sort((a, b) => {
        const dt = b.timeLeft - a.timeLeft;
        return b.score - a.score || (Number.isFinite(dt) ? dt : 0);
      });
  }
}
