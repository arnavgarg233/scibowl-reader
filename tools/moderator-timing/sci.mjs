import { syllables } from '../../js/voice.js';
import fs from 'fs';
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const byLetter = {}; const sciRates = []; const examples = [];
for (const f of fs.readdirSync('.').filter(f => f.endsWith('.json3'))) {
  const d = JSON.parse(fs.readFileSync(f)); const W = [];
  for (const ev of d.events || []) for (const sg of ev.segs || []) { const w = (sg.utf8 || '').trim(); if (w) W.push({ t: ((ev.tStartMs || 0) + (sg.tOffsetMs || 0)) / 1000, w }); }
  const low = W.map(x => x.w.toLowerCase());
  for (let i = 1; i < W.length - 6; i++) {
    // after-letter pause, by letter
    if (/^[wxyz]$/.test(low[i]) && /^[a-z]/.test(low[i + 1] || '') && W[i + 1].t - W[i].t < 3) (byLetter[low[i]] ||= []).push(W[i + 1].t - W[i].t - Math.max(syllables(W[i].w), 1) * 0.201);
    // scientific notation: "... times 10 to the ..."
    if (low[i] === 'times' && /^(10|ten)$/.test(low[i + 1]) && low[i + 2] === 'to') {
      const a = Math.max(0, i - 2); const b = Math.min(W.length - 1, i + 6);
      const span = W.slice(a, b + 1); const syl = span.slice(0, -1).reduce((s, x) => s + syllables(x.w), 0);
      const sec = W[b].t - W[a].t; sciRates.push(sec / syl);
      if (examples.length < 12) examples.push(`${span.map(x => x.w).join(' ')}  [${(sec / syl).toFixed(3)} s/syl]`);
    }
  }
}
for (const [l, a] of Object.entries(byLetter).sort()) console.log(`after "${l.toUpperCase()}": extra pause median ${med(a).toFixed(2)} s (n=${a.length})`);
console.log(`\nscientific notation phrases: ${med(sciRates).toFixed(3)} s/syllable (n=${sciRates.length}) vs prose 0.201 (ratio ${(med(sciRates) / 0.201).toFixed(2)})`);
examples.forEach(e => console.log('  ' + e));
