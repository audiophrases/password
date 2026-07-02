// circle.js — renders one player's alphabet circle. Letters are positioned around
// a ring; the center holds the player's name/score (or the webcam in camera mode).

export class Circle {
  constructor(letters) {
    this.letters = letters;
    this.chips = new Map();

    this.el = document.createElement('div');
    this.el.className = 'circle';

    this.center = document.createElement('div');
    this.center.className = 'circle-center';
    this.el.appendChild(this.center);

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'circle-name';
    this.center.appendChild(this.nameEl);

    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'circle-score';
    this.center.appendChild(this.scoreEl);

    this.timeEl = document.createElement('div');
    this.timeEl.className = 'circle-time';
    this.center.appendChild(this.timeEl);

    const n = letters.length;
    letters.forEach((ch, i) => {
      const angle = (-90 + (i * 360) / n) * (Math.PI / 180);
      const r = 46; // percent of half-size
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.dataset.letter = ch;
      chip.textContent = ch;
      chip.style.left = `${50 + r * Math.cos(angle)}%`;
      chip.style.top = `${50 + r * Math.sin(angle)}%`;
      this.el.appendChild(chip);
      this.chips.set(ch, chip);
    });
  }

  setName(name) {
    this.nameEl.textContent = name || '';
  }

  setTime(seconds) {
    if (seconds == null) {
      this.timeEl.textContent = '';
      return;
    }
    if (!Number.isFinite(seconds)) {
      // no-timer game
      this.timeEl.textContent = '∞';
      this.timeEl.classList.remove('low');
      return;
    }
    this.timeEl.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    this.timeEl.classList.toggle('low', seconds <= 15);
  }

  setScore(score, total) {
    this.scoreEl.textContent = total != null ? `${score}/${total}` : `${score}`;
  }

  setColor(color) {
    this.el.style.setProperty('--player', color);
  }

  setStates(stateMap) {
    for (const [letter, chip] of this.chips) {
      const st = stateMap[letter] || 'pending';
      chip.dataset.state = st;
    }
  }

  setActive(letter) {
    for (const [l, chip] of this.chips) {
      chip.classList.toggle('active', l === letter);
    }
  }

  setMini(isMini) {
    this.el.classList.toggle('mini', isMini);
  }
}
