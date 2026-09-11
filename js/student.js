// student.js — the play-only page a student opens from an assignment link.
//
// This module deliberately does NOT import app.js. It reuses the engine
// (game.js), the circle renderer (circle.js), the answer matcher (match.js) and
// speech (speech.js), so a round plays exactly as it does for the teacher —
// but the library, the editor, import/export and the library key are not
// present in this page at all. There is nothing here for a student to break.
//
// Only two judging modes can appear: type-in and voice-auto. The other two
// (voice-assist, teacher-judge) wait for a teacher to press a key, so a student
// would sit in front of a round that never advances. The Worker enforces this
// too — see relay/worker.js — this is the second half of the same rule.

import { Game } from './game.js';
import { Circle } from './circle.js';
import { scoreAnswer } from './match.js';
import { Recognizer, recognitionSupported, speak, stopSpeaking } from './speech.js';

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
const only = (id) => {
  for (const s of ['s-join', 's-ready', 's-play', 's-done']) (s === id ? show : hide)(s);
};

const state = { assignment: null, game: null, circle: null, recognizer: null, listening: false };

// ---------- loading the assignment ----------

async function loadAssignment(code) {
  const res = await fetch(`/api/assignment?code=${encodeURIComponent(code)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'That code did not work.');
  return body;
}

function describe(a) {
  const n = a.game.letters.length;
  const mins = a.settings.durationSec ? `${Math.round(a.settings.durationSec / 60)} min` : 'no time limit';
  const how =
    a.settings.mode === 'voice-auto'
      ? 'Say each answer out loud — hold the 🎤 button while you speak.'
      : 'Type each answer and press Enter.';
  return `${n} letters · ${mins}. ${how} Skip one with Pass and it comes back later.`;
}

async function join(code) {
  const msg = $('s-join-msg');
  msg.className = 'msg';
  msg.textContent = 'Looking for that code…';
  try {
    const a = await loadAssignment(code);
    state.assignment = a;
    // Remember it so a student who closes the tab mid-lesson can reopen without
    // retyping. Their own browser only — nothing leaves the device.
    try {
      localStorage.setItem('password.student.code.v1', a.code);
    } catch {
      /* private window */
    }
    history.replaceState(null, '', `?code=${a.code}`);
    $('s-title').textContent = a.title;
    $('s-rules').textContent = describe(a);
    try {
      $('s-player').value = localStorage.getItem('password.student.name.v1') || '';
    } catch {
      /* ignore */
    }
    only('s-ready');
  } catch (e) {
    msg.className = 'msg error';
    msg.textContent = e.message;
    only('s-join');
  }
}

// ---------- playing ----------

function startRound() {
  const a = state.assignment;
  const name = $('s-player').value.trim();
  try {
    localStorage.setItem('password.student.name.v1', name);
  } catch {
    /* ignore */
  }

  // The engine expects a settings block; the assignment's is authoritative and
  // the student has no way to change it.
  const data = { ...a.game, settings: { ...a.game.settings, ...a.settings } };
  const g = new Game(data, [{ name: name || 'You', color: '#e8632c' }]);
  state.game = g;

  const circle = new Circle(data.letters.map((l) => l.letter));
  state.circle = circle;
  $('s-circle-wrap').innerHTML = '';
  $('s-circle-wrap').appendChild(circle.el);
  circle.setName(name || 'You');
  circle.setColor('#e8632c');

  // Voice mode still leaves the typing box available when the browser has no
  // speech recognition — a locked-down or non-Chrome browser would otherwise
  // leave the student with no way to answer at all.
  const canHear = recognitionSupported();
  const voice = a.settings.mode === 'voice-auto' && canHear;
  $('s-answer').hidden = voice;
  $('s-enter').hidden = voice;
  $('s-talk').classList.toggle('hidden', !voice);
  if (a.settings.mode === 'voice-auto' && !canHear) {
    flash('This browser cannot hear you — type your answers instead.', 'msg');
  }

  g.addEventListener('update', paint);
  g.addEventListener('tick', paint);
  g.addEventListener('reveal', paint);
  g.addEventListener('end', finish);
  only('s-play');
  g.start();
  paint();
}

function paint() {
  const g = state.game;
  if (!g) return;
  const p = g.players[0];
  state.circle.setStates(p.results);
  state.circle.setActive(g.currentLetter);
  state.circle.setScore(g.score(), g.order.length);
  state.circle.setTime(p.timeLeft);
  const e = g.currentEntry;
  $('s-letter').textContent = e ? e.letter : '—';
  $('s-clue').textContent = e ? e.clue : '';
  if (!g.ended) $('s-answer').focus({ preventScroll: true });
}

function flash(text, cls = 'msg ok') {
  const el = $('s-feedback');
  el.className = cls;
  el.textContent = text;
}

// hyps is the recognizer's shape — [{ transcript, confidence }] — and a typed
// answer is wrapped to match, so both routes score identically.
function judge(hyps) {
  const g = state.game;
  const e = g?.currentEntry;
  if (!e || !hyps.length || !hyps[0].transcript) return;
  const { decision } = scoreAnswer([e.answer, ...(e.accept || [])], hyps, state.assignment.settings.strictness);
  // With a teacher, the middle band means "ask the human". There is no human
  // here, so a near miss counts — an ESL student who knew the word should not
  // lose the point to a typo or an accent — but show the real spelling.
  if (decision === 'wrong') {
    flash(`✗ it was “${e.answer}”`, 'msg error');
    g.wrong();
  } else {
    flash(decision === 'review' ? `✓ close — it is spelled “${e.answer}”` : `✓ ${e.answer}`, 'msg ok');
    g.correct();
  }
  $('s-answer').value = '';
}

const typed = (s) => [{ transcript: s, confidence: 1 }];

function finish() {
  const g = state.game;
  stopSpeaking();
  stopListening();
  const total = g.order.length;
  const got = g.score();
  $('s-score').textContent = `${got} of ${total} correct`;
  // Show the words they missed — the point of the exercise is learning them.
  const missed = Object.entries(g.players[0].results)
    .filter(([, st]) => st !== 'correct')
    .map(([letter]) => g.entryFor(0, letter))
    .filter(Boolean);
  $('s-review').innerHTML = missed.length
    ? `<h2>Words to remember</h2>` +
      missed
        .map((e) => `<div class="s-row"><b>${esc(e.letter)}</b> <span>${esc(e.answer)}</span><em>${esc(e.clue)}</em></div>`)
        .join('')
    : '<p>Every word correct — nothing to review.</p>';
  only('s-done');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- voice ----------

function ensureRecognizer() {
  if (state.recognizer) return state.recognizer;
  const lang = state.assignment.game.langCode || 'en-US';
  const r = new Recognizer({ lang, maxAlternatives: 5 });
  // Five alternatives, scored together: ESL pronunciation often pushes the right
  // word down to hypothesis two or three, and scoreAnswer checks them all.
  r.onHypotheses = (hyps) => judge(hyps);
  r.onStateChange = (on) => {
    state.listening = on;
    $('s-talk').classList.toggle('listening', on);
  };
  state.recognizer = r;
  return r;
}

function startListening() {
  if (state.listening || !recognitionSupported()) return;
  ensureRecognizer().start();
}

function stopListening() {
  state.recognizer?.stop(); // onStateChange clears the button styling
}

// ---------- wiring ----------

$('s-join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('s-code').value.trim().toLowerCase();
  if (code) join(code);
});

$('s-start').addEventListener('click', startRound);
$('s-again').addEventListener('click', startRound);

$('s-answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  judge(typed($('s-answer').value.trim()));
});

$('s-pass').addEventListener('click', () => {
  state.game?.pass();
  $('s-answer').value = '';
  flash('Passed — it will come back.', 'msg');
});

$('s-hear').addEventListener('click', () => {
  const e = state.game?.currentEntry;
  if (e) speak(e.clue, state.assignment.game.langCode || 'en-US');
});

$('s-quit').addEventListener('click', () => {
  // _end() is the engine's own way to close a round early; app.js reaches the
  // same place via endToSetup(), which is bound up with the teacher's screens.
  if (confirm('Finish the round now?')) state.game?._end();
});

for (const [down, up] of [['pointerdown', 'pointerup'], ['touchstart', 'touchend']]) {
  $('s-talk').addEventListener(down, (e) => {
    e.preventDefault();
    startListening();
  });
  $('s-talk').addEventListener(up, (e) => {
    e.preventDefault();
    stopListening();
  });
}
$('s-talk').addEventListener('pointerleave', stopListening);

// ---------- boot ----------

const fromUrl = (new URLSearchParams(location.search).get('code') || '').trim().toLowerCase();
let remembered = '';
try {
  remembered = localStorage.getItem('password.student.code.v1') || '';
} catch {
  /* private window */
}
if (fromUrl) {
  only('s-join');
  join(fromUrl);
} else {
  only('s-join');
  if (remembered) $('s-code').value = remembered;
  $('s-code').focus();
}
