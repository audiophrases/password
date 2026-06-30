// remote.js — phone controller. Sends button presses to the game (host) and
// renders the game state pushed back, so the teacher can read the clue here too.
import { connect } from './link.js';

const $ = (id) => document.getElementById(id);

const link = connect({
  role: 'remote',
  onState: applyState,
  onStatus: (s) => {
    const online = s === 'open';
    document.body.classList.toggle('offline', !online);
    $('status').textContent = online ? 'Connected' : 'Offline';
  },
});

function send(action) {
  link.send({ t: 'cmd', action });
}

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', () => send(b.dataset.act))
);

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
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function applyState(m) {
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
}
