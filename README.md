# SciBowl Reader

Buzzer practice for the National Science Bowl, laid out like [qbreader](https://www.qbreader.org):
questions are revealed word by word, <kbd>space</kbd> buzzes, you type the answer and hit <kbd>enter</kbd>.

- All 12,023 official **high school sample questions** (Sets 1–17) from the
  [NSB website](https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/HS-Sample-Questions)
- Toss-up → bonus flow with NSB scoring (+4 toss-up, +10 bonus, −4 wrong interrupt) and NSB timing:
  5 s to buzz and 20 s for bonuses, both starting when reading finishes, with the "5 seconds" warning
- Random mode filtered by subject, difficulty, format and set, or play a round in order
- Difficulty follows the NSB coordinator manual: rounds 1–10 are about equal, then each round
  gets harder through round 17 (filters: rounds 1–10 / 11–14 / 15–17)
- "Only ones I haven't seen" and "Review ones I missed" pools
- Math and chemistry rendered with KaTeX. The 662 questions whose equations were images or
  equation-editor objects in the PDFs were transcribed to LaTeX by hand-checking each one against
  the original page (`data/overrides.json`, applied by the extractor)
- Answer checking understands `ACCEPT:` / `DO NOT ACCEPT:`, MC letters or choice text, numbers and
  fractions, and "identify all" lists; "I was wrong / right" to override, and self-judging for
  answers it can't check
- Read aloud with a human-like AI voice ([Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
  runs entirely in your browser: WebGPU when available, one-time ~325 MB download, then cached) or
  the browser's built-in voices. Math is spoken the way a moderator reads it. Optional
  listen-only mode hides the text until the answer is revealed, like a real match
- Light / night themes, per-category stats, question history

Keys: `space` buzz, `n` next, `s` skip, `p` pause, `e` settings, `c` / `w` mark yourself right / wrong.

## Run locally

    python3 -m http.server 8765    # then open http://localhost:8765

It's a static site, so GitHub Pages works as-is.

## Rebuilding the question data

    pip install pymupdf
    tools/download.sh              # fetches the PDFs into pdfs/ and runs tools/extract.py
    node tools/test_check.mjs      # answer-checker sanity test
    node tools/test_timer.mjs      # countdown accuracy (5 s, 20 s + warning, freeze, pause)

Questions are from the U.S. Department of Energy National Science Bowl. Reading pace follows
qbreader's timing (MIT). Original idea: [legendboss123/BuzzerPractice](https://github.com/legendboss123/BuzzerPractice).

## Multiplayer

`mp.html`: qbreader-style rooms. A public lobby plus join-by-code or invite link, shared reading,
first buzz answers (others locked out), wrong answers let everyone else keep going, bonuses go to
whoever got the toss-up, live scoreboard, chat, and room settings anyone can change.

There's no game server. Rooms live in Firebase Realtime Database, and every change goes
through a transaction, so Firebase settles races such as two simultaneous buzzes.

### Multiplayer setup (one time, free)

1. Go to https://console.firebase.google.com, choose **Create a project** (Analytics can be off).
2. **Build → Realtime Database → Create database**, pick a location, start in **locked mode**.
   Open the **Rules** tab, paste the contents of `database.rules.json`, and **Publish**.
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**.
4. **Project settings (gear) → Your apps → Web (`</>`)**: register an app (no hosting needed).
   Copy the `firebaseConfig` object into `js/firebase-config.js`
   (`export const firebaseConfig = { apiKey: ..., databaseURL: ..., ... };`).
5. Also under **Authentication → Settings → Authorized domains**, make sure your site's domain
   (e.g. `yourname.github.io`) is listed.

### Testing locally without a project

    npx firebase-tools emulators:start --only auth,database --project demo-sbr
    # then open http://localhost:8765/mp.html?emulator in two tabs (each tab is its own player)
