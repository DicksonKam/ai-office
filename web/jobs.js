// Work an agent has going on outside its turn, read the same way by the server and the page. A job is
//   { id, kind: run | timer | schedule, label, state: running | waiting | done | failed | stopped | unknown, startedAt, nextAt, endedAt, evidence }
// and nothing here, or anywhere past the readers that report jobs, knows which tool it came from.
export const TIMER_HOLD_MS = 30 * 60 * 1000; // a timer due sooner than this is something to wait for; a later one goes on the board

const active = j => j.state === 'running' || j.state === 'waiting';

/** Does this job keep its worker at the desk? A run does until it ends, a timer once it is close, a schedule never. */
export function holdsWorker(j, now) {
  if (!active(j)) return false;
  if (j.kind === 'run') return true;
  return j.kind === 'timer' && Number.isFinite(j.nextAt) && j.nextAt - now < TIMER_HOLD_MS;
}

export function waitingOnJob(agent, now) { return !!agent?.jobs?.some(j => holdsWorker(j, now)); }

/** What the desk and the name label say: how many runs are going, the next timer due, any that failed. */
export function jobSummary(agent, now) {
  let running = 0, nextAt = 0, failed = 0;
  for (const j of agent?.jobs || []) {
    if (j.state === 'failed') failed++;
    if (!holdsWorker(j, now)) continue;
    if (j.kind === 'run') running++;
    else if (!nextAt || j.nextAt < nextAt) nextAt = j.nextAt;
  }
  return { running, nextAt, failed };
}
