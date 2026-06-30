# Password — ESL word game

A classroom alphabet word game for ESL teachers: a circle of letters A–Z, one word and
clue per letter, guessed against the clock. Single player or hot-seat multiplayer, voice
or teacher-judged, with an optional webcam "student in the center" projector view.

No build step. Pure static site — deploy to GitHub Pages or run from a folder.

## Run locally

Run the included server (Node, **no dependencies — no `npm install`**). This also enables
the phone remote:

```bash
node server.js
#   Game (this laptop):  http://localhost:8000
#   Phone remote:        http://<your-LAN-IP>:8000/remote   (printed on start)
```

The static files also work under any plain static host (e.g. `python -m http.server`) or
GitHub Pages — but the **phone remote needs `node server.js`** (a static host can't relay
WebSocket traffic).

## Languages & voices

Pick the **Language** in section 1 — currently **American English (en-US)**, **Catalan (ca-ES)**,
**French (fr-FR)**, and **Spanish · Spain (es-ES)**. The choice drives the chatbot prompt, the
speech-recognition language, the default letter set (Spanish adds Ñ), and the read-aloud voice.

Read-aloud uses the browser's natural neural voices. **Open the app in Microsoft Edge** to get
Microsoft's "… Online (Natural)" voices (the same engine as Edge Read Aloud) — the app auto-selects
the best natural voice per language, and you can override it (and press ▶ to test) in section 1.
In other browsers it falls back to whatever voices are installed.

**Best quality — neural voices via the server.** When you run `node server.js`, tick
**High-quality neural voice** in section 1. The server reaches Microsoft's edge-tts endpoint and
streams real neural voices (e.g. `ca-ES-JoanaNeural`, `fr-FR-DeniseNeural`) as audio that plays in
*any* browser — the same quality as Edge Read Aloud, independent of the browser's installed voices,
and notably better for Catalan. It's dependency-free (no `npm install`), needs internet, and works
only in local-server mode (not GitHub Pages). If it's ever unreachable, the app falls back to the
browser voice automatically. (Requires a correct system clock — the token Microsoft uses is
time-based.)

**Audio-only mode:** definitions are **hidden by default** when a round starts, so students rely
on listening; reveal/hide them with the 👁 button (or `H`, or 👁 Text on the phone). When hidden,
each clue is read aloud automatically,
announced with the letter in the game's language — e.g. *"Begins with the letter R…"*,
*"Empieza por la letra R…"*, *"Comença per la lletra R…"*. The 🔊 button reads it on demand.

## How a round works

1. **Generate the words.** On the setup screen pick language / level / topic / letters / number of
   players and click **Build chatbot prompt**. Copy it into ChatGPT, Claude, or any chatbot. With
   more than one player, the prompt asks for a **different word per player for each letter**, so
   students in the same room don't get the same words.
2. **Your games** — section 2 is a library saved in this browser:
   - **✏️ New game** opens the editor (a table of letter · language · starts/contains · answer ·
     accepted synonyms · clue); its **💾 Save** adds the round to the library. Use the **Word set**
     switcher (+ player set / ‹ ›) to give each player a different word for the same letters.
   - Each saved game shows as a row — **click it to open** (ready to play), **✏️** to edit, **🗑**
     to delete. **💾 Save current game** stores whatever is currently loaded.
   - **Import** (the collapsible at the bottom) brings a game in from a chatbot (paste the JSON),
     a `.txt`/`.json` file, or the built-in sample. Imported games load immediately; Save to keep.

   Saved games persist across sessions in this browser (no files).
3. **Add players, pick a judging mode, press Start.**

### In-game keys (the teacher is always the final judge)

| Key | Action |
|-----|--------|
| `C` | mark correct |
| `W` | mark wrong |
| `Space` | pass — requeues the letter for later, next turn |
| hold `V` (or hold the 🎤 button) | push-to-talk speech recognition |
| `Enter` | confirm the speech suggestion |
| `H` | hide/show the written definition (audio-only mode) |
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

## Phone remote (control from across the room)

Run `node server.js`. The setup screen shows the remote's address **and a QR code** — scan it
with your phone's camera to open `http://<LAN-IP>:8000/remote` (or type the URL). Phone and
laptop must be on the **same network** — same Wi-Fi, or join the laptop to your phone's hotspot.

You get big **Correct / Pass / Wrong** buttons, **hold-to-talk**, and Start / Pause / Clue /
Camera / Fullscreen / Exit — plus the current player, letter, clue, **the expected answer**,
score and timer mirrored on the phone. So you can read the clue, see the answer, and judge
Correct/Wrong from your phone without looking at the projector. Presses travel phone
→ laptop over the local network in a few milliseconds; **no internet needed.** After that one
URL the laptop is untouched: students watch the projected circle while you drive from the phone.

How it works: `server.js` is a tiny WebSocket relay. The game tab connects as the "host"; the
phone connects as a "remote" and its taps are forwarded to the host. A browser tab can't accept
connections itself, so the relay is the rendezvous.

> If the school Wi-Fi blocks device-to-device traffic ("client isolation"), turn on your phone's
> hotspot and join the laptop to it — same private network, no internet required.

## Game JSON schema

Each letter has one or more **variants** — one per player, so students in the same room don't
get the same words (hearing another player's word would make it too easy). Player *i* plays
`variants[i]` for each letter (wrapping if there are fewer variants than players). A legacy
single-word shape `{ "answer", "accept", "clue" }` per letter is still accepted and treated as
one shared variant.

```json
{
  "title": "Everyday English A2",
  "language": "English",
  "langCode": "en-US",
  "settings": { "durationSec": 200, "mode": "voice-assist", "strictness": 0.7 },
  "players": 2,
  "letters": [
    { "letter": "A", "type": "starts", "variants": [
      { "answer": "apple", "accept": [], "clue": "A round fruit…" },
      { "answer": "ant",   "accept": [], "clue": "A tiny insect…" }
    ] },
    { "letter": "X", "type": "contains", "variants": [
      { "answer": "fox", "accept": [], "clue": "…(contains X)" },
      { "answer": "box", "accept": [], "clue": "…(contains X)" }
    ] }
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
| `server.js` | static server + phone-remote WebSocket relay + neural-TTS proxy (no deps) |
| `remote.html` / `remote.css` / `js/remote.js` | the phone controller page |
| `js/link.js` | WebSocket client shared by the game and the remote |
| `js/vendor/qrcode.js` | vendored MIT QR generator (offline) for the remote-pairing QR |
| `sample-game.json` | a ready-to-play A2 round |
