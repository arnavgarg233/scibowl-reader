// Countdown that measures real elapsed time, so late or throttled ticks never add
// drift, and that holds exactly while paused.
export function countdown ({ seconds, onEnd, onTick = () => {}, onWarn = null, warnAt = null, isPaused = () => false, tickMs = 20, now = () => performance.now() }) {
  let left = seconds * 1000;
  let last = now();
  let warned = false;
  let stopped = false;
  const id = setInterval(() => {
    const t = now();
    if (!isPaused()) left -= t - last;
    last = t;
    if (onWarn && !warned && warnAt !== null && left <= warnAt * 1000) { warned = true; onWarn(); }
    if (left <= 0) {
      stop();
      onTick(0);
      onEnd();
      return;
    }
    onTick(left / 1000);
  }, tickMs);
  function stop () {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
  }
  return { stop, get left () { return Math.max(0, left) / 1000; } };
}
