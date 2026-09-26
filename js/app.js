import { checkAnswer, parseAnswer, stripLatex } from './check.js';
import { NeuralVoice, NEURAL_VOICES, alignChunk, naturalWpm, rankBrowserVoices, readingTimes, speechChunks, speedFactor } from './voice.js';
import { countdown } from './timer.js';

const CATEGORIES = ['Biology', 'Chemistry', 'Earth and Space', 'Energy', 'Math', 'Physics', 'General Science'];
const FORMATS = { mc: 'Multiple Choice', sa: 'Short Answer' };
const POINTS = { tossup: 4, bonus: 10 };

const DEFAULT_SETTINGS = {
  questionType: 'match',
  mode: 'random',
  packetSet: 1,
  packetRound: '1',
  sets: null, // null = all
  categories: CATEGORIES.slice(),
  formats: ['mc', 'sa'],
  typeToAnswer: true,
  alwaysBonus: false,
  showHistory: true,
  showSetName: true,
  timer: true,
  voiceMode: 'off', // off | neural | browser
  neuralVoice: 'af_heart',
  voice: '',
  readingSpeed: 50,
  tossupTime: 5,
  bonusTime: 20,
  answerTime: 10,
  sound: true,
  shuffleRound: false,
  difficulties: ['standard', 'hard', 'hardest'],
  pool: 'all', // all | unseen | missed
  theme: 'auto'
};

const $ = id => document.getElementById(id);

function load (key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch (e) { return { ...fallback }; }
}
function save (key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

const settings = load('sbr-settings', DEFAULT_SETTINGS);
const emptyStats = () => ({ tu: { seen: 0, correct: 0, wrong: 0, negs: 0, points: 0, celerity: 0 }, bonus: { seen: 0, correct: 0, points: 0 }, byCat: {} });
let stats = load('sbr-stats', emptyStats());
// questions you've seen / missed, for "unseen only" and "review missed"
let progress = load('sbr-progress', { seen: [], missed: [] });

let ALL = [];
let BY_ID = {};
let SOURCES = {};

// ---------- text rendering ----------

function escapeHtml (s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderMath (tex) {
  try {
    return window.katex.renderToString(tex, { throwOnError: false, output: 'html' });
  } catch (e) {
    return escapeHtml(tex);
  }
}

// plain text with \( ... \) math, pronunciation guides in [ ] and (read as: ...)
function renderRich (text) {
  let html = '';
  const re = /\\\((.*?)\\\)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    html += escapeHtml(text.slice(last, m.index));
    html += renderMath(m[1]);
    last = re.lastIndex;
  }
  html += escapeHtml(text.slice(last));
  return html
    .replace(/\[([^\]<]*)\]/g, '<span class="pron">[$1]</span>')
    .replace(/\((read as:[^)<]*)\)/gi, '<span class="pron">($1)</span>');
}

// split into words without breaking a \( ... \) group
function splitWords (text) {
  const words = [];
  let cur = ''; let inMath = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('\\(', i)) inMath = true;
    if (text.startsWith('\\)', i)) inMath = false;
    const c = text[i];
    if (/\s/.test(c) && !inMath) {
      if (cur) words.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) words.push(cur);
  return words;
}

// tokens: [{ text, br }] where br = starts a choice line
function tokenize (q) {
  const toks = splitWords(q.text).map(t => ({ text: t }));
  if (q.choices) {
    q.choices.forEach((c, i) => {
      toks.push({ text: 'WXYZ'[i] + ')', br: true });
      splitWords(c).forEach(w => toks.push({ text: w }));
    });
  }
  return toks;
}

function renderTokens (toks, upto, buzzAt = -1) {
  let html = ''; let line = [];
  const flush = (isChoice) => {
    if (!line.length) return;
    const inner = renderRich(line.join(' '));
    html += isChoice ? `<span class="choice">${inner}</span>` : inner + ' ';
    line = [];
  };
  let inChoice = false;
  for (let i = 0; i < upto; i++) {
    const t = toks[i];
    if (t.br) { flush(inChoice); inChoice = true; }
    if (i === buzzAt) line.push('\u0000BUZZ\u0000');
    line.push(t.text);
  }
  if (buzzAt === upto) line.push('\u0000BUZZ\u0000');
  flush(inChoice);
  return html.replace(/\u0000BUZZ\u0000/g, '<span class="buzzmark">(#)</span>');
}

// ---------- speech ----------

let voices = [];
function loadVoices () {
  voices = rankBrowserVoices(window.speechSynthesis?.getVoices() || []);
  if (!settings.voice && voices[0]) settings.voice = voices[0].name;
  $('voice').replaceChildren(...voices.map(v => new Option(v.name, v.name, false, v.name === settings.voice)));
}

const neural = new NeuralVoice(status => {
  const el = $('voice-status');
  if (status.state === 'loading') {
    el.textContent = `Downloading AI voice (one time, ${neural.device === 'webgpu' ? '~325' : '~90'} MB): ${status.pct}%`;
  } else if (status.state === 'ready') {
    el.textContent = neural.device === 'webgpu' ? 'AI voice ready.' : 'AI voice ready (no WebGPU here, so it may lag; the browser voice is faster).';
  } else {
    el.textContent = `AI voice failed to load (${status.message}). Using the browser voice.`;
  }
});

function neuralSpeed () { return Math.round(speedFactor(settings.readingSpeed) * 20) / 20; }

