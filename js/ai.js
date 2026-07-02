// ai.js — build a copy-paste prompt for any chatbot and validate the JSON it returns.
// Provider-agnostic on purpose: no API keys live in a public static site.

export const ALPHABET_EN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export function buildPrompt({
  language = 'English',
  level = 'A2',
  topic = 'everyday vocabulary',
  letters = ALPHABET_EN,
  langCode = 'en-US',
  players = 1,
}) {
  const letterList = letters.join(', ');
  const n = Math.max(1, players);
  const variantsRule =
    n > 1
      ? `Provide exactly ${n} "variants" per letter — a DIFFERENT word (with its own clue) for each player. The players are in the same classroom and hear each other answer, so no two players may get the same word for a given letter; make the variants genuinely different words, not synonyms or plurals of one another.`
      : `Provide exactly 1 "variant" per letter.`;
  return `You are creating word lists for "Password", an alphabet word game for an ESL classroom. There is one word and clue per letter of the alphabet; the player guesses each word from its clue.

Target language: ${language}
Level (CEFR): ${level}
Topic / theme: ${topic}
Letters to include: ${letterList}
Players: ${n}

Return ONLY valid JSON (no markdown, no commentary) matching this exact schema:

{
  "title": "string — short name for this round",
  "language": "${language}",
  "langCode": "${langCode}",
  "settings": { "mode": "voice-auto", "strictness": 0.7 },
  "players": ${n},
  "letters": [
    {
      "letter": "A",
      "type": "starts",            // "starts" (word begins with the letter) or "contains" (letter appears in it)
      "variants": [
        {
          "answer": "string — the target word, lowercase",
          "accept": ["optional synonyms / accepted variants, lowercase"],
          "clue": "string — a one-sentence clue at ${level} level. Do NOT include the answer word."
        }
        // exactly ${n} variant object(s), one per player
      ]
    }
  ]
}

Rules:
- Write every answer and clue in ${language} (the target language).
- One letter object per letter listed above, in that order.
- ${variantsRule}
- All variants of a letter share the same "letter" and "type".
- Prefer "starts" for the letter; only use "contains" when no good ${level} word fits (then end each clue with "(contains <LETTER>)").
- Keep answers to a single word where possible, lowercase, no punctuation.
- Clues must be solvable at ${level} and must never contain their own answer.
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
    const type = l.type === 'contains' ? 'contains' : 'starts';

    // Each letter has one or more per-player variants. Accept the legacy
    // single-word shape ({answer, accept, clue}) as a single variant.
    const rawVariants =
      Array.isArray(l.variants) && l.variants.length ? l.variants : [{ answer: l.answer, accept: l.accept, clue: l.clue }];
    const variants = rawVariants.map((v, j) => {
      if (!v || typeof v !== 'object') {
        errors.push(`${where} variant ${j + 1} is not an object.`);
        return null;
      }
      if (!v.answer || typeof v.answer !== 'string') errors.push(`${letter || where} variant ${j + 1} missing "answer".`);
      if (!v.clue || typeof v.clue !== 'string') errors.push(`${letter || where} variant ${j + 1} missing "clue".`);
      const accept = Array.isArray(v.accept) ? v.accept.filter((x) => typeof x === 'string') : [];
      return { answer: String(v.answer || ''), accept, clue: String(v.clue || '') };
    });
    return { letter, type, variants };
  });

  if (errors.length) return { ok: false, errors };

  // intended player count: explicit "players", else the max variants per letter
  const maxVariants = letters.reduce((m, l) => Math.max(m, l.variants.length), 1);
  const players = Math.max(1, Math.min(6, Number(obj.players) || maxVariants));

  const game = {
    title: obj.title || 'Untitled round',
    language: obj.language || 'English',
    langCode: obj.langCode || 'en-US',
    players,
    settings: {
      // default 300s; an explicit 0 is kept and means "no timer"
      durationSec: (() => {
        const d = Number(obj.settings?.durationSec);
        return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 300;
      })(),
      mode: obj.settings?.mode || 'voice-auto',
      strictness: typeof obj.settings?.strictness === 'number' ? obj.settings.strictness : 0.7,
    },
    letters,
  };
  return { ok: true, errors: [], game };
}

// Replace raw control characters that sit *inside* string literals (e.g. line
// breaks from a wrapped paste, which JSON forbids) with spaces, so hand-pasted
// JSON still loads.
function softenControlChars(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
    } else if (ch === '\\') {
      out += ch;
      esc = true;
    } else if (ch === '"') {
      inStr = !inStr;
      out += ch;
    } else if (inStr && ch.charCodeAt(0) < 0x20) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

// Tolerant parse: accepts raw JSON, ```json fences, surrounding prose, an outer
// [ ... ] array wrapper (uses the first element), and wrapped/multiline strings.
export function parseGameText(text) {
  let raw = (text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();

  // Slice to the outermost JSON value if there's surrounding prose.
  const objAt = raw.indexOf('{');
  const arrAt = raw.indexOf('[');
  let startChar = '{';
  let startIdx = objAt;
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) {
    startChar = '[';
    startIdx = arrAt;
  }
  const endIdx = raw.lastIndexOf(startChar === '{' ? '}' : ']');
  if (startIdx !== -1 && endIdx > startIdx) raw = raw.slice(startIdx, endIdx + 1);

  raw = softenControlChars(raw);

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: ['Could not parse JSON: ' + e.message] };
  }
  if (Array.isArray(obj)) obj = obj[0]; // tolerate an outer array wrapper
  return validateGame(obj);
}
