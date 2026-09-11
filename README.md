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

**New machine?** Run **`install.bat`** (Windows) — a guided setup that checks for Node
(and can download a portable copy into the folder, **no admin rights needed** — ideal for
school/work computers), then optionally walks you through the cloud relay below.

The static files also work under any plain static host (e.g. `python -m http.server`) or
GitHub Pages — but the **phone remote needs a relay** (a static host can't forward
WebSocket traffic): either `node server.js` on the laptop, or the **☁ cloud relay**
(see "Phone remote" below), which also works on networks that block the phone entirely.

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
   - **⬇ Export all games** saves the whole library to one file, and **🔑 Cloud library** keeps it
     the same on every computer you teach from — see "Your games on every computer" below.
   - **👥 Give this game to students** makes a link and code your class can play on their own
     devices, with no access to your library — see "Student mode" below.

   Saved games persist across sessions in this browser. Renaming a game in the editor saves a
   *copy* and leaves the original alone, so a round is never overwritten by accident.
3. **Add players, pick a judging mode, press Start — twice.** The first ▶ Start opens the game
   tab and puts the circles on screen with the clocks still and nothing read aloud, so the class
   can settle and you can get in position. The second ▶ Start (the button on the game screen,
   `Enter`, or ▶ Start on the phone) starts the timer and reads the first clue.

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
| `Enter` / `Space` | *before the round begins:* start it (the board is already up) |

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
Correct/Wrong from your phone without looking at the projector. **▶ Start takes two presses**: the
first brings the circles up on the projector (clocks still, nothing read aloud), the second starts
the round — the button turns green in between. **🔇 Mute** works before the round as well, so you
can claim the clues as yours to read out before the very first one is spoken. Presses travel phone
→ laptop over the local network in a few milliseconds; **no internet needed.** After that one
URL the laptop is untouched: students watch the projected circle while you drive from the phone.

How it works: `server.js` is a tiny WebSocket relay. The game tab connects as the "host"; the
phone connects as a "remote" and its taps are forwarded to the host. A browser tab can't accept
connections itself, so the relay is the rendezvous.

> If the school Wi-Fi blocks device-to-device traffic ("client isolation"), turn on your phone's
> hotspot and join the laptop to it — same private network, no internet required.

### ☁ Cloud relay — when the network blocks the phone entirely

Locked-down work machines can make the local relay impossible: allowing inbound
connections through the Windows firewall needs admin rights, and client-isolation Wi-Fi
kills phone → laptop traffic even on the hotspot. The cloud relay routes around all of it:
a tiny Cloudflare Worker (`relay/worker.js`, free tier) forwards the same messages, and
**both the game and the phones dial out to it** — no inbound connection anywhere, nothing
to allow, no admin rights.

One-time setup, from any machine (free Cloudflare account):

```bash
npx wrangler login    # opens the browser once
npx wrangler deploy   # prints your URL, e.g. https://password-game.you.workers.dev
```