function voiceMode () {
  if (settings.voiceMode === 'neural') return neural.isReady ? 'neural' : 'off'; // silent until the model is ready
  if (settings.voiceMode !== 'off' && window.speechSynthesis) return 'browser';
  return 'off';
}

let voiceCtx = null;
function audioContext () {
  voiceCtx = voiceCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (voiceCtx.state === 'suspended' && !game.paused) voiceCtx.resume();
  return voiceCtx;
}

// queue audio for a question's chunks (current question first, then the next one)
function requestChunks (q) {
  const chunks = speechChunks(q, tokenize(q));
  const voice = settings.neuralVoice; const speed = neuralSpeed();
  return chunks.map(c => ({ ...c, key: neural.key(c.text, voice, speed), audio: neural.request(c.text, voice, speed, c.words) }));
}

function prefetchUpcoming (currentChunks = []) {
  if (voiceMode() !== 'neural') return;
  const upcoming = game.pendingBonus || game.queue[0];
  const next = upcoming ? requestChunks(upcoming) : [];
  neural.retain([...currentChunks, ...next].map(c => c.key));
}

function revealUpTo (i) {
  if (i > game.wordIndex) {
    game.wordIndex = i;
    $('question').innerHTML = renderTokens(game.toks, game.wordIndex);
  }
}

async function speakNeural () {
  const gen = ++game.speechGen;
  const chunks = requestChunks(game.q);
  prefetchUpcoming(chunks);
  const live = () => gen === game.speechGen && game.phase === 'reading';
  for (const chunk of chunks) {
    let audio;
    try { audio = await chunk.audio; } catch (e) { if (live()) readNext(); return; } // fall back to silent reading
    if (!live()) return;
    await playChunk(audio, chunk, gen);
    if (!live()) return;
    if (chunk.idxs.length) revealUpTo(chunk.idxs[chunk.idxs.length - 1] + 1);
  }
  if (live()) doneReading();
}

