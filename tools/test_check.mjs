import { checkAnswer, parseAnswer } from '../js/check.js';
import fs from 'fs';
const qs = JSON.parse(fs.readFileSync(new URL('../data/questions.json', import.meta.url)));
let fail = [];
for (const q of qs) {
  const a = parseAnswer(q.answer);
  if (q.format === 'mc' && a.letter) {
    if (!checkAnswer(q, a.letter.toLowerCase())) fail.push(['letter', q.id]);
    const wrong = 'WXYZ'.replace(a.letter, '')[0];
    if (checkAnswer(q, wrong)) fail.push(['wrongletter', q.id]);
    if (q.choices && !checkAnswer(q, q.choices['WXYZ'.indexOf(a.letter)])) fail.push(['choicetext', q.id, q.choices['WXYZ'.indexOf(a.letter)]]);
  } else if (a.main && checkAnswer(q, a.main) === false) fail.push(['main', q.id, q.answer]);
}
console.log('failures', fail.length); console.log(fail.slice(0, 15));
const byId = Object.fromEntries(qs.map(q => [q.id, q]));
const T = (id, g, want) => { const r = checkAnswer(byId[id], g); console.log(r === want ? 'ok ' : 'BAD', id, JSON.stringify(g), '->', r, '|', byId[id].answer.slice(0, 70)); };
T('1-1-1t', 'phenotype', true); T('1-1-1t', 'phenotipe', true); T('1-1-1t', 'genotype', false);
T('5-1-1t', 'blue', true); T('5-1-1t', 'cobalt blue', true); T('5-1-1b', '5', false); T('5-1-1b', '+5', true);
T('1-1-2t', 'basic', true); T('1-1-2t', 'acidic', false); T('1-1-2b', '144', true); T('1-1-2b', '144.0', true);
T('13-4-9t', '3, 2, 1', true); T('13-4-9t', '1 2 3', false); T('13-16-9b', '3 and 2', true);
T('12-4-3b', '-1/3', true); T('12-4-3b', '-0.333', false);
const op=qs.find(q=>q.answer.startsWith('OPERANT LEARNING')).id; T(op,'operant conditioning',true); T(op,'classical conditioning',false); T('2-11-12b','(-3/2, 5/2), (3, -2)',true); T('3-5-4b','pi',false); T('3-5-4b','π',true);
