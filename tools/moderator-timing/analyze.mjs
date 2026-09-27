import { syllables } from '../../js/voice.js';
import fs from 'fs';
const files = fs.readdirSync('.').filter(f => f.endsWith('.json3'));
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const MATHW = /^(times|ten|10|to|the|negative|minus|plus|squared|cubed|over|equals|power|root|square|sub|log|sine|cosine|x|y|z|point|\d[\d.,]*|half|halves|thirds?|fourths?|quantity|of)$/i;
const all = { spans: [], letterPause: [], normalGap: [], afterLetter: [], header: [], hdrToQ: [], mathSps: [], proseSps: [], sentenceGap: [] };
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f));
  const W = [];
  for (const ev of d.events || []) for (const sg of ev.segs || []) { const w = (sg.utf8 || '').trim(); if (w) W.push({ t: ((ev.tStartMs || 0) + (sg.tOffsetMs || 0)) / 1000, w }); }
  const low = W.map(x => x.w.toLowerCase());
  for (let i = 0; i < W.length - 10; i++) {
    const isHead = /^(toss|tossup|bonus)$/.test(low[i]);
    if (!isHead) continue;
    // header ends at "answer" / "choice" within 9 words
    let h1 = -1;
    for (let k = i + 1; k < Math.min(i + 10, W.length); k++) if (/^(answer|choice)$/.test(low[k]) && /^(short|multiple)$/.test(low[k - 1])) { h1 = k; break; }
    if (h1 < 0) continue;
    const mc = low[h1] === 'choice';
    // question words until a long silence (buzz / answer time) or next header
    const q = [];
    for (let k = h1 + 1; k < W.length && q.length < 140; k++) {
      if (/^(toss|tossup|bonus|interrupt)$/.test(low[k])) break;
      if (q.length && W[k].t - W[k - 1].t > 2.2) break;
      q.push(k);
    }
    if (q.length < 8) continue;
    all.header.push({ sec: W[h1].t - W[i].t, syl: low.slice(i, h1 + 1).reduce((s, w) => s + syllables(w), 0) });
    all.hdrToQ.push(W[q[0]].t - W[h1].t);
    const t0 = W[q[0]].t; const tEnd = W[q[q.length - 1]].t;
    const syl = q.slice(0, -1).reduce((s, k) => s + syllables(W[k].w), 0);
    all.spans.push({ f, mc, words: q.length - 1, syl, sec: tEnd - t0 });
    // per-gap measurements: gap from word k-1 start to word k start vs its syllables
    for (let j = 1; j < q.length; j++) {
      const a = q[j - 1]; const b = q[j];
      const gap = W[b].t - W[a].t; const s = Math.max(syllables(W[a].w), 1);
      const isLetter = mc && /^[wxyz]$/.test(low[b]) && j > 2;
      const prevLetter = mc && /^[wxyz]$/.test(low[a]);
      if (isLetter) all.letterPause.push({ gap, s });
      else if (prevLetter) all.afterLetter.push({ gap, s });
      else {
        all.normalGap.push({ gap, s });
        (MATHW.test(low[a]) && MATHW.test(low[b]) && /\d|times|squared|over|power|negative|equals/.test(low[a] + low[b]) ? all.mathSps : all.proseSps).push(gap / s);
      }
    }
  }
}
const S = all.spans;
const tot = S.reduce((a, s) => ({ w: a.w + s.words, syl: a.syl + s.syl, sec: a.sec + s.sec }), { w: 0, syl: 0, sec: 0 });
console.log(`questions measured: ${S.length} (${S.filter(s => s.mc).length} multiple choice) from ${files.length} matches`);
console.log(`overall pace incl. pauses: ${Math.round(tot.w / tot.sec * 60)} wpm, ${(tot.sec / tot.syl).toFixed(3)} s/syllable`);
const perQ = S.map(s => s.words / s.sec * 60);
console.log(`per-question wpm: median ${Math.round(med(perQ))}, 10-90%: ${Math.round(pct(perQ, 0.1))}-${Math.round(pct(perQ, 0.9))}`);
const sps = all.normalGap.map(g => g.gap / g.s);
const baseSps = med(sps);
console.log(`typical word: ${baseSps.toFixed(3)} s per syllable (median over ${sps.length} word gaps)`);
const extra = arr => arr.map(g => g.gap - g.s * baseSps);
console.log(`pause before a choice letter W/X/Y/Z: median ${med(extra(all.letterPause)).toFixed(2)} s extra (n=${all.letterPause.length}, 25-75%: ${pct(extra(all.letterPause), .25).toFixed(2)}-${pct(extra(all.letterPause), .75).toFixed(2)})`);
console.log(`gap after saying the letter: median ${med(all.afterLetter.map(g => g.gap)).toFixed(2)} s (the letter itself + pause)`);
const ne = extra(all.normalGap);
console.log(`ordinary word gaps: extra pause median ${med(ne).toFixed(2)} s; share of gaps with >0.3 s extra (phrase/sentence breaks): ${(100 * ne.filter(x => x > 0.3).length / ne.length).toFixed(1)}%, their median ${med(ne.filter(x => x > 0.3)).toFixed(2)} s`);
console.log(`header ("Toss-up 3 is an energy multiple choice"): median ${med(all.header.map(h => h.sec)).toFixed(2)} s to say, then ${med(all.hdrToQ).toFixed(2)} s until the question starts`);
console.log(`math/number words: ${med(all.mathSps).toFixed(3)} s/syllable (n=${all.mathSps.length}) vs prose ${med(all.proseSps).toFixed(3)} (ratio ${(med(all.mathSps) / med(all.proseSps)).toFixed(2)})`);
fs.writeFileSync('measurements.json', JSON.stringify(all));