function playChunk (audio, chunk, gen) {
  return new Promise(resolve => {
    const ctx = audioContext();
    const buf = ctx.createBuffer(1, audio.samples.length, audio.rate);
    buf.copyToChannel(audio.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    game.voiceSource = src;
    const start = ctx.currentTime;
    // when each word starts in this clip (phoneme lengths pinned to the real pauses)
    const { starts, voicedEnd } = alignChunk(chunk, audio.samples, audio.rate, audio.weights);
    // move on (and start the NSB clock) when the voice stops, not after the clip's silent tail
    let done = false;
    const finish = () => { if (!done) { done = true; clearInterval(tick); resolve(); } };
    const LEAD = 0.04; // show a word just as it begins
    const tick = setInterval(() => {
      if (gen !== game.speechGen) { clearInterval(tick); return; }
      if (ctx.currentTime - start >= voicedEnd) { finish(); return; }
      const t = ctx.currentTime - start + LEAD;
      // silent tokens (symbols a read-as description replaces) share the next word's start
      let k = 0;
      while (k < starts.length && starts[k] <= t) k++;
      if (k) revealUpTo(chunk.idxs[k - 1] + 1);
    }, 25);
    src.onended = () => { if (game.voiceSource === src) game.voiceSource = null; finish(); };
    src.start();
  });
}

function speakBrowser () {
  const synth = window.speechSynthesis;
  synth.cancel();
  const gen = ++game.speechGen;
  const chunks = speechChunks(game.q, game.toks);
  const live = () => gen === game.speechGen && game.phase === 'reading';
  const speakChunk = (ci) => {
    if (!live()) return;
    if (ci >= chunks.length) return doneReading();
    const { text, idxs, offsets } = chunks[ci];
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find(x => x.name === settings.voice);
    if (v) u.voice = v;
    u.rate = speedFactor(settings.readingSpeed);
    u.onboundary = (e) => {
      if (!live() || !idxs.length) return;
      let k = 0;
      while (k + 1 < offsets.length && offsets[k + 1] <= e.charIndex) k++;
      revealUpTo(idxs[k] + 1);
    };
    u.onend = () => {
      if (!live()) return;
      if (idxs.length) revealUpTo(idxs[idxs.length - 1] + 1);
      speakChunk(ci + 1);
    };
    synth.speak(u);
  };
  speakChunk(0);
}

// ---------- game state ----------

const game = {
  queue: [],
  q: null,
  kind: null, // 'tossup' | 'bonus'
  toks: [],
  wordIndex: 0,
  phase: 'idle', // idle | reading | dead | answering | judging | revealed
  paused: false,
  buzzIndex: -1,
  readTimeout: null,
  timer: { clock: null, left: 0 },
  last: null, // last scored result, for "I was wrong"
  pendingBonus: null,
  speechGen: 0,
  voiceSource: null
};

function shuffle (a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roundOrder (r) { return /^\d+$/.test(r) ? parseInt(r) : 999; }

function buildQueue () {
  const wantPart = settings.questionType === 'bonuses' ? 'bonus' : 'tossup';
  if (settings.mode === 'packet') {
    game.queue = ALL.filter(q => q.set === +settings.packetSet && q.round === settings.packetRound && q.part === wantPart)
      .sort((a, b) => a.num - b.num);
    if (settings.shuffleRound) shuffle(game.queue);
  } else {
    game.queue = shuffle(matching());
  }
  game.pendingBonus = null;
  updateMatchCount();
}

// NSB coordinator manual: rounds 1-10 are about equal; from round 11 each round
// gets harder, with round 17 the hardest.
function difficulty (q) {
  const r = parseInt(q.round);
  return r <= 10 ? 'standard' : r <= 14 ? 'hard' : 'hardest';
}
const DIFFICULTIES = { standard: 'Rounds 1–10', hard: 'Rounds 11–14', hardest: 'Rounds 15–17' };
const DIFFICULTY_NAMES = { standard: 'Round robin', hard: 'Elimination', hardest: 'Late elimination' };

function matching () {
  const wantPart = settings.questionType === 'bonuses' ? 'bonus' : 'tossup';
  const sets = settings.sets ? new Set(settings.sets) : null;
  const seen = new Set(progress.seen); const missed = new Set(progress.missed);
  return ALL.filter(q => q.part === wantPart &&
    settings.categories.includes(q.category) &&
    settings.formats.includes(q.format) &&
    settings.difficulties.includes(difficulty(q)) &&
    (!sets || sets.has(q.set)) &&
    (settings.pool === 'all' || (settings.pool === 'unseen' ? !seen.has(q.id) : missed.has(q.id))));
}

function updateMatchCount () {
  const el = $('match-count');
  if (!el) return;
  if (settings.mode === 'packet') { el.textContent = ''; return; }
  const n = matching().length;
  const what = settings.questionType === 'bonuses' ? 'bonus' : 'toss-up';
  el.textContent = `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'} match`;
  el.classList.toggle('text-danger', n === 0);
}

function recordProgress (result) {
  const id = result.q.id;
  if (!progress.seen.includes(id)) progress.seen.push(id);
  progress.missed = progress.missed.filter(x => x !== id);
  if (!result.correct) progress.missed.push(id);
  save('sbr-progress', progress);
}

function next () {
  if (game.phase === 'answering' || game.phase === 'judging') return;
  if (voiceMode() === 'neural') audioContext(); // create inside the key press/click (autoplay rules)
  if ((game.phase === 'reading' || game.phase === 'dead') && game.q) {
    finishUnanswered(true);
  }
  stopReading();
  stopTimer();
  let q;
  if (game.pendingBonus) {
    q = game.pendingBonus;
    game.pendingBonus = null;
  } else {
    if (!game.queue.length) buildQueue();
    q = game.queue.shift();
  }
  if (!q) {
    $('question').innerHTML = '<span class="text-body-secondary">No questions match these settings. Try turning on more categories or sets.</span>';
    game.phase = 'idle';
    updateButtons();
    return;
  }
  startQuestion(q);
}

function startQuestion (q) {
  game.q = q;
  game.kind = q.part;
  game.toks = tokenize(q);
  game.wordIndex = 0;
  game.buzzIndex = -1;
  game.paused = false;
  game.phase = 'reading';
  game.last = null;
  $('answer').innerHTML = '';
  $('question').innerHTML = '';
  $('toggle-correct').classList.add('d-none');
  $('answer-input-group').classList.add('d-none');
  $('judge-group').classList.add('d-none');
  $('judge-group').classList.remove('d-flex');
  $('category-line').innerHTML = `<span class="part">${q.part === 'tossup' ? 'TOSS-UP' : 'BONUS'}</span> · ${escapeHtml(q.category.toUpperCase())}${q.sub ? ` <span class="text-body-secondary">(${q.sub})</span>` : ''} · <i>${FORMATS[q.format]}</i> <span class="badge rounded-pill diff-${difficulty(q)} ms-1" title="${DIFFICULTIES[difficulty(q)]}">${DIFFICULTY_NAMES[difficulty(q)]}</span>`;
  updateInfo(false);
  updateButtons();
  setTimerDisplay(q.part === 'bonus' ? settings.bonusTime : settings.tossupTime);
  game.nextWordAt = 0;
  $('pause').innerHTML = '<i class="bi bi-pause-fill"></i>';
  const { header, times } = readingTimes(q, game.toks);
  game.readTimes = times;
  const mode = voiceMode();
  if (mode === 'neural') speakNeural();
  else if (mode === 'browser') speakBrowser();
  else {
    // wait while the moderator would be saying "Toss-up 5. Physics, short answer."
    const wait = header * 1000 / speedFactor(settings.readingSpeed);
    game.nextWordAt = performance.now() + wait;
    game.readTimeout = setTimeout(readNext, wait);
  }
}

function readNext () {
  if (game.phase !== 'reading' || game.paused) return;
  if (game.wordIndex >= game.toks.length) return doneReading();
  const i = game.wordIndex;
  game.wordIndex++;
  $('question').innerHTML = renderTokens(game.toks, game.wordIndex);
  // human reading pace; schedule against the ideal timeline so slow frames don't add drift
  const now = performance.now();
  game.nextWordAt = Math.max(game.nextWordAt || now, now - 250) + game.readTimes[i] * 1000 / speedFactor(settings.readingSpeed);
  game.readTimeout = setTimeout(readNext, Math.max(0, game.nextWordAt - now));
}

function stopReading () {
  clearTimeout(game.readTimeout);
  game.speechGen++;
  if (game.voiceSource) { try { game.voiceSource.stop(); } catch (e) {} game.voiceSource = null; }
  if (voiceCtx && voiceCtx.state === 'suspended') voiceCtx.resume();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function doneReading () {
  game.wordIndex = game.toks.length;
  $('question').innerHTML = renderTokens(game.toks, game.wordIndex);
  if (game.kind === 'bonus') {
    // bonuses: no buzz needed, the clock starts right away
    game.phase = 'dead';
    if (settings.typeToAnswer) openAnswer(settings.bonusTime);
    else startTimer(settings.bonusTime, () => openAnswer(0), { warn: true });
  } else {
    game.phase = 'dead';
    startTimer(settings.tossupTime, () => finishUnanswered(false));
  }
  updateButtons();
}

function buzz () {
  if (game.phase !== 'reading' && game.phase !== 'dead') return;
  game.paused = false;
  $('pause').innerHTML = '<i class="bi bi-pause-fill"></i>';
  if (game.kind === 'tossup') {
    game.buzzIndex = game.wordIndex;
    stopReading();
    stopTimer();
    beep();
    // show where you buzzed right away
    $('question').innerHTML = renderTokens(game.toks, game.wordIndex, game.buzzIndex);
    openAnswer(settings.answerTime);
  } else {
    // answering a bonus early: show the rest of it and open the box
    stopReading();
    if (game.phase === 'reading') {
      game.wordIndex = game.toks.length;
      $('question').innerHTML = renderTokens(game.toks, game.wordIndex);
    }
    openAnswer(game.phase === 'dead' ? Math.max(game.timer.left, 1) : settings.bonusTime);
  }
}

function openAnswer (seconds) {
  stopTimer();
  game.phase = 'answering';
  if (settings.typeToAnswer) {
    $('answer-input-group').classList.remove('d-none');
    const input = $('answer-input');
    input.value = '';
    input.placeholder = game.q.format === 'mc' ? 'Enter answer (W, X, Y, Z or the choice)' : 'Enter answer';
    input.focus();
    startTimer(seconds, () => submitAnswer(), { warn: game.kind === 'bonus' });
  } else {
    // self-judged: reveal immediately and ask
    game.phase = 'judging';
    showAnswer(null);
    showJudge();
  }
  updateButtons();
}

function submitAnswer () {
  if (game.phase !== 'answering') return;
  stopTimer();
  const given = $('answer-input').value;
  $('answer-input-group').classList.add('d-none');
  const verdict = checkAnswer(game.q, given);
  if (verdict === null) {
    game.phase = 'judging';
    showAnswer(given, true);
    showJudge();
    updateButtons();
    return;
  }
  score(verdict, given);
}

function showJudge () {
  $('judge-group').classList.remove('d-none');
  $('judge-group').classList.add('d-flex');
  $('judge-correct').focus();
}

function judge (correct) {
  if (game.phase !== 'judging') return;
  $('judge-group').classList.add('d-none');
  $('judge-group').classList.remove('d-flex');
  score(correct, game.lastGiven ?? null);
}

function interrupted () {
  return game.kind === 'tossup' && game.buzzIndex >= 0 && game.buzzIndex < game.toks.length;
}

function applyScore (result, sign) {
  const q = result.q;
  const blank = () => ({ tuSeen: 0, tuCorrect: 0, tuNegs: 0, bSeen: 0, bCorrect: 0 });
  stats.byDiff = stats.byDiff || {};
  const buckets = [
    stats.byCat[q.category] || (stats.byCat[q.category] = blank()),
    stats.byDiff[difficulty(q)] || (stats.byDiff[difficulty(q)] = blank())
  ];
  const add = (key) => buckets.forEach(b => { b[key] += sign; });
  if (q.part === 'tossup') {
    stats.tu.seen += sign; add('tuSeen');
    if (result.correct) {
      stats.tu.correct += sign; add('tuCorrect');
      stats.tu.celerity += sign * result.celerity;
    } else if (result.buzzed) {
      stats.tu.wrong += sign;
      if (result.neg) { stats.tu.negs += sign; add('tuNegs'); }
    }
  } else {
    stats.bonus.seen += sign; add('bSeen');
    if (result.correct) { stats.bonus.correct += sign; add('bCorrect'); }
  }
  stats.tu.points += sign * result.points;
  save('sbr-stats', stats);
}

function pointsFor (result) {
  if (result.correct) return POINTS[result.q.part];
  return result.neg ? -4 : 0;
}

function score (correct, given) {
  const q = game.q;
  const celerity = game.buzzIndex >= 0 ? 1 - game.buzzIndex / Math.max(game.toks.length, 1) : 0;
  const result = { q, correct, buzzed: true, neg: !correct && interrupted(), celerity, given };
  result.points = pointsFor(result);
  applyScore(result, 1);
  game.last = result;
  reveal(result);
}

function finishUnanswered (skipped) {
  // nobody buzzed: timer ran out, or skipped mid-question
  stopTimer();
  stopReading();
  const q = game.q;
  if (skipped) {
    addHistory({ q, correct: null, skipped: true }, renderTokens(game.toks, game.toks.length));
    game.phase = 'idle';
    return;
  }
  const result = { q, correct: false, buzzed: false, neg: false, points: 0, celerity: 0 };
  applyScore(result, 1);
  game.last = result;
  reveal(result);
}

function reveal (result) {
  game.phase = 'revealed';
  stopTimer();
  setTimerDisplay(0);
  recordProgress(result);
  const q = result.q;
  $('question').innerHTML = renderTokens(game.toks, game.toks.length, game.buzzIndex);
  showAnswer(result.given, false, result);
  updateInfo(true);
  $('toggle-correct').classList.toggle('d-none', !result.buzzed);
  $('toggle-correct').textContent = result.correct ? 'I was wrong' : 'I was right';
  // match rules: bonus follows a correct toss-up
  if (settings.questionType === 'match' && q.part === 'tossup' && (result.correct || settings.alwaysBonus)) {
    game.pendingBonus = BY_ID[q.id.replace(/t$/, 'b')] || null;
  } else if (!(settings.questionType === 'match' && q.part === 'tossup')) {
    game.pendingBonus = null;
  }
  addHistory(result, $('question').innerHTML);
  updateStatline();
  updateMatchCount();
  prefetchUpcoming();
  updateButtons();
}

function answerHtml (q) {
  let html = `<span class="answer-label">ANSWER:</span> ${renderRich(q.answer)}`;
  if (q.format === 'mc' && q.choices) {
    const letter = parseAnswer(q.answer).letter;
    if (letter && !q.answer.replace(/^[WXYZ]\)\s*/, '').trim()) html += ' ' + renderRich(q.choices['WXYZ'.indexOf(letter)]);
  }
  return html;
}

function showAnswer (given, pendingJudge, result) {
  const q = game.q;
  let html = answerHtml(q);
  if (given !== null && given !== undefined) {
    game.lastGiven = given;
    const mark = result ? (result.correct ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-x-circle-fill text-danger"></i>') : '';
    html += `<div class="given mt-1">${mark} You said: <b>${escapeHtml(given || '(nothing)')}</b>${result ? ` · ${result.points > 0 ? '+' : ''}${result.points} pts` : ''}${pendingJudge ? ' · <i>can\'t auto-check this one, judge it yourself</i>' : ''}</div>`;
  } else if (result && !result.buzzed) {
    html += `<div class="given mt-1"><i class="bi bi-clock"></i> Time's up</div>`;
  } else if (result) {
    const mark = result.correct ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-x-circle-fill text-danger"></i>';
    html += `<div class="given mt-1">${mark} ${result.points > 0 ? '+' : ''}${result.points} pts</div>`;
  } else {
    game.lastGiven = null;
  }
  $('answer').innerHTML = html;
}

function toggleCorrect (e) {
  e.preventDefault();
  const r = game.last;
  if (!r || !r.buzzed) return;
  applyScore(r, -1);
  r.correct = !r.correct;
  r.neg = !r.correct && r.q.part === 'tossup' && game.buzzIndex >= 0 && game.buzzIndex < game.toks.length;
  r.points = pointsFor(r);
  applyScore(r, 1);
  recordProgress(r);
  updateMatchCount();
  if (settings.questionType === 'match' && r.q.part === 'tossup') {
    game.pendingBonus = (r.correct || settings.alwaysBonus) ? BY_ID[r.q.id.replace(/t$/, 'b')] || null : null;
  }
  showAnswer(r.given ?? null, false, r);
  $('toggle-correct').textContent = r.correct ? 'I was wrong' : 'I was right';
  const first = $('room-history').firstElementChild;
  if (first) first.replaceWith(historyItem(r, renderTokens(game.toks, game.toks.length, game.buzzIndex)));
  updateStatline();
  updateButtons();
}

function togglePause () {
  if (game.phase !== 'reading' && game.phase !== 'dead') return;
  game.paused = !game.paused;
  if (game.phase === 'reading') {
    const mode = voiceMode();
    if (mode === 'neural') {
      if (game.paused) voiceCtx?.suspend(); else voiceCtx?.resume();
    } else if (mode === 'browser') {
      if (game.paused) window.speechSynthesis.pause(); else window.speechSynthesis.resume();
    } else if (!game.paused) readNext();
    else clearTimeout(game.readTimeout);
  }
  $('pause').innerHTML = game.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>';
}

// ---------- timer ----------

function setTimerDisplay (seconds) {
  const tenths = Math.max(0, Math.ceil(seconds * 10 - 1e-6));
  $('timer').querySelector('.face').textContent = Math.floor(tenths / 10);
  $('timer').querySelector('.fraction').textContent = '.' + (tenths % 10);
}

function startTimer (seconds, onEnd, { warn = false } = {}) {
  stopTimer();
  game.timer.left = seconds;
  setTimerDisplay(seconds);
  if (!settings.timer) return; // untimed: wait for the player
  game.timer.clock = countdown({
    seconds,
    isPaused: () => game.paused,
    onTick: left => { game.timer.left = left; setTimerDisplay(left); },
    // NSB bonus: the timekeeper calls "5 SECONDS" after 15 of the 20 seconds
    warnAt: warn ? 5 : null,
    onWarn: () => { $('timer').classList.add('low'); beep(660, 0.12); },
    onEnd: () => { game.timer.clock = null; $('timer').classList.remove('low'); beep(330, 0.35); onEnd(); }
  });
}

function stopTimer () {
  game.timer.clock?.stop();
  game.timer.clock = null;
  $('timer').classList.remove('low');
}

let audioCtx = null;
function beep (freq = 520, length = 0.25) {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + length);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + length);
  } catch (e) {}
}

