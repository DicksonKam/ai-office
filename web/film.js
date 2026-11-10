// The office on film: the day journal, run again through the real director, into something a player can jump around in.
// No drawing here, and nothing but journal lines going in, so it runs in the page, in a test or in a script alike.
//
// A film is worked out once, whole, when it is opened: a recorded day takes well under a second. After that, going to any
// moment is a lookup. It holds a frame for every moment anything changed: who is in, what the plan is, what just happened.
//
// What is real and what is acted: who was in, when, working or idle, waiting on you, helpers, reports and verdicts are the
// journal's own. The walks, breaks and coffee between them were never recorded; the director acts them out again.
import { Director } from './director.js';

export const FILM_TICK_MS = 1500; // as often as the server looks
const EVENT_KINDS = new Set(['spawn', 'message', 'report', 'review', 'verdict', 'handoff', 'approval', 'launch']);
const HEAT_BUCKETS = 240;
const VENDOR_NAME = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' };

const hostOf = e => {
  const name = VENDOR_NAME[e.vendor] || e.vendor || 'Agent';
  return e.agentKind === 'desktop' ? `${name} Desktop` : e.agentKind === 'cli' ? `${name} CLI` : name;
};

/** One journal line brought to bear on who is in. `agents` is the map of id -> agent, changed in place. True if it changed. */
export function applyLine(agents, e) {
  const a = agents.get(e.id);
  switch (e.kind) {
    case 'arrived': {
      const carried = !!e.carried; // carried over a midnight, not a real arrival
      agents.set(e.id, {
        id: e.id, vendor: e.vendor, kind: e.agentKind, host: hostOf(e), task: e.task, project: e.project, parentId: e.parentId || null, role: e.role || null,
        nickname: e.nickname, status: e.status || 'idle', thought: null, asking: a?.asking ?? null, askTo: a?.askTo ?? null,
        // in already when the file begins: at their place, not walking in, and not a fresh start of work
        startedAt: a?.startedAt ?? (carried ? e.t - 3600000 : e.t), lastActivityAt: e.t, idleSince: a?.idleSince ?? (carried ? e.t - 120000 : e.t),
        delegator: e.delegatedBy ? { id: e.delegatedBy, certain: true } : a?.delegator ?? null,
      });
      return true;
    }
    case 'left': return agents.delete(e.id);
    case 'working': if (!a) return false; a.status = 'working'; a.lastActivityAt = e.t; return true;
    case 'idle': if (!a) return false; a.status = 'idle'; a.idleSince = e.t; return true;
    case 'role-change': if (!a) return false; a.role = e.role || null; return true;
    case 'asking-start': if (!a) return false; a.asking = e.text || 'asking'; a.askTo = e.askTo || null; return true;
    case 'asking-end': if (!a) return false; a.asking = null; a.askTo = null; return true;
    default: return false;
  }
}

const eventOf = e => {
  const ev = { id: e.eid, kind: e.kind, from: e.id, to: e.to, at: e.at || e.t };
  for (const k of ['text', 'channel', 'confidence', 'linkKind', 'stub']) if (e[k]) ev[k] = e[k];
  if (e.outcome || e.risk) ev.verdict = { outcome: e.outcome ?? null, risk: e.risk ?? null };
  return ev;
};

/** what a viewer would want to find on the bar */
function markOf(e) {
  if (e.carried) return null;
  switch (e.kind) {
    case 'asking-start': return e.askTo ? null : 'ask';
    case 'arrived': return e.role === 'helper' || e.role === 'reviewer' ? null : 'in';
    case 'report': return 'report';
    default: return null;
  }
}
// what Auto slows down for: someone coming, going or needing you, and people dealing with each other. A worker flipping between
// typing and thinking happens hundreds of times an hour and is not worth stopping for.
const WORTH_SEEING = new Set(['arrived', 'left', 'asking-start', 'spawn', 'report', 'review', 'verdict', 'handoff', 'launch']);

