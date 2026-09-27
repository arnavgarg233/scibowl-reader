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
    this.worker = new Worker(new URL('./tts-worker.js?v=202609261912', import.meta.url), { type: 'module' });
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

const GREEK = { alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', Delta: 'delta', epsilon: 'epsilon', varepsilon: 'epsilon', zeta: 'zeta', eta: 'eta', theta: 'theta', Theta: 'theta', lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', pi: 'pi', rho: 'rho', sigma: 'sigma', Sigma: 'sigma', tau: 'tau', phi: 'phi', varphi: 'phi', Phi: 'phi', chi: 'chi', psi: 'psi', omega: 'omega', Omega: 'omega', ell: 'l', hbar: 'h bar', infty: 'infinity', circ: 'degrees', prime: 'prime', angle: 'angle', triangle: 'triangle', degree: 'degrees' };
const FUNCS = { sin: 'sine', cos: 'cosine', tan: 'tangent', sec: 'secant', csc: 'cosecant', cot: 'cotangent', arcsin: 'arc sine', arccos: 'arc cosine', arctan: 'arc tangent', sinh: 'hyperbolic sine', cosh: 'hyperbolic cosine', tanh: 'hyperbolic tangent', ln: 'natural log', log: 'log', exp: 'e to the', det: 'the determinant of' };
const SYMBOLS = { times: 'times', cdot: 'times', div: 'divided by', pm: 'plus or minus', mp: 'minus or plus', le: 'is less than or equal to', leq: 'is less than or equal to', ge: 'is greater than or equal to', geq: 'is greater than or equal to', ne: 'is not equal to', neq: 'is not equal to', approx: 'is approximately', sim: 'is approximately', propto: 'is proportional to', to: 'approaches', rightarrow: 'yields', longrightarrow: 'yields', leftarrow: 'is produced from', rightleftharpoons: 'is in equilibrium with', leftrightarrow: 'is in equilibrium with', perp: 'is perpendicular to', parallel: 'is parallel to', ldots: 'dot dot dot', cdots: 'dot dot dot', dots: 'dot dot dot', cup: 'union', cap: 'intersect', in: 'in', therefore: 'therefore', cong: 'is congruent to', deg: 'degrees' };
const OP_WORDS = { '+': 'plus', '=': 'equals', '<': 'is less than', '>': 'is greater than', '×': 'times', '÷': 'divided by', '±': 'plus or minus', '≤': 'is less than or equal to', '≥': 'is greater than or equal to', '≠': 'is not equal to', '≈': 'is approximately', '→': 'yields', '*': 'times', '%': 'percent', '!': 'factorial' };
const COMPOUND = /\b(plus|minus|times|over|equals|divided|to the|root)\b/;

function ordinal (p) {
  if (!/^\d+$/.test(p)) return p;
  const n = +p % 100;
  return p + (n >= 11 && n <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
}

// tiny LaTeX reader: characters, \commands, {groups}, ^ and _
function parseTex (src) {
  let i = 0;
  const seq = (end) => {
    const out = [];
    while (i < src.length && src[i] !== end) {
      const c = src[i];
      if (c === '{') { i++; out.push({ t: 'group', c: seq('}') }); i++; } else if (c === '\\') {
        const m = src.slice(i + 1).match(/^([A-Za-z]+|.)/);
        i += 1 + (m ? m[1].length : 0);
        out.push({ t: 'cmd', v: m ? m[1] : '' });
      } else { out.push({ t: 'ch', v: c }); i++; }
    }
    return out;
  };
  return seq(null);
}

const plain = s => s.replace(/\s+/g, ' ').trim();
// the voice drops a lone "A" right after "sub"; "eh" comes out as the letter (checked with speech recognition)
const subLetter = s => s === 'A' ? 'eh' : s;
const SCI = /^-?[\d.]+ times 10 to the (negative )?\S+$/; // 6.0 times 10 to the 22nd is a single number
const quantity = s => COMPOUND.test(s) && !SCI.test(s) && !/^the quantity/.test(s) ? `the quantity ${s},` : s;

function power (arg, base) {
  const raw = plain(arg.raw);
  if (arg.structured) return ` to the power of ${arg.spoken},`; // e.g. a fraction exponent
  if (/^\\?circ$/.test(raw) || raw === '°') return ' degrees';
  if (/^\d*[+\-−–]$/.test(raw) && /[A-Za-z)\]]$/.test(base)) return ` ${raw.slice(0, -1)} ${raw.endsWith('+') ? 'plus' : 'minus'}`; // ion charge
  if (raw === '2') return ' squared';
  if (raw === '3') return ' cubed';
  if (/^\d+$/.test(raw)) return ` to the ${ordinal(raw)}`;
  if (/^[-−–]\d+$/.test(raw)) return ` to the negative ${ordinal(raw.slice(1))}`;
  if (/^[A-Za-z]$/.test(raw)) return ` to the ${raw}`;
  if (raw === "'" || raw === '\\prime') return ' prime';
  return ` to the power of ${arg.spoken},`;
}