// ---------- ui ----------

function updateButtons () {
  const p = game.phase;
  $('buzz').disabled = !(p === 'reading' || p === 'dead');
  $('buzz').textContent = game.kind === 'bonus' ? 'Answer' : 'Buzz';
  $('pause').disabled = !(p === 'reading' || p === 'dead');
  $('skip').disabled = !(p === 'reading' || p === 'dead');
  $('next').disabled = p === 'answering' || p === 'judging';
  $('next').textContent = game.pendingBonus && p === 'revealed' ? 'Bonus' : (p === 'idle' ? 'Start' : 'Next');
}

function updateInfo (revealed) {
  const q = game.q;
  if (!q) { $('question-info').textContent = ''; return; }
  const show = settings.showSetName || revealed;
  const src = SOURCES[`${q.set}-${q.round}`];
  let packetPos = '';
  if (settings.mode === 'packet') {
    const n = ALL.filter(x => x.set === q.set && x.round === q.round && x.part === q.part).length;
    packetPos = ` of ${n}`;
  }
  $('question-info').innerHTML = show
    ? `Set ${q.set} · Round ${escapeHtml(q.round)} · ${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${q.num}${packetPos}${src && revealed ? ` · <a href="${src}" target="_blank" rel="noopener">PDF <i class="bi bi-box-arrow-up-right"></i></a>` : ''}`
    : `${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${q.num}${packetPos}`;
}

