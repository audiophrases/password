// app.js — wires the setup screen, game engine, speech, and camera together.
import { buildPrompt, buildAppendPrompt, appendSets, mixSets, parseGameText, validateGame, ALPHABET_EN } from './ai.js';
import { Game } from './game.js';
import { Circle } from './circle.js';
import { Recognizer, recognitionSupported, speak, stopSpeaking, voicesFor, onVoices } from './speech.js';
import { scoreAnswer } from './match.js';
import { Camera, toggleFullscreen } from './camera.js';
import { connect } from './link.js';
import { CLOUD_RELAY } from './config.js';
import {
  sync as librarySync,
  syncSoon,
  getKey as getLibraryKey,
  setKey as setLibraryKey,
  generateKey,
  validKey,
  fingerprint,
} from './library.js';

const $ = (id) => document.getElementById(id);
const PLAYER_COLORS = ['#e8632c', '#1f9d55', '#2b6cb0', '#9b2c98', '#b7791f', '#0d9488'];

// The game now runs in its own tab. The setup tab launches it (handing the round
// off via localStorage) and stays open as a control panel; the two tabs talk over
// a BroadcastChannel so setting changes can be pushed to the live game.
const isPlayMode = new URLSearchParams(location.search).has('play');
const PLAY_KEY = 'password.play.v1';
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('password') : null;

// Microsoft neural voices served via the local server's /tts endpoint.
const NEURAL_VOICES = {
  'en-US': ['en-US-AvaNeural', 'en-US-AndrewNeural', 'en-US-EmmaNeural', 'en-US-BrianNeural'],
  'es-ES': ['es-ES-ElviraNeural', 'es-ES-AlvaroNeural', 'es-ES-XimenaNeural'],
  'fr-FR': ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural', 'fr-FR-VivienneNeural'],
  'ca-ES': ['ca-ES-EnricNeural', 'ca-ES-JoanaNeural'],
};
const neuralLabel = (id) => (id.split('-')[2] || id).replace(/Neural$/, '');
const ttsAudio = typeof Audio !== 'undefined' ? new Audio() : null;

const state = {
  game: null,
  data: null,
  openId: null, // library id of the loaded game; null = unsaved or freshly imported
  cloudOrigin: '', // resolved Worker origin; the games library syncs here
  circles: [],
  players: [],
  recognizer: null,
  camera: new Camera(),
  cameraOn: false,
  autoRead: true, // read clues aloud by default (checkbox in Play settings)
  showCorrectWord: true, // flash the word on the projected screen once it's guessed right
  clueMuted: false, // remote 🔇: suppress ALL automatic read-aloud so the teacher reads live
  ttsRate: 0.93, // read-aloud speed multiplier (1 = normal); slightly slow suits ESL
  voiceName: null,
  voicePicked: false,
  neuralAvailable: false,
  useNeural: false,
  neuralBroken: false,
  neuralFailStreak: 0, // consecutive failures; 2 in a row trips neuralBroken (one blip shouldn't)
  neuralRetryAt: 0, // once broken, timestamp to quietly try neural again instead of staying broken all game
  edit: { set: 0, sets: 1 },
  lastSuggestion: null,
  link: null,
  remoteUrl: '',
  remotes: 0,
  relayMode: 'local', // 'local' (server.js on this machine) | 'cloud' (relay/worker.js)
  launchedPlay: false, // this (setup) tab has opened a game tab
  gameRunning: false, // a game tab has reported itself running
};

// ---------- Answer sound effects ----------
// Short jingles for judged answers (passes stay silent). Each kind rotates
// through its files in a random order, reshuffling when the bag empties, so
// the same sting never plays twice in a row.
const FX_FILES = {
  correct: ['correct.mp3', 'correct2.mp3', 'correct3.mp3', 'correct4.mp3'],
  wrong: ['incorrect.mp3', 'incorrect2.mp3'],
};
const fxBags = { correct: [], wrong: [] };
const fxLast = { correct: null, wrong: null };
function playFx(kind) {
  const files = FX_FILES[kind];
  if (!files) return;
  let bag = fxBags[kind];
  if (!bag.length) {
    bag = fxBags[kind] = [...files];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // a fresh bag could start with the file that just played — push it deeper
    if (bag.length > 1 && bag[bag.length - 1] === fxLast[kind]) bag.unshift(bag.pop());
  }
  const src = bag.pop();
  fxLast[kind] = src;
  new Audio(src).play().catch(() => {}); // autoplay blocked → just skip the sting
}

// Fire the right sting whenever the engine records a new judgement. The engine
// makes a fresh lastResolved object per answer, so identity tells us it's new.
let fxSeen = null;
function playAnswerFx() {
  const lr = state.game?.lastResolved;
  if (!lr || lr === fxSeen) return;
  fxSeen = lr;
  if (lr.state === 'correct') playFx('correct');
  else if (lr.state === 'wrong') playFx('wrong');
}

// ---------- Correct-answer word flash ----------
// A wrong answer holds the board still while it reveals the word; a correct one
// doesn't — the turn carries straight on to the next letter. So this flash is
// purely a timed overlay: it shows the word that was just won for a beat and
// fades itself out, without touching the game's pacing. Off by the teacher's
// "flash the word" setting, in which case a correct word never reaches the
// projected screen at all.
const CORRECT_FLASH_MS = 1400;
let flashSeen = null; // lastResolved already flashed — 'update' also fires for clock/rotation changes
let flashTimer = null;

function hideAnswerBanner() {
  clearTimeout(flashTimer);
  const banner = $('reveal-answer');
  banner.classList.add('hidden');
  banner.classList.remove('correct');
}

function flashCorrectWord() {
  const lr = state.game?.lastResolved;
  if (!lr || lr === flashSeen) return;
  flashSeen = lr;
  if (lr.state !== 'correct' || !state.showCorrectWord) return;
  const e = state.game.entryFor(lr.playerIndex, lr.letter);
  if (!e) return;
  const banner = $('reveal-answer');
  banner.innerHTML = `<small>${esc(lr.letter)} ✓</small>${esc(e.answer)}`;
  banner.classList.add('correct');
  banner.classList.remove('hidden');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(hideAnswerBanner, CORRECT_FLASH_MS);
}

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

// Resize the player list (1–6) and reflect it in the section-1 field.
function setPlayerCount(n) {
  n = Math.max(1, Math.min(6, n || 1));
  const players = state.players;
  while (players.length < n) {
    const i = players.length;
    players.push({ name: `Player ${i + 1}`, color: PLAYER_COLORS[i % PLAYER_COLORS.length] });
  }
  players.length = n;
  $('num-players').value = n;
  if ($('active-players')) $('active-players').value = n;
  renderPlayers(players);
}

// Voice picker — neural voices (via the server) when available, else browser voices.
function populateVoices(langCode) {
  const sel = $('voice');
  const prev = sel.value;
  sel.innerHTML = '';

  if (state.useNeural && state.neuralAvailable && !state.neuralBroken) {
    const list = NEURAL_VOICES[langCode] || NEURAL_VOICES['en-US'];
    for (const id of list) {
      const o = document.createElement('option');
      o.value = id;
      o.dataset.type = 'neural';
      o.textContent = `${neuralLabel(id)} — neural`;
      sel.appendChild(o);
    }
    if (state.voicePicked && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    state.voiceName = null; // browser voice unused in neural mode
    return;
  }

  const list = voicesFor(langCode).slice(0, 4); // just the best few, not Edge's whole list
  if (!list.length) {
    sel.innerHTML = '<option value="" data-type="browser">(system default)</option>';
    state.voiceName = null;
    return;
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.name;
    o.dataset.type = 'browser';
    o.textContent = v.name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*.*$/, ''); // shorten label
    sel.appendChild(o);
  }
  if (state.voicePicked && list.some((v) => v.name === prev)) {
    sel.value = prev; // keep an explicit user choice
    state.voiceName = prev;
  } else {
    // auto-pick the best — a "Natural" Edge voice once the online voices load
    state.voiceName = list[0].name;
    sel.value = state.voiceName;
  }
}

// Read text aloud: neural (server /tts) when a neural voice is selected, else browser.
// Pick a neural voice for langCode; honor the dropdown choice only if it fits.
function neuralVoiceFor(langCode, selectedId) {
  const list = NEURAL_VOICES[langCode] || NEURAL_VOICES['en-US'];
  return selectedId && list.includes(selectedId) ? selectedId : list[0];
}

function neuralFailed() {
  // A single failure is treated as a transient blip (bad luck / a dropped packet /
  // rate-limiting) and just falls back to the browser voice for that one line. Only
  // two in a row disables neural — and even then it retries itself later instead of
  // staying broken for the rest of the game (see the top of narrate()).
  state.neuralFailStreak++;
  if (state.neuralFailStreak < 2) return;
  state.neuralBroken = true;
  state.useNeural = false;
  state.neuralRetryAt = Date.now() + 20000;
  const nb = $('neural');
  if (nb) nb.checked = false;
  if ($('neural-note')) $('neural-note').textContent = 'Neural voice having trouble — retrying automatically…';
  populateVoices($('language').value);
}

function neuralSucceeded() {
  state.neuralFailStreak = 0;
}

// Read-aloud speed: keep state, the slider, and its label in sync (clamped to
// the slider's range). Used from Setup and when settings are pushed to a live game.
function setTtsRate(v) {
  const rate = Math.min(1.5, Math.max(0.5, +v || 1));
  state.ttsRate = rate;
  if ($('tts-rate')) $('tts-rate').value = rate;
  if ($('tts-rate-num')) $('tts-rate-num').value = rate.toFixed(2);
}

const ttsUrl = (voiceId, text, rate) =>
  `/tts?voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}&rate=${encodeURIComponent(rate)}`;

