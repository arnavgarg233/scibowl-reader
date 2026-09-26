// Answer checking for NSB-style answer lines, e.g.
//   "W) BASIC"
//   "COBALT BLUE (ACCEPT: BLUE, COBALT)"
//   "+5 (DO NOT ACCEPT: 5)"
//   "1, 4"   (identify-all / ranking questions)

export function stripLatex (s) {
  return s
    .replace(/\\\(\\tfrac\{(.*?)\}\{(.*?)\}\\\)/g, '$1/$2')
    .replace(/\\\(\^\{(.*?)\}\\\)/g, '^$1')
    .replace(/\\\(_\{(.*?)\}\\\)/g, '$1')
    .replace(/\\text\{(.*?)\}/g, '$1')
    .replace(/\\([%#&_{}$^])/g, '$1');
}

function normalize (s) {
  return stripLatex(s)
    .toLowerCase()
    .replace(/π/g, ' pi ').replace(/θ/g, ' theta ').replace(/[∆Δ]/g, ' delta ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/[’‘`]/g, "'")
    .replace(/\^/g, '')
    .replace(/[^a-z0-9.\-/+%°' ]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// directive groups like "(ACCEPT: ...)", "(Solution: ...)", "(MUST GIVE BOTH)"
const DIRECTIVE = /^\s*(ALSO\s+ACCEPT|ACCEPT|DO NOT|DON'T|SOLUTION|MUST|NOTE|READ|PROMPT|ANSWER|IN ANY ORDER)\b/i;

// split top-level directive "(...)" groups off an answer line; other parens stay in the answer
function splitParens (s) {
  const groups = [];
  let depth = 0; let start = -1; let main = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ')' && depth > 0) {
      depth--;
      if (depth === 0) {
        const g = s.slice(start + 1, i);
        if (DIRECTIVE.test(g)) groups.push(g); else main += '(' + g + ')';
      }
      continue;
    }
    if (depth === 0) main += c;
  }
  if (depth > 0) { // unclosed paren (wrapped/truncated lines)
    const g = s.slice(start + 1);
    if (DIRECTIVE.test(g)) groups.push(g); else main += '(' + g;
  }
  return { main: main.trim(), groups };
}

function alternatives (list) {
  return list.split(/;|\bOR\b|,(?!\s*\d)/i).map(x => x.trim()).filter(Boolean).concat([list.trim()]);
}

export function parseAnswer (raw) {
  let letter = null;
  let s = raw.trim().replace(/^[:\s]+/, '');
  const m = s.match(/^([WXYZ])\)\s*/);
  if (m) { letter = m[1]; s = s.slice(m[0].length); }
  const { main, groups } = splitParens(s);
  const accept = [main, ...main.split(/\bOR\b/i).map(x => x.trim())];
  const reject = [];
  for (const g of groups) {
    const dm = g.match(/^\s*(DO NOT|DON'T)\s+ACCEPT\s*:?\s*/i);
    const am = g.match(/^\s*(ALSO\s+)?ACCEPT\s*:?\s*/i);
    if (dm) reject.push(...alternatives(g.slice(dm[0].length)));
    else if (am) accept.push(...alternatives(g.slice(am[0].length)));
  }
  return { letter, main, accept: accept.filter(Boolean), reject };
}

function levenshtein (a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function toNumber (s) {
  let t = normalize(s).replace(/,/g, '').replace(/\s+/g, '');
  if (t.endsWith('%')) t = t.slice(0, -1);
  const sci = t.match(/^(-?[\d.]+)(?:x|\*)10(-?\d+)$/);
  let v;
  if (sci) v = parseFloat(sci[1]) * 10 ** parseInt(sci[2]);
  else if (/^[+-]?\d+\/\d+$/.test(t)) { const [a, b] = t.split('/'); v = parseFloat(a) / parseFloat(b); }
  else if (/^[+-]?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(t)) v = parseFloat(t);
  else return null;
  return v;
}

function similar (given, target) {
  const a = normalize(given); const b = normalize(target);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.replace(/[\s\-']/g, '') === b.replace(/[\s\-']/g, '')) return true;
  const na = toNumber(given); const nb = toNumber(target);
  if (na !== null && nb !== null) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(nb));
  if (/\d/.test(b) && b.length <= 6) return false; // short numeric/symbolic answers must match exactly
  if (b.length <= 4) return false;
  return levenshtein(a, b) <= Math.floor(b.length * 0.2);
}

// "1, 3" / "1 AND 3" style answers to "identify all"/"rank" questions
function listMatch (given, target, ordered) {
  const nums = s => (normalize(s).match(/\d+/g) || []);
  if (!/^[\d\s,;and]+$/i.test(normalize(target)) || nums(target).length < 2) return null;
  const a = nums(given); const b = nums(target);
  if (!ordered) { a.sort(); b.sort(); }
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// true/false, or null when the answer line can't be checked automatically
// (answer only exists as an equation image) and the player should judge.
export function checkAnswer (question, given) {
  const g = given.trim();
  if (!g) return false;
  const ans = parseAnswer(question.answer);
  if (question.format !== 'mc' && !/[a-z0-9]/i.test(normalize(ans.main))) return null;
  if (question.format === 'mc' && ans.letter) {
    const lm = g.match(/^\s*([wxyz])\s*\)?\s*$/i);
    if (lm) return lm[1].toUpperCase() === ans.letter;
    if (question.choices) {
      const idx = 'WXYZ'.indexOf(ans.letter);
      const hits = question.choices.map(c => similar(g, c));
      if (hits[idx]) return true;
      if (hits.some(Boolean)) return false;
    }
    return ans.accept.some(a => similar(g, a));
  }
  if (ans.reject.some(r => normalize(r) === normalize(g))) return false;
  const ordered = /\b(order|rank|sequence|chronological)/i.test(question.text);
  for (const a of ans.accept) {
    const lm = listMatch(g, a, ordered);
    if (lm !== null) { if (lm) return true; continue; }
    if (similar(g, a)) return true;
  }
  // part of the answer is an equation image, so the text may be incomplete
  return question.img_a ? null : false;
}