function updateStatline () {
  const t = stats.tu; const b = stats.bonus;
  const cel = t.correct ? (t.celerity / t.correct).toFixed(3) : '0';
  $('statline').innerHTML = `${t.correct}/${t.wrong}/${t.negs} with ${t.seen} toss-ups seen · bonuses ${b.correct}/${b.seen} (${t.points} pts, celerity: ${cel})`;
  $('statline').title = 'correct / wrong / interrupts (−4)';
}

function historyItem (result, questionHtml) {
  const q = result.q;
  const li = document.createElement('li');
  const id = 'h' + Math.random().toString(36).slice(2);
  const icon = result.skipped ? '<i class="bi bi-skip-forward text-body-secondary"></i>'
    : result.correct ? '<i class="bi bi-check-circle-fill text-success"></i>'
      : result.buzzed ? '<i class="bi bi-x-circle-fill text-danger"></i>' : '<i class="bi bi-clock text-body-secondary"></i>';
  const pts = result.points ? ` <span class="badge text-bg-${result.points > 0 ? 'success' : 'danger'}">${result.points > 0 ? '+' : ''}${result.points}</span>` : '';
  const src = SOURCES[`${q.set}-${q.round}`];
  li.innerHTML = `<div class="card">
    <div class="card-header" data-bs-toggle="collapse" data-bs-target="#${id}">${icon} <b>${q.part === 'tossup' ? 'TU' : 'B'}</b> ${escapeHtml(q.category)} · Set ${q.set} R${escapeHtml(q.round)} #${q.num}${pts}
      <span class="text-body-secondary d-none d-md-inline">— ${escapeHtml(stripLatex(parseAnswer(q.answer).main || q.answer).slice(0, 60))}</span></div>
    <div class="collapse" id="${id}"><div class="card-body">
      <div>${questionHtml}</div>
      <div class="mt-2">${answerHtml(q)}</div>
      ${result.given ? `<div class="text-body-secondary mt-1">You said: ${escapeHtml(result.given)}</div>` : ''}
      ${src ? `<a class="small" href="${src}" target="_blank" rel="noopener">Source PDF</a>` : ''}
    </div></div></div>`;
  return li;
}