// Generic narration of a single piece of text (used by the voice test button).
function narrate(text, langCode) {
  if (!text) return;
  // Neural broke earlier this game but the cooldown has passed — quietly try it
  // again rather than staying stuck on the robotic browser voice for good.
  if (state.neuralBroken && state.neuralAvailable && Date.now() >= state.neuralRetryAt) {
    state.neuralBroken = false;
    state.useNeural = true;
    const nb = $('neural');
    if (nb) nb.checked = true;
    if ($('neural-note')) $('neural-note').textContent = 'Using Microsoft neural voices via the server.';
    populateVoices($('language').value);
  }
  const useNeural = state.useNeural && state.neuralAvailable && !state.neuralBroken && ttsAudio;
  if (useNeural) {
    const sel = $('voice').selectedOptions[0];
    const selId = sel && sel.dataset.type === 'neural' ? sel.value : null;
    const voiceId = neuralVoiceFor(langCode, selId); // always match the game's language
    stopNarration();
    ttsAudio.onerror = () => {
      ttsAudio.onerror = null;
      neuralFailed();
      speak(text, langCode, state.voiceName, state.ttsRate);
    };
    ttsAudio.onplaying = () => neuralSucceeded();
    ttsAudio.src = ttsUrl(voiceId, text, state.ttsRate);
    ttsAudio.play().catch(() => {});
    return;
  }
  speak(text, langCode, state.voiceName, state.ttsRate);
}

function stopNarration() {
  stopSpeaking();
  if (ttsAudio) {
    ttsAudio.onerror = null;
    ttsAudio.onended = null;
    ttsAudio.onplaying = null;
    try {
      ttsAudio.pause();
      ttsAudio.removeAttribute('src');
      ttsAudio.load();
    } catch {
      /* ignore */
    }
  }
}