// speak a node list; returns words
function speakNodes (nodes) {
  const items = []; // spoken pieces
  let k = 0;
  const arg = () => {
    while (k < nodes.length && nodes[k].t === 'ch' && nodes[k].v === ' ') k++;
    const n = nodes[k++];
    if (!n) return { spoken: '', raw: '' };
    const list = n.t === 'group' ? n.c : [n];
    return { spoken: speakNodes(list), raw: rawText(list), structured: list.some(x => x.t === 'cmd' && !['circ', 'prime'].includes(x.v)) };
  };
  const last = () => items.length ? items[items.length - 1] : '';
  const prevIsOperand = () => /[\w)\]]$/.test(plain(last())) && !/\b(plus|minus|times|equals|over|of|than|to)$/.test(plain(last()));
  while (k < nodes.length) {
    const n = nodes[k++];
    if (n.t === 'group') { items.push(speakNodes(n.c)); continue; }
    if (n.t === 'cmd') {
      const v = n.v;
      if (v === 'frac' || v === 'dfrac' || v === 'tfrac') {
        const a = arg(); const b = arg();
        items.push(`${quantity(a.spoken)} over ${quantity(b.spoken)}`);
      } else if (v === 'sqrt') {
        let idx = '';
        if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '[') { k++; let r = ''; while (k < nodes.length && !(nodes[k].t === 'ch' && nodes[k].v === ']')) r += rawText([nodes[k++]]); k++; idx = r; }
        const a = arg();
        const root = idx ? `the ${idx === '3' ? 'cube' : ordinal(idx)} root of` : 'the square root of';
        items.push(`${root} ${COMPOUND.test(a.spoken) ? `the quantity ${a.spoken},` : a.spoken}`);
      } else if (['text', 'textrm', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'boldsymbol'].includes(v)) {
        items.push(plain(arg().raw)); // words inside \text{...} are read as written
      } else if (v === 'vec') items.push(`vector ${arg().spoken}`);
      else if (v === 'hat') items.push(`${arg().spoken} hat`);
      else if (v === 'overline' || v === 'bar') items.push(`${arg().spoken} bar`);
      else if (v === 'binom') { const a = arg(); const b = arg(); items.push(`${a.spoken} choose ${b.spoken}`); } else if (v === 'begin') {
        const env = arg().raw; const cells = []; let row = []; let cur = [];
        while (k < nodes.length && !(nodes[k].t === 'cmd' && nodes[k].v === 'end')) {
          const x = nodes[k++];
          if (x.t === 'ch' && x.v === '&') { row.push(speakNodes(cur)); cur = []; } else if (x.t === 'cmd' && x.v === '\\') { row.push(speakNodes(cur)); cells.push(row); row = []; cur = []; } else cur.push(x);
        }
        k++; arg(); // \end{env}
        if (cur.length || row.length) { row.push(speakNodes(cur)); cells.push(row); }
        items.push(/matrix/.test(env) ? `the matrix with rows ${cells.map(r => r.map(plain).join(', ')).join('; ')};` : cells.map(r => r.join(' ')).join('; '));
      } else if (v === 'int') {
        let lo = ''; let hi = '';
        for (let j = 0; j < 2; j++) {
          if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '_') { k++; lo = arg().spoken; } else if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '^') { k++; hi = arg().spoken; }
        }
        items.push(lo || hi ? `the integral from ${lo} to ${hi} of` : 'the integral of');
      } else if (v === 'sum' || v === 'prod') {
        let lo = ''; let hi = '';
        for (let j = 0; j < 2; j++) {
          if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '_') { k++; lo = arg().spoken; } else if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '^') { k++; hi = arg().spoken; }
        }
        items.push(`the ${v === 'sum' ? 'sum' : 'product'}${lo ? ` from ${lo}` : ''}${hi ? ` to ${hi}` : ''} of`);
      } else if (v === 'lim') {
        let sub = '';
        if (nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '_') { k++; sub = arg().spoken; }
        items.push(`the limit${sub ? ` as ${sub}` : ''} of`);
      } else if (v === 'log' && nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '_') { k++; items.push(`log base ${arg().spoken} of`); } else if (FUNCS[v]) items.push(FUNCS[v] + (v === 'exp' || v === 'det' ? '' : ' of'));
      else if (GREEK[v]) items.push(GREEK[v]);
      else if (SYMBOLS[v]) items.push(SYMBOLS[v]);
      else if (v === '%' || v === '$' || v === '#' || v === '&') items.push(v === '%' ? 'percent' : v === '$' ? 'dollars' : '');
      else items.push(' '); // \left \right \, \quad etc.
      continue;
    }
    const c = n.v;
    if (c === '^' || c === '_') {
      const a = arg();
      const base = plain(items.pop() || '');
      if (c === '^') items.push(`${/\)$/.test(base) || COMPOUND.test(base) ? `the quantity ${base.replace(/[()]/g, '')},` : base}${power(a, base)}`);
      else items.push(/^\d+$/.test(plain(a.raw)) && /[A-Za-z)]$/.test(base) && !/^[a-z]$/.test(base) ? `${base} ${plain(a.raw)}` : `${base} sub ${subLetter(a.spoken)}`);
      continue;
    }
    if (/\d/.test(c) || (c === '.' && nodes[k] && /\d/.test(nodes[k].v || ''))) { // whole number
      let num = c;
      while (k < nodes.length && nodes[k].t === 'ch' && /[\d.,]/.test(nodes[k].v) && !(nodes[k].v === ',' && !/\d/.test((nodes[k + 1] || {}).v || ''))) num += nodes[k++].v;
      items.push(num);
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      // "f(x)" -> "f of x"
      const next = nodes[k];
      if (/^[fgh]$/.test(c) && next && next.t === 'ch' && next.v === '(') { items.push(`${c} of`); k++; let depth = 1; const inner = []; while (k < nodes.length) { const x = nodes[k++]; if (x.t === 'ch' && x.v === '(') depth++; if (x.t === 'ch' && x.v === ')' && --depth === 0) break; inner.push(x); } items.push(speakNodes(inner)); continue; }
      items.push(c === 'a' ? 'A' : c); // lowercase "a" would be read as the article
      continue;
    }
    if (c === '(' || c === '[') {
      let depth = 1; const inner = []; const close = c === '(' ? ')' : ']';
      while (k < nodes.length) { const x = nodes[k++]; if (x.t === 'ch' && x.v === c) depth++; if (x.t === 'ch' && x.v === close && --depth === 0) break; inner.push(x); }
      const s = speakNodes(inner);
      const followedByPower = nodes[k] && nodes[k].t === 'ch' && nodes[k].v === '^';
      const wrap = COMPOUND.test(s) && !SCI.test(s) && !/^the quantity/.test(s);
      items.push(followedByPower ? `(${s})` : wrap && prevIsOperand() ? `times the quantity ${s},` : wrap ? `the quantity ${s},` : prevIsOperand() && SCI.test(s) ? `times ${s}` : s);
      continue;
    }
    if (c === '|') {
      const inner = []; while (k < nodes.length && !(nodes[k].t === 'ch' && nodes[k].v === '|')) inner.push(nodes[k++]); k++;
      items.push(`the absolute value of ${speakNodes(inner)},`);
      continue;
    }
    if (c === '-' || c === '−' || c === '–') { items.push(prevIsOperand() ? 'minus' : 'negative'); continue; }
    if (c === '/') { items.push('over'); continue; }
    if (c === "'") { items.push('prime'); continue; }
    if (OP_WORDS[c]) { items.push(OP_WORDS[c]); continue; }
    if (c === ',' || c === ';' || c === ':') { items.push(c === ':' ? 'to' : ','); continue; }
    // spaces and anything else: nothing
  }
  return plain(items.join(' ').replace(/ ,/g, ','));
}