function addHistory (result, questionHtml) {
  const list = $('room-history');
  list.prepend(historyItem(result, questionHtml));
  while (list.children.length > 100) list.lastElementChild.remove();
}

function renderStatsModal () {
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
  const row = (label, s = {}) => {
    s = { tuSeen: 0, tuCorrect: 0, tuNegs: 0, bSeen: 0, bCorrect: 0, ...s };
    return `<tr><td>${label}</td><td>${s.tuSeen}</td><td>${s.tuCorrect}</td><td>${s.tuNegs}</td><td>${pct(s.tuCorrect, s.tuSeen)}</td><td>${s.bSeen}</td><td>${s.bCorrect}</td><td>${pct(s.bCorrect, s.bSeen)}</td></tr>`;
  };
  const head = first => `<thead><tr><th>${first}</th><th>TU seen</th><th>TU correct</th><th>Interrupts</th><th>TU %</th><th>Bonus seen</th><th>Bonus correct</th><th>Bonus %</th></tr></thead>`;
  const byDiff = stats.byDiff || {};
  $('stats-body').innerHTML = `<table class="table table-sm stats-table">${head('Subject')}
    <tbody>${CATEGORIES.map(c => row(c, stats.byCat[c])).join('')}</tbody></table>
    <table class="table table-sm stats-table">${head('Difficulty')}
    <tbody>${Object.keys(DIFFICULTIES).map(d => row(`${DIFFICULTY_NAMES[d]} <span class="text-body-secondary small">(${DIFFICULTIES[d]})</span>`, byDiff[d])).join('')}</tbody></table>
    <p class="small text-body-secondary mb-0">Toss-ups +4, bonuses +10, wrong interrupt −4 (NSB scoring). ${progress.seen.length.toLocaleString()} questions seen, ${progress.missed.length.toLocaleString()} in your review list.</p>`;
}

function applyTheme () {
  let t = settings.theme;
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', t);
  $('theme-toggle').innerHTML = settings.theme === 'auto' ? '<i class="bi bi-circle-half"></i>'
    : settings.theme === 'dark' ? '<i class="bi bi-moon-stars-fill"></i>' : '<i class="bi bi-sun-fill"></i>';
  $('theme-toggle').title = `Theme: ${settings.theme}`;
}

function settingsChanged (rebuild = true) {
  save('sbr-settings', settings);
  if (rebuild) buildQueue();
}