function setupScreen() {
  const players = defaultPlayers();
  state.players = players;
  renderPlayers(players);

  // Number of players (source of truth lives in section 1).
  $('num-players').addEventListener('change', () => setPlayerCount(+$('num-players').value));

  // Play with fewer players than the loaded game has word circles — the extra
  // circles' words get mixed in at start instead of just sitting unused.
  $('active-players').addEventListener('change', () => {
    const max = state.data ? gameSetCount(state.data) : 6;
    setPlayerCount(Math.max(1, Math.min(max, +$('active-players').value || 1)));
    updateCurrentGame();
  });

  // Section 1 language is for the PROMPT only: it just fills in the default letter
  // set to draft. It never touches a loaded game or the read-aloud voice.
  $('prompt-lang').addEventListener('change', () => {
    $('letters').value = $('prompt-lang').selectedOptions[0].dataset.letters;
  });
  // Section 3 language is the GAME's: it drives speech recognition + the read-aloud
  // voice, and follows a loaded game.
  $('language').addEventListener('change', () => {
    state.voicePicked = false; // re-auto-pick the best voice for the new language
    populateVoices($('language').value);
  });
  $('voice').addEventListener('change', () => {
    state.voiceName = $('voice').value || null;
    state.voicePicked = true;
  });
  $('test-voice').addEventListener('click', () => {
    const code = $('language').value;
    const samples = {
      'en-US': 'This is the voice that will read the clues aloud.',
      'fr-FR': 'Voici la voix qui lira les définitions à voix haute.',
      'es-ES': 'Esta es la voz que leerá las pistas en voz alta.',
      'ca-ES': 'Aquesta és la veu que llegirà les pistes en veu alta.',
    };
    narrate(samples[code] || samples['en-US'], code);
  });
  $('neural').addEventListener('change', () => {
    state.useNeural = $('neural').checked;
    state.voicePicked = false;
    populateVoices($('language').value);
  });
  // Slider drags update everything live; the number box lets you type an exact
  // value (e.g. 0.89) and commits on blur/Enter.
  $('tts-rate').addEventListener('change', savePrefs);
  $('tts-rate').addEventListener('input', (e) => setTtsRate(parseFloat(e.target.value) || 0.93));
  $('tts-rate-num').addEventListener('change', (e) => {
    setTtsRate(parseFloat(e.target.value) || 0.93);
    savePrefs();
  });
  setTtsRate(parseFloat($('tts-rate').value) || 0.93); // sync state + boxes from the initial value

  // Play settings are the teacher's own — persist them whenever they change.
  $('play-duration').addEventListener('change', () => {
    $('play-duration').value = playDurationValue(); // clamp (0 = no timer)
    savePrefs();
  });
  $('mode').addEventListener('change', savePrefs);
  $('strictness').addEventListener('change', savePrefs);
  populateVoices($('language').value);
  onVoices(() => populateVoices($('language').value)); // re-list once Edge's natural voices load

  // Each game type suggests its own topic; swap the suggestion only while the
  // teacher hasn't typed a custom one.
  const TOPIC_DEFAULTS = {
    vocabulary: 'everyday vocabulary',
    quiz: 'people, places, history and science',
    subject: 'natural science (Medi), 4th grade',
  };
  $('purpose').addEventListener('change', () => {
    const t = $('topic');
    if (!t.value.trim() || Object.values(TOPIC_DEFAULTS).includes(t.value.trim())) {
      t.value = TOPIC_DEFAULTS[$('purpose').value] || '';
    }
  });

  $('build-prompt').addEventListener('click', () => {
    const opt = $('prompt-lang').selectedOptions[0];
    const letters = ($('letters').value || ALPHABET_EN.join('')).toUpperCase().replace(/[^A-ZÑ]/g, '').split('');
    const prompt = buildPrompt({
      language: opt.dataset.name,
      level: $('level').value,
      topic: $('topic').value.trim() || TOPIC_DEFAULTS[$('purpose').value] || 'everyday vocabulary',
      letters: letters.length ? letters : ALPHABET_EN,
      players: state.players.length,
      purpose: $('purpose').value,
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
    if (!$('editor').classList.contains('hidden') && state.data) openEditor(); // refresh editor view
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

// Section-3 status chip: which game the play settings / Start apply to.
function updateCurrentGame() {
  const box = $('current-game');
  if (!box) return;
  const g = state.data;
  updateAppendPanel(g);
  updateActivePlayersPanel(g);
  if (!g) {
    box.className = 'current-game none';
    box.innerHTML = 'No game loaded — pick or create one in <b>1 · Your games</b>.';
    return;
  }
  const langName =
    [...$('language').options].find((o) => o.value === g.langCode)?.dataset.name || g.language || g.langCode;
  const sets = gameSetCount(g);
  const n = state.players.length;
  const playersLabel =
    n < sets ? `${n} player${n > 1 ? 's' : ''} (mixed from ${sets} circles)` : `${n} player${n > 1 ? 's' : ''}`;
  box.className = 'current-game';
  box.innerHTML =
    `<b>${esc(g.title)}</b>` + `<span>${esc(langName)} · ${g.letters.length} letters · ${playersLabel}</span>`;
}

// ---------- Add circles (word sets) to the loaded game ----------

const gameSetCount = (g) => Math.max(1, ...g.letters.map((l) => (l.variants ? l.variants.length : 1)));

// Section-2 "Players this round" control — lets a game with several word
// circles (one per player) be played with fewer players than it has circles;
// the unused circles' words get folded in via a mix at start, not dropped.
function updateActivePlayersPanel(g) {
  const input = $('active-players');
  const hint = $('active-players-hint');
  if (!input || !hint) return;
  if (!g) {
    input.disabled = true;
    input.max = 6;
    hint.textContent = 'Load a game to set how many players take part.';
    return;
  }
  const sets = gameSetCount(g);
  input.disabled = sets <= 1;
  input.min = 1;
  input.max = sets;
  if (+input.value > sets) input.value = sets;
  hint.textContent =
    sets > 1
      ? `“${g.title}” has ${sets} word circles. Play with fewer and the circles mix together.`
      : `“${g.title}” has a single word circle — one player.`;
}

// Show the "add circles" panel only when a game is loaded; keep its info line
// and the new-circles input clamped to what still fits (6 players max).
function updateAppendPanel(g) {
  const panel = $('append-details');
  if (!panel) return;
  panel.classList.toggle('hidden', !g);
  if (!g) return;
  const sets = gameSetCount(g);
  const room = Math.max(0, 6 - sets);
  $('append-info').textContent =
    `“${g.title}” has ${sets} circle${sets > 1 ? 's' : ''} of words — one per player. ` +
    (room ? `You can add up to ${room} more.` : 'It already has the maximum of 6.');
  const cnt = $('append-count');
  cnt.max = Math.max(1, room);
  if (+cnt.value > room) cnt.value = Math.max(1, room);
  $('append-prompt').disabled = !room;
  $('append-json').disabled = !room;
}

function bindAppend() {
  $('append-prompt').addEventListener('click', () => {
    const g = state.data;
    if (!g) return;
    const langName =
      [...$('language').options].find((o) => o.value === g.langCode)?.dataset.name || g.language || 'English';
    const count = Math.max(1, Math.min(6 - gameSetCount(g), +$('append-count').value || 1));
    $('append-output').value = buildAppendPrompt({
      language: langName,
      count,
      letters: g.letters.map((l) => ({ letter: l.letter, type: l.type, existing: l.variants.map((v) => v.answer) })),
    });
  });

  $('copy-append').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('append-output').value).catch(() => {});
    flash($('copy-append'), 'Copied!');
  });

  $('append-json').addEventListener('click', () => {
    const msg = $('append-msg');
    const g = state.data;
    if (!g) return;
    const parsed = parseGameText($('append-input').value);
    if (!parsed.ok) {
      msg.className = 'msg error';
      msg.textContent = parsed.errors.slice(0, 3).join(' ');
      return;
    }
    const res = appendSets(g, parsed.game.letters);
    if (!res.ok) {
      msg.className = 'msg error';
      msg.textContent = res.errors.join(' ');
      return;
    }
    setPlayerCount(res.total);
    saveLocal(); // an extended game is worth keeping — updates the library entry
    updateCurrentGame();
    pushRemoteState();
    $('append-input').value = '';
    msg.className = 'msg ok';
    msg.textContent =
      `Added ${res.added} circle${res.added > 1 ? 's' : ''} — “${g.title}” now has ${res.total} word sets.` +
      (res.duplicates.length ? ` ⚠ Repeats of existing words: ${res.duplicates.slice(0, 6).join(', ')} — press ✏️ to fix.` : '');
  });
}

function loadGameText(text, players) {
  const result = parseGameText(text);
  const msg = $('validation');
  if (!result.ok) {
    msg.className = 'msg error';
    msg.textContent = result.errors.slice(0, 4).join(' ');
    state.data = null;
    $('start-game').disabled = true;
    updateCurrentGame();
    return;
  }
  state.data = result.game;
  state.openId = null; // openSaved() re-sets this; an import or edit is a new game until saved
  // A game is only its CONTENT: sync the game language (drives voice/ASR) and the
  // player count (word sets). Play settings — mode/strictness/time/voice — are the
  // teacher's own and are never touched by loading a game.
  const langSel = $('language'); // section-3 game language
  if ([...langSel.options].some((o) => o.value === result.game.langCode)) {
    langSel.value = result.game.langCode;
    state.voicePicked = false;
    populateVoices(result.game.langCode);
  }
  setPlayerCount(result.game.players); // a 3-word-set game sets up 3 players
  msg.className = 'msg ok';
  msg.textContent = `Loaded "${result.game.title}" — ${result.game.letters.length} letters. Ready.`;
  $('start-game').disabled = false;
  updateCurrentGame();
  pushRemoteState();
  renderLibrary();
}

// ---------- Manual create / edit + save to file ----------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Default letter set for a language code (reads the data-letters of the matching option).
function lettersForLang(langCode) {
  const opt = [...$('language').options].find((o) => o.value === langCode);
  return (opt?.dataset.letters || ALPHABET_EN.join('')).toUpperCase().replace(/[^A-ZÑ]/g, '').split('');
}

// Each row carries every player's variant on row._variants; the inputs show the
// currently selected set (state.edit.set). letter/type are shared across sets.
function editorRowEl({ letter = '', type = 'starts', variants = [] } = {}) {
  const row = document.createElement('div');
  row.className = 'erow';
  row.innerHTML = `
    <input class="e-letter" maxlength="2" value="${esc(letter)}" />
    <select class="e-type">
      <option value="starts">starts with</option>
      <option value="contains">contains</option>
    </select>
    <input class="e-answer" placeholder="answer" />
    <input class="e-accept" placeholder="also accept (comma-separated)" />
    <input class="e-clue" placeholder="clue / definition" />
    <button class="e-del" title="Remove letter">✕</button>`;
  row.querySelector('.e-type').value = type === 'contains' ? 'contains' : 'starts';
  row._variants = variants.map((v) => ({ answer: v.answer || '', accept: v.accept || '', clue: v.clue || '' }));
  while (row._variants.length < state.edit.sets) row._variants.push({ answer: '', accept: '', clue: '' });
  applyVariantToRow(row, state.edit.set);
  row.querySelector('.e-del').addEventListener('click', () => row.remove());
  return row;
}

function applyVariantToRow(row, set) {
  const v = row._variants[set] || { answer: '', accept: '', clue: '' };
  row.querySelector('.e-answer').value = v.answer || '';
  row.querySelector('.e-accept').value = v.accept || '';
  row.querySelector('.e-clue').value = v.clue || '';
}

// Copy the visible inputs back into each row's current variant.
function stashVisibleSet() {
  const set = state.edit.set;
  $('editor-rows').querySelectorAll('.erow').forEach((row) => {
    row._variants[set] = {
      answer: row.querySelector('.e-answer').value,
      accept: row.querySelector('.e-accept').value,
      clue: row.querySelector('.e-clue').value,
    };
  });
}

function updateSetLabel() {
  const lbl = $('editor-set-label');
  if (lbl) lbl.textContent = `${state.edit.set + 1} / ${state.edit.sets}`;
  if ($('editor-set-del')) $('editor-set-del').disabled = state.edit.sets <= 1;
  if ($('editor-mix')) $('editor-mix').disabled = state.edit.sets < 2; // nothing to mix with one set
}

function setEditorSet(index) {
  if (index < 0 || index >= state.edit.sets) return;
  stashVisibleSet();
  state.edit.set = index;
  $('editor-rows').querySelectorAll('.erow').forEach((row) => applyVariantToRow(row, index));
  updateSetLabel();
}

function addSet() {
  stashVisibleSet();
  state.edit.sets += 1;
  $('editor-rows').querySelectorAll('.erow').forEach((row) => row._variants.push({ answer: '', accept: '', clue: '' }));
  setEditorSet(state.edit.sets - 1);
}

function removeSet() {
  if (state.edit.sets <= 1) return;
  stashVisibleSet();
  const idx = state.edit.set;
  $('editor-rows').querySelectorAll('.erow').forEach((row) => row._variants.splice(idx, 1));
  state.edit.sets -= 1;
  state.edit.set = Math.min(idx, state.edit.sets - 1);
  $('editor-rows').querySelectorAll('.erow').forEach((row) => applyVariantToRow(row, state.edit.set));
  updateSetLabel();
}

// Open the editor pre-filled from the loaded game, or blank (blank === true for a new game).
function openEditor(blank) {
  const data = blank === true ? null : state.data;
  $('editor-title').value = data?.title || '';
  const lang = $('editor-lang');
  const known = [...lang.options].map((o) => o.value);
  lang.value = data && known.includes(data.langCode) ? data.langCode : $('language').value;

  let rows;
  if (data?.letters?.length) {
    state.edit = { set: 0, sets: Math.max(1, ...data.letters.map((l) => (l.variants ? l.variants.length : 1))) };
    rows = data.letters.map((l) => ({
      letter: l.letter,
      type: l.type,
      variants: (l.variants || [{ answer: l.answer, accept: l.accept, clue: l.clue }]).map((v) => ({
        answer: v.answer || '',
        accept: (v.accept || []).join(', '),
        clue: v.clue || '',
      })),
    }));
  } else {
    // new game: one word set per player so each gets different words
    state.edit = { set: 0, sets: Math.max(1, state.players.length) };
    rows = lettersForLang(lang.value).map((ch) => ({ letter: ch, type: 'starts', variants: [] }));
  }

  const box = $('editor-rows');
  box.innerHTML = '';
  rows.forEach((r) => box.appendChild(editorRowEl(r)));
  updateSetLabel();
  $('editor-msg').textContent = '';
  $('editor-msg').className = 'msg';
  $('setup').classList.add('hidden');
  $('editor').classList.remove('hidden');
}

function scaffoldEditor() {
  stashVisibleSet();
  const present = new Set([...$('editor-rows').querySelectorAll('.e-letter')].map((i) => i.value.trim().toUpperCase()));
  lettersForLang($('editor-lang').value).forEach((ch) => {
    if (!present.has(ch)) $('editor-rows').appendChild(editorRowEl({ letter: ch }));
  });
}

function closeEditor() {
  $('editor').classList.add('hidden');
  $('setup').classList.remove('hidden');
}

// Collect + validate the editor into state.data; returns true on success.
function saveEditorData() {
  stashVisibleSet();
  const opt = $('editor-lang').selectedOptions[0];
  const letters = [...$('editor-rows').querySelectorAll('.erow')]
    .map((row) => ({
      letter: row.querySelector('.e-letter').value.trim().toUpperCase(),
      type: row.querySelector('.e-type').value,
      variants: row._variants.map((v) => ({
        answer: (v.answer || '').trim(),
        accept: (v.accept || '').split(',').map((s) => s.trim()).filter(Boolean),
        clue: (v.clue || '').trim(),
      })),
    }))
    .filter((l) => l.letter);

  const msg = $('editor-msg');
  if (!letters.length) {
    msg.className = 'msg error';
    msg.textContent = 'Add at least one letter.';
    return false;
  }
  const incomplete = [];
  for (const l of letters) {
    for (const v of l.variants) {
      if (!v.answer || !v.clue) {
        incomplete.push(l.letter);
        break;
      }
    }
  }
  if (incomplete.length) {
    msg.className = 'msg error';
    msg.textContent = `Add an answer and a clue for every set of: ${[...new Set(incomplete)].join(', ')}`;
    return false;
  }

  const game = {
    title: $('editor-title').value.trim() || 'Manual round',
    language: opt.dataset.name,
    langCode: opt.value,
    players: state.edit.sets, // one word set per player
    // No settings block: a game is content only; play settings live with the teacher.
    letters,
  };
  const result = validateGame(game);
  if (!result.ok) {
    msg.className = 'msg error';
    msg.textContent = result.errors.slice(0, 4).join(' ');
    return false;
  }
  state.data = result.game;
  setPlayerCount(result.game.players);
  $('json-input').value = JSON.stringify(result.game, null, 2);
  const v = $('validation');
  v.className = 'msg ok';
  v.textContent = `Loaded "${result.game.title}" — ${result.game.letters.length} letters. Ready.`;
  $('start-game').disabled = false;
  updateCurrentGame();
  return true;
}

// ---------- Saved games (browser storage) ----------
// v1 kept games in a { [title]: game } map, so the title WAS the primary key:
// two rounds with one title silently overwrote each other, renaming orphaned the
// original, and two browsers' libraries could never be merged. v2 keys by a
// stable id instead, so a library can be exported, carried, and merged.
//
// The v1 key is migrated once and then LEFT ALONE FOREVER as a rollback net —
// never write to it, never delete it.

const STORE_KEY = 'password.games.v1'; // legacy; read once by migrateV1()
const STORE_KEY_V2 = 'password.games.v2';

// An entry is { id, title, clientAt, deleted, version, dirty, game }.
//   version — the server version this copy was last synced at (0 = never).
//   deleted — tombstone; the game payload is kept so a mistake stays recoverable.
//   dirty   — changed here since the last sync, so it still needs pushing. Only
//             dirty entries are sent, which is what makes a steady-state sync
//             one request that transfers nothing.

// Ids are derived from the game's CONTENT, which is what makes merging work:
// two machines holding the identical round mint the same id, so importing one
// into the other is a no-op instead of a duplicate; genuinely different rounds
// that share a title mint different ids, so both survive.
//
// Deliberately not crypto.subtle/randomUUID: both need a secure context, and
// this app is routinely served over plain http from a LAN IP, where they are
// undefined. cyrb128 is 128 bits, synchronous, and works on every origin —
// collision resistance is all that's needed here, not unforgeability.
function hash128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

// Key order must not change the hash, or the same game hashes two ways.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(',')}}`;
}

// Hash the VALIDATED game, never the raw object: validateGame fills in defaults
// (mode, strictness, durationSec), uppercases letters and expands the legacy
// {answer, accept, clue} shape into variants. Hashing raw input would give the
// same round two ids depending on which app version wrote it, and dedupe would
// silently stop working.
function gameId(game) {
  const res = validateGame(game);
  return `g_${hash128(canonicalJson(res.ok ? res.game : game))}`;
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY_V2)) || {};
  } catch {
    return {};
  }
}
function persistStore(obj) {
  try {
    localStorage.setItem(STORE_KEY_V2, JSON.stringify(obj));
    return true;
  } catch (e) {
    // Never silent: a full quota means the round the teacher just saved is NOT
    // saved, and they need to know now rather than after closing the tab.
    console.warn('Could not save to browser storage:', e);
    const v = $('validation');
    if (v) {
      v.className = 'msg error';
      v.textContent = 'This browser refused to save — its storage is full. Use ⬇ Export to get your games out before closing the tab.';
    }
    return false;
  }
}