function rawText (nodes) {
  return nodes.map(n => n.t === 'group' ? rawText(n.c) : n.t === 'cmd' ? (n.v === 'circ' ? '\\circ' : n.v === 'prime' ? "'" : '') : n.v).join('');
}

function mathToSpeech (tex, prevChar) {
  // chemistry: a lone subscript/charge right after a symbol, e.g. H\(_{2}\)O, Fe\(^{3+}\)
  const lone = tex.match(/^\s*([_^])\{([^{}]*)\}\s*$/);
  if (lone) {
    const v = lone[2].trim();
    if (lone[1] === '_') return /[A-Za-z)]/.test(prevChar || '') && /^\d+$/.test(v) ? ` ${v}` : ` sub ${subLetter(speakNodes(parseTex(v)))}`;
    if (/^\d*[+\-−–]$/.test(v)) return ` ${v.slice(0, -1)} ${v.endsWith('+') ? 'plus' : 'minus'}`;
    return power({ spoken: speakNodes(parseTex(v)), raw: v }, prevChar || 'x');
  }
  return ' ' + speakNodes(parseTex(tex));
}

// ordinary (non-LaTeX) text: symbols and number formats a voice would misread
function plainToSpeech (t) {
  return t
    .replace(/\)\s*\(/g, ') times (')
    .replace(/\(([^()]*\d[^()]*)\)/g, ' $1 ')
    .replace(/^[x×](?=\d)/, 'times ') // "x10" glued to the number
    .replace(/(\d)([a-z])(?![A-Za-z])/g, '$1 $2') // 4x -> 4 x
    .replace(/(^|[\s(])(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?=$|[\s),.;:?])/g, '$1$2 over $3')
    .replace(/([\w)])\s*=\s*(?=[\w(−–-])/g, '$1 equals ')
    .replace(/([\w)])\+(?=[\w(])/g, '$1 plus ')
    .replace(/(^|[\s(=,])[-−–](?=\d)/g, '$1negative ')
    .replace(/\s[-−–]\s/g, ' minus ')
    .replace(/[−]/g, ' minus ')
    .replace(/[º°]\s?C\b/g, ' degrees Celsius').replace(/[º°]\s?F\b/g, ' degrees Fahrenheit')
    .replace(/×/g, ' times ').replace(/[º°]/g, ' degrees').replace(/π/g, ' pi ').replace(/√/g, ' square root of ')
    .replace(/→/g, ' yields ');
}

export function spokenWord (text) {
  let out = '';
  let last = 0;
  const re = /\\\((.*?)\\\)/g;
  let m;
  while ((m = re.exec(text))) {
    out += plainToSpeech(text.slice(last, m.index));
    out += mathToSpeech(m[1], out.slice(-1)) + ' ';
    last = re.lastIndex;
  }
  out += plainToSpeech(text.slice(last));
  // brackets and parentheses are never spoken (and make the voice stumble)
  return out.replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').replace(/ ([,.;:?!])/g, '$1').trim();
}

const numberish = t => /^[-–−(]*[\d.,]+[)%.,;:?]*$/.test(t) || /^[-–−(]*[\d.]+\\\(/.test(t) || /^10\\\(/.test(t);
const STANDALONE = { '=': 'equals', '+': 'plus', '×': 'times', '÷': 'divided by', '<': 'is less than', '>': 'is greater than', '≤': 'is less than or equal to', '≥': 'is greater than or equal to', '±': 'plus or minus', '→': 'yields', '/': 'over', '*': 'times' };

// a token that's part of an equation (read a bit slower, like a moderator does)
export function isEquation (t) {
  if (STANDALONE[t] || /^[-−–]$/.test(t)) return true;
  const math = (t.match(/\\\((.*?)\\\)/g) || []).join(' ');
  if (math && !/^(\\\([_^]\{[^{}]*\}\\\)\s*)+$/.test(math)) return true; // more than a chemistry subscript/charge
  if (/^\d*[a-z]\d*[\^=+]/i.test(t) || /[=+^]/.test(t)) return true;
  return /^-?\d+[a-z]$/.test(t) || /\d\s*[x×]\s*10/.test(t);
}

const mathy = t => /\\\(|[=+×÷^√π<>≤≥|θαβλΔ∆]/.test(t) || /^(sin|cos|tan|log|ln|lim)\b/i.test(t) ||
  /^[a-z]\([a-z0-9]+\)[,.]?$/i.test(t) || /^[-–−(]*[\d.,/]+[)%,.]*$/.test(t) || /^[-–−(]*[a-z][)\]]?[,.]?$/i.test(t) || /^[()[\]\-–−+*/]+$/.test(t);

// Spoken form of each token. Moderator descriptions like "(read as: ...)" or
// "[the square root of ...]" are spoken instead of the math just before them;
// one-word pronunciation guides like "[kor-ee-AWN-ik]" are skipped.
export function spokenTokens (toks) {
  const out = toks.map(t => spokenWord(t.text));
  out.described = new Set(); // tokens inside a spoken description of math
  // symbols standing alone between words
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].text; const prev = toks[i - 1]?.text || ''; const next = toks[i + 1]?.text || '';
    if (STANDALONE[t]) out[i] = STANDALONE[t];
    else if (/^[xX]$/.test(t) && numberish(prev) && (numberish(next) || /^\d/.test(next))) {
      out[i] = /^(matri|grid|array|board|square)/i.test(toks[i + 2]?.text || '') ? 'by' : 'times';
    } else if (/^[-−–]$/.test(t)) {
      const m = x => mathy(x) || isEquation(x) || numberish(x);
      out[i] = (m(prev) && m(next)) ? 'minus' : '';
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].text;
    const readAs = /^\(read$/i.test(t);
    const bracket = t.startsWith('[');
    if (!readAs && !bracket) continue;
    let j = i;
    const closer = readAs ? /\)[.,;:?]*$/ : /\][.,;:?)]*$/;
    while (j < toks.length - 1 && !closer.test(toks[j].text)) j++;
    if (bracket && i === j) { out[i] = out[i].replace(/^.*?([.,;:?]*)$/, '$1'); continue; } // pronunciation guide
    for (let d = i; d <= j; d++) out.described.add(d);
    if (readAs) {
      out[i] = '';
      if (toks[i + 1] && /^as:?$/i.test(toks[i + 1].text)) out[i + 1] = '';
      out[j] = out[j].replace(/\)([.,;:?]*)$/, '$1');
    }
    // silence the symbols this description replaces, but never past an answer-choice
    // label or the end of an earlier description
    for (let k = i - 1, n = 0; k >= 0 && n < 14 && !toks[k].br && !/[\])]$/.test(toks[k].text.replace(/\\\)$/, '')) && (mathy(toks[k].text) || isEquation(toks[k].text)); k--, n++) out[k] = '';
    i = j;
  }
  return out;
}

