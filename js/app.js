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
  circles: [],
  players: [],
  recognizer: null,
  camera: new Camera(),
  cameraOn: false,
  autoRead: true, // read clues aloud by default (checkbox in Play settings)
  ttsRate: 1, // read-aloud speed multiplier (1 = normal); fine-tuned in Settings
  voiceName: null,
  voicePicked: false,
  neuralAvailable: false,
  useNeural: false,
  neuralBroken: false,
  edit: { set: 0, sets: 1 },
  lastSuggestion: null,
  link: null,
  remoteUrl: '',
  remotes: 0,
  launchedPlay: false, // this (setup) tab has opened a game tab
  gameRunning: false, // a game tab has reported itself running
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
  // server TTS failed (offline / token rejected): drop to the browser voice for good
  state.neuralBroken = true;
  state.useNeural = false;
  const nb = $('neural');
  if (nb) nb.checked = false;
  if ($('neural-note')) $('neural-note').textContent = 'Neural voice unavailable — using the browser voice.';
  populateVoices($('language').value);
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
  $('tts-rate').addEventListener('input', (e) => setTtsRate(parseFloat(e.target.value) || 1));
  $('tts-rate-num').addEventListener('change', (e) => setTtsRate(parseFloat(e.target.value) || 1));
  setTtsRate(parseFloat($('tts-rate').value) || 1); // sync state + boxes from the initial value
  populateVoices($('language').value);
  onVoices(() => populateVoices($('language').value)); // re-list once Edge's natural voices load

  $('build-prompt').addEventListener('click', () => {
    const opt = $('prompt-lang').selectedOptions[0];
    const letters = ($('letters').value || ALPHABET_EN.join('')).toUpperCase().replace(/[^A-ZÑ]/g, '').split('');
    const prompt = buildPrompt({
      language: opt.dataset.name,
      level: $('level').value,
      topic: $('topic').value.trim() || 'everyday vocabulary',
      letters: letters.length ? letters : ALPHABET_EN,
      langCode: opt.value,
      durationSec: +$('duration').value || 200,
      players: state.players.length,
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
  if (!g) {
    box.className = 'current-game none';
    box.innerHTML = 'No game loaded — pick or create one in <b>2 · Your games</b>.';
    return;
  }
  const langName =
    [...$('language').options].find((o) => o.value === g.langCode)?.dataset.name || g.language || g.langCode;
  box.className = 'current-game';
  box.innerHTML =
    `<b>${esc(g.title)}</b>` +
    `<span>${esc(langName)} · ${g.letters.length} letters · ${g.players} player${g.players > 1 ? 's' : ''} · ${g.settings.durationSec}s each</span>`;
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
  // Sync only the play settings (section 3) from the loaded game — never the
  // section-1 prompt fields (language/letters/seconds), which stay independent.
  $('mode').value = result.game.settings.mode;
  $('strictness').value = result.game.settings.strictness;
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
  $('editor-duration').value = data?.settings?.durationSec || 200;
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
    settings: { durationSec: +$('editor-duration').value || 200, mode: $('mode').value, strictness: parseFloat($('strictness').value) },
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

const STORE_KEY = 'password.games.v1';

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function persistStore(obj) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('Could not save to browser storage:', e);
  }
}

const libMeta = (game) => `${(game.langCode || '??').slice(0, 2)} · ${game.letters?.length || 0} letters`;

// Render the saved-games library: one clickable row per game (open / edit / delete).
function renderLibrary() {
  const box = $('library');
  if (!box) return;
  const store = loadStore();
  const names = Object.keys(store).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    box.innerHTML = '<p class="lib-empty">No saved games yet. Make a New game, or import one below, then Save.</p>';
  } else {
    box.innerHTML = '';
    for (const n of names) {
      const item = document.createElement('div');
      item.className = 'lib-item' + (state.data && state.data.title === n ? ' current' : '');
      item.innerHTML =
        `<button class="lib-open"><span class="lib-title">${esc(n)}</span>` +
        `<span class="lib-meta">${esc(libMeta(store[n]))}</span></button>` +
        `<button class="lib-edit" title="Edit">✏️</button>` +
        `<button class="lib-del" title="Delete">🗑</button>`;
      item.querySelector('.lib-open').addEventListener('click', () => openSaved(n));
      item.querySelector('.lib-edit').addEventListener('click', () => editSaved(n));
      item.querySelector('.lib-del').addEventListener('click', () => deleteSaved(n));
      box.appendChild(item);
    }
  }
  const d = $('import-details');
  if (d && !names.length) d.open = true; // help first-timers find import
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
  btn.textContent = loadStore()[state.data.title] ? '💾 Update saved game' : '💾 Save current game';
}

// Save the current game into this browser (keyed by title; same title updates).
function saveLocal() {
  const v = $('validation');
  if (!state.data) {
    v.className = 'msg error';
    v.textContent = 'Make or import a game first.';
    return;
  }
  const store = loadStore();
  store[state.data.title] = state.data;
  persistStore(store);
  renderLibrary();
  v.className = 'msg ok';
  v.textContent = `Saved "${state.data.title}" in this browser.`;
}

function openSaved(name) {
  const game = loadStore()[name];
  if (!game) return;
  loadGameText(JSON.stringify(game), state.players);
  if (!$('editor').classList.contains('hidden')) openEditor(); // refresh editor if open
}

function editSaved(name) {
  openSaved(name);
  openEditor();
}

function deleteSaved(name) {
  const store = loadStore();
  delete store[name];
  persistStore(store);
  renderLibrary();
}

function bindEditor() {
  $('edit-game').addEventListener('click', () => openEditor(true));
  $('save-local').addEventListener('click', saveLocal);
  $('editor-add').addEventListener('click', () => $('editor-rows').appendChild(editorRowEl({})));
  $('editor-scaffold').addEventListener('click', scaffoldEditor);
  $('editor-set-prev').addEventListener('click', () => setEditorSet(state.edit.set - 1));
  $('editor-set-next').addEventListener('click', () => setEditorSet(state.edit.set + 1));
  $('editor-set-add').addEventListener('click', addSet);
  $('editor-set-del').addEventListener('click', removeSet);
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

// Snapshot the settings that can be pushed to (or launched into) a live game.
function currentSettings() {
  return {
    mode: $('mode').value,
    strictness: parseFloat($('strictness').value),
    durationSec: +$('duration').value || state.data?.settings?.durationSec || 200,
    langCode: $('language').value,
    voiceName: state.voiceName,
    useNeural: state.useNeural,
    autoRead: state.autoRead,
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
    if ($('game').classList.contains('hidden')) startGame(state.players);
    return;
  }
  const data = JSON.parse(JSON.stringify(state.data));
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
  if (typeof s.useNeural === 'boolean') state.useNeural = s.useNeural && state.neuralAvailable && !state.neuralBroken;
  if (typeof s.ttsRate === 'number') setTtsRate(s.ttsRate);

  // Time bank: adjust each running clock by the change so elapsed time is kept.
  if (typeof s.durationSec === 'number' && s.durationSec > 0) g.setDuration(s.durationSec);

  // Player names: update the engine, the on-board circle labels, and the HUD.
  if (Array.isArray(s.players)) {
    s.players.forEach((pl, i) => {
      if (g.players[i] && pl && pl.name) {
        g.players[i].name = pl.name;
        state.circles[i]?.setName(pl.name);
      }
    });
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
  renderQR();
}

function renderRemoteInfo() {
  const el = $('remote-info');
  if (!el || !state.remoteUrl) return;
  const conn = state.remotes > 0 ? `connected: ${state.remotes} 📱` : 'scan or open on your phone (same Wi‑Fi)';
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
function handleRemoteCommand(action) {
  const g = state.game;
  const inGame = g && !$('game').classList.contains('hidden');
  // Confirm arrival on screen (and in the console) — if this never shows when you
  // press a phone button, the command isn't reaching the game (network/pairing),
  // not the button handling.
  if (action !== 'talk-start' && action !== 'talk-stop') {
    console.log('[remote] received:', action, '· inGame:', !!inGame);
    if (inGame) toast('📱 ' + action);
  }
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
    time: p.timeLeft,
    score: g.score(p),
    total: g.order.length,
    letter: e ? e.letter : '',
    kind: e ? (e.type === 'contains' ? `Contains ${e.letter}` : `Starts with ${e.letter}`) : '',
    clue: e ? e.clue : '',
    answer: e ? e.answer : '',
    accept: e ? (e.accept || []).join(', ') : '',
    paused: g.paused,
    suggestion: state.lastSuggestion || '',
  });
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

  if (data.settings.mode.startsWith('voice')) state.recognizer = makeRecognizer(data.langCode);

  game.addEventListener('update', render);
  game.addEventListener('reveal', renderReveal);
  game.addEventListener('tick', renderHud);
  game.addEventListener('end', showResults);

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
  const overlay = $('result');
  const rows = state.game
    .results()
    .map((r, i) => `<div class="result-row"><span>${i + 1}. <b style="color:${r.color}">${r.name}</b></span><span>${r.score} correct</span></div>`)
    .join('');
  $('result-body').innerHTML = rows;
  overlay.classList.remove('hidden');
  $('result-again').onclick = endToSetup;
  announceStatus(); // game.ended -> tell the control panel the round is over
}

function endToSetup() {
  stopNarration();
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
        if (!m.running) state.launchedPlay = false;
        updateLiveControls();
      }
    }
  };
}

// ---------- boot ----------
setupScreen();
bindGameControls();
bindEditor();
const remoteReady = initRemoteLink(); // resolves once we know whether the neural server is up
$('strictness-out') && $('strictness').addEventListener('input', (e) => ($('strictness-out').textContent = e.target.value));
$('auto-read')?.addEventListener('change', (e) => (state.autoRead = e.target.checked));
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
