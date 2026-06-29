// match.js — fuzzy + phonetic answer matching tuned for ESL speech recognition.
// The recognizer is an assistant, not the judge: we score the target word against
// every ASR hypothesis using spelling distance AND a phonetic key, so a word the
// student said correctly but the engine misheard as a near-homophone still passes.

export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(a|an|the|to)\b/g, ' ') // ignore leading articles
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function ratio(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

// A compact metaphone-style phonetic key. Heuristic but predictable; paired with
// raw spelling distance below so an imperfect key never silently fails a student.
export function phonetic(word) {
  let s = (word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s
    .replace(/^x/, 'z')
    .replace(/^wh/, 'w')
    .replace(/^(kn|gn|pn|wr)/, '')
    .replace(/mb$/, 'm')
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/sch/g, 'sk')
    .replace(/ck/g, 'k')
    .replace(/[cs]h/g, 'X') // sh / ch
    .replace(/th/g, '0')
    .replace(/qu?/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/w/g, '')
    .replace(/y/g, 'i');
  const first = s[0];
  const rest = s.slice(1).replace(/[aeiou]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1'); // collapse doubles
}

function scoreOne(target, hyp) {
  const a = normalize(target);
  const b = normalize(hyp);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const rawRatio = ratio(a, b);

  const pa = phonetic(a);
  const pb = phonetic(b);
  const phRatio = pa && pb ? (pa === pb ? 1 : ratio(pa, pb)) : 0;

  // token containment: "an apple" said for target "apple"
  const at = a.split(' ');
  const bt = b.split(' ');
  const contain = at.some((t) => t.length > 1 && bt.includes(t)) ? 0.9 : 0;

  return Math.max(rawRatio, phRatio * 0.97, contain);
}

// targets: [primary, ...accepted synonyms]; hyps: [{ transcript, confidence }]
// strictness 0..1 shifts the accept/review thresholds.
export function scoreAnswer(targets, hyps, strictness = 0.7) {
  let best = 0;
  let heard = '';
  for (const h of hyps) {
    for (const t of targets) {
      const s = scoreOne(t, h.transcript);
      if (s > best) {
        best = s;
        heard = h.transcript;
      }
    }
  }
  const accept = 0.6 + 0.26 * strictness; // 0.60 .. 0.86
  const review = accept - 0.14;
  const decision = best >= accept ? 'correct' : best >= review ? 'review' : 'wrong';
  return { score: best, decision, heard };
}
