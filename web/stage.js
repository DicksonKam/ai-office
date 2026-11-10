// What time it is in the office. Live, that is simply now. During a film it is the film's own moment, and everything that
// counts seconds (reactions, marks, how long someone has been at it) follows the film's speed and stops when it pauses.
export const stage = {
  film: null,  // the film's moment in ms, or null when the office is live
  skew: 0,     // how far the running clock has been pushed from the real one
  /** the running clock, for "in 3 seconds" */
  perf() { return performance.now() + this.skew; },
  /** the date and time, for "since 10:42" */
  wall() { return this.film ?? Date.now(); },
};
