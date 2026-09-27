# Moderator timing

The reading pace (`HUMAN` in `js/voice.js`) comes from how real moderators read at the
National Science Bowl finals. The scripts here read YouTube auto-caption word timings
(json3) of the DOE's official final-match videos and measure speaking rate, pauses around
answer choices, phrase breaks, header length, and how much slower numbers and math are.

    pip install yt-dlp
    yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format json3 -o ID https://www.youtube.com/watch?v=ID
    node analyze.mjs && node fitwords.mjs && node sci.mjs      # run in the folder with the .json3 files

Used: 14 finals (HS 2015-2019, 2023, 2025; MS 2013-2019, 2022, 2025, 2026), 309 questions.
