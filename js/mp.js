// Multiplayer rooms on Firebase Realtime Database.
//
// There's no game server: every client runs the same rules against the shared room
// state, and every change to that state goes through a transaction, so Firebase decides
// races (two people buzzing at once, two people pressing Next) and exactly one wins.
// Reading is a shared timeline: the room stores when reading (re)started in server time
// and how far it had got, and each client reveals words from that with the same
// human-paced schedule as solo mode.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { browserSessionPersistence, connectAuthEmulator, initializeAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  connectDatabaseEmulator, get, getDatabase, limitToLast, onChildAdded, onDisconnect, onValue, push, query, ref,
  runTransaction, serverTimestamp, set, update
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js?v=202609262104';
import { checkAnswer, parseAnswer } from './check.js?v=202609262104';
import { readingTimes, speedFactor } from './voice.js?v=202609262104';
import { escapeHtml, renderRich, renderTokens, tokenize } from './render.js?v=202609262104';
import { CATEGORIES, DIFFICULTIES, DIFFICULTY_NAMES, FORMATS, POINTS, difficulty } from './common.js?v=202609262104';

const TOSSUP_TIME = 5; // NSB: 5 s to buzz after reading, 20 s for a bonus
const BONUS_TIME = 20;
const ANSWER_TIME = 10; // typing allowance after a buzz
const GRACE = 2000; // ms before other players resolve a buzzer who went silent

const $ = id => document.getElementById(id);
const EMULATOR = new URLSearchParams(location.search).has('emulator');

let db, auth;
let me = { uid: null, name: '' };
let ALL = []; let BY_ID = {};
let serverOffset = 0;
const now = () => Date.now() + serverOffset;

let code = null; // current room
const roomData = { meta: null, settings: null, state: null, players: {} };
let unsubs = [];
let judging = null; // { given } while the buzzer marks themselves on an uncheckable answer
let lastBuzzSeen = null;

// ---------- setup ----------

async function main () {
  try {
    ALL = await fetch('data/questions.json?v=202609262104').then(r => r.json());
  } catch (e) {
    $('conn-status').textContent = 'Could not load questions.';
    return;
  }
  BY_ID = Object.fromEntries(ALL.map(q => [q.id, q]));
  const config = EMULATOR
    ? { apiKey: 'demo-key', projectId: 'demo-sbr', databaseURL: `http://127.0.0.1:9000?ns=demo-sbr` }
    : firebaseConfig;
  if (!config) { $('setup-needed').classList.remove('d-none'); return; }
  const app = initializeApp(config);
  // one player per tab (kept across a refresh of that tab)
  auth = initializeAuth(app, { persistence: browserSessionPersistence });
  db = getDatabase(app);
  if (EMULATOR) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectDatabaseEmulator(db, '127.0.0.1', 9000);
  }
  onValue(ref(db, '.info/serverTimeOffset'), s => { serverOffset = s.val() || 0; });
  onValue(ref(db, '.info/connected'), s => { $('conn-status').textContent = s.val() ? '' : 'Reconnecting…'; });
  $('conn-status').textContent = 'Connecting…';
  onAuthStateChanged(auth, user => {
    if (!user) return;
    me.uid = user.uid;
    $('conn-status').textContent = '';
    initLobby();
    const hash = location.hash.slice(1).toUpperCase();
    if (/^[A-Z]{5}$/.test(hash)) joinRoom(hash);
    else showLobby();
  });
  await signInAnonymously(auth);
  setInterval(tick, 50);
  initControls();
}

// ---------- lobby ----------

