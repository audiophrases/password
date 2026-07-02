// speech.js — thin wrappers over the Web Speech API.
// Recognition (Chrome/Edge, cloud-backed) is used as an assist with multiple
// alternatives. Synthesis prefers the natural neural voices Microsoft Edge exposes
// ("… Online (Natural)") so the spoken clues sound like Edge Read Aloud.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function recognitionSupported() {
  return !!SR;
}

export class Recognizer {
  constructor({ lang = 'en-US', maxAlternatives = 5 } = {}) {
    this.lang = lang;
    this.maxAlternatives = maxAlternatives;
    this.onHypotheses = () => {};
    this.onInterim = () => {};
    this.onStateChange = () => {};
    this.rec = null;
    this.listening = false;
  }

  start() {
    if (!SR || this.listening) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.maxAlternatives = this.maxAlternatives;
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (e) => {
      const result = e.results[e.results.length - 1];
      if (!result.isFinal) {
        this.onInterim(result[0]?.transcript || '');
        return;
      }
      const hyps = [];
      for (let i = 0; i < result.length; i++) {
        hyps.push({ transcript: result[i].transcript, confidence: result[i].confidence });
      }
      this.onHypotheses(hyps);
    };
    rec.onend = () => {
      this.listening = false;
      this.onStateChange(false);
    };
    rec.onerror = () => {
      this.listening = false;
      this.onStateChange(false);
    };

    this.rec = rec;
    this.listening = true;
    this.onStateChange(true);
    try {
      rec.start();
    } catch {
      this.listening = false;
    }
  }

  stop() {
    if (this.rec && this.listening) {
      try {
        this.rec.stop();
      } catch {
        /* already stopping */
      }
    }
  }
}

// ---------- voices / synthesis ----------

let voices = [];
const listeners = new Set();

// Edge exposes its high-quality online "Natural" voices a moment after page
// load. Until they arrive, getVoices() lists only robotic local voices, so the
// first spoken clue of a session would come out in the wrong voice. We defer
// the first utterance until the list has "settled": a natural voice appeared,
// or we gave up waiting (some browsers only ever expose local voices).
let voicesSettled = false;
let settleTimer = null;
const readyWaiters = new Set();

function haveNaturalVoice() {
  return voices.some((v) => /natural|online/i.test(v.name || ''));
}

function markVoicesSettled() {
  if (voicesSettled) return;
  voicesSettled = true;
  clearTimeout(settleTimer);
  readyWaiters.forEach((cb) => cb());
  readyWaiters.clear();
}

// Run cb once the natural voices have loaded — or immediately if they already
// have (or we've stopped waiting).
function whenVoicesReady(cb) {
  if (voicesSettled || !window.speechSynthesis) cb();
  else readyWaiters.add(cb);
}

function refresh() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  listeners.forEach((cb) => cb(voices));
  if (haveNaturalVoice()) markVoicesSettled();
}
if (window.speechSynthesis) {
  refresh();
  // Edge loads its online "Natural" voices a moment after page load.
  window.speechSynthesis.onvoiceschanged = refresh;
  // Never wait forever: fall back to whatever voices exist after a short grace.
  settleTimer = setTimeout(markVoicesSettled, 2500);
}

// Notify whenever the voice list changes (fires immediately if already loaded).
export function onVoices(cb) {
  listeners.add(cb);
  if (voices.length) cb(voices);
  return () => listeners.delete(cb);
}

function rank(v) {
  const n = v.name || '';
  let s = 0;
  if (/natural/i.test(n)) s += 8;       // Edge neural voices
  if (/online/i.test(n)) s += 4;
  if (/microsoft/i.test(n)) s += 2;
  if (/google/i.test(n)) s += 1;
  if (!v.localService) s += 1;          // online generally higher quality
  return s;
}

export function voicesFor(langCode) {
  const two = (langCode || 'en').slice(0, 2).toLowerCase();
  return voices
    .filter((v) => v.lang && (v.lang.toLowerCase() === langCode.toLowerCase() || v.lang.toLowerCase().startsWith(two)))
    .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
}

export function bestVoice(langCode) {
  return voicesFor(langCode)[0] || null;
}

let keepAlive = null;
let speakToken = 0;

export function speak(text, langCode = 'en-US', voiceName = null, rate = 1) {
  if (!window.speechSynthesis || !text) return;
  stopSpeaking();
  const token = ++speakToken;
  // Hold the utterance until Edge's natural voices have loaded — otherwise the
  // first spoken clue of a session comes out in the robotic default voice.
  whenVoicesReady(() => {
    if (token === speakToken) utter(text, langCode, voiceName, rate);
  });
}

function utter(text, langCode, voiceName, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langCode;
  const two = langCode.slice(0, 2).toLowerCase();
  let voice = null;
  if (voiceName) {
    const v = voices.find((x) => x.name === voiceName);
    if (v && v.lang.toLowerCase().startsWith(two)) voice = v; // honor choice only if it fits the language
  }
  if (!voice) voice = bestVoice(langCode);
  if (voice) u.voice = voice;
  u.rate = Math.min(4, Math.max(0.1, rate || 1));
  u.pitch = 1;
  u.onend = () => clearInterval(keepAlive);
  u.onerror = () => clearInterval(keepAlive);
  window.speechSynthesis.speak(u);
  // Work around the Chromium/Edge bug that stops long utterances after ~15s.
  keepAlive = setInterval(() => {
    if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
    else clearInterval(keepAlive);
  }, 9000);
}

export function stopSpeaking() {
  speakToken++; // cancel any utterance still waiting on the voice list
  clearInterval(keepAlive);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