// Split a question into speakable chunks: a short header, a short first chunk so
// audio starts quickly, then sentence-sized pieces, one per answer choice.
export function speechChunks (q, toks) {
  const words = spokenTokens(toks);
  const chunks = [{ text: headerText(q), idxs: [], offsets: [], words: [], gapAfter: HUMAN.afterHeader }];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    let text = ''; const offsets = []; const said = [];
    for (const i of cur) {
      offsets.push(text.length);
      const w = toks[i].br ? toks[i].text.replace(')', '') + '.' : words[i]; // "W." said on its own
      said.push(w);
      if (w) text += w + ' ';
    }
    const math = cur.some(i => words.described.has(i) || isEquation(toks[i].text));
    const letter = toks[cur[0]].br ? toks[cur[0]].text[0] : null;
    if (text.trim()) chunks.push({ text: text.trim(), idxs: cur.slice(), offsets, words: said, math, letter });
    else if (chunks.length) {
      const last = chunks[chunks.length - 1];
      last.idxs.push(...cur); last.offsets.push(...cur.map(() => last.text.length)); last.words.push(...cur.map(() => ''));
    }
    cur = [];
  };
  toks.forEach((t, i) => {
    if (t.br) { flush(); cur.push(i); flush(); return; } // the letter is its own clip
    cur.push(i);
    const firstChunk = chunks.length === 1;
    const end = /[.?!:;]["”]?$/.test(t.text);
    const comma = /,$/.test(t.text);
    if ((end && cur.length >= 4) || (firstChunk && comma && cur.length >= 6) || cur.length >= (firstChunk ? 12 : 28) ||
      (toks[i + 1] && toks[i + 1].br)) flush();
  });
  flush();
  // human pause after each clip
  for (let c = 1; c < chunks.length; c++) {
    const ch = chunks[c]; const next = chunks[c + 1];
    ch.gapAfter = !next ? 0 : ch.letter ? HUMAN.afterChoice[ch.letter] : next.letter ? HUMAN.beforeChoice : HUMAN.phraseBreak;
  }
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
  return { starts: startPos.map(timeAt), ends: startPos.map((p, i) => timeAt(p + w[i])), voicedStart: t0, voicedEnd: t1 };
}