function initLobby () {
  const saved = localStorage.getItem('sbr-name');
  me.name = saved || `Player ${Math.floor(Math.random() * 900 + 100)}`;
  $('username').value = me.name;
  $('username').addEventListener('change', e => {
    me.name = e.target.value.trim().slice(0, 24) || me.name;
    try { localStorage.setItem('sbr-name', me.name); } catch (err) {}
    if (code) update(ref(db, `rooms/${code}/players/${me.uid}`), { name: me.name });
  });
  onValue(ref(db, 'lobby'), snap => {
    const rooms = Object.entries(snap.val() || {})
      .map(([c, r]) => ({ code: c, ...r, count: Object.keys(r.present || {}).length }))
      .filter(r => r.public && r.count > 0)
      .sort((a, b) => b.count - a.count);
    $('room-list').innerHTML = rooms.length
      ? rooms.map(r => `<button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" data-code="${r.code}">
          <span><b>${escapeHtml(r.name || r.code)}</b> <span class="text-body-secondary small">${r.code}</span></span>
          <span class="badge text-bg-primary rounded-pill">${r.count} ${r.count === 1 ? 'player' : 'players'}</span></button>`).join('')
      : '<div class="text-body-secondary">No public rooms right now. Create one!</div>';
  });
  $('room-list').addEventListener('click', e => {
    const b = e.target.closest('[data-code]');
    if (b) joinRoom(b.dataset.code);
  });
  $('create-room').addEventListener('click', createRoom);
  $('join-room').addEventListener('click', () => joinRoom($('join-code').value.trim().toUpperCase()));
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-room').click(); });
}

function showLobby () {
  $('lobby').classList.remove('d-none');
  $('room').classList.add('d-none');
  $('mp-button-bar').classList.add('d-none');
}

