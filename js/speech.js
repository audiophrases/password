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

function refresh() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  listeners.forEach((cb) => cb(voices));
}
if (window.speechSynthesis) {
  refresh();
  // Edge loads its online "Natural" voices a moment after page load.
  window.speechSynthesis.onvoiceschanged = refresh;
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

export function speak(text, langCode = 'en-US', voiceName = null) {
  if (!window.speechSynthesis || !text) return;
  stopSpeaking();
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
  u.rate = 0.95;
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
  clearInterval(keepAlive);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
