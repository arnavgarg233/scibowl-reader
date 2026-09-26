import { countdown } from '../js/timer.js';
const { performance } = globalThis;
const run = (name, opts, extra = () => {}) => new Promise(resolve => {
  const t0 = performance.now(); let warnAt = null;
  countdown({ ...opts, onWarn: opts.warnAt != null ? () => { warnAt = (performance.now() - t0) / 1000; } : null, onEnd: () => resolve(`${name}: ended at ${((performance.now() - t0) / 1000).toFixed(3)} s${warnAt != null ? `, "5 seconds" at ${warnAt.toFixed(3)} s` : ''}`) });
  extra(t0);
});
const busy = ms => { const e = performance.now() + ms; while (performance.now() < e); };
let paused = false;
const results = await Promise.all([
  run('toss-up 5 s', { seconds: 5 }),
  run('bonus 20 s', { seconds: 20, warnAt: 5 }),
  run('5 s with a 400 ms page freeze at 2 s (expect ~5.0)', { seconds: 5 }, () => setTimeout(() => busy(400), 2000)),
  run('5 s paused 3 s from 1 s to 4 s (expect ~8.0)', { seconds: 5, isPaused: () => paused }, () => { setTimeout(() => { paused = true; }, 1000); setTimeout(() => { paused = false; }, 4000); })
]);
results.forEach(r => console.log(r));
