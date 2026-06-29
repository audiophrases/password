# Password — ESL word game

A classroom alphabet word game for ESL teachers: a circle of letters A–Z, one word and
clue per letter, guessed against the clock. Single player or hot-seat multiplayer, voice
or teacher-judged, with an optional webcam "student in the center" projector view.

No build step. Pure static site — deploy to GitHub Pages or run from a folder.

## Run locally

ES modules + the sample loader need to be served over HTTP (not opened as a `file://`):

```bash
# from this folder
python -m http.server 8000
# then open http://localhost:8000
```

(Or use VS Code "Live Server", or just push to GitHub Pages — this repo is Pages-ready.)

## Languages & voices

Pick the **Language** in section 1 — currently **American English (en-US)**, **Catalan (ca-ES)**,
**French (fr-FR)**, and **Spanish · Spain (es-ES)**. The choice drives the chatbot prompt, the
speech-recognition language, the default letter set (Spanish adds Ñ), and the read-aloud voice.

Read-aloud uses the browser's natural neural voices. **Open the app in Microsoft Edge** to get
Microsoft's "… Online (Natural)" voices (the same engine as Edge Read Aloud) — the app auto-selects
the best natural voice per language, and you can override it (and press ▶ to test) in section 1.
In other browsers it falls back to whatever voices are installed.

## How a round works

1. **Generate the words.** On the setup screen pick language / level / topic / letters / number of
   players and click **Build chatbot prompt**. Copy it into ChatGPT, Claude, or any chatbot.
2. **Load the game.** Paste the JSON it returns and click **Load JSON**, or **Load file**
   to pick a `.txt` or `.json` file (both are parsed as JSON, tolerant of ```json fences /
   surrounding prose). Or click **Try sample round**.
3. **Add players, pick a judging mode, press Start.**

### In-game keys (the teacher is always the final judge)

| Key | Action |
|-----|--------|
| `C` | mark correct |
| `X` | mark wrong |
| `Space` | pass — requeues the letter for later, next turn |
| hold `V` (or hold the 🎤 button) | push-to-talk speech recognition |
| `Enter` | confirm the speech suggestion |
| `F` | fullscreen (projector) · `P` pause |

## Speech recognition strategy (the hard part)

The recognizer **assists**; it never has the final say. This handles both failure modes
(right answer rejected / wrong answer accepted):

- **Multiple alternatives.** `maxAlternatives = 5` — ESL pronunciation often pushes the right
  word to hypothesis #2–3; we score the target against *all* of them.
- **Fuzzy + phonetic matching** (`js/match.js`): Levenshtein on the normalized spelling **and**
  a metaphone-style phonetic key, so a correctly-said word the engine misheard as a near-homophone
  still passes. Synonyms come from each letter's `accept` list in the JSON.
- **Three outcomes**, not two: high → auto-accept, middle → *flag for teacher*, low → suggest wrong.
  The **strictness slider** moves the thresholds live.
- **Teacher override is one keypress** (`C` / `X`), so any speech mistake is fixed instantly.
- **Push-to-talk** stops the mic transcribing the whole noisy room (biggest false-positive killer).
- **Modes:** *voice-assist* (default), *voice-auto* (auto-accept confident answers),
  *teacher-judge* (no mic — bulletproof for strong accents / noisy rooms / offline),
  *type-in* (typed answers, same fuzzy match).

> Browser note: speech **recognition** works in **Chrome/Edge** and uses a cloud service
> (needs internet). *Teacher-judge* and *type-in* work in any browser and offline.

## Camera / projector mode

Toggle 📷 in game to put the active student's webcam in the center of their letter circle
(letters ring around them, like the TV format). In multiplayer the camera follows whoever's
answering — their circle grows to the center while the others shrink to the corners. `F` makes
it fullscreen for the projector.

## Game JSON schema

```json
{
  "title": "Everyday English A2",
  "language": "English",
  "langCode": "en-US",
  "settings": { "durationSec": 200, "mode": "voice-assist", "strictness": 0.7 },
  "letters": [
    { "letter": "A", "type": "starts", "answer": "apple", "accept": [], "clue": "A round fruit…" },
    { "letter": "X", "type": "contains", "answer": "fox",  "accept": [], "clue": "…(contains X)" }
  ]
}
```

`type` is `"starts"` (word begins with the letter) or `"contains"` (letter appears in it).

## Files

| File | Role |
|------|------|
| `index.html` / `styles.css` | shell + minimal, projector-friendly light UI |
| `js/app.js` | wires setup, engine, speech, camera; keyboard control |
| `js/game.js` | engine: players, turns, time banks, scoring, pass queue |
| `js/circle.js` | renders one player's alphabet circle |
| `js/match.js` | fuzzy + phonetic answer matching |
| `js/speech.js` | Web Speech recognition (alternatives) + synthesis |
| `js/camera.js` | webcam for the center-of-circle projector look |
| `js/ai.js` | prompt builder + JSON validation |
| `sample-game.json` | a ready-to-play A2 round |