export class Film {
  constructor({ from, to, frames, marks, heat, changes, gaps }) {
    Object.assign(this, { from, to, frames, marks, heat, changes, gaps });
  }
  get length() { return this.to - this.from; }
  /** Auto speed at `t`: races the silences, slows to a pace where a walk can be seen when something happens. */
  rateAt(t) {
    const p = this.pace || (this.pace = paceOf(this));
    const x = (t - this.from) / p.width, i = Math.max(0, Math.min(p.rates.length - 1, Math.floor(x)));
    return p.rates[i];
  }
  /** how long a whole watch takes at Auto, in seconds */
  autoLength() { const p = this.pace || (this.pace = paceOf(this)); return p.rates.reduce((n, r) => n + p.width / r, 0) / 1000; }
  /** the last frame at or before `t` */
  indexAt(t) {
    let lo = 0, hi = this.frames.length - 1;
    if (hi < 0 || t <= this.frames[0].t) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.frames[mid].t <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  frame(i) { return this.frames[i]; }
  planOf(f) { return JSON.parse(f.plan); }
  /** the office at `t`: for a jump */
  at(t) { const f = this.frames[this.indexAt(t)]; return { t, agents: f.agents, plan: this.planOf(f), events: [] }; }
}

const PACE = { slowMin: 4, slowMax: 16, fastMin: 60, fastMax: 1800, before: 1500, after: 9000, ease: 2, quietShare: 0.25 };
/** the speed for each short stretch of a film */
export function paceOf(film) {
  const span = Math.max(1, film.length), width = Math.max(4000, span / 3000), n = Math.max(1, Math.ceil(span / width));
  const busy = new Uint8Array(n);
  for (const c of film.changes) {
    const a = Math.max(0, Math.floor((c - PACE.before - film.from) / width)), b = Math.min(n - 1, Math.floor((c + PACE.after - film.from) / width));
    for (let i = a; i <= b; i++) busy[i] = 1;
  }
  const busyMs = busy.reduce((v, x) => v + x, 0) * width, quietMs = n * width - busyMs, hours = span / 3600000;
  const watch = Math.min(300, 30 + 12 * hours) * 1000; // about how long the busy part should take to watch
  const slow = Math.min(PACE.slowMax, Math.max(PACE.slowMin, busyMs / watch));
  const fast = Math.min(PACE.fastMax, Math.max(PACE.fastMin, quietMs / (watch * PACE.quietShare)));
  const raw = Array.from(busy, b => Math.log(b ? slow : fast));
  // no lurch between the two: eased over the stretches beside each change
  const rates = raw.map((_, i) => {
    let sum = 0, k = 0;
    for (let j = i - PACE.ease; j <= i + PACE.ease; j++) if (j >= 0 && j < n) { sum += raw[j]; k++; }
    return Math.exp(sum / k);
  }).map((r, i) => (busy[i] ? Math.min(r, slow) : r));
  return { width, rates, slow, fast };
}

/** teams as the roster wants them, from who is in */
export function teamsOf(agents) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const top = a => { let w = a, guard = 0; while (w.parentId && byId.has(w.parentId) && guard++ < 6) w = byId.get(w.parentId); return w; };
  const teams = new Map();
  for (const a of agents) {
    const l = top(a);
    if (!teams.has(l.id)) teams.set(l.id, { id: l.id, lead: l.id, members: [], reviewers: [] });
    if (a !== l) teams.get(l.id)[a.role === 'reviewer' ? 'reviewers' : 'members'].push(a.id);
  }
  return [...teams.values()];
}

