# SciBowl Reader

Buzzer practice for the National Science Bowl, laid out like [qbreader](https://www.qbreader.org):
questions are revealed word by word, <kbd>space</kbd> buzzes, you type the answer and hit <kbd>enter</kbd>.

- All 12,023 official **high school sample questions** (Sets 1–17) from the
  [NSB website](https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/HS-Sample-Questions)
- Toss-up → bonus flow with NSB scoring (+4 toss-up, +10 bonus, −4 wrong interrupt), 5 s / 20 s clocks
- Random mode filtered by subject, difficulty, format and set, or play a round in order
- Difficulty follows the NSB coordinator manual: rounds 1–10 are about equal, then each round
  gets harder through round 17 (filters: rounds 1–10 / 11–14 / 15–17)
- "Only ones I haven't seen" and "Review ones I missed" pools
- Math and chemistry rendered with KaTeX (superscripts, subscripts, fractions); questions whose
  equations were images in the PDF also show a crop of the original packet
- Answer checking understands `ACCEPT:` / `DO NOT ACCEPT:`, MC letters or choice text, numbers and
  fractions, and "identify all" lists; "I was wrong / right" to override, and self-judging for
  answers it can't check
- Optional read-aloud voice, light / night themes, per-category stats, question history

Keys: `space` buzz, `n` next, `s` skip, `p` pause, `e` settings, `c` / `w` mark yourself right / wrong.

## Run locally

    python3 -m http.server 8765    # then open http://localhost:8765

It's a static site, so GitHub Pages works as-is.

## Rebuilding the question data

    pip install pymupdf
    tools/download.sh              # fetches the PDFs into pdfs/ and runs tools/extract.py
    node tools/test_check.mjs      # answer-checker sanity test

Questions are from the U.S. Department of Energy National Science Bowl. Reading pace follows
qbreader's timing (MIT). Original idea: [legendboss123/BuzzerPractice](https://github.com/legendboss123/BuzzerPractice).
