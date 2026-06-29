// ai.js — build a copy-paste prompt for any chatbot and validate the JSON it returns.
// Provider-agnostic on purpose: no API keys live in a public static site.

export const ALPHABET_EN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export function buildPrompt({
  language = 'English',
  level = 'A2',
  topic = 'everyday vocabulary',
  letters = ALPHABET_EN,
  langCode = 'en-US',
  durationSec = 200,
}) {
  const letterList = letters.join(', ');
  return `You are creating word lists for "Password", an alphabet word game for an ESL classroom. There is one target word and one clue for each letter of the alphabet, and the player guesses each word from its clue.

Target language: ${language}
Level (CEFR): ${level}
Topic / theme: ${topic}
Letters to include: ${letterList}

Return ONLY valid JSON (no markdown, no commentary) matching this exact schema:

{
  "title": "string — short name for this round",
  "language": "${language}",
  "langCode": "${langCode}",
  "settings": { "durationSec": ${durationSec}, "mode": "voice-assist", "strictness": 0.7 },
  "letters": [
    {
      "letter": "A",
      "type": "starts",            // "starts" (word begins with the letter) or "contains" (letter appears in it)
      "answer": "string — the single target word, lowercase",
      "accept": ["optional synonyms or accepted variants, lowercase"],
      "clue": "string — a one-sentence definition/clue at ${level} level. Do NOT include the answer word."
    }
  ]
}

Rules:
- Write every answer and clue in ${language} (the target language).
- One object per letter listed above, in that order.
- Prefer "starts" for the letter; only use "contains" when no good ${level} word starts with it (then make the clue end with "(contains <LETTER>)").
- Keep answers to a single word where possible, lowercase, no punctuation.
- Clues must be solvable at ${level} and must never contain the answer.
- Output JSON only.`;
}

export function validateGame(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Not a JSON object.'] };
  if (!Array.isArray(obj.letters) || obj.letters.length === 0) {
    return { ok: false, errors: ['Missing "letters" array.'] };
  }

  const seen = new Set();
  const letters = obj.letters.map((l, i) => {
    const where = `letters[${i}]`;
    if (!l || typeof l !== 'object') {
      errors.push(`${where} is not an object.`);
      return null;
    }
    const letter = String(l.letter || '').trim().toUpperCase();
    if (!letter) errors.push(`${where} missing "letter".`);
    if (seen.has(letter)) errors.push(`${where} duplicate letter "${letter}".`);
    seen.add(letter);
    if (!l.answer || typeof l.answer !== 'string') errors.push(`${where} missing "answer".`);
    if (!l.clue || typeof l.clue !== 'string') errors.push(`${where} missing "clue".`);
    const type = l.type === 'contains' ? 'contains' : 'starts';
    const accept = Array.isArray(l.accept) ? l.accept.filter((x) => typeof x === 'string') : [];
    return {
      letter,
      type,
      answer: String(l.answer || ''),
      accept,
      clue: String(l.clue || ''),
    };
  });

  if (errors.length) return { ok: false, errors };

  const game = {
    title: obj.title || 'Untitled round',
    language: obj.language || 'English',
    langCode: obj.langCode || 'en-US',
    settings: {
      durationSec: Number(obj.settings?.durationSec) || 200,
      mode: obj.settings?.mode || 'voice-assist',
      strictness: typeof obj.settings?.strictness === 'number' ? obj.settings.strictness : 0.7,
    },
    letters,
  };
  return { ok: true, errors: [], game };
}

// Tolerant parse: accepts raw JSON or JSON wrapped in ```json fences / surrounding prose.
export function parseGameText(text) {
  let raw = (text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  if (raw[0] !== '{') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: ['Could not parse JSON: ' + e.message] };
  }
  return validateGame(obj);
}
