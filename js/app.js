// app.js — wires the setup screen, game engine, speech, and camera together.
import { buildPrompt, parseGameText, validateGame, ALPHABET_EN } from './ai.js';
import { Game } from './game.js';
import { Circle } from './circle.js';
import { Recognizer, recognitionSupported, speak, stopSpeaking, voicesFor, onVoices } from './speech.js';
import { scoreAnswer } from './match.js';
import { Camera, toggleFullscreen } from './camera.js';
import { connect } from './link.js';

const $ = (id) => document.getElementById(id);
const PLAYER_COLORS = ['#e8632c', '#1f9d55', '#2b6cb0', '#9b2c98', '#b7791f', '#0d9488'];

const state = {
  game: null,
  data: null,
  circles: [],
  players: [],
  recognizer: null,
  camera: new Camera(),
  cameraOn: false,
  autoRead: false,
  voiceName: null,
  lastSuggestion: null,
  link: null,
  remoteUrl: '',
  remotes: 0,
};

// ---------- Setup screen ----------

function defaultPlayers() {
  return [{ name: 'Player 1', color: PLAYER_COLORS[0] }];
}

function renderPlayers(players) {
  const list = $('players-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <input class="p-name" type="text" value="${p.name}" data-i="${i}" />`;
    list.appendChild(row);
  });
  list.querySelectorAll('.p-name').forEach((inp) =>
    inp.addEventListener('input', (e) => {
      players[+e.target.dataset.i].name = e.target.value;
    })
  );
}

// Voice picker, populated from the browser's voices for the chosen language.
function populateVoices(langCode) {
  const sel = $('voice');
  const prev = sel.value;
  const list = voicesFor(langCode);
  sel.innerHTML = '';
  if (!list.length) {
    sel.innerHTML = '<option value="">(system default)</option>';
    state.voiceName = null;
    return;
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*.*$/, ''); // shorten label
    sel.appendChild(o);
  }
  if (list.some((v) => v.name === prev)) {
    sel.value = prev;
    state.voiceName = prev;
  } else {
    state.voiceName = list[0].name; // best = a "Natural" Edge voice when available
    sel.value = state.voiceName;
  }
}

function setupScreen() {
  const players = defaultPlayers();
  state.players = players;
  renderPlayers(players);

  // Number of players (source of truth lives in section 1).
  $('num-players').addEventListener('change', () => {
    const n = Math.max(1, Math.min(6, +$('num-players').value || 1));
    $('num-players').value = n;
    while (players.length < n) {
      const i = players.length;
      players.push({ name: `Player ${i + 1}`, color: PLAYER_COLORS[i % PLAYER_COLORS.length] });
    }
    players.length = n;
    renderPlayers(players);
  });

  // Language drives the default letter set, speech recognition, and the read-aloud voice.
  $('language').addEventListener('change', () => {
    const opt = $('language').selectedOptions[0];
    $('letters').value = opt.dataset.letters;
    populateVoices(opt.value);
  });
  $('voice').addEventListener('change', () => (state.voiceName = $('voice').value || null));
  $('test-voice').addEventListener('click', () => {
    const code = $('language').value;
    const samples = {
      'en-US': 'This is the voice that will read the clues aloud.',
      'fr-FR': 'Voici la voix qui lira les définitions à voix haute.',
      'es-ES': 'Esta es la voz que leerá las pistas en voz alta.',
      'ca-ES': 'Aquesta és la veu que llegirà les pistes en veu alta.',
    };
    speak(samples[code] || samples['en-US'], code, state.voiceName);
  });
  populateVoices($('language').value);
  onVoices(() => populateVoices($('language').value)); // re-list once Edge's natural voices load

  $('build-prompt').addEventListener('click', () => {
    const opt = $('language').selectedOptions[0];
    const letters = ($('letters').value || ALPHABET_EN.join('')).toUpperCase().replace(/[^A-ZÑ]/g, '').split('');
    const prompt = buildPrompt({
      language: opt.dataset.name,
      level: $('level').value,
      topic: $('topic').value.trim() || 'everyday vocabulary',
      letters: letters.length ? letters : ALPHABET_EN,
      langCode: opt.value,
      durationSec: +$('duration').value || 200,
    });
    $('prompt-output').value = prompt;
  });

  $('copy-prompt').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('prompt-output').value).catch(() => {});
    flash($('copy-prompt'), 'Copied!');
  });

  $('load-json').addEventListener('click', () => loadGameText($('json-input').value, players));

  // Load a .txt or .json file (both parsed as JSON).
  $('load-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    $('json-input').value = text;
    loadGameText(text, players);
    e.target.value = '';
  });

  $('load-sample').addEventListener('click', async () => {
    const res = await fetch('./sample-game.json').then((r) => r.text()).catch(() => null);
    if (res) {
      $('json-input').value = res;
      loadGameText(res, players);
    }
  });

  $('start-game').addEventListener('click', beginGame);

  $('speech-note').textContent = recognitionSupported()
    ? 'Tip: open in Microsoft Edge for the most natural (neural) read-aloud voices.'
    : 'Speech recognition needs Chrome/Edge (teacher-judge and type-in still work). Open in Edge for the most natural voices.';
}

