// On the public demo the visitor's machine may be far weaker than the one this was built on. Watch the frame times and, if
// the page is struggling, step the picture down one level at a time; never back up, so it cannot flip back and forth.
/** @param {Function[]} steps cheapest loss first; each is called once, in order
 *  @param {number} minFps below this (median over a window) the next step is taken */
export function createQualityStepper({ steps = [], minFps = 28, windowMs = 2500, settleMs = 1500 } = {}) {
  let next = 0, samples = [], spent = 0, settle = settleMs;
  return {
    get level() { return next; },
    tick(dtMs) {
      if (next >= steps.length || !(dtMs > 0) || dtMs > 5000) return;       // done, or a long stall: not a frame (a very slow machine really does take seconds)
      if (settle > 0) { settle -= dtMs; return; }                           // let the last change (and the page's start) pass
      samples.push(dtMs); spent += dtMs;
      if (spent < windowMs) return;
      samples.sort((a, b) => a - b);
      const fps = 1000 / samples[Math.floor(samples.length / 2)];
      samples = []; spent = 0;
      if (fps < minFps) { steps[next++](); settle = settleMs; }
    },
  };
}
