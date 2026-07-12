// remote.js — phone controller. Sends button presses to the game (host) and
// renders the game state pushed back, so the teacher can read the clue here too.
import { connect } from './link.js';

const $ = (id) => document.getElementById(id);

const link = connect({
  role: 'remote',
  onState: applyState,
  onStatus: (s) => setOnline(s === 'open'),
});

// Enable/disable the controls with the connection. Receiving any state below
// also flips this on — if data is arriving the socket is open, so the buttons
// must work, even if a transient error briefly flagged us offline.
function setOnline(online) {
  document.body.classList.toggle('offline', !online);
  $('status').textContent = online ? 'Connected' : 'Offline';
}

function send(action, extra) {
  const sent = link.send({ t: 'cmd', action, ...extra });
  if (!sent) setOnline(false); // socket wasn't open — reflect it so the teacher sees why
}

// Delegated so buttons built dynamically (the per-player time bank) work the
// same as the static ones without needing their own listeners wired up.
document.body.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const extra = {};
  if (b.dataset.sec) extra.seconds = +b.dataset.sec;
  if (b.dataset.player != null) extra.playerIndex = +b.dataset.player;
  send(b.dataset.act, Object.keys(extra).length ? extra : undefined);
});

// push-to-talk: hold the button to keep the laptop mic listening
const talk = $('talk');
const startTalk = (e) => {
  e.preventDefault();
  talk.classList.add('live');
  send('talk-start');
};
const stopTalk = () => {
  if (talk.classList.contains('live')) {
    talk.classList.remove('live');
    send('talk-stop');
  }
};
talk.addEventListener('pointerdown', startTalk);
talk.addEventListener('pointerup', stopTalk);
talk.addEventListener('pointerleave', stopTalk);
talk.addEventListener('pointercancel', stopTalk);

function fmt(t) {
  if (t == null) return '';
  if (t < 0) return '∞'; // host sends -1 for a no-timer game
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One row per player, each with its own +10s/+30s — so time can be given to
// anyone, not just whoever is currently answering.
function renderTimebank(roster) {
  const box = $('timebank');
  if (!box) return;
  box.innerHTML = '';
  (roster || []).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'tb-row' + (p.active ? ' active' : '') + (p.done ? ' done' : '');
    row.innerHTML =
      `<span class="tb-name" style="border-left:6px solid ${p.color || '#ccc'}">${esc(p.name || `Player ${i + 1}`)}` +
      `<span class="tb-time">${fmt(p.time)}</span></span>` +
      `<button data-act="add-time" data-player="${i}" data-sec="10">+10s</button>` +
      `<button data-act="add-time" data-player="${i}" data-sec="30">+30s</button>`;
    box.appendChild(row);
  });
}

// ---- ⚙ game settings panel: mirrors live values, applies without restart ----
const rset = $('r-settings');
$('rs-strict').addEventListener('input', (e) => ($('rs-strict-out').textContent = e.target.value));
$('rs-rate').addEventListener('input', (e) => ($('rs-rate-out').textContent = e.target.value));

// Fill the panel from the game's live settings — but never while the teacher has
// it open and is mid-edit.
function fillSettings(s) {
  if (!s || rset.open) return;
  $('rs-mode').value = s.mode || 'voice-auto';
  if (typeof s.strictness === 'number') {
    $('rs-strict').value = s.strictness;
    $('rs-strict-out').textContent = s.strictness;
  }
  if (typeof s.ttsRate === 'number') {
    $('rs-rate').value = s.ttsRate;
    $('rs-rate-out').textContent = s.ttsRate;
  }
  if (typeof s.durationSec === 'number') $('rs-duration').value = s.durationSec;
  if (typeof s.autoRead === 'boolean') $('rs-autoread').checked = s.autoRead;
  // Neural voices for the game's language (e.g. Catalan: Enric / Joana). The
  // host sends an empty list when the neural server is off — hide the picker.
  if (Array.isArray(s.voices)) {
    const sel = $('rs-voice');
    $('rs-voice-label').hidden = s.voices.length === 0;
    sel.innerHTML = '';
    s.voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      sel.appendChild(o);
    });
    if (s.voiceId) sel.value = s.voiceId;
  }
  // One name input per player, tinted with the player's circle colour.
  if (Array.isArray(s.players)) {
    const box = $('rs-players');
    box.innerHTML = '';
    s.players.forEach((p, i) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'rs-name';
      inp.value = p.name || `Player ${i + 1}`;
      inp.style.borderLeft = `6px solid ${p.color || '#ccc'}`;
      box.appendChild(inp);
    });
  }
}

$('rs-apply').addEventListener('click', () => {
  const sent = link.send({
    t: 'cmd',
    action: 'apply-settings',
    settings: {
      mode: $('rs-mode').value,
      strictness: parseFloat($('rs-strict').value),
      ttsRate: parseFloat($('rs-rate').value),
      durationSec: Math.max(0, Math.floor(+$('rs-duration').value) || 0),
      autoRead: $('rs-autoread').checked,
      voiceName: $('rs-voice').value || undefined, // undefined = leave the voice alone
      // keep index order — the host matches names to players by position
      players: [...document.querySelectorAll('#rs-players .rs-name')].map((i) => ({ name: i.value.trim() })),
    },
  });
  if (!sent) setOnline(false);
  const btn = $('rs-apply');
  btn.textContent = sent ? 'Applied ✓' : 'Offline ✕';
  setTimeout(() => (btn.textContent = '⚡ Apply to game'), 1200);
});

function applyState(m) {
  setOnline(true); // state arrived → the socket is open → keep the controls live
  if (m.screen === 'setup') {
    $('r-player').textContent = 'Setup';
    $('r-player').style.color = '';
    $('r-time').textContent = '';
    $('r-score').textContent = '';
    $('r-letter').textContent = '';
    $('r-kind').textContent = '';
    $('r-clue').textContent = m.loaded ? `Loaded: ${m.title} — press ▶ Start` : 'Load a game on the laptop first.';
    $('r-answer').textContent = '';
    $('r-accept').textContent = '';
    $('r-sugg').textContent = '';
    renderTimebank([]);
    return;
  }
  $('r-player').textContent = m.player || '';
  $('r-player').style.color = m.color || '';
  $('r-time').textContent = fmt(m.time);
  $('r-score').textContent = m.total != null ? `${m.score}/${m.total}` : '';
  $('r-letter').textContent = m.letter || '';
  $('r-kind').textContent = m.kind || '';
  $('r-clue').textContent = m.clue || '';
  $('r-answer').textContent = m.answer || '';
  $('r-accept').textContent = m.accept ? ` · also: ${m.accept}` : '';
  $('r-sugg').textContent = m.paused
    ? '⏸ paused'
    : m.suggestion
    ? `speech suggests: ${m.suggestion === 'wrong' ? 'wrong' : 'correct'}`
    : '';
  // Mute toggle: lit while the game's automatic read-aloud is off.
  $('mute').classList.toggle('on', !!m.muted);
  $('mute').textContent = m.muted ? '🔇 Muted' : '🔇 Mute';
  renderTimebank(m.roster);
  fillSettings(m.settings);
}