// One-time lift of the title-keyed v1 library into id-keyed v2.
function migrateV1() {
  if (localStorage.getItem(STORE_KEY_V2) !== null) return; // already done
  let old = null;
  try {
    old = JSON.parse(localStorage.getItem(STORE_KEY));
  } catch {
    old = null;
  }
  const store = {};
  for (const [title, game] of Object.entries(old || {})) {
    if (!game || typeof game !== 'object') continue;
    const g = { ...game, title: game.title || title }; // v1 held the title in the key
    // Store the NORMALIZED game, not the raw one: the id is derived from the
    // normalized form, so keeping the raw payload would leave every migrated
    // entry looking "changed" forever and rewrite the whole library on first
    // export or sync. A game too broken to validate is kept as-is rather than
    // dropped — it was already unplayable, but it is not ours to throw away.
    const res = validateGame(g);
    const norm = res.ok ? res.game : g;
    const id = gameId(norm);
    store[id] = { id, title: norm.title || g.title, clientAt: Date.now(), deleted: 0, version: 0, dirty: 1, game: norm };
  }
  persistStore(store);
}

// Live (non-deleted) entries, sorted by title.
function libraryEntries() {
  return Object.values(loadStore())
    .filter((e) => e && !e.deleted && e.game)
    .sort((a, b) => a.title.localeCompare(b.title));
}

const libMeta = (game) => {
  const players = game.players || 0;
  return `${(game.langCode || '??').slice(0, 2)} · ${game.letters?.length || 0} letters · ${players} player${players === 1 ? '' : 's'}`;
};

// Render the saved-games library: one clickable row per game (open / edit / delete).
function renderLibrary() {
  const box = $('library');
  if (!box) return;
  const entries = libraryEntries();
  // Same-titled rounds from different machines are a real outcome of merging, so
  // disambiguate them HERE rather than renaming anything on disk: a render-time
  // suffix is reversible and lets the teacher see which copy is the fuller one.
  const seen = new Map();
  for (const e of entries) seen.set(e.title, (seen.get(e.title) || 0) + 1);

  if (!entries.length) {
    box.innerHTML = '<p class="lib-empty">No saved games yet. Make a New game, or import one below, then Save.</p>';
  } else {
    box.innerHTML = '';
    for (const e of entries) {
      const label = seen.get(e.title) > 1 ? `${e.title} · #${e.id.slice(2, 6)}` : e.title;
      const item = document.createElement('div');
      item.className = 'lib-item' + (state.openId === e.id ? ' current' : '');
      item.innerHTML =
        `<button class="lib-open"><span class="lib-title">${esc(label)}</span>` +
        `<span class="lib-meta">${esc(libMeta(e.game))}</span></button>` +
        `<button class="lib-edit" title="Edit">✏️</button>` +
        `<button class="lib-del" title="Delete">🗑</button>`;
      item.querySelector('.lib-open').addEventListener('click', () => openSaved(e.id));
      item.querySelector('.lib-edit').addEventListener('click', () => editSaved(e.id));
      item.querySelector('.lib-del').addEventListener('click', () => deleteSaved(e.id));
      box.appendChild(item);
    }
  }
  const d = $('import-details');
  if (d && !entries.length) d.open = true; // help first-timers find import
  updateSaveButton();
}

function updateSaveButton() {
  const btn = $('save-local');
  if (!btn) return;
  if (!state.data) {
    btn.disabled = true;
    btn.textContent = '💾 Save current game';
    return;
  }
  btn.disabled = false;
  // "Update" only when saving would overwrite in place — i.e. the open game is
  // still under its original title. Retitling saves a copy (see saveLocal).
  const open = state.openId && loadStore()[state.openId];
  btn.textContent = open && !open.deleted && open.title === state.data.title ? '💾 Update saved game' : '💾 Save current game';
}

// Save the current game into this browser, keyed by a stable content id.
function saveLocal() {
  const v = $('validation');
  if (!state.data) {
    v.className = 'msg error';
    v.textContent = 'Make or import a game first.';
    return;
  }
  const store = loadStore();
  const open = state.openId && store[state.openId];
  // Editing an open game updates it in place; RENAMING it saves a new game and
  // leaves the original untouched — the editor's own hint promises exactly that
  // ("Rename the title before 💾 Save to keep the original game unchanged").
  const id = open && !open.deleted && open.title === state.data.title ? state.openId : gameId(state.data);
  store[id] = {
    id,
    title: state.data.title,
    clientAt: Date.now(),
    deleted: 0,
    version: store[id]?.version || 0,
    dirty: 1,
    game: state.data,
  };
  if (!persistStore(store)) return; // quota error already reported
  state.openId = id;
  renderLibrary();
  scheduleSync();
  v.className = 'msg ok';
  v.textContent = `Saved "${state.data.title}" in this browser.`;
}

function openSaved(id) {
  const entry = loadStore()[id];
  if (!entry || !entry.game) return;
  loadGameText(JSON.stringify(entry.game), state.players);
  state.openId = id; // set after loadGameText, which re-renders the library
  renderLibrary();
  if (!$('editor').classList.contains('hidden')) openEditor(); // refresh editor if open
}

function editSaved(id) {
  openSaved(id);
  openEditor();
}

// Tombstone rather than drop: the payload is kept so a mis-click stays
// recoverable, and a delete has to be able to travel to other machines later.
function deleteSaved(id) {
  const store = loadStore();
  const entry = store[id];
  if (!entry) return;
  if (!confirm(`Delete "${entry.title}"?`)) return;
  store[id] = { ...entry, deleted: 1, clientAt: Date.now(), dirty: 1 };
  if (!persistStore(store)) return;
  if (state.openId === id) state.openId = null;
  renderLibrary();
  scheduleSync();
}

// ---------- Export / import the whole library ----------
// The only way games leave this browser. Works offline, on file://, and on a
// static host — and it is the backstop for everything else, so keep it simple.