function newCode () {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O
  return Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

async function createRoom () {
  let c = newCode();
  while ((await get(ref(db, `rooms/${c}/meta`))).exists()) c = newCode();
  const name = $('new-room-name').value.trim().slice(0, 40) || `${me.name}'s room`;
  const isPublic = $('new-room-public').checked;
  await set(ref(db, `rooms/${c}`), {
    meta: { name, public: isPublic, created: serverTimestamp() },
    settings: {
      questionType: 'match', categories: CATEGORIES, formats: Object.keys(FORMATS),
      difficulties: Object.keys(DIFFICULTIES), readingSpeed: 50, seed: Math.floor(Math.random() * 2 ** 31)
    },
    state: { n: -1, phase: 'idle' }
  });
  await set(ref(db, `lobby/${c}`), { name, public: isPublic });
  joinRoom(c);
}

// ---------- joining a room ----------

async function joinRoom (c) {
  if (!/^[A-Z]{5}$/.test(c)) return;
  const meta = await get(ref(db, `rooms/${c}/meta`));
  if (!meta.exists()) { alert(`No room with code ${c}.`); showLobby(); return; }
  if (code) leaveRoom(false);
  code = c;
  location.hash = c;
  const playerRef = ref(db, `rooms/${c}/players/${me.uid}`);
  const existing = (await get(playerRef)).val() || {};
  await update(playerRef, { name: me.name, online: true, score: existing.score || 0, tu: existing.tu || 0, negs: existing.negs || 0, bonus: existing.bonus || 0 });
  onDisconnect(ref(db, `rooms/${c}/players/${me.uid}/online`)).set(false);
  const presentRef = ref(db, `lobby/${c}/present/${me.uid}`);
  await set(presentRef, true);
  onDisconnect(presentRef).remove();
  logEvent(`${me.name} joined`);

  $('lobby').classList.add('d-none');
  $('room').classList.remove('d-none');
  $('mp-button-bar').classList.remove('d-none');
  $('mp-log').innerHTML = '';
  unsubs = [
    onValue(ref(db, `rooms/${c}/meta`), s => { roomData.meta = s.val(); drawRoomHeader(); }),
    onValue(ref(db, `rooms/${c}/settings`), s => { roomData.settings = s.val(); drawSettings(); }),
    onValue(ref(db, `rooms/${c}/players`), s => { roomData.players = s.val() || {}; drawPlayers(); }),
    onValue(ref(db, `rooms/${c}/state`), s => { roomData.state = s.val(); onState(); }),
    onChildAdded(query(ref(db, `rooms/${c}/chat`), limitToLast(60)), s => addLogLine(s.val()))
  ];
}

function leaveRoom (toLobby = true) {
  if (!code) return;
  unsubs.forEach(u => u());
  unsubs = [];
  update(ref(db, `rooms/${code}/players/${me.uid}`), { online: false });
  set(ref(db, `lobby/${code}/present/${me.uid}`), null);
  logEvent(`${me.name} left`);
  code = null;
  history.replaceState(null, '', location.pathname + location.search);
  if (toLobby) showLobby();
}

// ---------- questions & reading timeline ----------

function seeded (seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// the room's question order: same filters + same seed = same order on every client
function roomQueue (st) {
  const list = ALL.filter(q => q.part === 'tossup' &&
    st.categories.includes(q.category) && st.formats.includes(q.format) && st.difficulties.includes(difficulty(q)));
  const rnd = seeded(st.seed);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

const schedules = {};
function schedule (qid) {
  if (!schedules[qid]) {
    const q = BY_ID[qid]; const toks = tokenize(q);
    const { header, times } = readingTimes(q, toks);
    const starts = []; let t = header;
    for (const x of times) { starts.push(t); t += x; }
    schedules[qid] = { q, toks, starts, total: t };
  }
  return schedules[qid];
}
const factor = () => speedFactor(roomData.settings?.readingSpeed ?? 50);
// ms of reading time for the whole question at the room's speed
const totalMs = qid => schedule(qid).total * 1000 / factor();
function wordsAt (qid, elapsedMs) {
  const { starts } = schedule(qid); const t = elapsedMs / 1000 * factor();
  let k = 0;
  while (k < starts.length && starts[k] <= t) k++;
  return k;
}
function readElapsed (st) {
  if (st.phase === 'reading') return Math.min(st.readElapsed + (now() - st.readStart), totalMs(st.qid));
  return st.readElapsed;
}

// ---------- actions (all transactions on the shared state) ----------

const stateRef = () => ref(db, `rooms/${code}/state`);
const onlineUids = () => Object.entries(roomData.players).filter(([, p]) => p.online).map(([u]) => u);

function nextQuestion () {
  const settings = roomData.settings;
  if (!settings) return;
  const queue = roomQueue(settings);
  if (!queue.length) { flash('No questions match the room settings.'); return; }
  let skipped = null;
  runTransaction(stateRef(), st => {
    if (!st) return st;
    if (st.phase === 'buzzed') return; // someone is answering
    skipped = (st.phase === 'reading' || st.phase === 'dead') ? st.qid : null;
    const base = { phase: 'reading', readStart: now(), readElapsed: 0, buzz: null, lockout: null, attempts: null, deadStart: null, answerDeadline: null, result: null, pendingBonus: null };
    if (st.phase === 'revealed' && st.pendingBonus && BY_ID[st.qid.replace(/t$/, 'b')]) {
      return { ...st, ...base, qid: st.qid.replace(/t$/, 'b'), part: 'bonus', bonusFor: st.pendingBonus, bonusName: st.pendingName };
    }
    const n = (st.n ?? -1) + 1;
    return { ...st, ...base, n, qid: queue[n % queue.length].id, part: 'tossup', bonusFor: null, bonusName: null };
  }).then(r => { if (r.committed && skipped) logEvent(`${me.name} skipped`); });
}

function buzz () {
  const st = roomData.state;
  if (!st || !['reading', 'dead'].includes(st.phase)) return;
  if (st.part === 'bonus' && st.bonusFor !== me.uid) return;
  if (st.lockout && st.lockout[me.uid]) return;
  runTransaction(stateRef(), cur => {
    if (!cur) return cur;
    if (!['reading', 'dead'].includes(cur.phase) || (cur.lockout && cur.lockout[me.uid])) return;
    if (cur.part === 'bonus' && cur.bonusFor !== me.uid) return;
    const el = readElapsed(cur); const total = totalMs(cur.qid);
    const limit = cur.part === 'bonus' ? BONUS_TIME : ANSWER_TIME;
    // bonus: the clock keeps its remaining time; toss-up: the answer allowance
    const deadline = cur.part === 'bonus' && cur.phase === 'dead' ? cur.deadStart + BONUS_TIME * 1000 : now() + limit * 1000;
    return {
      ...cur,
      phase: 'buzzed',
      prevPhase: cur.phase,
      readElapsed: el,
      buzz: { uid: me.uid, name: me.name, word: wordsAt(cur.qid, el), interrupt: cur.part === 'tossup' && cur.phase === 'reading' && el < total, at: now() },
      answerDeadline: deadline,
      lockout: { ...(cur.lockout || {}), [me.uid]: true }
    };
  }).then(r => {
    if (r.committed) {
      beep();
      if (r.snapshot.val().part === 'tossup') logEvent(`${me.name} buzzed`);
    }
  });
}

function submitAnswer (given) {
  const st = roomData.state;
  if (!st || st.phase !== 'buzzed' || st.buzz.uid !== me.uid) return;
  $('mp-answer-group').classList.add('d-none');
  const verdict = checkAnswer(BY_ID[st.qid], given);
  if (verdict === null) {
    judging = { given };
    $('mp-judge-group').classList.remove('d-none');
    $('mp-judge-group').classList.add('d-flex');
    return;
  }
  resolveBuzz(me.uid, verdict, given);
}

function judge (correct) {
  if (!judging) return;
  const { given } = judging;
  judging = null;
  $('mp-judge-group').classList.add('d-none');
  $('mp-judge-group').classList.remove('d-flex');
  resolveBuzz(me.uid, correct, given);
}

// finish a buzz: by the buzzer with their answer, or by anyone once the buzzer has gone quiet
function resolveBuzz (uid, correct, given, timedOut = false) {
  let outcome = null;
  runTransaction(stateRef(), cur => {
    if (!cur || cur.phase !== 'buzzed' || !cur.buzz || cur.buzz.uid !== uid) return;
    if (timedOut && now() < cur.answerDeadline + GRACE) return;
    const b = cur.buzz;
    const bonus = cur.part === 'bonus';
    const points = correct ? POINTS[cur.part] : (!bonus && b.interrupt ? -4 : 0);
    const attempt = { name: b.name, given: given || '', correct, points, word: b.word, interrupt: !!b.interrupt };
    const attempts = { ...(cur.attempts || {}), [uid]: attempt };
    outcome = { points, bonus, correct, name: b.name, given, interrupt: !!b.interrupt };
    if (correct || bonus) {
      return {
        ...cur, phase: 'revealed', attempts, answerDeadline: null,
        result: { correct, name: b.name, uid },
        pendingBonus: !bonus && correct && roomData.settings.questionType === 'match' ? uid : null,
        pendingName: b.name
      };
    }
    // wrong toss-up answer: everyone else keeps going
    const everyoneOut = onlineUids().every(u => (cur.lockout || {})[u]);
    if (everyoneOut) return { ...cur, phase: 'revealed', attempts, answerDeadline: null, result: { correct: false } };
    if (cur.prevPhase === 'reading' && cur.readElapsed < totalMs(cur.qid)) {
      return { ...cur, phase: 'reading', readStart: now(), attempts, answerDeadline: null, buzz: null };
    }
    // NSB rule 3-8: the others get another 5 seconds after a wrong answer
    return { ...cur, phase: 'dead', deadStart: now(), attempts, answerDeadline: null, buzz: null };
  }).then(r => {
    if (!r.committed || !outcome) return;
    const o = outcome;
    const said = o.given ? `"${o.given}"` : '(no answer)';
    logEvent(`${o.name}: ${said} ${o.correct ? 'correct' : 'incorrect'}${o.points ? ` (${o.points > 0 ? '+' : ''}${o.points}${o.interrupt && !o.correct ? ', interrupt' : ''})` : ''}`);
    runTransaction(ref(db, `rooms/${code}/players/${uid}`), p => {
      if (!p) return p;
      p.score = (p.score || 0) + o.points;
      if (!o.bonus && o.correct) p.tu = (p.tu || 0) + 1;
      if (!o.bonus && o.points < 0) p.negs = (p.negs || 0) + 1;
      if (o.bonus && o.correct) p.bonus = (p.bonus || 0) + 1;
      return p;
    });
  });
}

// ---------- the clock: every client runs it, transactions keep it to one outcome ----------

function tick () {
  const st = roomData.state;
  if (!code || !st || !st.qid) { drawTimer(null); return; }
  if (st.phase === 'reading') {
    const el = readElapsed(st);
    drawQuestion();
    if (el >= totalMs(st.qid)) {
      // reading finished at an exact moment in server time; start the buzz clock from it
      runTransaction(stateRef(), cur => {
        if (!cur || cur.phase !== 'reading' || cur.qid !== st.qid) return;
        const end = cur.readStart + (totalMs(cur.qid) - cur.readElapsed);
        return { ...cur, phase: 'dead', readElapsed: totalMs(cur.qid), deadStart: end };
      });
    }
    drawTimer(st.part === 'bonus' ? BONUS_TIME : TOSSUP_TIME);
  } else if (st.phase === 'dead') {
    const limit = (st.part === 'bonus' ? BONUS_TIME : TOSSUP_TIME) * 1000;
    const left = st.deadStart + limit - now();
    drawTimer(Math.max(0, left) / 1000, st.part === 'bonus' && left <= 5000);
    if (left <= 0) {
      runTransaction(stateRef(), cur => {
        if (!cur || cur.phase !== 'dead' || cur.qid !== st.qid || now() < cur.deadStart + limit) return;
        return { ...cur, phase: 'revealed', result: { correct: false, timeout: true } };
      }).then(r => { if (r.committed) logEvent('Time'); });
    }
  } else if (st.phase === 'buzzed') {
    const left = st.answerDeadline - now();
    drawTimer(Math.max(0, left) / 1000, left <= 3000);
    if (st.buzz.uid === me.uid && left <= 0 && !judging) submitAnswer($('mp-answer-input').value);
    if (left < -GRACE) resolveBuzz(st.buzz.uid, false, '', true); // buzzer disconnected or froze
  } else {
    drawTimer(0);
  }
}

// ---------- drawing ----------

function onState () {
  const st = roomData.state;
  const mine = st && st.phase === 'buzzed' && st.buzz && st.buzz.uid === me.uid;
  if (st && st.phase === 'buzzed' && st.buzz && lastBuzzSeen !== st.buzz.at) {
    lastBuzzSeen = st.buzz.at;
    if (!mine) beep();
  }
  const group = $('mp-answer-group');
  if (mine && !judging) {
    if (group.classList.contains('d-none')) {
      group.classList.remove('d-none');
      $('mp-answer-input').value = '';
      $('mp-answer-input').focus();
    }
  } else {
    group.classList.add('d-none');
  }
  if (!mine && judging) { judging = null; $('mp-judge-group').classList.add('d-none'); }
  // the bonus winner's answer box opens as soon as the bonus has been read
  if (st && st.part === 'bonus' && st.phase === 'dead' && st.bonusFor === me.uid && !(st.lockout && st.lockout[me.uid])) buzz();
  drawQuestion();
  drawPlayers();
  const canBuzz = st && ['reading', 'dead'].includes(st.phase) && !(st.lockout && st.lockout[me.uid]) &&
    (st.part !== 'bonus' || st.bonusFor === me.uid);
  $('mp-buzz').disabled = !canBuzz;
  $('mp-buzz').textContent = st && st.part === 'bonus' ? 'Answer' : 'Buzz';
  $('mp-next').disabled = !st || st.phase === 'buzzed';
  $('mp-next').textContent = !st || st.phase === 'idle' ? 'Start' : st.phase === 'revealed' && st.pendingBonus ? 'Bonus' : st.phase === 'revealed' ? 'Next' : 'Skip';
}

function drawQuestion () {
  const st = roomData.state;
  if (!st || !st.qid) {
    $('mp-status').textContent = '';
    $('mp-category-line').innerHTML = '';
    $('mp-question-info').innerHTML = '';
    $('mp-answer').innerHTML = '';
    $('mp-question').innerHTML = '<span class="text-body-secondary">Press <kbd>n</kbd> or <b>Start</b> when everyone is here. <kbd>space</kbd> buzzes.</span>';
    return;
  }
  const { q, toks } = schedule(st.qid);
  $('mp-category-line').innerHTML = `<span class="part">${q.part === 'tossup' ? 'TOSS-UP' : 'BONUS'}</span> · ${escapeHtml(q.category.toUpperCase())} · <i>${FORMATS[q.format]}</i> <span class="badge rounded-pill diff-${difficulty(q)} ms-1">${DIFFICULTY_NAMES[difficulty(q)]}</span>`;
  $('mp-question-info').innerHTML = st.phase === 'revealed'
    ? `<b>Set ${q.set} · Round ${escapeHtml(q.round)} · ${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${q.num}</b>`
    : `<b>${q.part === 'tossup' ? 'Toss-up' : 'Bonus'} ${(st.n ?? 0) + 1}</b>`;
  const shown = st.phase === 'reading' ? wordsAt(st.qid, readElapsed(st))
    : st.phase === 'buzzed' ? (st.buzz ? st.buzz.word : 0) : toks.length;
  const buzzAt = st.phase === 'buzzed' && st.buzz && st.buzz.interrupt ? st.buzz.word : -1;
  $('mp-question').innerHTML = renderTokens(toks, Math.min(shown, toks.length), buzzAt);

  let status = '';
  if (st.part === 'bonus') status = st.bonusFor === me.uid ? 'Your bonus' : `Bonus for ${escapeHtml(st.bonusName || 'the toss-up winner')}`;
  if (st.phase === 'buzzed') status = st.buzz.uid === me.uid ? 'You buzzed, answer!' : `${escapeHtml(st.buzz.name)} is answering…`;
  $('mp-status').innerHTML = status;

  if (st.phase === 'revealed') {
    const attempts = Object.values(st.attempts || {});
    $('mp-answer').innerHTML = `<span class="answer-label">ANSWER:</span> ${renderRich(q.answer)}` +
      (attempts.length ? `<div class="given mt-1">${attempts.map(a =>
        `${a.correct ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-x-circle-fill text-danger"></i>'} ${escapeHtml(a.name)}: <b>${escapeHtml(a.given || '(no answer)')}</b>${a.points ? ` · ${a.points > 0 ? '+' : ''}${a.points}${a.interrupt && !a.correct ? ' (interrupt)' : ''}` : ''}`).join('<br>')}</div>` : '') +
      (st.result && st.result.timeout ? '<div class="given mt-1"><i class="bi bi-clock"></i> Time</div>' : '');
  } else {
    $('mp-answer').innerHTML = '';
  }
}

function drawPlayers () {
  const st = roomData.state;
  const players = Object.entries(roomData.players).sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  $('players').innerHTML = players.map(([uid, p]) => {
    const buzzing = st && st.phase === 'buzzed' && st.buzz && st.buzz.uid === uid;
    const out = st && st.lockout && st.lockout[uid] && ['reading', 'dead'].includes(st.phase);
    return `<li class="list-group-item d-flex justify-content-between align-items-center${buzzing ? ' list-group-item-warning' : ''}${p.online ? '' : ' text-body-secondary'}">
      <span>${p.online ? '<i class="bi bi-circle-fill text-success small"></i>' : '<i class="bi bi-circle small"></i>'} ${escapeHtml(p.name || '?')}${uid === me.uid ? ' <span class="small">(you)</span>' : ''}${out ? ' <i class="bi bi-slash-circle small" title="already buzzed"></i>' : ''}</span>
      <span title="toss-ups correct / interrupts / bonuses"><b>${p.score || 0}</b> <span class="small text-body-secondary">${p.tu || 0}/${p.negs || 0}/${p.bonus || 0}</span></span></li>`;
  }).join('');
}

function drawRoomHeader () {
  const m = roomData.meta;
  if (!m) return;
  $('room-title').textContent = m.name;
  $('room-code').textContent = code;
}

function drawTimer (seconds, low = false) {
  const tenths = seconds === null ? 0 : Math.max(0, Math.ceil(seconds * 10 - 1e-6));
  $('timer').querySelector('.face').textContent = Math.floor(tenths / 10);
  $('timer').querySelector('.fraction').textContent = '.' + (tenths % 10);
  $('timer').classList.toggle('low', low);
}

function toggles (container, items, key) {
  const st = roomData.settings;
  $(container).innerHTML = items.map(([val, label]) => {
    const id = `${key}-${val.replace(/\W/g, '')}`;
    return `<input type="checkbox" class="btn-check" id="${id}" value="${val}" autocomplete="off"${st[key].includes(val) ? ' checked' : ''}>` +
      `<label class="btn btn-outline-primary btn-sm" for="${id}">${label}</label>`;
  }).join('');
}

function drawSettings () {
  const st = roomData.settings;
  if (!st) return;
  if (document.activeElement && $('room-settings').contains(document.activeElement)) return; // don't fight the user mid-edit
  $('mp-question-type').value = st.questionType;
  toggles('mp-categories', CATEGORIES.map(c => [c, c === 'Earth and Space' ? 'Earth & Space' : c]), 'categories');
  toggles('mp-difficulties', Object.entries(DIFFICULTIES), 'difficulties');
  toggles('mp-formats', Object.entries(FORMATS), 'formats');
  $('mp-speed').value = st.readingSpeed;
  $('mp-speed-label').textContent = `${speedFactor(st.readingSpeed).toFixed(2)}×`;
  const n = roomQueue(st).length;
  $('mp-match-count').textContent = `${n.toLocaleString()} toss-ups match`;
}

function changeSettings (patch, what) {
  const seed = Math.floor(Math.random() * 2 ** 31); // new filters, new order
  update(ref(db, `rooms/${code}/settings`), { ...patch, seed });
  update(stateRef(), { n: -1 });
  logEvent(`${me.name} changed ${what}`);
}

// ---------- log & chat ----------

function logEvent (text) {
  if (!code) return;
  push(ref(db, `rooms/${code}/chat`), { name: me.name, text, at: serverTimestamp(), kind: 'event' });
}

function addLogLine (m) {
  if (!m) return;
  const li = document.createElement('li');
  li.className = m.kind === 'event' ? 'text-body-secondary small' : '';
  li.innerHTML = m.kind === 'event' ? escapeHtml(m.text) : `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
  $('mp-log').prepend(li);
  while ($('mp-log').children.length > 60) $('mp-log').lastElementChild.remove();
}

function flash (text) {
  $('mp-status').textContent = text;
}

let audioCtx = null;
function beep () {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 520;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch (e) {}
}

// ---------- controls ----------

function initControls () {
  $('mp-next').addEventListener('click', nextQuestion);
  $('mp-buzz').addEventListener('click', buzz);
  $('leave-room').addEventListener('click', () => leaveRoom(true));
  $('copy-link').addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}#${code}`;
    navigator.clipboard?.writeText(link);
    $('copy-link').innerHTML = '<i class="bi bi-check2"></i> Copied';
    setTimeout(() => { $('copy-link').innerHTML = '<i class="bi bi-link-45deg"></i> Copy invite link'; }, 1500);
  });
  $('mp-answer-form').addEventListener('submit', e => { e.preventDefault(); submitAnswer($('mp-answer-input').value); });
  $('mp-judge-correct').addEventListener('click', () => judge(true));
  $('mp-judge-wrong').addEventListener('click', () => judge(false));
  $('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('chat-input').value.trim().slice(0, 400);
    if (text && code) push(ref(db, `rooms/${code}/chat`), { name: me.name, text, at: serverTimestamp(), kind: 'chat' });
    $('chat-input').value = '';
    $('chat-input').blur();
  });

  $('mp-question-type').addEventListener('change', e => changeSettings({ questionType: e.target.value }, 'the question type'));
  for (const [container, key, what] of [['mp-categories', 'categories', 'subjects'], ['mp-difficulties', 'difficulties', 'difficulty'], ['mp-formats', 'formats', 'question formats']]) {
    $(container).addEventListener('change', () => {
      const vals = [...$(container).querySelectorAll('input:checked')].map(i => i.value);
      if (vals.length) changeSettings({ [key]: vals }, what);
    });
  }
  $('mp-speed').addEventListener('input', e => { $('mp-speed-label').textContent = `${speedFactor(+e.target.value).toFixed(2)}×`; });
  $('mp-speed').addEventListener('change', e => {
    update(ref(db, `rooms/${code}/settings`), { readingSpeed: +e.target.value });
    logEvent(`${me.name} set reading speed to ${speedFactor(+e.target.value).toFixed(2)}×`);
  });

  document.addEventListener('click', e => {
    const el = e.target.closest('button, input[type=checkbox], input[type=range], summary');
    if (el && !el.closest('.dropdown-menu')) setTimeout(() => el.blur(), 0);
  });
  const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(el.type)));
  document.addEventListener('keydown', e => {
    if (!code || typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (judging && (key === 'c' || key === 'w')) { e.preventDefault(); judge(key === 'c'); return; }
    if (key === ' ') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) buzz(); } else if (key === 'n') { e.preventDefault(); if (!$('mp-next').disabled) nextQuestion(); } else if (key === 'enter') { e.preventDefault(); $('chat-input').focus(); }
  }, true);
  document.addEventListener('keyup', e => { if (e.key === ' ' && !typing(document.activeElement)) e.preventDefault(); }, true);
}

window.sbrMp = { get state () { return roomData; }, get me () { return me; }, buzz, nextQuestion, submitAnswer, joinRoom, leaveRoom };

main();
