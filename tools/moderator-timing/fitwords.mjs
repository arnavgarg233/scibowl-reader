import { syllables } from '../../js/voice.js';
import fs from 'fs';
const FUNC = /^(the|a|an|of|to|in|is|and|for|on|by|at|it|as|or|what|which|that|this|its|be|are|with|from)$/;
const rows = { content: [], func: [], number: [] };
for (const f of fs.readdirSync('.').filter(f => f.endsWith('.json3'))) {
  const d = JSON.parse(fs.readFileSync(f)); const W = [];
  for (const ev of d.events || []) for (const sg of ev.segs || []) { const w = (sg.utf8 || '').trim(); if (w) W.push({ t: ((ev.tStartMs || 0) + (sg.tOffsetMs || 0)) / 1000, w }); }
  const low = W.map(x => x.w.toLowerCase());
  let inQ = false;
  for (let i = 1; i < W.length - 1; i++) {
    if (/^(answer|choice)$/.test(low[i]) && /^(short|multiple)$/.test(low[i - 1])) { inQ = true; continue; }
    if (!inQ) continue;
    const gap = W[i + 1].t - W[i].t;
    if (gap > 2.2 || /^(toss|tossup|bonus|interrupt)$/.test(low[i + 1])) { inQ = false; continue; }
    if (gap > 1.0 || gap < 0.05) continue; // phrase breaks handled separately
    const w = low[i];
    if (/^[wxyz]$/.test(w)) continue;
    if (/^\d/.test(w)) rows.number.push([syllables(w), gap]);
    else if (FUNC.test(w)) rows.func.push([1, gap]);
    else rows.content.push([Math.max(syllables(w), 1), gap]);
  }
}
// robust-ish linear fit gap = a + b*x using medians per x bucket, weighted least squares
function fit (pts) {
  const by = {}; for (const [x, y] of pts) (by[Math.round(x)] ||= []).push(y);
  const med = a => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const P = Object.entries(by).filter(([, v]) => v.length >= 15).map(([x, v]) => [+x, med(v), v.length]);
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y, w] of P) { sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; }
  const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx); const a = (sy - b * sx) / sw;
  return { a, b, P };
}
for (const k of ['content', 'number']) {
  const { a, b, P } = fit(rows[k]);
  console.log(`${k}: time = ${a.toFixed(3)} s + ${b.toFixed(3)} s x syllables   | medians by syllables: ${P.map(([x, y, n]) => `${x}:${y.toFixed(2)}(${n})`).join(' ')}`);
}
const fm = rows.func.map(r => r[1]).sort((p, q) => p - q);
console.log(`function words (the, of, is...): median ${fm[Math.floor(fm.length / 2)].toFixed(3)} s each (n=${fm.length})`);