function loadGameText(text, players) {
  const result = parseGameText(text);
  const msg = $('validation');
  if (!result.ok) {
    msg.className = 'msg error';
    msg.textContent = result.errors.slice(0, 4).join(' ');
    state.data = null;
    $('start-game').disabled = true;
    return;
  }
  state.data = result.game;
  // sync UI defaults from the loaded game
  $('mode').value = result.game.settings.mode;
  $('strictness').value = result.game.settings.strictness;
  msg.className = 'msg ok';
  msg.textContent = `Loaded "${result.game.title}" — ${result.game.letters.length} letters. Ready.`;
  $('start-game').disabled = false;
  pushRemoteState();
}

// ---------- Manual create / edit + save to file ----------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function currentLetterSet() {
  return ($('letters').value || ALPHABET_EN.join('')).toUpperCase().replace(/[^A-ZÑ]/g, '').split('');
}

function editorRowEl({ letter = '', type = 'starts', answer = '', accept = '', clue = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'erow';
  row.innerHTML = `
    <input class="e-letter" maxlength="2" value="${esc(letter)}" />
    <select class="e-type">
      <option value="starts">starts with</option>
      <option value="contains">contains</option>
    </select>
    <input class="e-answer" value="${esc(answer)}" placeholder="answer" />
    <input class="e-accept" value="${esc(accept)}" placeholder="also accept (comma-separated)" />
    <input class="e-clue" value="${esc(clue)}" placeholder="clue / definition" />
    <button class="e-del" title="Remove">✕</button>`;
  row.querySelector('.e-type').value = type === 'contains' ? 'contains' : 'starts';
  row.querySelector('.e-del').addEventListener('click', () => row.remove());
  return row;
}

function renderEditorRows(list) {
  const c = $('editor-rows');
  c.innerHTML = '';
  list.forEach((r) => c.appendChild(editorRowEl(r)));
}

// Open the editor pre-filled from the loaded game, or scaffolded blank A–Z.
function openEditor() {
  const data = state.data;
  $('editor-title').value = data?.title || '';
  const rows = data?.letters?.length
    ? data.letters.map((l) => ({ letter: l.letter, type: l.type, answer: l.answer, accept: (l.accept || []).join(', '), clue: l.clue }))
    : currentLetterSet().map((ch) => ({ letter: ch, type: 'starts', answer: '', accept: '', clue: '' }));
  renderEditorRows(rows);
  $('editor-msg').textContent = '';
  $('editor-msg').className = 'msg';
  $('setup').classList.add('hidden');
  $('editor').classList.remove('hidden');
}

function scaffoldEditor() {
  const present = new Set([...$('editor-rows').querySelectorAll('.e-letter')].map((i) => i.value.trim().toUpperCase()));
  currentLetterSet().forEach((ch) => {
    if (!present.has(ch)) $('editor-rows').appendChild(editorRowEl({ letter: ch }));
  });
}

function closeEditor() {
  $('editor').classList.add('hidden');
  $('setup').classList.remove('hidden');
}

// Collect + validate the editor into state.data; returns true on success.
function saveEditorData() {
  const opt = $('language').selectedOptions[0];
  const letters = [...$('editor-rows').querySelectorAll('.erow')]
    .map((row) => ({
      letter: row.querySelector('.e-letter').value.trim().toUpperCase(),
      type: row.querySelector('.e-type').value,
      answer: row.querySelector('.e-answer').value.trim(),
      accept: row.querySelector('.e-accept').value.split(',').map((s) => s.trim()).filter(Boolean),
      clue: row.querySelector('.e-clue').value.trim(),
    }))
    .filter((l) => l.letter);

  const msg = $('editor-msg');
  if (!letters.length) {
    msg.className = 'msg error';
    msg.textContent = 'Add at least one letter.';
    return false;
  }
  const incomplete = letters.filter((l) => !l.answer || !l.clue).map((l) => l.letter);
  if (incomplete.length) {
    msg.className = 'msg error';
    msg.textContent = `Add an answer and a clue for: ${incomplete.join(', ')}`;
    return false;
  }

  const game = {
    title: $('editor-title').value.trim() || 'Manual round',
    language: opt.dataset.name,
    langCode: opt.value,
    settings: { durationSec: +$('duration').value || 200, mode: $('mode').value, strictness: parseFloat($('strictness').value) },
    letters,
  };
  const result = validateGame(game);
  if (!result.ok) {
    msg.className = 'msg error';
    msg.textContent = result.errors.slice(0, 4).join(' ');
    return false;
  }
  state.data = result.game;
  $('json-input').value = JSON.stringify(result.game, null, 2);
  const v = $('validation');
  v.className = 'msg ok';
  v.textContent = `Loaded "${result.game.title}" — ${result.game.letters.length} letters. Ready.`;
  $('start-game').disabled = false;
  return true;
}

// Save the current game to a local .json file.
function downloadGame() {
  if (!state.data) {
    const v = $('validation');
    v.className = 'msg error';
    v.textContent = 'Load or create a game first.';
    return;
  }
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download =
    (state.data.title || 'password-game').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bindEditor() {
  $('edit-game').addEventListener('click', openEditor);
  $('save-file').addEventListener('click', downloadGame);
  $('editor-add').addEventListener('click', () => $('editor-rows').appendChild(editorRowEl({})));
  $('editor-scaffold').addEventListener('click', scaffoldEditor);
  $('editor-save').addEventListener('click', () => {
    if (saveEditorData()) {
      closeEditor();
      pushRemoteState();
    }
  });
  $('editor-download').addEventListener('click', () => {
    if (saveEditorData()) downloadGame();
  });
  $('editor-cancel').addEventListener('click', closeEditor);
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

function beginGame() {
  if (state.data && $('game').classList.contains('hidden')) startGame(state.players);
}

// ---------- Phone remote (companion controller over the local relay) ----------

async function initRemoteLink() {
  let info = null;
  try {
    const r = await fetch('/lan-info');
    if (r.ok) info = await r.json();
  } catch {
    /* relay not running */
  }
  if (!info) {
    if ($('remote-info')) $('remote-info').textContent = 'Phone remote: run “node server.js” on the laptop to enable it.';
    return;
  }
  state.remoteUrl = `http://${info.ip}:${info.port}/remote`;
  state.link = connect({
    role: 'host',
    onCmd: handleRemoteCommand,
    onPeers: (m) => {
      state.remotes = m.remotes;
      renderRemoteInfo();
    },
    onStatus: (s) => {
      if (s === 'open') pushRemoteState();
    },
  });
  renderRemoteInfo();
}

function renderRemoteInfo() {
  const el = $('remote-info');
  if (!el || !state.remoteUrl) return;
  const conn = state.remotes > 0 ? `connected: ${state.remotes} 📱` : 'waiting for phone…';
  el.innerHTML = `📱 Phone remote — open <b>${state.remoteUrl}</b> on the same Wi‑Fi · ${conn}`;
}

// Map a remote button to the same actions as the keyboard/on-screen controls.
function handleRemoteCommand(action) {
  const g = state.game;
  const inGame = g && !$('game').classList.contains('hidden');
  switch (action) {
    case 'correct': if (inGame) g.correct(); break;
    case 'wrong': if (inGame) g.wrong(); break;
    case 'pass': if (inGame) g.pass(); break;
    case 'talk-start': if (inGame) startTalk(); break;
    case 'talk-stop': stopTalk(); break;
    case 'read': if (inGame) readCurrentClue(); break;
    case 'toggle-clue': if (inGame) toggleClue(); break;
    case 'camera': if (inGame) toggleCamera(); break;
    case 'fullscreen': toggleFullscreen($('game')); break;
    case 'start': beginGame(); break;
    case 'exit': if (inGame) endToSetup(); break;
    case 'pause':
      if (inGame) {
        g.togglePause();
        $('pause').textContent = g.paused ? '▶ Resume' : '⏸ Pause';
        pushRemoteState();
      }
      break;
  }
}

// Push current game context to any connected phones.
function pushRemoteState() {
  if (!state.link) return;
  const g = state.game;
  const inGame = g && !$('game').classList.contains('hidden');
  if (!inGame) {
    state.link.send({ t: 'state', screen: 'setup', loaded: !!state.data, title: state.data?.title || null });
    return;
  }
  const p = g.active;
  const e = g.currentEntry;
  state.link.send({
    t: 'state',
    screen: 'game',
    player: p.name,
    color: p.color,
    time: p.timeLeft,
    score: g.score(p),
    total: g.order.length,
    letter: e ? e.letter : '',
    kind: e ? (e.type === 'contains' ? `Contains ${e.letter}` : `Starts with ${e.letter}`) : '',
    clue: e ? e.clue : '',
    paused: g.paused,
    suggestion: state.lastSuggestion || '',
  });
}

// ---------- Game screen ----------

function startGame(players) {
  const data = state.data;
  data.settings.mode = $('mode').value;
  data.settings.strictness = parseFloat($('strictness').value);

  const game = new Game(data, players);
  state.game = game;

  const stage = $('stage');
  $('game').appendChild($('cam')); // detach cam before clearing, so it survives a rebuild
  stage.innerHTML = '';
  state.circles = game.players.map((p) => {
    const r = new Circle(game.order);
    r.setName(p.name);
    r.setColor(p.color);
    stage.appendChild(r.el);
    return r;
  });

  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  if (data.settings.mode.startsWith('voice') && recognitionSupported()) {
    state.recognizer = new Recognizer({ lang: data.langCode, maxAlternatives: 5 });
    state.recognizer.onInterim = (t) => ($('heard').textContent = t ? `… ${t}` : '');
    state.recognizer.onHypotheses = onHypotheses;
    state.recognizer.onStateChange = (on) => $('mic').classList.toggle('live', on);
  }

  game.addEventListener('update', render);
  game.addEventListener('tick', renderHud);
  game.addEventListener('end', showResults);

  game.start();
  render();
}

const CORNERS = ['tl', 'tr', 'bl', 'br', 'ml', 'mr'];

function layout() {
  const game = state.game;
  let ci = 0;
  state.circles.forEach((r, i) => {
    if (i === game.activeIndex) {
      r.el.className = 'circle active';
      r.setMini(false);
      if (state.cameraOn) r.center.appendChild($('cam'));
    } else {
      r.el.className = `circle mini corner-${CORNERS[ci++] || 'tl'}`;
      r.setMini(true);
    }
  });
}

function render() {
  const game = state.game;
  state.circles.forEach((r, i) => {
    const p = game.players[i];
    r.setStates(p.results);
    r.setScore(game.score(p), game.order.length);
    r.setActive(i === game.activeIndex ? game.currentLetter : null);
  });
  layout();
  renderHud();
  renderClue();
  state.lastSuggestion = null;
  $('suggestion').className = 'suggestion';
  $('suggestion').textContent = '';
  $('heard').textContent = '';
}

function renderHud() {
  const game = state.game;
  const p = game.active;
  $('hud-name').textContent = p.name;
  $('hud-name').style.color = p.color;
  const t = p.timeLeft;
  $('hud-time').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  $('hud-time').classList.toggle('low', t <= 15);
  $('hud-score').textContent = `${game.score(p)}/${game.order.length}`;
  pushRemoteState();
}

// Spoken lead-in per language, e.g. "Begins with the letter R. <clue>".
const SAY_PREFIX = {
  en: { starts: 'Begins with the letter', contains: 'Contains the letter' },
  es: { starts: 'Empieza por la letra', contains: 'Contiene la letra' },
  fr: { starts: 'Commence par la lettre', contains: 'Contient la lettre' },
  ca: { starts: 'Comença per la lletra', contains: 'Conté la lletra' },
};
function spokenClue(entry, langCode) {
  const set = SAY_PREFIX[(langCode || 'en').slice(0, 2).toLowerCase()] || SAY_PREFIX.en;
  const lead = set[entry.type === 'contains' ? 'contains' : 'starts'];
  return `${lead} ${entry.letter}. ${entry.clue}`;
}
function readCurrentClue() {
  const e = state.game?.currentEntry;
  if (e) speak(spokenClue(e, state.game.data.langCode), state.game.data.langCode, state.voiceName);
}

// Hide/show the written definition so the round can be played from audio only.
function toggleClue() {
  const hidden = document.body.classList.toggle('clue-hidden');
  const btn = $('toggle-clue');
  if (btn) {
    btn.textContent = hidden ? '🙈' : '👁';
    btn.title = hidden ? 'Show definition' : 'Hide definition (audio only)';
  }
  // switching to audio-only mid-letter: speak the current clue right away
  if (hidden && state.game && !$('game').classList.contains('hidden')) readCurrentClue();
}

function renderClue() {
  const entry = state.game.currentEntry;
  if (!entry) return;
  const verb = entry.type === 'contains' ? 'Contains' : 'Starts with';
  $('clue-letter').textContent = entry.letter;
  $('clue-kind').textContent = `${verb} ${entry.letter}`;
  $('clue-text').textContent = entry.clue;
  $('type-answer').value = '';
  // narrate automatically when auto-read is on, or when the text is hidden
  if (state.autoRead || document.body.classList.contains('clue-hidden')) readCurrentClue();
}

function onHypotheses(hyps) {
  const game = state.game;
  const entry = game.currentEntry;
  if (!entry) return;
  const targets = [entry.answer, ...entry.accept];
  const { decision, heard, score } = scoreAnswer(targets, hyps, game.data.settings.strictness);
  $('heard').textContent = heard ? `Heard: “${heard}”` : '';

  if (game.data.settings.mode === 'voice-auto' && decision === 'correct') {
    game.correct();
    return;
  }
  state.lastSuggestion = decision === 'wrong' ? 'wrong' : 'correct';
  const box = $('suggestion');
  box.className = `suggestion ${decision}`;
  const pct = Math.round(score * 100);
  box.textContent =
    decision === 'correct'
      ? `Looks correct (${pct}%). Press Enter / C to confirm, W to reject.`
      : decision === 'review'
      ? `Not sure (${pct}%). Enter to accept, W to reject.`
      : `Sounds wrong (${pct}%). Enter / W to confirm, C to accept anyway.`;
  pushRemoteState();
}

// ---------- input (the teacher is always the final judge) ----------

let talking = false;
function startTalk() {
  if (talking || !state.recognizer) return;
  talking = true;
  state.recognizer.start();
}
function stopTalk() {
  if (!talking || !state.recognizer) return;
  talking = false;
  state.recognizer.stop();
}

function bindGameControls() {
  $('btn-correct').addEventListener('click', () => state.game.correct());
  $('btn-wrong').addEventListener('click', () => state.game.wrong());
  $('btn-pass').addEventListener('click', () => state.game.pass());
  $('pause').addEventListener('click', () => {
    state.game.togglePause();
    $('pause').textContent = state.game.paused ? '▶ Resume' : '⏸ Pause';
  });
  $('exit').addEventListener('click', endToSetup);
  $('read-clue').addEventListener('click', readCurrentClue);
  $('toggle-clue').addEventListener('click', toggleClue);
  $('fullscreen').addEventListener('click', () => toggleFullscreen($('game')));
  $('camera-toggle').addEventListener('click', toggleCamera);

  const mic = $('mic');
  mic.addEventListener('pointerdown', startTalk);
  mic.addEventListener('pointerup', stopTalk);
  mic.addEventListener('pointerleave', stopTalk);

  $('type-answer').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const entry = state.game.currentEntry;
    const targets = [entry.answer, ...entry.accept];
    const { decision } = scoreAnswer(targets, [{ transcript: e.target.value, confidence: 1 }], state.game.data.settings.strictness);
    decision === 'wrong' ? state.game.wrong() : state.game.correct();
  });

  document.addEventListener('keydown', (e) => {
    if ($('game').classList.contains('hidden')) return;
    if (document.activeElement === $('type-answer')) return;
    switch (e.key.toLowerCase()) {
      case 'c': state.game.correct(); break;
      case 'w': state.game.wrong(); break;
      case ' ': e.preventDefault(); state.game.pass(); break;
      case 'enter':
        if (state.lastSuggestion === 'wrong') state.game.wrong();
        else if (state.lastSuggestion === 'correct') state.game.correct();
        break;
      case 'v':
        if (!e.repeat) startTalk();
        break;
      case 'f': toggleFullscreen($('game')); break;
      case 'p': state.game.togglePause(); break;
      case 'h': toggleClue(); break;
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'v') stopTalk();
  });
}

async function toggleCamera() {
  if (state.cameraOn) {
    state.camera.stop($('cam'));
    state.cameraOn = false;
    document.body.classList.remove('cam-on');
  } else {
    const ok = await state.camera.start($('cam'));
    if (ok) {
      state.cameraOn = true;
      document.body.classList.add('cam-on');
      layout();
    }
  }
}

function showResults() {
  stopSpeaking();
  const overlay = $('result');
  const rows = state.game
    .results()
    .map((r, i) => `<div class="result-row"><span>${i + 1}. <b style="color:${r.color}">${r.name}</b></span><span>${r.score} correct</span></div>`)
    .join('');
  $('result-body').innerHTML = rows;
  overlay.classList.remove('hidden');
  $('result-again').onclick = endToSetup;
}

function endToSetup() {
  stopSpeaking();
  stopTalk();
  state.camera.stop($('cam'));
  state.cameraOn = false;
  document.body.classList.remove('cam-on');
  $('result').classList.add('hidden');
  $('game').classList.add('hidden');
  $('setup').classList.remove('hidden');
  pushRemoteState();
}

// ---------- boot ----------
setupScreen();
bindGameControls();
bindEditor();
initRemoteLink();
$('strictness-out') && $('strictness').addEventListener('input', (e) => ($('strictness-out').textContent = e.target.value));
$('auto-read')?.addEventListener('change', (e) => (state.autoRead = e.target.checked));