function exportLibrary() {
  const games = libraryEntries().map((e) => ({ id: e.id, title: e.title, game: e.game }));
  const v = $('validation');
  if (!games.length) {
    v.className = 'msg error';
    v.textContent = 'No saved games to export yet.';
    return;
  }
  const payload = { kind: 'password.library', v: 1, exportedAt: new Date().toISOString(), games };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `password-games-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  v.className = 'msg ok';
  v.textContent = `Exported ${games.length} game${games.length === 1 ? '' : 's'}.`;
}

// Accepts an export envelope, a bare array of games, a single game, or a raw v1
// { title: game } dump — so a library pasted out of another browser's
// localStorage still imports.
function importLibraryGames(parsed) {
  if (Array.isArray(parsed)) return parsed.map((game) => ({ game }));
  if (parsed && Array.isArray(parsed.games)) return parsed.games;
  if (parsed && Array.isArray(parsed.letters)) return [{ game: parsed }];
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([title, game]) => ({ game: { ...game, title: game?.title || title } }));
  }
  return [];
}

function importLibraryText(text) {
  const v = $('validation');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    v.className = 'msg error';
    v.textContent = 'That file is not valid JSON.';
    return;
  }
  const store = loadStore();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const row of importLibraryGames(parsed)) {
    const raw = row?.game;
    const res = raw ? validateGame(raw) : { ok: false };
    if (!res.ok) {
      skipped++;
      continue;
    }
    // Re-derive the id from content rather than trusting the file: that is what
    // makes importing the same library twice a no-op instead of a duplicate.
    const id = gameId(res.game);
    const prev = store[id];
    if (prev && !prev.deleted && canonicalJson(prev.game) === canonicalJson(res.game)) {
      unchanged++;
      continue;
    }
    store[id] = {
      id,
      title: res.game.title,
      clientAt: Date.now(),
      deleted: 0,
      version: prev?.version || 0,
      dirty: 1,
      game: res.game,
    };
    if (prev) updated++;
    else added++;
  }
  if (!persistStore(store)) return;
  renderLibrary();
  scheduleSync();
  v.className = skipped && !added && !updated ? 'msg error' : 'msg ok';
  v.textContent =
    `${added} added, ${updated} updated, ${unchanged} unchanged` +
    (skipped ? `, ${skipped} skipped (not a valid game).` : '.');
}

// ---------- Cloud library sync ----------
// The store layer above is passed in rather than imported by js/library.js, so
// localStorage stays owned in one place and the sync module stays testable.

const syncDeps = {
  get origin() {
    return state.cloudOrigin;
  },
  loadStore,
  persistStore,
  gameId,
  hash128,
  onStatus: renderSyncStatus,
  // A wrong key does not fail — it opens a different, empty library. Asking here
  // is the only thing standing between a typo and a library forked in two.
  confirmAdopt: (n, fp) =>
    Promise.resolve(
      confirm(
        `This key opens a library that has never been used (${fp}).\n\n` +
          `Start a new cloud library with the ${n} game${n === 1 ? '' : 's'} on this computer?\n\n` +
          `If you expected to find your games here, choose Cancel and re-check the key — ` +
          `a mistyped key quietly starts a SECOND library that never merges with the first.`,
      ),
    ),
};

function renderSyncStatus(s = {}) {
  const el = $('sync-status');
  if (!el) return;
  const key = getLibraryKey();
  if (!key) {
    el.textContent = 'Not set up — Generate a key here, or paste the one from your other computer.';
    return;
  }
  const fp = s.fp || fingerprint(key, hash128);
  if (s.state === 'syncing') {
    el.textContent = `Library ${fp} · syncing…`;
    return;
  }
  if (s.state === 'error') {
    el.textContent = `Library ${fp} · not synced (${s.error}) — your games are still saved on this laptop.`;
    return;
  }
  if (s.note) {
    el.textContent = `Library ${fp} · ${s.note}`;
    return;
  }
  const bits = [`Library ${fp}`];
  if (typeof s.count === 'number') bits.push(`${s.count} game${s.count === 1 ? '' : 's'}`);
  if (s.at) bits.push('synced just now');
  if (s.pushed) bits.push(`${s.pushed} sent`);
  if (s.forked) bits.push(`${s.forked} kept as a copy (changed on two computers)`);
  if (s.resurrected) bits.push(`${s.resurrected} kept from this laptop`);
  el.textContent = bits.join(' · ');
}

async function runSync(manual) {
  if (isPlayMode) return; // the projector tab never touches the network
  try {
    const res = await librarySync(syncDeps, { manual });
    if (!res.skipped) {
      renderLibrary();
      bc?.postMessage({ t: 'library' }); // a sibling setup tab re-reads the store
    }
    if (res.error) renderSyncStatus({ state: 'error', error: res.error });
  } catch (e) {
    renderSyncStatus({ state: 'error', error: e.message });
  }
}

// Called after every local change. Never awaited from a click handler — the
// "➕ Append" button saves on each press, and a save must never wait on a network.
function scheduleSync() {
  if (isPlayMode || !getLibraryKey()) return;
  syncSoon(syncDeps);
}

function bindLibrarySync() {
  if (isPlayMode) return;
  const input = $('library-key');
  if (input) input.value = getLibraryKey();
  renderSyncStatus();

  $('library-generate')?.addEventListener('click', () => {
    if (getLibraryKey() && !confirm('Replace the key on this computer? Games already in the old library stay there, and this computer will start a new, empty one.')) return;
    const k = generateKey();
    setLibraryKey(k);
    if (input) input.value = k;
    renderSyncStatus();
    runSync(true);
  });

  $('library-copy')?.addEventListener('click', async () => {
    const k = getLibraryKey();
    if (!k) return;
    try {
      await navigator.clipboard.writeText(k);
      flash($('library-copy'), 'Copied!');
    } catch {
      input?.select(); // clipboard needs a secure context; let them copy by hand
    }
  });

  $('library-key')?.addEventListener('change', (e) => {
    const k = e.target.value.trim().toLowerCase();
    if (k && !validKey(k)) {
      renderSyncStatus({ state: 'error', error: 'that key does not look right' });
      return;
    }
    setLibraryKey(k);
    e.target.value = k;
    renderSyncStatus();
    if (k) runSync(true);
  });

  $('library-sync')?.addEventListener('click', () => runSync(true));
}
// ---------- Results history (browser storage) ----------
// Every finished round is recorded so difficult words can be reviewed later —
// and turned into a fresh "review round" with one click.

const HISTORY_KEY = 'password.history.v1';
const HISTORY_MAX = 40;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}
function persistHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch (e) {
    console.warn('Could not save history:', e);
  }
}

// Words a player did not get right. For a full round that includes letters the
// clock cut off ("unanswered" — they're still part of the vocabulary to review);
// for an early exit only actually attempted letters (wrong/passed) count.
function missedFor(g, i, partial) {
  const p = g.players[i];
  return g.order
    .filter((L) => {
      const s = p.results[L];
      if (s === 'correct') return false;
      return partial ? s === 'wrong' || s === 'passed' : true;
    })
    .map((L) => {
      const e = g.entryFor(i, L);
      const s = p.results[L];
      return {
        letter: L,
        answer: e?.answer || '',
        clue: e?.clue || '',
        type: e?.type || 'starts',
        status: s === 'wrong' ? 'wrong' : s === 'passed' ? 'passed' : 'unanswered',
      };
    });
}

// Record the session once (guarded), skipping rounds where nothing was attempted.
function recordSession(g, partial = false) {
  if (!g || g._recorded) return;
  const attempted = g.players.some((p) => Object.values(p.results).some((s) => s === 'correct' || s === 'wrong' || s === 'passed'));
  if (!attempted) return;
  g._recorded = true;
  const session = {
    at: Date.now(),
    title: g.data.title || 'Untitled round',
    langCode: g.data.langCode || 'en-US',
    partial: !!partial,
    players: g.players.map((p, i) => ({
      name: p.name,
      color: p.color,
      score: g.score(p),
      total: g.order.length,
      missed: missedFor(g, i, partial),
    })),
  };
  persistHistory([session, ...loadHistory()]);
  renderHistory();
}

const STATUS_LABEL = { wrong: 'wrong', passed: 'passed', unanswered: 'not reached' };

function historyDate(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// Words missed most often across all recorded sessions (top of the review pile).
function mostMissed(history, limit = 8) {
  const counts = new Map(); // answer -> { n, clue }
  for (const s of history) {
    for (const p of s.players) {
      for (const m of p.missed) {
        if (!m.answer || m.status === 'unanswered') continue; // only genuinely attempted
        const cur = counts.get(m.answer) || { n: 0, clue: m.clue };
        cur.n += 1;
        counts.set(m.answer, cur);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([answer, v]) => ({ answer, clue: v.clue, n: v.n }));
}

function renderHistory() {
  const box = $('history');
  if (!box) return;
  const history = loadHistory();
  // the collapsed card's summary shows how much is inside
  const hint = $('history-hint');
  if (hint) hint.textContent = history.length ? `${history.length} round${history.length > 1 ? 's' : ''} recorded` : 'collects automatically';
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<p class="lib-empty">No rounds played yet — results will collect here automatically.</p>';
    return;
  }

  history.forEach((s, idx) => {
    const item = document.createElement('details');
    item.className = 'h-item';
    const scores = s.players.map((p) => `<b style="color:${esc(p.color || '#333')}">${esc(p.name)}</b> ${p.score}/${p.total}`).join(' · ');
    const missedCount = s.players.reduce((n, p) => n + p.missed.length, 0);
    item.innerHTML =
      `<summary><span class="h-date">${historyDate(s.at)}${s.partial ? ' · partial' : ''}</span>` +
      `<span class="h-title">${esc(s.title)}</span><span class="h-scores">${scores}</span></summary>` +
      s.players
        .map((p) => {
          if (!p.missed.length) return `<div class="h-player"><b style="color:${esc(p.color || '#333')}">${esc(p.name)}</b> — all correct 🎉</div>`;
          const words = p.missed
            .map((m) => `<span class="h-word ${m.status}" title="${esc(m.clue)} (${STATUS_LABEL[m.status] || m.status})"><i>${esc(m.letter)}</i>${esc(m.answer)}</span>`)
            .join('');
          return `<div class="h-player"><b style="color:${esc(p.color || '#333')}">${esc(p.name)}</b>${words}</div>`;
        })
        .join('') +
      `<div class="h-actions">` +
      (missedCount ? `<button class="btn small h-practice">▶ Practice the ${missedCount} missed word${missedCount > 1 ? 's' : ''}</button>` : '') +
      `<button class="btn ghost small h-del">🗑</button></div>`;
    item.querySelector('.h-practice')?.addEventListener('click', () => practiceSession(idx));
    item.querySelector('.h-del').addEventListener('click', () => {
      const h = loadHistory();
      h.splice(idx, 1);
      persistHistory(h);
      renderHistory();
    });
    box.appendChild(item);
  });

  const agg = mostMissed(history);
  if (agg.length) {
    const div = document.createElement('div');
    div.className = 'h-agg';
    div.innerHTML =
      '<span class="h-agg-label">Missed more than once:</span>' +
      agg.map((w) => `<span class="h-word wrong" title="${esc(w.clue)}">${esc(w.answer)} ×${w.n}</span>`).join('');
    box.appendChild(div);
  }

  const clear = document.createElement('button');
  clear.className = 'btn ghost small h-clear';
  clear.textContent = 'Clear history';
  clear.addEventListener('click', () => {
    persistHistory([]);
    renderHistory();
  });
  box.appendChild(clear);
}

// Build a playable round out of one session's missed words and load it. Letters
// missed by several players (different words) become per-player variants, so the
// review round naturally has one circle per word set.
function practiceSession(idx) {
  const s = loadHistory()[idx];
  if (!s) return;
  const byLetter = new Map();
  s.players.forEach((p) =>
    p.missed.forEach((m) => {
      if (!m.answer) return;
      const cur = byLetter.get(m.letter) || { letter: m.letter, type: m.type, variants: [] };
      if (!cur.variants.some((v) => v.answer === m.answer)) cur.variants.push({ answer: m.answer, accept: [], clue: m.clue });
      byLetter.set(m.letter, cur);
    })
  );
  const letters = [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter));
  if (!letters.length) return;
  const game = { title: `Review: ${s.title}`, langCode: s.langCode, letters };
  loadGameText(JSON.stringify(game), state.players);
  $('current-game')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function bindEditor() {
  $('edit-game').addEventListener('click', () => openEditor(true));
  $('save-local').addEventListener('click', saveLocal);
  $('export-library')?.addEventListener('click', exportLibrary);
  $('import-library')?.addEventListener('click', () => $('library-file').click());
  $('library-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // let the same file be picked again after a fix
    if (file) importLibraryText(await file.text());
  });
  $('editor-add').addEventListener('click', () => $('editor-rows').appendChild(editorRowEl({})));
  $('editor-scaffold').addEventListener('click', scaffoldEditor);
  $('editor-set-prev').addEventListener('click', () => setEditorSet(state.edit.set - 1));
  $('editor-set-next').addEventListener('click', () => setEditorSet(state.edit.set + 1));
  $('editor-set-add').addEventListener('click', addSet);
  $('editor-set-del').addEventListener('click', removeSet);
  // Blend the word sets letter by letter (see mixSets). Operates on the editor's
  // in-memory rows, so the teacher can rename the title and save the mix as a
  // NEW game without touching the original.
  $('editor-mix').addEventListener('click', () => {
    const msg = $('editor-msg');
    stashVisibleSet(); // capture in-progress edits before shuffling
    const rows = [...$('editor-rows').querySelectorAll('.erow')];
    const res = rows.length
      ? mixSets({ letters: rows.map((r) => ({ variants: r._variants })) }) // swaps in place
      : { ok: false, errors: ['Add some letters first.'] };
    if (!res.ok) {
      msg.className = 'msg error';
      msg.textContent = res.errors[0];
      return;
    }
    rows.forEach((r) => applyVariantToRow(r, state.edit.set));
    flash($('editor-mix'), 'Mixed!');
    msg.className = 'msg ok';
    msg.textContent =
      'Circles mixed — every set is now a random blend of the old ones. Rename the title before 💾 Save to keep the original game unchanged.';
  });
  $('editor-save').addEventListener('click', () => {
    if (saveEditorData()) {
      saveLocal(); // saving also stores it in this browser
      closeEditor();
      pushRemoteState();
    }
  });
  $('editor-cancel').addEventListener('click', closeEditor);
  renderLibrary();
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

// Clamped time-limit field value; 0 means no timer.
function playDurationValue() {
  const v = Math.floor(+$('play-duration').value);
  return Number.isFinite(v) && v >= 0 ? Math.min(3600, v) : 300;
}

// ---------- Play-settings persistence ----------
// Play settings belong to the teacher, not to any game: they are remembered on
// this laptop and NEVER changed by loading a game (a game is only its content).
const PREFS_KEY = 'password.prefs.v1';

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        mode: $('mode').value,
        strictness: parseFloat($('strictness').value),
        durationSec: playDurationValue(),
        ttsRate: state.ttsRate,
        autoRead: state.autoRead,
        showCorrectWord: state.showCorrectWord,
      })
    );
  } catch {
    /* storage unavailable */
  }
}

function applyPrefs() {
  let p = null;
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY));
  } catch {
    /* none saved */
  }
  if (!p) return;
  if (p.mode && [...$('mode').options].some((o) => o.value === p.mode)) $('mode').value = p.mode;
  if (typeof p.strictness === 'number') {
    $('strictness').value = p.strictness;
    if ($('strictness-out')) $('strictness-out').textContent = p.strictness;
  }
  if (typeof p.durationSec === 'number') $('play-duration').value = p.durationSec;
  if (typeof p.ttsRate === 'number') setTtsRate(p.ttsRate);
  if (typeof p.autoRead === 'boolean') {
    state.autoRead = p.autoRead;
    $('auto-read').checked = p.autoRead;
  }
  if (typeof p.showCorrectWord === 'boolean') setShowCorrectWord(p.showCorrectWord);
}

// One place to move the setting + its checkbox, so the setup tab, the game tab
// and the phone's apply-settings all end up in the same state.
function setShowCorrectWord(on) {
  state.showCorrectWord = !!on;
  const box = $('show-correct-word');
  if (box) box.checked = state.showCorrectWord;
  if (!state.showCorrectWord) hideAnswerBanner(); // switched off mid-flash: take it down now
}

// Snapshot the settings that can be pushed to (or launched into) a live game.
function currentSettings() {
  return {
    mode: $('mode').value,
    strictness: parseFloat($('strictness').value),
    durationSec: playDurationValue(),
    langCode: $('language').value,
    voiceName: state.voiceName,
    useNeural: state.useNeural,
    autoRead: state.autoRead,
    showCorrectWord: state.showCorrectWord,
    ttsRate: state.ttsRate,
    players: state.players.map((p) => ({ name: p.name, color: p.color })),
  };
}

// Launch the round in a NEW tab (so this tab stays a control panel). We hand the
// round off through localStorage, then open ./?play=1 which reads it back. Inside
// the game tab itself, "start" just (re)plays here.
function beginGame() {
  if (!state.data) return;
  if (isPlayMode) {
    if ($('game').classList.contains('hidden')) {
      // Fewer players than word circles: fold the extra circles' words in via
      // a fresh mix each time, instead of just leaving them unused.
      if (state.players.length < gameSetCount(state.data)) mixSets(state.data);
      startGame(state.players);
    }
    return;
  }
  const data = JSON.parse(JSON.stringify(state.data));
  if (state.players.length < gameSetCount(state.data)) mixSets(data); // same as above, on the handed-off copy
  const s = currentSettings();
  data.settings.mode = s.mode;
  data.settings.strictness = s.strictness;
  data.settings.durationSec = s.durationSec;
  data.langCode = s.langCode;
  const payload = { data, players: state.players.map((p) => ({ name: p.name, color: p.color })), settings: s };
  try {
    localStorage.setItem(PLAY_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not hand off the game:', e);
  }
  state.launchedPlay = true;
  updateLiveControls();
  window.open('./?play=1', '_blank');
}

// Setup tab: show the "apply to live game" button only while a game tab is open.
function updateLiveControls() {
  const btn = $('apply-live');
  if (!btn) return;
  btn.classList.toggle('hidden', !(state.launchedPlay || state.gameRunning));
}

// Setup tab: push the current settings to the running game tab.
function applyToLiveGame() {
  if (!bc) return;
  bc.postMessage({ t: 'apply', settings: currentSettings() });
  flash($('apply-live'), 'Applied ✓');
}

// Game tab: tell the setup tab whether a round is currently running.
function announceStatus() {
  if (!bc || !isPlayMode) return;
  const running = !!(state.game && !$('game').classList.contains('hidden') && !state.game.ended);
  bc.postMessage({ t: 'status', running, title: state.data?.title || '' });
}

// Game tab: apply settings pushed from the control panel without restarting.
function applyLiveSettings(s = {}) {
  const g = state.game;
  if (!g) return;
  if (s.mode) {
    g.data.settings.mode = s.mode;
    $('mode').value = s.mode;
  }
  if (typeof s.strictness === 'number') {
    g.data.settings.strictness = s.strictness;
    $('strictness').value = s.strictness;
  }
  if (typeof s.autoRead === 'boolean') {
    state.autoRead = s.autoRead;
    $('auto-read').checked = s.autoRead;
  }
  if (typeof s.showCorrectWord === 'boolean') setShowCorrectWord(s.showCorrectWord);
  if (typeof s.useNeural === 'boolean') state.useNeural = s.useNeural && state.neuralAvailable && !state.neuralBroken;
  if (typeof s.ttsRate === 'number') setTtsRate(s.ttsRate);

  // Time bank: adjust each running clock by the change so elapsed time is kept.
  // 0 switches the timer off mid-game (∞); a positive value switches it back on.
  if (typeof s.durationSec === 'number' && s.durationSec >= 0) {
    g.setDuration(s.durationSec);
    g.data.settings.durationSec = g.duration;
    $('play-duration').value = g.duration;
  }

  // Player names: update the engine, the on-board circle labels, the HUD, and
  // the roster used for the next round. Empty names are ignored.
  if (Array.isArray(s.players)) {
    s.players.forEach((pl, i) => {
      if (g.players[i] && pl && pl.name) {
        g.players[i].name = pl.name;
        if (state.players[i]) state.players[i].name = pl.name;
        state.circles[i]?.setName(pl.name);
      }
    });
    renderPlayers(state.players); // keep the setup panel's name fields in sync
  }
  if (state.circles?.length) renderHud(); // reflect new names/times without re-reading the clue

  const langChanged = s.langCode && s.langCode !== g.data.langCode;
  if (s.langCode) {
    g.data.langCode = s.langCode;
    const ls = $('language');
    if ([...ls.options].some((o) => o.value === s.langCode)) ls.value = s.langCode;
  }
  populateVoices(g.data.langCode);
  if (s.voiceName) {
    const vsel = $('voice');
    if ([...vsel.options].some((o) => o.value === s.voiceName)) {
      vsel.value = s.voiceName;
      state.voicePicked = true;
      state.voiceName = vsel.selectedOptions[0]?.dataset.type === 'browser' ? s.voiceName : null;
    }
  }

  // Recognizer follows the judging mode + language.
  const wantVoice = g.data.settings.mode.startsWith('voice') && recognitionSupported();
  if (!wantVoice) {
    stopTalk();
    state.recognizer = null;
  } else if (!state.recognizer || langChanged) {
    stopTalk();
    state.recognizer = makeRecognizer(g.data.langCode);
  }

  // Settings take effect internally and on the next clue (no forced re-read; the
  // teacher can press 🔊 to re-hear the current clue in a new voice/language).
  savePrefs(); // changes pushed from the panel/phone are teacher prefs too
  pushRemoteState();
  toast('Settings applied');
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
}

// ---------- Phone remote (companion controller over a relay) ----------
//
// Two routes to the phones, same protocol (see link.js):
//   local (default) — the ws relay inside server.js; phones join over the LAN.
//     Lowest lag and works without internet, but needs phone → laptop traffic
//     to be allowed (home Wi-Fi: yes; work/school networks: often no).
//   ☁ cloud — a Cloudflare Worker (relay/worker.js) that BOTH sides dial out
//     to, so inbound firewalls and client isolation never matter. The game tab
//     keeps running from the local server (neural TTS stays available); only
//     the relay hop moves to the cloud. Rooms are keyed by a sticky per-browser
//     code so the shared Worker can carry many games at once.

const RELAY_CLOUD_KEY = 'password.cloudRelay.v1'; // '1' = ☁ box ticked
const RELAY_ORIGIN_KEY = 'password.cloudRelayUrl.v1'; // user-entered Worker URL
const RELAY_ROOM_KEY = 'password.cloudRoom.v1'; // sticky per-browser room code

// Sticky random room code: unguessable enough for a classroom game, short
// enough to retype from the QR caption if scanning fails.
function relayRoom() {
  let code = localStorage.getItem(RELAY_ROOM_KEY) || '';
  if (!/^[a-z0-9]{6}$/.test(code)) {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/0/1 look-alikes
    code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join('');
    localStorage.setItem(RELAY_ROOM_KEY, code);
  }
  return code;
}

// The Worker URL: typed into the ☁ input (persisted) → baked into config.js →
// the page's own origin when it *is* the Worker (its /ws answers 426 to a
// plain GET, where a static host like GitHub Pages would 404).
async function resolveCloudOrigin() {
  const typed = (localStorage.getItem(RELAY_ORIGIN_KEY) || '').trim() || CLOUD_RELAY.trim();
  const origin = typed.replace(/\/+$/, '');
  if (/^https?:\/\//.test(origin)) return origin;
  try {
    const r = await fetch('/ws');
    if (r.status === 426) return location.origin;
  } catch {
    /* offline */
  }
  return '';
}

async function initRemoteLink() {
  state.link?.close(); // re-entrant: the ☁ controls re-run this on change
  state.link = null;
  state.remotes = 0;
  state.remoteUrl = '';

  let info = null;
  try {
    const r = await fetch('/lan-info');
    if (r.ok) info = await r.json();
  } catch {
    /* not the local server (cloud or static hosting) */
  }
  if (info) {
    // server present -> Microsoft neural voices available via /tts
    state.neuralAvailable = true;
    const nb = $('neural');
    if (nb && !state.neuralBroken) {
      nb.disabled = false;
      nb.checked = true;
      state.useNeural = true;
      if ($('neural-note')) $('neural-note').textContent = 'Using Microsoft neural voices via the server.';
      populateVoices($('language').value);
    }
  }

  // Without the local relay, the cloud is the only possible route.
  const cloud = !info || localStorage.getItem(RELAY_CLOUD_KEY) === '1';
  const box = $('relay-cloud');
  if (box) {
    box.checked = cloud;
    box.disabled = !info;
  }

  // Resolved even when ☁ is unticked: the saved-games library syncs to this same
  // Worker origin, and it must not hinge on a phone-remote setting.
  const origin = await resolveCloudOrigin();
  state.cloudOrigin = origin;
  const urlInput = $('relay-origin');
  if (urlInput) {
    if (!urlInput.value) urlInput.value = (localStorage.getItem(RELAY_ORIGIN_KEY) || CLOUD_RELAY || '').trim();
    // hidden when it has nothing to add: local mode, or the page IS the relay
    urlInput.hidden = !cloud || (!!origin && origin === location.origin);
  }

  state.relayMode = cloud ? 'cloud' : 'local';
  let room = 'main';
  if (cloud) {
    if (!origin) {
      if ($('remote-info'))
        $('remote-info').textContent =
          'Phone remote: paste your cloud relay URL above (README → “Cloud relay”)' +
          (info ? ', or untick ☁ to pair over this Wi-Fi.' : ' — or run “node server.js” on the laptop.');
      if ($('remote-qr')) $('remote-qr').innerHTML = '';
      return;
    }
    room = relayRoom();
    state.remoteUrl = `${origin}/remote?room=${room}`;
  } else {
    state.remoteUrl = `http://${info.ip}:${info.port}/remote`;
  }

  state.link = connect({
    role: 'host',
    room,
    relay: cloud && origin !== location.origin ? origin : '',
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
  renderQR();
}

$('relay-cloud')?.addEventListener('change', (e) => {
  localStorage.setItem(RELAY_CLOUD_KEY, e.target.checked ? '1' : '0');
  initRemoteLink();
});
$('relay-origin')?.addEventListener('change', (e) => {
  localStorage.setItem(RELAY_ORIGIN_KEY, e.target.value.trim());
  initRemoteLink();
});

function renderRemoteInfo() {
  const el = $('remote-info');
  if (!el || !state.remoteUrl) return;
  const here = state.relayMode === 'cloud' ? 'scan or open on your phone (any network)' : 'scan or open on your phone (same Wi‑Fi)';
  const conn = state.remotes > 0 ? `connected: ${state.remotes} 📱` : here;
  el.innerHTML = `📱 Phone remote — <b>${state.remoteUrl}</b> · ${conn}`;
}

// Render a scannable QR for the remote URL (vendored qrcode-generator, offline).
function renderQR() {
  const box = $('remote-qr');
  if (!box || !state.remoteUrl || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(state.remoteUrl);
    qr.make();
    box.innerHTML = `<img alt="Scan to open the phone remote" src="${qr.createDataURL(5, 8)}" />`;
  } catch (e) {
    console.warn('QR generation failed:', e);
  }
}

// Map a remote button to the same actions as the keyboard/on-screen controls.
function handleRemoteCommand(action, msg) {
  const g = state.game;
  const inGame = g && !$('game').classList.contains('hidden');
  // Confirm arrival on screen (and in the console) — if this never shows when you
  // press a phone button, the command isn't reaching the game (network/pairing),
  // not the button handling.
  if (action !== 'talk-start' && action !== 'talk-stop') {
    console.log('[remote] received:', action, '· inGame:', !!inGame);
    if (inGame && action !== 'apply-settings') toast('📱 ' + action); // apply shows its own toast
  }
  switch (action) {
    case 'apply-settings': if (inGame) applyLiveSettings(msg?.settings || {}); break;
    case 'correct': if (inGame) g.correct(); break;
    case 'wrong': if (inGame) g.wrong(); break;
    case 'pass': if (inGame) g.pass(); break;
    case 'talk-start': if (inGame) startTalk(); break;
    case 'talk-stop': stopTalk(); break;
    case 'read': if (inGame) readCurrentClue(); break;
    case 'mute': // suppress automatic read-aloud so the teacher can read the clues live
      if (inGame) {
        state.clueMuted = !state.clueMuted;
        if (state.clueMuted) stopNarration();
        pushRemoteState(); // reflect the new state on the phone's 🔇 button
      }
      break;
    case 'add-time': if (inGame) g.addTime(msg?.playerIndex, msg?.seconds); break; // emits 'tick' → HUD + phones repaint
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
  // Once the game runs in another tab, that tab is the authoritative host — don't
  // overwrite its state from the control panel.
  if (!isPlayMode && (state.launchedPlay || state.gameRunning)) return;
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
    time: Number.isFinite(p.timeLeft) ? p.timeLeft : -1, // -1 = no timer (Infinity isn't JSON)
    score: g.score(p),
    total: g.order.length,
    letter: e ? e.letter : '',
    kind: e ? (e.type === 'contains' ? `Contains ${e.letter}` : `Starts with ${e.letter}`) : '',
    clue: e ? e.clue : '',
    answer: e ? e.answer : '',
    accept: e ? (e.accept || []).join(', ') : '',
    paused: g.paused,
    muted: state.clueMuted,
    suggestion: state.lastSuggestion || '',
    // every player's clock, for the phone's per-player "add time" buttons —
    // not just whoever is currently answering
    roster: g.players.map((pl, i) => ({
      name: pl.name,
      color: pl.color,
      time: Number.isFinite(pl.timeLeft) ? pl.timeLeft : -1,
      done: pl.done,
      active: i === g.activeIndex,
    })),
    // current settings, so the phone's ⚙ panel starts from live values
    settings: {
      mode: g.data.settings.mode,
      strictness: g.data.settings.strictness,
      ttsRate: state.ttsRate,
      autoRead: state.autoRead,
      showCorrectWord: state.showCorrectWord,
      durationSec: g.duration,
      players: g.players.map((pl) => ({ name: pl.name, color: pl.color })),
      ...remoteVoiceChoices(g.data.langCode),
    },
  });
}