function initSettingsUi () {
  const setNums = [...new Set(ALL.map(q => q.set))].sort((a, b) => a - b);

  // sets dropdown (random mode)
  const menu = $('sets-menu');
  const updateSetsLabel = () => {
    const n = settings.sets ? settings.sets.length : setNums.length;
    $('sets-button').textContent = n === setNums.length ? 'All sets (1–17)' : `${n} set${n === 1 ? '' : 's'} selected`;
  };
  menu.innerHTML = `<div class="d-flex gap-1 mb-1"><button class="btn btn-sm btn-outline-secondary" data-all="1" type="button">All</button><button class="btn btn-sm btn-outline-secondary" data-all="0" type="button">None</button></div>` +
    setNums.map(s => `<div class="form-check"><input class="form-check-input" type="checkbox" id="set-${s}" value="${s}"><label class="form-check-label" for="set-${s}">Set ${s} <span class="text-body-secondary small">(${ALL.filter(q => q.set === s && q.part === 'tossup').length} TU)</span></label></div>`).join('');
  const syncSetChecks = () => menu.querySelectorAll('input').forEach(i => { i.checked = !settings.sets || settings.sets.includes(+i.value); });
  syncSetChecks(); updateSetsLabel();
  menu.addEventListener('change', () => {
    const chosen = [...menu.querySelectorAll('input:checked')].map(i => +i.value);
    settings.sets = chosen.length === setNums.length ? null : chosen;
    updateSetsLabel(); settingsChanged();
  });
  menu.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => {
    settings.sets = b.dataset.all === '1' ? null : [];
    syncSetChecks(); updateSetsLabel(); settingsChanged();
  }));

  // packet mode pickers
  const fillRounds = () => {
    const rounds = [...new Set(ALL.filter(q => q.set === +settings.packetSet).map(q => q.round))].sort((a, b) => roundOrder(a) - roundOrder(b));
    if (!rounds.includes(settings.packetRound)) settings.packetRound = rounds[0];
    $('packet-round').replaceChildren(...rounds.map(r => new Option(`Round ${r}`, r, false, r === settings.packetRound)));
  };
  $('packet-set').replaceChildren(...setNums.map(s => new Option(`Set ${s}`, s, false, s === +settings.packetSet)));
  fillRounds();
  $('packet-set').addEventListener('change', e => { settings.packetSet = +e.target.value; fillRounds(); settingsChanged(); });
  $('packet-round').addEventListener('change', e => { settings.packetRound = e.target.value; settingsChanged(); });

  const syncMode = () => {
    $('packet-settings').classList.toggle('d-none', settings.mode !== 'packet');
    $('random-settings').classList.toggle('d-none', settings.mode === 'packet');
    $('filter-settings').classList.toggle('d-none', settings.mode === 'packet');
  };
  $('set-mode').value = settings.mode;
  syncMode();
  $('set-mode').addEventListener('change', e => { settings.mode = e.target.value; syncMode(); settingsChanged(); });
  $('question-type').value = settings.questionType;
  $('question-type').addEventListener('change', e => { settings.questionType = e.target.value; settingsChanged(); });

  // category + format toggles
  const toggles = (container, items, key) => {
    $(container).innerHTML = items.map(([val, label]) =>
      `<input type="checkbox" class="btn-check" id="${key}-${val.replace(/\W/g, '')}" value="${val}" autocomplete="off"${settings[key].includes(val) ? ' checked' : ''}>` +
      `<label class="btn btn-outline-primary" for="${key}-${val.replace(/\W/g, '')}">${label}</label>`).join('');
    $(container).addEventListener('change', () => {
      settings[key] = [...$(container).querySelectorAll('input:checked')].map(i => i.value);
      settingsChanged();
    });
  };
  toggles('category-buttons', CATEGORIES.map(c => [c, c === 'Earth and Space' ? 'Earth & Space' : c]), 'categories');
  toggles('format-buttons', Object.entries(FORMATS), 'formats');
  toggles('difficulty-buttons', Object.entries(DIFFICULTIES), 'difficulties');
  $('difficulty-buttons').querySelectorAll('label').forEach(l => { l.title = DIFFICULTY_NAMES[l.previousElementSibling.value]; });
  $('pool').value = settings.pool;
  $('pool').addEventListener('change', e => { settings.pool = e.target.value; settingsChanged(); });

  // switches
  const sw = (id, key, rebuild = false, after) => {
    $(id).checked = settings[key];
    $(id).addEventListener('change', e => { settings[key] = e.target.checked; settingsChanged(rebuild); after && after(); });
  };
  sw('type-to-answer', 'typeToAnswer');
  sw('always-bonus', 'alwaysBonus');
  sw('show-history', 'showHistory', false, () => $('room-history').classList.toggle('d-none', !settings.showHistory));
  $('room-history').classList.toggle('d-none', !settings.showHistory);
  sw('show-set-name', 'showSetName', false, () => updateInfo(game.phase === 'revealed'));
  sw('enable-timer', 'timer');
  sw('sound', 'sound');
  sw('shuffle-round', 'shuffleRound', true);
  // read aloud
  if (settings.tts) { settings.voiceMode = 'browser'; delete settings.tts; } // old setting
  $('neural-voice').replaceChildren(...NEURAL_VOICES.map(([id, name]) => new Option(name, id, false, id === settings.neuralVoice)));
  const syncVoice = () => {
    $('voice').classList.toggle('d-none', settings.voiceMode !== 'browser');
    $('neural-voice').classList.toggle('d-none', settings.voiceMode !== 'neural');
    $('voice-status').classList.toggle('d-none', settings.voiceMode !== 'neural');
    if (settings.voiceMode === 'neural') neural.load().catch(() => {});
  };
  $('voice-mode').value = settings.voiceMode;
  $('voice-mode').addEventListener('change', e => { settings.voiceMode = e.target.value; syncVoice(); settingsChanged(false); });
  $('neural-voice').addEventListener('change', e => { settings.neuralVoice = e.target.value; settingsChanged(false); });
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  $('voice').addEventListener('change', e => { settings.voice = e.target.value; settingsChanged(false); });
  syncVoice();

  $('reading-speed').value = settings.readingSpeed;
  const speedLabel = () => {
    const f = speedFactor(settings.readingSpeed);
    $('reading-speed-display').textContent = `${f.toFixed(2)}×`;
    $('wpm-display').textContent = `(~${Math.round(naturalWpm() * f)} wpm${settings.readingSpeed === 50 ? ', natural' : ''})`;
  };
  speedLabel();
  $('reading-speed').addEventListener('input', e => {
    settings.readingSpeed = +e.target.value;
    speedLabel();
    settingsChanged(false);
  });
  for (const [id, key] of [['tossup-time', 'tossupTime'], ['bonus-time', 'bonusTime'], ['answer-time', 'answerTime']]) {
    $(id).value = settings[key];
    $(id).addEventListener('change', e => { const v = +e.target.value; if (v > 0) { settings[key] = v; settingsChanged(false); } });
  }

  $('clear-stats').addEventListener('click', () => {
    if (!window.confirm('Clear all stats, including which questions you have seen and missed?')) return;
    stats = emptyStats(); save('sbr-stats', stats);
    progress = { seen: [], missed: [] }; save('sbr-progress', progress);
    updateStatline(); updateMatchCount();
  });
  $('stats-modal').addEventListener('show.bs.modal', renderStatsModal);
  $('theme-toggle').addEventListener('click', () => {
    settings.theme = { auto: 'light', light: 'dark', dark: 'auto' }[settings.theme] || 'auto';
    applyTheme(); settingsChanged(false);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function initControls () {
  $('next').addEventListener('click', next);
  $('skip').addEventListener('click', next);
  $('buzz').addEventListener('click', buzz);
  $('pause').addEventListener('click', togglePause);
  $('toggle-settings').addEventListener('click', toggleSettings);
  $('answer-form').addEventListener('submit', e => { e.preventDefault(); submitAnswer(); });
  $('judge-correct').addEventListener('click', () => judge(true));
  $('judge-wrong').addEventListener('click', () => judge(false));
  $('toggle-correct').addEventListener('click', toggleCorrect);

  // clicked controls keep focus; drop it so space/keys go to the game, not the control
  document.addEventListener('click', e => {
    const el = e.target.closest('button, input[type=checkbox], input[type=range], summary, a');
    if (el && !el.closest('.modal, .dropdown-menu')) setTimeout(() => el.blur(), 0);
  });

  const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(el.type)));

  // capture phase so a focused button/switch never also reacts to the key
  document.addEventListener('keydown', e => {
    if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal.show')) return;
    const key = e.key.toLowerCase();
    if (game.phase === 'judging' && (key === 'c' || key === 'w')) {
      e.preventDefault();
      judge(key === 'c');
      return;
    }
    switch (key) {
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        document.activeElement?.blur?.();
        if (e.repeat) return;
        buzz();
        break;
      case 'n': e.preventDefault(); if (!$('next').disabled) next(); break;
      case 's': if (!$('skip').disabled) next(); break;
      case 'p': togglePause(); break;
      case 'e': toggleSettings(); break;
    }
  }, true);
  // a focused button would still "click" on space keyup
  document.addEventListener('keyup', e => {
    if (e.key === ' ' && !typing(document.activeElement)) e.preventDefault();
  }, true);
}

