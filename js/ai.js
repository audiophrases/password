// ai.js — build a copy-paste prompt for any chatbot and validate the JSON it returns.
// Provider-agnostic on purpose: no API keys live in a public static site.

export const ALPHABET_EN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// What kind of round is being generated — each use case gets its own framing,
// clue style and answer rule, while the JSON schema stays identical.
const PURPOSES = {
  vocabulary: {
    intro: (language) =>
      `an alphabet word game played in class by school students learning ${language} as a foreign language. There is one word and clue per letter of the alphabet; the player guesses each word from its clue.`,
    clue: (language, level) => `a one-sentence definition-style clue at ${level} level`,
    rule: (language, level) =>
      `Answers are common ${language} vocabulary words (no proper nouns); clues are simple definitions solvable at ${level}.`,
  },
  quiz: {
    intro: (language) =>
      `a general-knowledge quiz in ${language}, played in class as an alphabet game. Each letter has an answer — a person, place, event, work or concept — and the player names it from a short factual clue.`,
    clue: (language, level) => `a one-sentence factual clue (who/what/where), in simple ${level}-level ${language}`,
    rule: (language, level) =>
      `Answers may be proper nouns (people, places, works, events) or common nouns — real general-knowledge material, not vocabulary practice; clues are factual hints in simple ${level}-level ${language}.`,
  },
  subject: {
    intro: (language) =>
      `a school revision game in ${language} for the subject given below, played as an alphabet quiz. Each letter has a key term from the subject; the player names it from a short clue.`,
    clue: (language, level) => `a one-sentence clue that quizzes the concept, in simple ${level}-level ${language}`,
    rule: (language, level) =>
      `Answers are key terms, names and concepts from the subject/curriculum below; clues test understanding of the material, phrased in simple ${level}-level ${language}.`,
  },
};

export function buildPrompt({
  language = 'English',
  level = 'A2',
  topic = 'everyday vocabulary',
  letters = ALPHABET_EN,
  players = 1,
  purpose = 'vocabulary',
}) {
  const letterList = letters.join(', ');
  const n = Math.max(1, players);
  const p = PURPOSES[purpose] || PURPOSES.vocabulary;
  const variantsRule =
    n > 1
      ? `Provide exactly ${n} "variants" per letter — a DIFFERENT word (with its own clue) for each player. The players are in the same classroom and hear each other answer, so no two players may get the same word for a given letter; make the variants genuinely different words, not synonyms or plurals of one another.`
      : `Provide exactly 1 "variant" per letter.`;
  return `You are creating word lists for "Password", ${p.intro(language)}

Language: ${language}
Level (CEFR, for the clue language): ${level}
Topic / theme: ${topic}
Letters to include: ${letterList}
Players: ${n}

Return ONLY valid JSON (no markdown, no commentary) matching this exact schema:

{
  "title": "string — short name for this round",
  "language": "${language}",
  "players": ${n},
  "letters": [
    {
      "letter": "A",
      "type": "starts",            // "starts" (word begins with the letter) or "contains" (letter appears in it)
      "variants": [
        {
          "answer": "string — the target answer, lowercase",
          "accept": ["optional synonyms / accepted variants, lowercase"],
          "clue": "string — ${p.clue(language, level)}. Do NOT include the answer word."
        }
        // exactly ${n} variant object(s), one per player
      ]
    }
  ]
}

Rules:
- Write every answer and clue in ${language}.
- ${p.rule(language, level)}
- One letter object per letter listed above, in that order.
- ${variantsRule}
- All variants of a letter share the same "letter" and "type".
- Prefer "starts" for the letter; only use "contains" when no good answer fits (then end each clue with "(contains <LETTER>)").
- Keep answers to a single word where possible, lowercase, no punctuation.
- Clues must never contain their own answer.
- Output JSON only.`;
}