// Neural voices for the game's language (e.g. Catalan: Enric, Joana), plus the
// one currently in use — lets the phone's ⚙ panel offer a voice picker. Empty
// when the neural server isn't available (the picker hides itself).
function remoteVoiceChoices(langCode) {
  if (!(state.useNeural && state.neuralAvailable && !state.neuralBroken)) return { voices: [], voiceId: '' };
  const sel = $('voice').selectedOptions[0];
  const selId = sel && sel.dataset.type === 'neural' ? sel.value : null;
  const list = NEURAL_VOICES[langCode] || NEURAL_VOICES['en-US'];
  return {
    voices: list.map((id) => ({ id, label: neuralLabel(id) })),
    voiceId: neuralVoiceFor(langCode, selId),
  };
}

// ---------- Game screen ----------

// Build a speech recognizer wired to the game's handlers, for a given language.
function makeRecognizer(lang) {
  if (!recognitionSupported()) return null;
  const r = new Recognizer({ lang, maxAlternatives: 5 });
  r.onInterim = (t) => ($('heard').textContent = t ? `… ${t}` : '');
  r.onHypotheses = onHypotheses;
  r.onStateChange = (on) => $('mic').classList.toggle('live', on);
  return r;
}

function startGame(players) {
  const data = state.data;
  // Stamp the teacher's play settings onto the runtime copy the engine reads.
  data.settings.mode = $('mode').value;
  data.settings.strictness = parseFloat($('strictness').value);
  data.settings.durationSec = playDurationValue();

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

  if (data.settings.mode.startsWith('voice')) state.recognizer = makeRecognizer(data.langCode);

  game.addEventListener('update', render);
  game.addEventListener('reveal', renderReveal);
  game.addEventListener('tick', renderHud);
  game.addEventListener('end', showResults);
  // Answer stings: correct answers surface as 'update', wrong ones as 'reveal'.
  fxSeen = null;
  game.addEventListener('update', playAnswerFx);
  game.addEventListener('reveal', playAnswerFx);
  // after `render`, which clears the banner as part of repainting the board
  flashSeen = null;
  game.addEventListener('update', flashCorrectWord);

  applyClueHidden(true); // audio-only by default; teacher can reveal with 👁 / H
  game.start();
  render();

  // Start with the control bar hidden so it stays out of the projected picture;
  // dropping the mouse to the bottom edge summons it.
  state.autohide?.hide();
  announceStatus();
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

function renderBoard() {
  const game = state.game;
  state.circles.forEach((r, i) => {
    const p = game.players[i];
    r.setStates(p.results);
    r.setScore(game.score(p), game.order.length);
    r.setActive(i === game.activeIndex ? game.currentLetter : null);
  });
  layout();
  renderHud();
  state.lastSuggestion = null;
  $('suggestion').className = 'suggestion';
  $('suggestion').textContent = '';
  $('heard').textContent = '';
  hideAnswerBanner(); // the banner belongs to the answer just judged, not to the next letter
}

function render() {
  renderBoard();
  renderClue();
}

// Multiplayer: show the green/red result on the board for a beat (no narration,
// no turn change yet) before the engine switches to the next player.
function renderReveal() {
  stopNarration();
  renderBoard();
  // A wrong answer flashes the correct one while the red chip is held on screen
  // (passes don't — that letter comes back around later).
  const lr = state.game.lastResolved;
  if (lr && lr.state === 'wrong') {
    const e = state.game.entryFor(lr.playerIndex, lr.letter);
    if (e) {
      const banner = $('reveal-answer');
      banner.innerHTML = `<small>${esc(lr.letter)} was</small>${esc(e.answer)}`;
      banner.classList.remove('hidden');
    }
  }
}

function renderHud() {
  const game = state.game;
  const p = game.active;
  $('hud-name').textContent = p.name;
  $('hud-name').style.color = p.color;
  const t = p.timeLeft;
  $('hud-time').textContent = Number.isFinite(t)
    ? `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
    : '∞';
  $('hud-time').classList.toggle('low', Number.isFinite(t) && t <= 15);
  $('hud-score').textContent = `${game.score(p)}/${game.order.length}`;
  // mini circles show each player's own remaining time
  state.circles.forEach((c, i) => c.setTime(game.players[i].timeLeft));
  pushRemoteState();
}

// Spoken lead-in per language. The letter is wrapped in quotes and followed by a
// colon — e.g. 'Comença per la lletra "A": <clue>' — which makes the neural voice
// pronounce the single letter clearly without slurring into the lead or the clue.
const SAY_PREFIX = {
  en: { starts: 'Begins with the letter', contains: 'Contains the letter' },
  es: { starts: 'Empieza por la letra', contains: 'Contiene la letra' },
  fr: { starts: 'Commence par la lettre', contains: 'Contient la lettre' },
  ca: { starts: 'Comença per la lletra', contains: 'Conté la lletra' },
};
function spokenClue(entry, langCode) {
  const set = SAY_PREFIX[(langCode || 'en').slice(0, 2).toLowerCase()] || SAY_PREFIX.en;
  const lead = set[entry.type === 'contains' ? 'contains' : 'starts'];
  return `${lead} "${entry.letter}": ${entry.clue}`;
}
function readCurrentClue() {
  const e = state.game?.currentEntry;
  if (e) narrate(spokenClue(e, state.game.data.langCode), state.game.data.langCode);
}

// Hide/show the written definition so the round can be played from audio only.
function applyClueHidden(hidden) {
  document.body.classList.toggle('clue-hidden', hidden);
  const btn = $('toggle-clue');
  if (btn) {
    btn.textContent = hidden ? '🙈' : '👁';
    btn.title = hidden ? 'Show definition' : 'Hide definition (audio only)';
  }
}

function toggleClue() {
  const hidden = !document.body.classList.contains('clue-hidden');
  applyClueHidden(hidden);
  // revealing to audio-only mid-letter: speak the current clue right away
  if (hidden && !state.clueMuted && state.game && !$('game').classList.contains('hidden')) readCurrentClue();
}

function renderClue() {
  const entry = state.game.currentEntry;
  if (!entry) return;
  const verb = entry.type === 'contains' ? 'Contains' : 'Starts with';
  $('clue-letter').textContent = entry.letter;
  $('clue-kind').textContent = `${verb} ${entry.letter}`;
  $('clue-text').textContent = entry.clue;
  $('type-answer').value = '';
  // narrate automatically when auto-read is on, or when the text is hidden —
  // unless the remote's 🔇 mute is on (the teacher is reading the clues live)
  if (!state.clueMuted && (state.autoRead || document.body.classList.contains('clue-hidden'))) readCurrentClue();
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

  state.autohide = setupControlsAutohide();
}

// Keep the control bar out of the projected picture until the teacher drops the
// mouse to the bottom of the screen. It also stays up while a control is in use.
function setupControlsAutohide() {
  const game = $('game');
  const REVEAL_ZONE = 120; // px from the bottom edge that summons the bar
  let hideTimer = null;

  const forceVisible = () =>
    document.activeElement === $('type-answer') ||
    $('mic').classList.contains('live') ||
    (state.game && state.game.paused);

  const show = () => {
    clearTimeout(hideTimer);
    game.classList.remove('controls-hidden');
  };
  const hide = () => {
    if (!forceVisible()) game.classList.add('controls-hidden');
  };
  const scheduleHide = (delay = 300) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, delay);
  };

  document.addEventListener('pointermove', (e) => {
    if (game.classList.contains('hidden')) return;
    if (e.clientY >= window.innerHeight - REVEAL_ZONE) show();
    else scheduleHide();
  });
  document.addEventListener('touchstart', (e) => {
    if (game.classList.contains('hidden')) return;
    const t = e.touches[0];
    if (t && t.clientY >= window.innerHeight - REVEAL_ZONE) {
      show();
      scheduleHide(3000);
    }
  }, { passive: true });

  $('controls').addEventListener('pointerenter', show);
  $('controls').addEventListener('pointerleave', () => scheduleHide());
  $('type-answer').addEventListener('focus', show);
  $('type-answer').addEventListener('blur', () => scheduleHide());

  return { show, hide, scheduleHide };
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
  stopNarration();
  recordSession(state.game); // save to history before showing
  const overlay = $('result');
  const g = state.game;
  const rows = g
    .results()
    .map((r, i) => `<div class="result-row"><span>${i + 1}. <b style="color:${r.color}">${r.name}</b></span><span>${r.score} correct</span></div>`)
    .join('');
  // Review the tricky words with the class right away: everything not answered
  // correctly, with the clue on hover.
  const missed = g.players
    .map((p, i) => {
      const words = missedFor(g, i, false)
        .map((m) => `<span class="h-word ${m.status}" title="${esc(m.clue)}"><i>${esc(m.letter)}</i>${esc(m.answer)}</span>`)
        .join('');
      return words ? `<div class="h-player"><b style="color:${esc(p.color)}">${esc(p.name)}</b>${words}</div>` : '';
    })
    .join('');
  $('result-body').innerHTML =
    rows + (missed ? `<div class="result-missed"><div class="h-agg-label">Words to review</div>${missed}</div>` : '');
  overlay.classList.remove('hidden');
  $('result-again').onclick = endToSetup;
  announceStatus(); // game.ended -> tell the control panel the round is over
}

function endToSetup() {
  stopNarration();
  recordSession(state.game, true); // early exit: keep what was attempted (no-op if already saved)
  stopTalk();
  state.camera.stop($('cam'));
  state.cameraOn = false;
  document.body.classList.remove('cam-on');
  $('result').classList.add('hidden');
  $('game').classList.add('hidden');
  $('setup').classList.remove('hidden');
  announceStatus(); // game hidden -> control panel hides the "apply live" button
  pushRemoteState();
}

// Read a handed-off round from the setup tab and start playing immediately.
function bootPlay() {
  let payload = null;
  try {
    payload = JSON.parse(localStorage.getItem(PLAY_KEY));
  } catch {
    /* nothing handed off */
  }
  if (!payload || !payload.data) return; // opened ?play with nothing to play — stay on setup
  state.data = payload.data;
  const s = payload.settings || {};
  state.autoRead = !!s.autoRead;
  $('auto-read').checked = state.autoRead;
  if (typeof s.showCorrectWord === 'boolean') setShowCorrectWord(s.showCorrectWord);
  if (typeof s.ttsRate === 'number') setTtsRate(s.ttsRate);
  if (typeof s.useNeural === 'boolean') state.useNeural = s.useNeural;
  if (s.voiceName) {
    state.voiceName = s.voiceName;
    state.voicePicked = true;
  }
  const ls = $('language');
  if (s.langCode && [...ls.options].some((o) => o.value === s.langCode)) {
    ls.value = s.langCode;
    populateVoices(s.langCode);
  }
  if (s.mode) $('mode').value = s.mode;
  if (typeof s.durationSec === 'number') $('play-duration').value = s.durationSec;
  if (typeof s.strictness === 'number') {
    $('strictness').value = s.strictness;
    if ($('strictness-out')) $('strictness-out').textContent = s.strictness;
  }
  const players = payload.players?.length ? payload.players : state.players;
  state.players = players;
  startGame(players);
}

// Cross-tab wiring: setup tab pushes settings; game tab reports status + applies.
if (bc) {
  bc.onmessage = (ev) => {
    const m = ev.data || {};
    if (isPlayMode) {
      if (m.t === 'apply') applyLiveSettings(m.settings);
      else if (m.t === 'ping') announceStatus();
    } else {
      if (m.t === 'status') {
        state.gameRunning = m.running;
        if (!m.running) {
          state.launchedPlay = false;
          renderHistory(); // the game tab just recorded a finished round
        }
        updateLiveControls();
      } else if (m.t === 'library') {
        // Another setup tab synced or saved. Re-read rather than keep our own
        // copy, or this tab would later push a stale whole-store over it.
        renderLibrary();
        renderSyncStatus();
      }
    }
  };
}

// ---------- boot ----------
migrateV1(); // lift a title-keyed v1 library into id-keyed v2 (v1 is left untouched)
setupScreen();
applyPrefs(); // restore the teacher's play settings (games never override them)
bindGameControls();
bindEditor();
bindAppend();
renderHistory();
const remoteReady = initRemoteLink(); // resolves once we know whether the neural server is up
bindLibrarySync();
// Only after initRemoteLink has resolved the Worker origin — and never in the
// projector tab, which must make no network calls mid-lesson.
if (!isPlayMode) remoteReady.then(() => runSync(false)).catch(() => {});
$('strictness-out') && $('strictness').addEventListener('input', (e) => ($('strictness-out').textContent = e.target.value));
$('auto-read')?.addEventListener('change', (e) => {
  state.autoRead = e.target.checked;
  savePrefs();
});
$('show-correct-word')?.addEventListener('change', (e) => {
  setShowCorrectWord(e.target.checked);
  savePrefs();
});
$('apply-live')?.addEventListener('click', applyToLiveGame);

if (isPlayMode) {
  document.body.classList.add('play-mode');
  // Hold the first clue until the neural probe finishes, otherwise clue #1 is
  // narrated with the browser fallback (robotic) before neural is known available
  // — and only clue #2 onward would get the neural voice. Cap the wait so a
  // slow or absent server can't stall the game start.
  Promise.race([remoteReady.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).finally(bootPlay);
} else if (bc) {
  bc.postMessage({ t: 'ping' }); // if a game tab is already open, it'll reveal the apply button
}