function toggleSettings () {
  const s = $('settings');
  const hidden = s.classList.toggle('d-none');
  $('content').classList.toggle('col-lg-9', !hidden);
  $('content').classList.toggle('col-lg-12', hidden);
  $('buttons').classList.toggle('col-lg-9', !hidden);
  $('buttons').classList.toggle('col-lg-12', hidden);
}

async function main () {
  applyTheme();
  $('question').innerHTML = '<span class="text-body-secondary">Loading questions…</span>';
  try {
    [ALL, SOURCES] = await Promise.all([
      fetch('data/questions.json').then(r => r.json()),
      fetch('data/sources.json').then(r => r.json())
    ]);
  } catch (e) {
    $('question').innerHTML = '<span class="text-danger">Could not load data/questions.json. If you opened index.html directly from disk, serve the folder instead (for example <code>python3 -m http.server</code>).</span>';
    return;
  }
  BY_ID = Object.fromEntries(ALL.map(q => [q.id, q]));
  $('question-count').textContent = `${ALL.length.toLocaleString()} NSB high school questions`;
  initSettingsUi();
  initControls();
  buildQueue();
  updateStatline();
  updateButtons();
  $('question').innerHTML = '<span class="text-body-secondary">Press <kbd>n</kbd> or <b>Start</b> to begin. <kbd>space</kbd> buzzes, type your answer and hit <kbd>enter</kbd>.</span>';
}

// handle for poking at state from the browser console
window.sbrDebug = { game, neural, settings, get voiceCtx () { return voiceCtx; } };

main();