// ---------- human reading pace ----------

// Measured from real moderators: auto-caption word timings of 309 questions read in 14
// National Science Bowl finals (high school and middle school, 2013-2026).
//   content word   0.228 s + 0.101 s per syllable   (1 syllable 0.32 s ... 5 syllables 0.72 s)
//   number         0.374 s + 0.111 s per syllable   (numbers are read noticeably slower)
//   the/of/is...   0.20 s
//   phrase break   0.52 s  (comma / sentence end; ~15% of word gaps)
//   before W/X/Y/Z 0.31 s, after the letter 0.36-0.52 s (longer toward Z)
//   header         ~2.2 s to say, then 0.62 s before the question starts
//   math words     ~15% slower than other words
// Overall about 141 words per minute.
export const HUMAN = {
  word: 0.228, perSyllable: 0.101,
  number: 0.374, numberPerSyllable: 0.111,
  functionWord: 0.2,
  phraseBreak: 0.52,
  beforeChoice: 0.31,
  afterChoice: { W: 0.36, X: 0.36, Y: 0.44, Z: 0.52 },
  afterHeader: 0.62,
  math: 1.15
};
// the AI voice at speed 1 says 0.181 s per syllable; moderators average 0.210
export const VOICE_SPEED = 0.86;
export const MATH_RATE = 1 / HUMAN.math;

