// Work going on outside an agent's turn (the job record: web/jobs.js). Readers report what they can see as observations;
// this book remembers them, because a long job's start scrolls out of the end of a transcript, and decides when a job is
// over. It knows no tool. A job nobody reported ending ends as `unknown`, never as finished.
export const LIMITS = {
  maxRunMs: 12 * 60 * 60 * 1000,   // a run still "running" after this is not believed
  ownerGraceMs: 2 * 60 * 1000,     // an owner no reader reports any more: its running jobs are not believed after this
  shellGraceMs: 30 * 1000,         // a run that needs a shell under its owner, with none for this long, has gone
  timerGraceMs: 10 * 60 * 1000,    // a timer this far past due, its owner never woke: not believed
  endedMinMs: 60 * 1000,           // an ended job is seen at least this long, even if its end wakes the agent at once
  endedMaxMs: 30 * 60 * 1000,      // and no longer than this if the agent never takes another turn
  unknownMs: 5 * 60 * 1000,
  tombMs: 48 * 60 * 60 * 1000,
};
const KINDS = new Set(['run', 'timer']), ENDED = new Set(['done', 'failed', 'stopped', 'unknown']), STATES = new Set(['running', 'waiting', ...ENDED]);

export class JobBook {
  constructor(state = null) {
    this.jobs = new Map((state?.jobs || []).map(j => [j.id, j]));
    this.tomb = new Map(state?.tomb || []); // id -> when it was dropped: the tail of a transcript keeps reporting it
    this.schedules = [];
    this.dirty = false;
  }
  toJSON() { return { jobs: [...this.jobs.values()], tomb: [...this.tomb] }; }

  /** `{ id, owner, kind, state, label, startedAt, nextAt, endedAt, evidence, pid, needsShell }`: a reader saying what it
   *  sees. An observation of only `id` and `state` is an end note, for a job already in the book. */
  observe(list, now = Date.now()) {
    for (const o of list || []) {
      if (!o?.id || !STATES.has(o.state) || this.tomb.has(o.id)) continue;
      const j = this.jobs.get(o.id);
      if (j) {
        if (ENDED.has(j.state) && j.state !== 'unknown') continue; // an end is final
        if (j.state !== o.state) { j.state = o.state; j.endedAt = ENDED.has(o.state) ? (o.endedAt || now) : null; this.dirty = true; }
        if (o.nextAt && o.nextAt !== j.nextAt) { j.nextAt = o.nextAt; this.dirty = true; }
        continue;
      }
      if (!o.owner || !KINDS.has(o.kind)) continue;
      const startedAt = o.startedAt || now;
      if (ENDED.has(o.state) ? now - (o.endedAt || now) > LIMITS.endedMaxMs // old history in a transcript's tail
        : o.kind === 'run' ? now - startedAt > LIMITS.maxRunMs : (!o.nextAt || now - o.nextAt > LIMITS.timerGraceMs)) continue;
      this.jobs.set(o.id, { id: o.id, owner: o.owner, kind: o.kind, state: o.state, label: o.label || (o.kind === 'timer' ? 'Timer' : 'Background job'), startedAt,
        nextAt: o.nextAt || null, endedAt: ENDED.has(o.state) ? (o.endedAt || now) : null, evidence: o.evidence || 'reported', pid: o.pid || null, needsShell: !!o.needsShell, ownerSeenAt: now, noShellSince: null });
      this.dirty = true;
    }
  }

  /** `owners`: id -> agent as reported this poll. `shellsUnder(pid)`: shells under that process, or null when unknown.
   *  `pidAlive(pid)`: is this process running. */
  sweep(now, owners, { shellsUnder = () => null, pidAlive = () => true } = {}) {
    const end = (j, state) => { j.state = state; j.endedAt = now; this.dirty = true; };
    const drop = j => { this.jobs.delete(j.id); this.tomb.set(j.id, now); this.dirty = true; };
    for (const j of [...this.jobs.values()]) {
      const a = owners.get(j.owner), gone = !a || a.status === 'gone';
      if (a) j.ownerSeenAt = now;
      if (!ENDED.has(j.state)) {
        if (j.kind === 'timer') {
          // it woke them, or it never will: a timer that is over leaves nothing on the desk
          if (a?.status === 'gone' || (j.nextAt <= now && a?.status === 'working') || now - j.nextAt > LIMITS.timerGraceMs || (!a && now - j.ownerSeenAt > LIMITS.ownerGraceMs)) drop(j);
          continue;
        }
        if (now - j.startedAt > LIMITS.maxRunMs || (a?.status === 'gone') || (!a && now - j.ownerSeenAt > LIMITS.ownerGraceMs) || (j.pid && !pidAlive(j.pid))) { end(j, 'unknown'); continue; }
        if (j.needsShell && Number.isInteger(a?.pid)) {
          const n = shellsUnder(a.pid);
          if (n !== 0) j.noShellSince = null;
          else if (!j.noShellSince) j.noShellSince = now;
          else if (now - j.noShellSince > LIMITS.shellGraceMs) end(j, 'unknown');
        }
        continue;
      }
      const age = now - j.endedAt;
      if (age > (j.state === 'unknown' ? LIMITS.unknownMs : LIMITS.endedMaxMs) || (age > LIMITS.endedMinMs && (gone || a?.status === 'working'))) drop(j);
    }
    for (const [id, at] of this.tomb) if (now - at > LIMITS.tombMs) { this.tomb.delete(id); this.dirty = true; }
  }

  /** This owner's jobs for the snapshot, oldest first: their schedules too, which never hold a worker. */
  listFor(owner) {
    const out = [];
    for (const j of this.jobs.values()) if (j.owner === owner) out.push(publicJob(j));
    for (const s of this.schedules) if (s.owner === owner) out.push(publicJob(s));
    return out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }
  /** Readers report their schedules whole each time: one paused or deleted is simply no longer in the list. */
  setSchedules(list) { this.schedules = list || []; }
  upcoming() { return this.schedules.filter(s => s.nextAt).sort((a, b) => a.nextAt - b.nextAt).map(s => ({ ...publicJob(s), owner: s.owner || null })); }
}

const publicJob = ({ id, kind, label, state, startedAt, nextAt, approx, endedAt, evidence }) => ({ id, kind, label, state, startedAt: startedAt || null, nextAt: nextAt || null, approx: !!approx, endedAt: endedAt || null, evidence: evidence || 'reported' });
