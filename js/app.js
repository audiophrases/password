// app.js — wires the setup screen, game engine, speech, and camera together.
import { buildPrompt, parseGameText, ALPHABET_EN } from './ai.js';
import { Game } from './game.js';
import { Circle } from './circle.js';
import { Recognizer, recognitionSupported, speak, stopSpeaking, voicesFor, onVoices } from './speech.js';
import { scoreAnswer } from './match.js';
import { Camera, toggleFullscreen } from './camera.js';

const $ = (id) => document.getElementById(id);
const PLAYER_COLORS = ['#e8632c', '#1f9d55', '#2b6cb0', '#9b2c98', '#b7791f', '#0d9488'];

const state = {
  game: null,
  data: null,
  circles: [],
  recognizer: null,
  camera: new Camera(),
  cameraOn: false,
  autoRead: false,
  voiceName: null,
  lastSuggestion: null,
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

  $('start-game').addEventListener('click', () => {
    if (state.data) startGame(players);
  });

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
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
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
}

function renderClue() {
  const entry = state.game.currentEntry;
  if (!entry) return;
  const verb = entry.type === 'contains' ? 'Contains' : 'Starts with';
  $('clue-letter').textContent = entry.letter;
  $('clue-kind').textContent = `${verb} ${entry.letter}`;
  $('clue-text').textContent = entry.clue;
  $('type-answer').value = '';
  if (state.autoRead) speak(entry.clue, state.game.data.langCode, state.voiceName);
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
      ? `Looks correct (${pct}%). Press Enter / C to confirm, X to reject.`
      : decision === 'review'
      ? `Not sure (${pct}%). Enter to accept, X to reject.`
      : `Sounds wrong (${pct}%). Enter / X to confirm, C to accept anyway.`;
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
  $('read-clue').addEventListener('click', () => speak(state.game.currentEntry?.clue, state.game.data.langCode, state.voiceName));
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
      case 'x': state.game.wrong(); break;
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
}

// ---------- boot ----------
setupScreen();
bindGameControls();
$('strictness-out') && $('strictness').addEventListener('input', (e) => ($('strictness-out').textContent = e.target.value));
$('auto-read')?.addEventListener('change', (e) => (state.autoRead = e.target.checked));