/** Works a film out a slice at a time, so a page can stay responsive while it does. */
export class FilmBuilder {
  /**
   * @param {object[]} entries  journal lines, from early enough to know who was in at `from` (the start of that day)
   * @param {object} o
   * @param {number} o.from, o.to    the span the film shows
   * @param {number[]} [o.dayStarts] when each file in `entries` begins: anyone not carried over it has gone
   * @param {object[]} [o.gaps]      stretches the office was not running: [{ from, to }]
   * @param {object} [o.config]      the office's settings, as in a snapshot
   */
  constructor(entries, { from, to, dayStarts = [], gaps = [], tick = FILM_TICK_MS, seed = 7, config = null } = {}) {
    this.lines = [...entries].filter(e => e && Number.isFinite(e.t) && e.t <= to).sort((a, b) => a.t - b.t);
    Object.assign(this, { from, to, tick, config, gaps: gaps.filter(g => g.to > from && g.from < to) });
    this.director = new Director({ seed });
    this.now = Math.min(this.lines.length ? this.lines[0].t : from, from);
    this.agents = new Map(); this.list = []; this.i = 0;
    this.days = dayStarts.filter(d => d > this.now).sort((a, b) => a - b);
    this.frames = []; this.marks = []; this.changes = []; this.lastPlan = null; this.warm = null;
    this.heat = new Array(HEAT_BUCKETS).fill(0);
    this.done = false;
  }
  /** the new day's file names who was carried over its midnight; nobody else is still in (the server was off, or they left) */
  crossMidnight(day) {
    let j = this.i;
    while (j < this.lines.length && this.lines[j].t < day) j++;
    if (j >= this.lines.length) return false;
    const first = this.lines[j].t, stayed = new Set();
    for (let k = j; k < this.lines.length && this.lines[k].t === first; k++) if (this.lines[k].carried && this.lines[k].kind === 'arrived') stayed.add(this.lines[k].id);
    let changed = false;
    for (const id of [...this.agents.keys()]) if (!stayed.has(id)) { this.agents.delete(id); changed = true; }
    return changed;
  }
  stepOnce() {
    const now = this.now, events = [];
    let dirty = false;
    while (this.days.length && this.days[0] <= now) { if (this.crossMidnight(this.days.shift())) dirty = true; }
    while (this.i < this.lines.length && this.lines[this.i].t <= now) {
      const e = this.lines[this.i++];
      if (applyLine(this.agents, e)) dirty = true;
      if (e.kind === 'seat' && (e.desk || e.slot)) this.director.hint(e.id, { desk: e.desk || null, slot: e.slot || null });
      if (EVENT_KINDS.has(e.kind) && e.eid) events.push(eventOf(e));
      if (e.t >= this.from) {
        const m = markOf(e); if (m) this.marks.push({ t: e.t, kind: m, id: e.id });
        if (WORTH_SEEING.has(e.kind) && !e.carried && !(e.kind === 'asking-start' && e.askTo)) this.changes.push(e.t);
      }
    }
    if (dirty) this.list = [...this.agents.values()].map(a => ({ ...a }));
    const plan = JSON.stringify(this.director.update(this.list, events, now, this.config));
    const frame = { t: now, agents: this.list, plan, events };
    if (now < this.from) { this.warm = { ...frame, t: this.from, events: [] }; this.lastPlan = plan; return; }
    if (this.warm) { this.frames.push(this.warm); this.warm = null; }
    else if (!this.frames.length) frame.t = this.from;
    if (dirty || events.length || plan !== this.lastPlan || !this.frames.length) this.frames.push(frame);
    this.lastPlan = plan;
    const span = Math.max(1, this.to - this.from), b = Math.min(HEAT_BUCKETS - 1, Math.floor((now - this.from) / span * HEAT_BUCKETS));
    this.heat[b] += this.list.reduce((n, a) => n + (a.status === 'working' ? 1 : 0), 0) * this.tick;
  }
  /** Runs for at most `ms`. True when the film is finished. */
  run(ms = Infinity) {
    const until = performance.now() + ms;
    let n = 0;
    while (this.now <= this.to) {
      this.stepOnce(); this.now += this.tick;
      if ((++n & 255) === 0 && performance.now() > until) return false;
    }
    this.done = true;
    return true;
  }
  film() {
    const bucketMs = Math.max(1, this.to - this.from) / HEAT_BUCKETS;
    return new Film({ from: this.from, to: this.to, frames: this.frames, marks: this.marks, heat: this.heat.map(v => v / bucketMs), changes: this.changes, gaps: this.gaps });
  }
}

/** The whole film in one go. */
export function makeFilm(entries, opts) { const b = new FilmBuilder(entries, opts); b.run(); return b.film(); }

/** The whole film without holding up the page. */
export async function buildFilm(entries, opts) {
  const b = new FilmBuilder(entries, opts);
  while (!b.run(10)) await new Promise(r => setTimeout(r));
  return b.film();
}