(`install.bat` automates this whole flow. Pick **d** to deploy on **your own** free
Cloudflare account — recommended, so the quota and control are yours — or **u** to save a
URL you already deployed from another computer. Sharing one relay does work if a colleague
deliberately offers theirs — room codes keep simultaneous games separate — but it spends
the owner's free quota.)

(A shared relay does not share saved games — see "Your games on every computer" below.)

Then on the teaching machine: run the game as usual (`password.bat` — the local server
keeps serving the game and the neural voices), tick **☁ Cloud relay** in the 📱 Phone
remote box, and paste your Worker URL. The QR/address switches to
`https://…/remote?room=abc123`, which phones can open from **any** network (school Wi-Fi,
mobile data…). The room code is a sticky random code per browser, so several teachers can
share one deployed relay without colliding; anyone who has your full URL could press your
buttons, so share the QR, not a screenshot of it, if that matters.

Notes:

- Untick ☁ to return to the pure-LAN path — nothing about local mode changed.
  Button lag over the cloud is one round-trip to the nearest Cloudflare edge
  (usually well under 100 ms) instead of LAN-instant.
- The Worker serves the whole game too, so in a pinch (no Node at all) everything can run
  from your Worker URL — you lose only the neural-voice proxy; Edge's built-in natural
  voices still work.
- The repo ships `js/config.js` with an empty `CLOUD_RELAY` so each install points at its
  own relay — `install.bat` fills it in per machine (a local, uncommitted change), or use
  the ☁ box, which keeps the URL per browser.
- `wrangler dev` tip: run it as `npx wrangler dev --persist-to "$TEMP/pw-relay-state"` —
  its state files must live *outside* the repo, or the assets watcher sees them change and
  reloads itself in an endless loop. This matters more now that the cloud library keeps
  real data: `wrangler dev` reads and writes that local folder, so a key opens a *different*
  (empty) library there than the same key does in production.

## Your games on every computer

Section 2's library lives in **one browser**. Because browser storage is separate per
address, a round saved at `localhost:8000` is invisible from `127.0.0.1:8000`, from your
Worker URL, from another laptop, and from another browser profile — which is how good
rounds quietly go missing.

Two ways out, and the first works everywhere with no setup at all.

### ⬇ Export / ⬆ Import — the backup

**⬇ Export all games** downloads the whole library as one JSON file; **⬆ Import games file**
merges one back in. Works offline, on `file://`, on GitHub Pages — no account, no relay.

Importing **merges**, it never replaces: each round is identified by its *content*, so
importing the same file twice adds nothing, and importing a colleague's file adds only what
you don't already have. Keep an export somewhere safe — it is the one copy that survives a
cleared browser.

### 🔑 Cloud library — the same games everywhere, automatically

If you have deployed the ☁ cloud relay above, you already have everything needed. Open
**🔑 Cloud library** in section 2 and press **Generate** — once, on your first computer.
Copy the key, and paste it into the same box on every other computer you teach from.

That's it. Games you save are uploaded in the background; games saved elsewhere appear on
the next load. The library keeps working with no internet — the browser copy is the one the
game actually reads, so a round always opens instantly and plays through a dead Wi-Fi. The
cloud is a mirror that catches up when it can.

- **Generate the key — never invent one.** There is no password check: a key simply *is* the
  address of a library. A mistyped key doesn't fail, it opens a different empty one, so the
  status line shows a short fingerprint (`Library 4f2a9c · 14 games`) to compare at a glance,
  and the game asks before starting a second library on a computer that already has games.
- **Anyone with the key can read and change your games.** Send it to yourself, not to a class.
- **Lose the key and the cloud copy is unreachable** — nothing can recover it. Your games are
  still in every browser you have used, and ⬇ Export is the real backup.
- Colleagues sharing one relay do **not** share a library: different keys are different
  libraries. Sharing a relay only shares the phone-remote hop.
- Editing the same round on two computers before they sync keeps **both**, with the second
  one labelled `(from this laptop)`. Nothing is silently overwritten; delete the one you
  don't want.
- Deleting a game deletes it everywhere on the next sync, so the 🗑 button asks first.

## 👥 Student mode — give a game to the class

Load a game, open **👥 Give this game to students** in section 2, and press **Create
student link**. You get a short code and a link:

```
https://password-game.<you>.workers.dev/student?code=abcd2345
```

Put the QR on the projector. Students scan it, or open the same address and type the
code. It works on a school Chromebook or any laptop — no install, no account, no sign-in.

**What a student gets** is a single round and nothing else: the letter circle, the clue,
a box to answer in, Pass, 🔊 to hear the clue again, and a score with the words they
missed at the end. Nothing is sent back to you.

**What a student cannot get to.** The student page (`student.html`) does not load the
setup code at all — there is no library, no editor, no import/export and no library key
in that page to begin with. On the wire the separation is the same: creating or revoking
an assignment needs your **library key**, while a student only ever has a **share code**,
and a share code can do exactly one thing — read that one round. It cannot list your
library, reach another assignment, edit, or delete. A student who tries your library URL
gets a 401.

Notes:

- **The assignment is a frozen copy.** Editing the round in your library afterwards does
  not change what a class is part-way through playing. Assign it again to push changes.
- **Answers:** *Type-in* works in every browser; *Voice* needs Chrome/Edge, a microphone
  and internet, and falls back to typing if the browser can't listen. The other two modes
  (voice-assist, teacher-judge) aren't offered — both wait for you to press a key, so a
  student would sit in front of a round that never advances.
- Typos and accents are forgiven by the same fuzzy/phonetic matcher you use in class; a
  near miss is accepted and the correct spelling is shown.
- **Time limit** `0` means no timer — usually right for homework. **Expires in** `0` days
  means the link never expires.
- Links you make are listed under the button. Click one to show its QR again, or 🚫 to
  **revoke** it — the link stops working immediately, for everyone.
- Anyone with the link can play the round, so treat it as "shared with the class". It
  gives away nothing except that one set of words and clues.

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
| `js/config.js` | optional baked-in cloud relay URL |
| `js/library.js` | 🔑 cloud library: offline-first sync of the saved-games library |
| `student.html` / `student.css` / `js/student.js` | 👥 student mode: the play-only page, loads no setup code |
| `relay/worker.js` + `wrangler.jsonc` + `.assetsignore` | ☁ cloud relay: Cloudflare Worker (rooms as Durable Objects) that also serves the site |
| `relay/library.js` | 🔑 cloud library: the saved games, as a Durable Object with SQLite |
| `relay/assign.js` | 👥 student mode: one assigned round per share code, read-only to students |
| `js/vendor/qrcode.js` | vendored MIT QR generator (offline) for the remote-pairing QR |
| `sample-game.json` | a ready-to-play A2 round |