// Prompt for ADDING word sets (circles) to an existing game: the AI sees the
// words already in use per letter so the new sets don't repeat them.
export function buildAppendPrompt({ language = 'English', count = 1, letters = [] }) {
  const n = Math.max(1, count);
  const inUse = letters
    .map((l) => `${l.letter} (${l.type === 'contains' ? 'contains' : 'starts'}): ${l.existing.join(', ') || '—'}`)
    .join('\n');
  return `You are ADDING word sets to an existing "Password" alphabet game played in class, in ${language} (one answer + clue per letter; each player gets their own answer per letter). The words already in the game show you what kind of round it is — vocabulary practice, general-knowledge quiz, school subject revision, etc.

Language: ${language}
New word sets to create: ${n}

Below, for every letter, are the words ALREADY IN USE. Create exactly ${n} NEW variant(s) per letter — answers that are different from each other AND from all the words already in use (not synonyms, translations or plural/derived forms of them). Match the kind of content, topic and difficulty of the existing words: if they are famous people and places, add more famous people and places; if they are everyday vocabulary, add everyday vocabulary.

Letters and words already in use:
${inUse}

Return ONLY valid JSON (no markdown, no commentary) with this exact schema:

{
  "letters": [
    {
      "letter": "A",
      "type": "starts",
      "variants": [
        {
          "answer": "string — the new word, lowercase",
          "accept": ["optional synonyms / accepted variants, lowercase"],
          "clue": "string — one-sentence clue in ${language}. Do NOT include the answer word."
        }
        // exactly ${n} variant object(s)
      ]
    }
  ]
}

Rules:
- One object per letter listed above, in the same order, keeping each letter's "type" as shown.
- Every answer and clue in ${language}; answers lowercase, single words where possible.
- Clues must never contain their own answer.
- Output JSON only.`;
}

// Merge freshly pasted word sets into an existing (validated) game. `incoming`
// is the letters array of a validated paste. Mutates `game` only on success.
export function appendSets(game, incoming) {
  const map = new Map(incoming.map((l) => [l.letter, l]));
  const missing = game.letters.filter((l) => !map.has(l.letter)).map((l) => l.letter);
  if (missing.length) {
    return { ok: false, errors: [`The pasted JSON is missing letters: ${missing.join(', ')}.`] };
  }
  const addCounts = new Set(game.letters.map((l) => map.get(l.letter).variants.length));
  if (addCounts.size > 1) {
    return { ok: false, errors: ['Every letter must add the same number of new word sets.'] };
  }
  const add = [...addCounts][0];
  const current = Math.max(...game.letters.map((l) => l.variants.length));
  if (current + add > 6) {
    return { ok: false, errors: [`That would make ${current + add} word sets — the game supports at most 6 players.`] };
  }
  // New words should be new: flag any that repeat an existing answer (still appended).
  const duplicates = [];
  for (const l of game.letters) {
    for (const v of map.get(l.letter).variants) {
      if (l.variants.some((x) => x.answer.trim().toLowerCase() === v.answer.trim().toLowerCase())) {
        duplicates.push(`${l.letter}: ${v.answer}`);
      }
    }
  }
  game.letters.forEach((l) => l.variants.push(...map.get(l.letter).variants));
  game.players = current + add;
  return { ok: true, errors: [], added: add, total: current + add, duplicates };
}

// Mix the circles for a replay with the same class: every letter shuffles which
// player gets which word (uniform random permutation), so each new circle is a
// random blend of the old ones — e.g. A from old circle 3, B from old circle 2,
// C from old circle 1. Circles stay complete alphabets over the same word pool.
// Mutates the game. Needs at least 2 word sets (with 1 there is nothing to mix).
export function mixSets(game, rand = Math.random) {
  const sets = Math.max(...game.letters.map((l) => l.variants.length));
  if (sets < 2) {
    return { ok: false, errors: ['Mixing needs at least 2 circles of words — this game has only 1.'] };
  }
  let changed = false;
  for (const l of game.letters) {
    const k = l.variants.length;
    if (k < 2) continue; // single word for this letter — nothing to mix
    for (let i = k - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1)); // Fisher-Yates
      if (j !== i) {
        [l.variants[i], l.variants[j]] = [l.variants[j], l.variants[i]];
        changed = true;
      }
    }
  }
  if (!changed) {
    // Astronomically rare with a full alphabet, but never return "mixed" with
    // everything identical: force one swap on the first mixable letter.
    const l = game.letters.find((x) => x.variants.length >= 2);
    [l.variants[0], l.variants[1]] = [l.variants[1], l.variants[0]];
  }
  return { ok: true, errors: [], sets };
}

// The prompt no longer asks the AI for langCode (an app concern); recover the
// dialect code from the echoed language name instead. Accepts native spellings.
const LANG_CODES = {
  english: 'en-US',
  catalan: 'ca-ES',
  'català': 'ca-ES',
  french: 'fr-FR',
  'français': 'fr-FR',
  'francès': 'fr-FR',
  spanish: 'es-ES',
  'español': 'es-ES',
  castellano: 'es-ES',
  'castellà': 'es-ES',
};
function langCodeFor(obj) {
  if (obj.langCode) return obj.langCode; // explicit code always wins
  return LANG_CODES[String(obj.language || '').trim().toLowerCase()] || 'en-US';
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
    langCode: langCodeFor(obj),
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
