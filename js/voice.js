// Read-aloud support: a human-like neural voice (Kokoro, run in the browser by a
// worker) plus ranking of the browser's built-in voices, and the text-to-speech
// preparation both use.

export const NEURAL_VOICES = [
  ['af_heart', 'Heart (US, female)'],
  ['af_bella', 'Bella (US, female)'],
  ['af_nicole', 'Nicole (US, female, soft)'],
  ['am_michael', 'Michael (US, male)'],
  ['am_fenrir', 'Fenrir (US, male)'],
  ['am_puck', 'Puck (US, male)'],
  ['bf_emma', 'Emma (UK, female)'],
  ['bm_george', 'George (UK, male)']
];

export class NeuralVoice {
  constructor (onStatus) {
    this.onStatus = onStatus;
    this.ready = null;
    this.cache = new Map(); // key -> job
    this.queue = [];
    this.busy = null;
    this.nextId = 1;
  }

  load () {
    if (this.ready) return this.ready;
    this.device = navigator.gpu ? 'webgpu' : 'wasm';
    this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.onStatus({ state: 'loading', pct: Math.round(100 * m.loaded / m.total) });
        else if (m.type === 'ready') { this.isReady = true; this.onStatus({ state: 'ready' }); resolve(); }
        else if (m.type === 'error' && m.id === undefined) { this.onStatus({ state: 'error', message: m.message }); reject(new Error(m.message)); }
        else this.finish(m);
      };
      this.worker.onerror = (e) => { this.onStatus({ state: 'error', message: e.message }); reject(e); };
    });
    this.onStatus({ state: 'loading', pct: 0 });
    this.worker.postMessage({ type: 'load', device: this.device });
    return this.ready;
  }

  // Promise of { samples, rate }. Identical requests share one generation.
  request (text, voice, speed, words = []) {
    const key = `${voice}|${speed}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit.promise;
    const job = { key, text, voice, speed, words };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {});
    this.cache.set(key, job);
    this.queue.push(job);
    this.trim();
    this.pump();
    return job.promise;
  }

  // drop queued work that isn't for the current or upcoming question
  retain (keys) {
    const keep = new Set(keys);
    this.queue = this.queue.filter(j => {
      if (keep.has(j.key)) return true;
      this.cache.delete(j.key);
      return false;
    });
    // put wanted jobs in the order asked
    this.queue.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
  }

  key (text, voice, speed) { return `${voice}|${speed}|${text}`; }

  trim () {
    for (const [k, j] of this.cache) {
      if (this.cache.size <= 150) break;
      if (j.done) this.cache.delete(k);
    }
  }

  pump () {
    if (this.busy || !this.queue.length || !this.ready) return;
    this.ready.then(() => {
      if (this.busy || !this.queue.length) return;
      const job = this.queue.shift();
      job.id = this.nextId++;
      this.busy = job;
      this.worker.postMessage({ type: 'gen', id: job.id, text: job.text, voice: job.voice, speed: job.speed, words: job.words });
    }, () => {});
  }

  finish (m) {
    const job = this.busy;
    this.busy = null;
    if (job && job.id === m.id) {
      if (m.type === 'audio') { job.done = true; job.resolve({ samples: m.samples, rate: m.rate, weights: m.weights }); } else { this.cache.delete(job.key); job.reject(new Error(m.message)); }
    }
    this.pump();
  }
}

// Best-sounding built-in voices first (Siri/premium/natural, then Google).
export function rankBrowserVoices (voices) {
  const score = v => (/premium|enhanced|natural|neural|siri/i.test(v.name) ? 3 : /google/i.test(v.name) ? 2 : 0) +
    (v.lang === 'en-US' ? 0.5 : 0) - (/compact|eloquence|novelty|bad news|bells|bubbles|cellos|jester|organ|trinoids|whisper|zarvox|albert|bahh|boing|wobble|superstar|grandma|grandpa|rocko|shelley|flo|reed|sandy|eddy/i.test(v.name) ? 5 : 0);
  return voices.filter(v => v.lang.startsWith('en')).sort((a, b) => score(b) - score(a));
}

// ---------- turning question text into something a voice can say ----------

const GREEK = { alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', Delta: 'delta', epsilon: 'epsilon', theta: 'theta', lambda: 'lambda', mu: 'mu', pi: 'pi', rho: 'rho', sigma: 'sigma', Sigma: 'sigma', tau: 'tau', phi: 'phi', omega: 'omega', Omega: 'omega' };
const POWERS = { 2: 'squared', 3: 'cubed' };

function ordinal (p) {
  if (!/^\d+$/.test(p)) return p;
  const n = +p % 100;
  return p + (n >= 11 && n <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
}

function mathToSpeech (tex, prevChar) {
  let s = tex;
  s = s.replace(/\\begin\{[bpv]?matrix\}[\s\S]*?\\end\{[bpv]?matrix\}/g, ' the matrix ');
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ');
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, ' the square root of $1 ');
  }
  s = s.replace(/\^\{?\\circ\}?/g, ' degrees');
  // ion charges: OH^{-}, Fe^{3+}
  s = s.replace(/\^\{(\d*)([+\-−–])\}/g, (m, n, sign) => ` ${n} ${sign === '+' ? 'plus' : 'minus'}`);
  s = s.replace(/\^\{(-?)([^{}]*)\}/g, (m, neg, p) => neg ? ` to the negative ${ordinal(p)}` : POWERS[p] ? ` ${POWERS[p]}` : ` to the ${ordinal(p)}`);
  s = s.replace(/\^(\w)/g, (m, p) => POWERS[p] ? ` ${POWERS[p]}` : ` to the ${p}`);
  // chemistry-style subscript right after an element symbol is just the number
  s = s.replace(/_\{([^{}]*)\}/g, (m, sub) => (/[A-Za-z)]/.test(prevChar || '') && /^\d+$/.test(sub)) ? ` ${sub}` : ` sub ${sub}`);
  s = s.replace(/\\(int)_\{?([^{}\s]*)\}?\^\{?([^{}\s]*)\}?/g, ' the integral from $2 to $3 of ');
  s = s.replace(/\\lim_\{([^{}]*)\}/g, ' the limit as $1 of ');
  s = s.replace(/\\to\b/g, ' approaches ').replace(/\\infty/g, ' infinity ');
  s = s.replace(/\\(times|cdot)/g, ' times ').replace(/\\pm/g, ' plus or minus ').replace(/\\le(q)?\b/g, ' less than or equal to ').replace(/\\ge(q)?\b/g, ' greater than or equal to ').replace(/\\neq?\b/g, ' not equal to ');
  s = s.replace(/\\(sin|cos|tan|sec|csc|cot)\b/g, (m, f) => ({ sin: ' sine ', cos: ' cosine ', tan: ' tangent ', sec: ' secant ', csc: ' cosecant ', cot: ' cotangent ' }[f]));
  s = s.replace(/\\ln\b/g, ' natural log ').replace(/\\log_\{?(\w+)\}?/g, ' log base $1 ').replace(/\\log\b/g, ' log ');
  s = s.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ? ` ${GREEK[name]} ` : ' ');
  s = s.replace(/\\text\{([^{}]*)\}/g, '$1').replace(/\\[,;!]/g, ' ').replace(/[{}]/g, ' ');
  s = s.replace(/=/g, ' equals ').replace(/</g, ' is less than ').replace(/>/g, ' is greater than ').replace(/\+/g, ' plus ');
  return s;
}

export function spokenWord (text) {
  let out = '';
  let last = 0;
  const re = /\\\((.*?)\\\)/g;
  let m;
  while ((m = re.exec(text))) {
    out += text.slice(last, m.index);
    out += mathToSpeech(m[1], out.slice(-1)) + ' ';
    last = re.lastIndex;
  }
  out += text.slice(last);
  return out
    .replace(/(^|[\s(=,])[-−–](?=\d)/g, '$1negative ')
    .replace(/\s[-−–]\s/g, ' minus ')
    .replace(/[−]/g, ' minus ')
    .replace(/[º°]\s?C\b/g, ' degrees Celsius').replace(/[º°]\s?F\b/g, ' degrees Fahrenheit')
    .replace(/×/g, ' times ').replace(/[º°]/g, ' degrees').replace(/π/g, ' pi ').replace(/√/g, ' square root of ')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const mathy = t => /\\\(|[=+×÷^√π<>≤≥|θαβλΔ∆]/.test(t) || /^(sin|cos|tan|log|ln|lim)\b/i.test(t) ||
  /^[a-z]\([a-z0-9]+\)[,.]?$/i.test(t) || /^[-–−(]*[\d.,/]+[)%,.]*$/.test(t) || /^[-–−(]*[a-z][)\]]?[,.]?$/i.test(t) || /^[()[\]\-–−+*/]+$/.test(t);

// Spoken form of each token. Moderator descriptions like "(read as: ...)" or
// "[the square root of ...]" are spoken instead of the math just before them;
// one-word pronunciation guides like "[kor-ee-AWN-ik]" are skipped.
export function spokenTokens (toks) {
  const out = toks.map(t => spokenWord(t.text));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].text;
    const readAs = /^\(read$/i.test(t);
    const bracket = t.startsWith('[');
    if (!readAs && !bracket) continue;
    let j = i;
    const closer = readAs ? /\)[.,;:?]*$/ : /\][.,;:?)]*$/;
    while (j < toks.length - 1 && !closer.test(toks[j].text)) j++;
    if (bracket && i === j) { out[i] = out[i].replace(/^.*?([.,;:?]*)$/, '$1'); continue; } // pronunciation guide
    if (readAs) {
      out[i] = '';
      if (toks[i + 1] && /^as:?$/i.test(toks[i + 1].text)) out[i + 1] = '';
      out[j] = out[j].replace(/\)([.,;:?]*)$/, '$1');
    }
    for (let k = i - 1, n = 0; k >= 0 && n < 14 && mathy(toks[k].text); k--, n++) out[k] = '';
    i = j;
  }
  return out;
}

// Split a question into speakable chunks: a short header, a short first chunk so
// audio starts quickly, then sentence-sized pieces, one per answer choice.
export function speechChunks (q, toks) {
  const words = spokenTokens(toks);
  const header = `${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${q.num}. ${q.category}, ${q.format === 'mc' ? 'multiple choice' : 'short answer'}.`;
  const chunks = [{ text: header, idxs: [], offsets: [], words: [] }];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    let text = ''; const offsets = []; const said = [];
    for (const i of cur) {
      offsets.push(text.length);
      let w = words[i];
      if (toks[i].br) w = toks[i].text.replace(')', '') + ','; // "W," before a choice
      said.push(w);
      if (w) text += w + ' ';
    }
    if (text.trim()) chunks.push({ text: text.trim(), idxs: cur.slice(), offsets, words: said });
    else if (chunks.length) {
      const last = chunks[chunks.length - 1];
      last.idxs.push(...cur); last.offsets.push(...cur.map(() => last.text.length)); last.words.push(...cur.map(() => ''));
    }
    cur = [];
  };
  toks.forEach((t, i) => {
    if (t.br) flush();
    cur.push(i);
    const firstChunk = chunks.length === 1;
    const end = /[.?!:;]["”]?$/.test(t.text);
    const comma = /,$/.test(t.text);
    if ((end && cur.length >= 4) || (firstChunk && comma && cur.length >= 6) || cur.length >= (firstChunk ? 12 : 28) ||
      (toks[i + 1] && toks[i + 1].br)) flush();
  });
  flush();
  return chunks;
}

// ---------- lining up words with the generated audio ----------

// rough spoken length of a word, in syllables
export function syllables (word) {
  let n = 0;
  for (const part of (word || '').split(/\s+/)) {
    const letters = part.replace(/[^A-Za-z]/g, '');
    const digits = part.replace(/[^0-9]/g, '');
    if (digits) n += digits.length * 1.3 + (part.includes('.') ? 1 : 0);
    if (!letters) continue;
    if (letters.length <= 3 && letters === letters.toUpperCase()) { // spelled out: "W", "DNA"
      for (const c of letters) n += c === 'W' ? 3 : 1;
      continue;
    }
    const lower = letters.toLowerCase();
    let v = (lower.match(/[aeiouy]+/g) || []).length;
    if (/[^l]e$/.test(lower) && v > 1) v--;
    n += Math.max(1, v);
  }
  return n;
}

function pauseAfter (word) {
  if (!word) return 0;
  if (/[.?!]["”)]?$/.test(word)) return 2.2;
  if (/[,;:]["”)]?$/.test(word)) return 1.3;
  return 0;
}

// silent stretches in the audio: [{ start, end }] in seconds, plus where speech begins/ends
export function findPauses (samples, rate, minPause = 0.07) {
  const hop = Math.round(rate * 0.01);
  const rms = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + hop; j++) e += samples[j] * samples[j];
    rms.push(Math.sqrt(e / hop));
  }
  const sorted = rms.slice().sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const thr = Math.max(0.004, loud * 0.08);
  let first = rms.findIndex(r => r > thr);
  let last = rms.length - 1 - rms.slice().reverse().findIndex(r => r > thr);
  if (first < 0) { first = 0; last = rms.length - 1; }
  const pauses = [];
  let run = -1;
  for (let f = first; f <= last; f++) {
    if (rms[f] <= thr) { if (run < 0) run = f; } else if (run >= 0) {
      if ((f - run) * 0.01 >= minPause) pauses.push({ start: run * 0.01, end: f * 0.01 });
      run = -1;
    }
  }
  return { start: first * 0.01, end: (last + 1) * 0.01, pauses };
}

// Start time (seconds into the audio) of each token in a chunk. Word lengths come
// from phoneme counts (or syllables as a fallback), then get pinned to the real
// pauses at punctuation.
export function alignChunk (chunk, samples, rate, weights = null) {
  const w = weights || chunk.words.map(syllables);
  const pw = chunk.words.map(pauseAfter);
  const startPos = []; let pos = 0;
  for (let i = 0; i < w.length; i++) { startPos.push(pos); pos += w[i] + pw[i]; }
  const total = pos || 1;
  const { start: t0, end: t1, pauses } = findPauses(samples, rate);
  const anchors = [[0, t0]];
  let pi = 0;
  for (let i = 0; i < w.length - 1; i++) {
    if (!pw[i]) continue;
    const [lastPos, lastT] = anchors[anchors.length - 1];
    const speed = (t1 - lastT) / Math.max(total - lastPos, 1e-6);
    const at = startPos[i] + w[i];
    const expected = lastT + (at - lastPos) * speed;
    const tol = Math.max(0.35, 0.25 * (at - lastPos) * speed);
    let best = -1;
    for (let k = pi; k < pauses.length; k++) {
      const d = Math.abs(pauses[k].start - expected);
      if (d <= tol && (best < 0 || d < Math.abs(pauses[best].start - expected))) best = k;
      if (pauses[k].start > expected + tol) break;
    }
    if (best >= 0) {
      anchors.push([at, pauses[best].start], [at + pw[i], pauses[best].end]);
      pi = best + 1;
    }
  }
  anchors.push([total, t1]);
  const timeAt = (p) => {
    let k = 1;
    while (k < anchors.length - 1 && anchors[k][0] < p) k++;
    const [p0, a0] = anchors[k - 1]; const [p1, a1] = anchors[k];
    return p1 === p0 ? a1 : a0 + (a1 - a0) * (p - p0) / (p1 - p0);
  };
  return { starts: startPos.map(timeAt), ends: startPos.map((p, i) => timeAt(p + w[i])) };
}