const FUNCTION_WORDS = /^(the|a|an|of|to|in|is|and|for|on|by|at|it|as|or|what|which|that|this|its|be|are|with|from)$/i;

// seconds to say a (possibly multi-word) spoken string
function sayTime (spoken, math) {
  let t = 0;
  for (const w of spoken.split(/\s+/)) {
    const bare = w.replace(/[^\w.-]/g, '');
    if (!bare) continue;
    if (/^-?\d/.test(bare)) t += HUMAN.number + HUMAN.numberPerSyllable * syllables(bare);
    else if (FUNCTION_WORDS.test(bare)) t += HUMAN.functionWord * (math ? HUMAN.math : 1);
    else t += (HUMAN.word + HUMAN.perSyllable * syllables(bare)) * (math ? HUMAN.math : 1);
  }
  return t;
}

export function speedFactor (setting) {
  return setting <= 50 ? 0.6 + 0.4 * setting / 50 : 1 + 0.8 * (setting - 50) / 50;
}

export function headerText (q) {
  return `${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${q.num}. ${q.category}, ${q.format === 'mc' ? 'multiple choice' : 'short answer'}.`;
}

// Seconds to say the header, and each token plus the pause after it, at 1.0x.
export function readingTimes (q, toks) {
  const words = spokenTokens(toks);
  const header = sayTime(headerText(q), false) + HUMAN.afterHeader;
  const times = toks.map((t, i) => {
    const math = words.described.has(i) || isEquation(t.text);
    const w = t.br ? t.text.replace(')', '') : words[i];
    let sec = w ? sayTime(w, math) : 0; // symbols a read-as covers, pronunciation guides: 0
    if (i === toks.length - 1) return sec; // the clock starts right after the last word
    if (t.br) sec += HUMAN.afterChoice[t.text[0]] || HUMAN.phraseBreak;
    else if (toks[i + 1] && toks[i + 1].br) sec += HUMAN.beforeChoice;
    else if (w && /[,;:.?!]["”)]?$/.test(w)) sec += HUMAN.phraseBreak;
    return sec;
  });
  return { header, times };
}

export function naturalWpm () { return 136; } // readingTimes at 1.0x over all questions (moderators measured 141)
