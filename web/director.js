// The director: where each worker is, what they are doing and since when. It runs whether or not a tab is open (the
// server runs it for the live office; a tab runs its own only for `?demo`), and tabs just draw its plan, so every tab shows
// one office. It works on spot ids (a desk, a lounge seat, the coffee machine), never on 3D: agents.js turns a step into
// a walk and a pose. The plan changes only when a decision is made, and carries wall-clock times, so a tab opened late joins
// a walk partway through. Small gestures (blinks, glances, a sip at the desk) stay with each tab.
import { NAMES, hash, rand01 } from './palette.js';
import { waitingOnJob } from './jobs.js';

// what one floor holds, matching office.js (`__office.check()` compares the two)
export const LAYOUT = {
  desks: ['1-0', '1-1', '1-2', '0-0', '0-1', '0-2'], slots: 4, cafe: 6, wcs: 3, bar: 3, plants: 4, windows: 3, qa: 4,
  rooms: { meeting: 6, huddle: 4 },
  lounge: level => [5, 3, 3][level % 3],
  loungeStyle: level => [null, 'read', 'beanbag'][level % 3],
  foos: level => level % 3 === 2,
};
// [anim, seconds] on a break, by the seat's style; 'excursion' is where the director may send them somewhere
export const BREAK_CYCLES = {
  read: [['sip', 6], ['readbook', 14], ['sip', 4], ['readbook', 12], ['excursion', 0], ['yawn', 2.2], ['readbook', 10]],
  beanbag: [['slouch', 8], ['sip', 5], ['phone', 6], ['excursion', 0], ['slouch', 7], ['sleepy', 6], ['sip', 4]],
  cafe: [['sip', 6], ['chat', 6], ['phone', 5], ['sip', 5], ['excursion', 0], ['chat', 5], ['idle', 4], ['sip', 5]],
  sofa: [['sip', 7], ['idle', 5], ['phone', 4.5], ['sip', 6], ['excursion', 0], ['idle', 4], ['yawn', 2.2], ['sleepy', 6], ['sip', 5]],
};
/** the pose `elapsed` seconds into a break that started at cycle index `from` */
export function breakAnim(style, from, elapsed) {
  const c = BREAK_CYCLES[style] || BREAK_CYCLES.sofa;
  let i = from, t = Math.max(0, elapsed);
  for (let guard = 0; guard < 400; guard++, i++) {
    const [anim, dur] = c[i % c.length];
    if (anim === 'excursion') continue;
    if (t < dur) return anim;
    t -= dur;
  }
  return 'idle';
}

// the way in (web/site.js approach): along the pavement from just beyond an ordinary picture's west edge, past next door,
// up the path to the door mat. The walking times keep the pace they always had (5.5 s in, 8 s out for the old 10.9 m from
// the street), over the real length; __office.check() fails if the built route and this number ever drift apart. Short on
// purpose: a wider window walks them further at a brisker pace (Worker.streetEnd) rather than everyone waiting off-screen.
export const ENTRY_M = 18.99;
export const IN_WALK_S = ENTRY_M * 5.5 / 10.9;  // ~9.6 s from the west end of the pavement to the door mat
const WIPE_S = 1.2;                       // feet on the mat
const IN_GAP_MS = 450;                    // several arriving together walk in one after another, not as one
const OUT_S = ENTRY_M * 8 / 10.9;         // ~13.9 s from the door back past the west edge
const WALK_SPEED = 2.3;                   // m/s, a little under the tabs' 2.4: arrivals never miss their dwell
const SETTLE_GAP_MS = 30000;              // a first update, or one after this long a silence: whoever is in was already in
const ARRIVING_MS = 20000;                // ...unless their session started this recently
const MISSING_MS = 6000;                  // one bad read of the registry must not send someone home
const FLOOR_KEEP_MS = 10 * 60 * 1000;     // an empty upper floor stays this long
const EVENT_KEEP_MS = 60 * 60 * 1000;
const STALE_EVENT_MS = 60000;
const DEBOUNCE_MS = 8000, READY_FRESH_MS = 20000, FINISHED_MIN_MS = 2 * 60 * 1000;
const HANDBACK_S = 5.2, BRIEF_S = 3.4, COLLECT_S = 1.7, BREW_S = 3.2, STRETCH_S = 2.4, REVIEW_S = 2.8, HANDOVER_S = 2.4, STAMP_S = 2.6, BYE_S = 1.5, EXIT_S = 1.3;
const SESSION_MS = 7000, ROOM_WAIT_MS = 60000, ROOM_COOL_MS = 60000, BOARD_KEEP_MS = 90000;
const CONF_RANK = { declared: 3, structural: 3, artifact: 2, inferred: 1 };
const weakLink = ev => (CONF_RANK[ev?.confidence] ?? 3) < 3;
const isStub = ev => ev?.stub && typeof ev.stub === 'object' && (ev.stub.side === 'from' || ev.stub.side === 'to');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roleOf = a => a.role || 'member';

// rough positions, only to estimate how long a walk takes (the tab walks the real route)
const PLACES = { door: [-15.7, 5.2], meeting: [-4.1, -5], huddle: [13.7, 4.5], qa: [13.4, -4.5], copier: [-4.1, 5.1], coffee: [-9, -4.7], lounge: [-8.1, 3.8], cafe: [-11.8, -0.3],
  wc: [-15.9, -3.5], bar: [-6.8, -1.2], foos: [-7.9, 3.8], water: [2, 0], cooler: [-6.9, -5.1], window: [4, -5.6], chat: [-8.1, 3.8], stair: [-15.4, 4.1], stand: [-6.5, 4] };
const deskXZ = d => { const [row, col] = d.split('-').map(Number); return [col * 4.4, row === 1 ? 3.3 : -1.9]; };
function placeOf(step) {
  if (!step) return { f: 0, p: PLACES.door };
  const f = step.f ?? 0;
  if (step.d) return { f, p: deskXZ(step.d) };
  const k = step.k;
  if (k === 'meeting' || k === 'meet') return { f, p: PLACES[step.room] };
  if (k === 'qa') return { f, p: PLACES.qa };
  if (k === 'collect') return { f, p: PLACES.copier };
  if (k === 'queue' || k === 'brew') return { f, p: PLACES.coffee };
  if (k === 'break') return { f, p: PLACES[step.seat?.kind === 'cafe' ? 'cafe' : step.stand ? 'stand' : 'lounge'] };
  if (k === 'ambient') return { f, p: PLACES[step.a] };
  return { f: 0, p: PLACES.door }; // in, exit, out
}
/** seconds for a walk between two steps; 0 when it is the same place */
export function walkS(a, b) {
  const A = placeOf(a), B = placeOf(b);
  const dist = ([x0, z0], [x1, z1]) => Math.hypot(x1 - x0, z1 - z0) * 1.1; // a route is a little longer than the straight line
  const metres = A.f === B.f ? dist(A.p, B.p) : dist(A.p, PLACES.stair) + dist(PLACES.stair, B.p) + Math.abs(A.f - B.f) * 8;
  return metres < 0.01 ? 0 : 1 + metres / WALK_SPEED;
}

export class Director {
  constructor({ seed = 1, state = null } = {}) {
    this.recs = new Map(); this.floors = 1; this.coffee = {}; this.rooms = {}; this.processed = {}; this.pending = []; this.qaOut = {};
    this.floorEmpty = {}; this.s = seed >>> 0 || 1; this.lastAt = 0; this.gen = 0; this.finishedMinMs = FINISHED_MIN_MS; this.now = 0;
    if (state) this.restore(state);
  }
  // ---- saving and resuming (the server keeps this under data/, so a restart reshuffles nobody) ----
  toJSON() {
    return { v: 1, recs: [...this.recs.values()], floors: this.floors, coffee: this.coffee, rooms: this.rooms, processed: this.processed, pending: this.pending,
      qaOut: this.qaOut, floorEmpty: this.floorEmpty, s: this.s, lastAt: this.lastAt, gen: this.gen };
  }
  restore(j) {
    if (!j || j.v !== 1) return;
    this.recs = new Map((j.recs || []).map(r => [r.id, r])); this.floors = j.floors || 1; this.coffee = j.coffee || {}; this.rooms = j.rooms || {}; this.processed = j.processed || {};
    this.pending = j.pending || []; this.qaOut = j.qaOut || {}; this.floorEmpty = j.floorEmpty || {}; this.s = j.s || this.s; this.lastAt = j.lastAt || 0; this.gen = j.gen || 0;
    for (const r of this.recs.values()) r.missingSince = null;
  }
  rand() { // mulberry32: one stream, saved with the state
    this.s = (this.s + 0x6d2b79f5) >>> 0; let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  rnd(a, b) { return a + this.rand() * (b - a); }

  // ---- the tick -----------------------------------------------------------------------------------------------------
  /** one tick from a snapshot: returns the plan the tabs draw */
  update(agents, events = [], now = Date.now(), config = null) {
    this.now = now;
    if (Number(config?.finishedMinMs) > 0) this.finishedMinMs = Number(config.finishedMinMs);
    const settling = !(now - this.lastAt < SETTLE_GAP_MS); this.lastAt = now;
    const ids = new Set(agents.map(a => a.id));
    // parents first; a parent that helpers point to is a lead even if its own record still says member
    const depthOf = a => (Number.isFinite(a.depth) ? a.depth : a.parentId ? 1 : 0);
    const parents = new Set(agents.filter(a => a.parentId && ids.has(a.parentId) && a.role !== 'reviewer').map(a => a.parentId));
    const ordered = [...agents].sort((x, y) => depthOf(x) - depthOf(y)).map(a => (parents.has(a.id) && roleOf(a) === 'member' ? { ...a, role: 'lead' } : a));
    const admit = a => { const r = this.newRec(a); this.recs.set(a.id, r); if (settling && !(now - a.startedAt < ARRIVING_MS)) this.settle(r); else { const since = Math.max(now, this.nextInAt || 0); this.nextInAt = since + IN_GAP_MS; this.setStep(r, { k: 'in' }, { walk: IN_WALK_S, since }); } };
    for (const a of ordered) {
      const r = this.recs.get(a.id);
      if (!r) { admit(a); continue; }
      this.applyAgent(r, a);
    }
    for (const r of this.recs.values()) {
      if (ids.has(r.id)) { r.missingSince = null; continue; }
      r.missingSince ??= now;
      if (now - r.missingSince > MISSING_MS && !r.leaving) this.startExit(r);
    }
    this.processEvents(events, settling);
    this.updateRooms();
    for (const r of [...this.recs.values()]) this.tick(r);
    // back while still walking out: the one who left is out of sight now, and they come straight in again (no tick
    // in which they are in but nowhere)
    for (const a of ordered) if (!this.recs.has(a.id)) admit(a);
    this.pruneFloors();
    return this.plan();
  }
  newRec(a) {
    const name = a.nickname || this.uniqueName(a.id);
    return { id: a.id, gen: ++this.gen, name, agent: a, enteredAt: this.now, seq: 0, step: null, from: null, desk: null, slot: null, seat: null, spot: null, qa: null, meetSeat: null, kickoff: null, meeting: null,
      reviewing: null, reviewTask: null, stampAt: 0, stampEnd: 0, queue: [], briefed: false, seatedOnce: false, pendingBrief: null, leaving: false, wavedBye: false, missingSince: null,
      readyAt: 0, workAgainAt: 0, workingSince: a.status === 'working' ? this.now : null, errors: 0, reports: 0, thoughtKey: a.thought ? thoughtKey(a) : null, restUntil: 0, breakI: 0, breakT: 0, deskBreak: false };
  }
  uniqueName(id) {
    const taken = new Set([...this.recs.values()].map(r => r.name));
    const h = hash(id);
    for (let i = 0; i < NAMES.length; i++) { const n = NAMES[(h + i) % NAMES.length]; if (!taken.has(n)) return n; }
    return NAMES[h % NAMES.length];
  }
  /** already in when the director first saw them: at their place at once */
  settle(r) {
    r.briefed = true; r.seatedOnce = true;
    const a = r.agent, idleFor = a.status === 'working' ? 0 : this.now - (Number(a.idleSince) || this.now);
    this.decide(r, true);
    // idle for a while and free to wander: already on a break, as they would be had the office been watched
    if (idleFor > 60000 && r.step?.k === 'desk' && !r.leaving && !this.onJob(r)) { const seat = this.pickSeat(r, r.step.f); if (seat) { r.seat = seat; this.setStep(r, { k: 'break', f: seat.f, seat, b: 0 }, { walk: 0 }); } }
  }
  applyAgent(r, a) {
    const prev = r.agent, now = this.now; r.agent = a;
    if (a.nickname && a.nickname !== r.name) r.name = a.nickname;
    if (a.thought) { const key = thoughtKey(a); if (key !== r.thoughtKey) { r.thoughtKey = key; if (a.thought.kind === 'error') r.errors++; } }
    // who gave the work became known after it walked in: still on its way, it takes the desk beside the giver instead
    if (!(prev.delegator || prev.startedBy) && (a.delegator || a.startedBy) && r.desk && !r.seatedOnce && roleOf(a) !== 'helper' && r.step?.k === 'desk' && !this.arrived(r) && this.giver(r)) {
      this.releaseDesk(r); this.allocDesk(r); this.setStep(r, this.deskStep(r));
    }
    if (prev.status !== a.status) {
      if (a.status === 'working') { r.workAgainAt = now; r.workingSince = now; }
      if (a.status !== 'working' && prev.status === 'working') {
        const idleAt = Math.min(Number(a.idleSince) || now, now), worked = r.workingSince != null ? idleAt - r.workingSince : 0;
        r.workingSince = null;
        const blip = r.readyAt && now - r.workAgainAt < DEBOUNCE_MS; // a few seconds of work right after a hand-back: still the same hand-back
        if (!blip) r.readyAt = !a.parentId && roleOf(a) !== 'helper' && roleOf(a) !== 'reviewer' && worked >= this.finishedMinMs ? now : 0;
      }
    }
    if (a.status === 'working' && r.readyAt && now - r.workAgainAt >= DEBOUNCE_MS) r.readyAt = 0; // really working again
    if (r.leaving) { // the session is back while the worker is on the way out: turn around, unless already out of the door
      if (r.step?.k === 'out') return; // they finish leaving, then come straight back in as a fresh arrival
      r.leaving = false; r.wavedBye = false; this.decide(r);
    }
  }

  // ---- steps ----------------------------------------------------------------------------------------------------------
  setStep(r, step, { walk = null, since = this.now } = {}) {
    r.from = r.step ? stepPlace(r.step) : null;
    r.step = { ...step, since, walk: walk ?? walkS(r.step, step) };
    r.seq++;
  }
  arrived(r) { return this.now >= r.step.since + r.step.walk * 1000; }
  /** seconds since arriving (negative on the way) */
  t(r) { return (this.now - r.step.since) / 1000 - r.step.walk; }
  rec(id) { const r = this.recs.get(id); return r && !r.done ? r : null; }
  /** whose desk this one sits near: the agent that gave it the work, or the chat that started it */
  giver(r) { const id = r.agent.delegator?.id ?? r.agent.startedBy?.id; return id ? this.rec(id) : null; }
  lead(r) { let w = r, guard = 0; while (w.agent.parentId && guard++ < 6) { const p = this.rec(w.agent.parentId); if (!p) break; w = p; } return w === r ? null : w; }
  isHelper(r) { return roleOf(r.agent) === 'helper'; }
  isReviewer(r) { return roleOf(r.agent) === 'reviewer'; }
  idle(r) { return r.agent.status !== 'working'; }
  /** turn over, but something it started is still going: they rest at their own desk, not the lounge, which means free */
  onJob(r) { return this.idle(r) && waitingOnJob(r.agent, this.now); }
  traits(r) { const h = hash(r.id); return { coffee: rand01(h, 11), sleepy: rand01(h, 13), social: rand01(h, 15), plants: rand01(h, 16) }; }
  floorOf(r) { return r.step?.f ?? 0; }
  live() { return [...this.recs.values()].filter(o => !o.leaving); }
  deskStep(r) { return { k: 'desk', f: r.desk.f, d: r.desk.d }; }

  // ---- seats ----------------------------------------------------------------------------------------------------------
  deskFree(f, d) { for (const o of this.recs.values()) if (o.desk && o.desk.f === f && o.desk.d === d) return false; return true; }
  deskSlots(f, d) { const out = []; for (const o of this.recs.values()) if (o.slot && o.slot.f === f && o.slot.d === d) out.push(o); return out; }
  allocDesk(r) {
    // work another agent gave this one (not its team: a desk of its own): the free desk nearest the giver's, on its floor
    const hinted = this.hintedDesk(r);
    if (hinted) { if (hinted.f >= this.floors) this.floors = hinted.f + 1; r.desk = { f: hinted.f, d: hinted.d }; return r.desk; }
    const g = this.giver(r), near = g ? (g.desk || g.slot) : null;
    if (near) {
      const [nx, nz] = deskXZ(near.d);
      const best = LAYOUT.desks.filter(d => d !== near.d && this.deskFree(near.f, d) && !this.deskSlots(near.f, d).length)
        .sort((a, b) => Math.hypot(deskXZ(a)[0] - nx, deskXZ(a)[1] - nz) - Math.hypot(deskXZ(b)[0] - nx, deskXZ(b)[1] - nz))[0];
      if (best) { r.desk = { f: near.f, d: best }; return r.desk; }
    }
    for (let f = 0; ; f++) {
      if (f >= this.floors) this.floors = f + 1;
      // a lead coming back takes the desk its helpers still sit around; nobody takes a desk whose pod another team still uses
      const d = LAYOUT.desks.find(d => this.deskFree(f, d) && this.deskSlots(f, d).some(o => this.lead(o) === r))
        || LAYOUT.desks.find(d => this.deskFree(f, d) && !this.deskSlots(f, d).length);
      if (d) { r.desk = { f, d }; return r.desk; }
    }
  }
  /** A film knows where someone really sat (the journal's `seat` lines): that place, when it is free. Live, nobody calls it. */
  hint(id, seat) {
    (this.hints ??= new Map()).set(id, seat);
    const r = this.recs.get(id); if (!r || r.leaving) return;
    const want = seat.desk, mine = r.desk;
    if (want && mine && (mine.f !== want.f || mine.d !== want.d) && this.deskFree(want.f, want.d) && !this.deskSlots(want.f, want.d).length) {
      if (want.f >= this.floors) this.floors = want.f + 1;
      r.desk = { f: want.f, d: want.d };
      if (r.step?.k === 'desk') this.setStep(r, this.deskStep(r));
    }
  }
  hintedDesk(r) {
    const want = this.hints?.get(r.id)?.desk;
    return want && this.deskFree(want.f, want.d) && !this.deskSlots(want.f, want.d).length ? want : null;
  }
  releaseDesk(r) { r.desk = null; }
  releaseSlot(r) { r.slot = null; }
  releaseSeat(r) { r.seat = null; }
  leaveCoffee(r) { for (const f of Object.keys(this.coffee)) { const q = this.coffee[f], i = q.indexOf(r.id); if (i >= 0) q.splice(i, 1); } }
  seatTaken(kind, f, i) { for (const o of this.recs.values()) if (o.seat && o.seat.kind === kind && o.seat.f === f && o.seat.i === i) return true; return false; }
  spotTaken(a, f, i) { for (const o of this.recs.values()) if (o.spot && o.spot.a === a && o.spot.f === f && o.spot.i === i) return true; return false; }
  freeSpots(a, f, n) { const out = []; for (let i = 0; i < n; i++) if (!this.spotTaken(a, f, i)) out.push(i); return out; }
  /** sociable ones sit at the café table, the rest in the lounge */
  pickSeat(r, f) {
    const free = (kind, n) => { for (let i = 0; i < n; i++) if (!this.seatTaken(kind, f, i)) return i; return -1; };
    const lounge = free('lounge', LAYOUT.lounge(f)), cafe = free('cafe', LAYOUT.cafe);
    if (cafe >= 0 && (this.traits(r).social > 0.45 || lounge < 0)) return { kind: 'cafe', f, i: cafe, style: 'cafe' };
    return lounge >= 0 ? { kind: 'lounge', f, i: lounge, style: LAYOUT.loungeStyle(f) || 'sofa' } : null;
  }

  // ---- where should they be? ------------------------------------------------------------------------------------------
  decide(r, instant = false) {
    const opt = instant ? { walk: 0 } : {};
    this.leaveCoffee(r); r.spot = null;
    if (this.isReviewer(r)) { // work to collect goes first: straight to the lead's desk, then to the quiet corner
      const i = r.queue.findIndex(q => q.type === 'review');
      if (i >= 0 && !r.reviewTask) { r.queue.unshift(...r.queue.splice(i, 1)); if (this.startAction(r)) return; }
      this.goToQa(r, opt); return;
    }
    const lead = this.isHelper(r) ? this.lead(r) : null;
    if (lead?.desk) {
      const pod = lead.desk, key = r.kickoff, room = key ? this.rooms[key] : null;
      if (room && room.team === lead.id && !r.briefed && !r.seatedOnce) {
        const n = LAYOUT.rooms[room.room];
        let i = r.meetSeat?.key === key ? r.meetSeat.i : -1;
        for (let k = 0; k < n && i < 0; k++) if (![...this.recs.values()].some(o => o.meetSeat?.key === key && o.meetSeat.i === k)) i = k;
        if (i >= 0) { r.meetSeat = { key, i }; this.setStep(r, { k: 'meeting', f: room.f, room: room.room, i }, opt); return; }
      }
      // a new helper is briefed at the lead's desk (a brief link to someone already at their own desk too: they walk over
      // on their way into the pod); briefed once, or in a kickoff, nobody is briefed twice
      if (!r.briefed && (r.pendingBrief || (!r.seatedOnce && lead.step?.k === 'desk' && this.arrived(lead)))) { this.setStep(r, { k: 'brief', f: pod.f, d: pod.d, text: r.pendingBrief?.text || null }, opt); return; }
      this.goToSlot(r, pod, opt); return;
    }
    this.releaseSlot(r);
    if (!r.desk) this.allocDesk(r);
    this.setStep(r, this.deskStep(r), opt);
  }
  goToSlot(r, pod, opt = {}) {
    if (!r.slot || r.slot.f !== pod.f || r.slot.d !== pod.d) {
      const used = new Set(this.deskSlots(pod.f, pod.d).filter(o => o !== r).map(o => o.slot.i));
      const want = this.hints?.get(r.id)?.slot;
      let i = want && want.f === pod.f && want.d === pod.d && !used.has(want.i) ? want.i : -1;
      for (let k = 0; k < LAYOUT.slots && i < 0; k++) if (!used.has(k)) i = k;
      if (i < 0) { if (!r.desk) this.allocDesk(r); this.setStep(r, this.deskStep(r), opt); return; } // a full pod: a spare desk, and stay there
      r.slot = { f: pod.f, d: pod.d, i }; this.releaseDesk(r);
    }
    this.setStep(r, { k: 'slot', f: r.slot.f, d: r.slot.d, i: r.slot.i }, opt);
  }
  goToQa(r, opt = {}) {
    const f = this.lead(r)?.desk?.f ?? this.floorOf(r);
    if (r.qa && r.qa.f !== f) r.qa = null;
    if (!r.qa) for (let i = 0; i < LAYOUT.qa && !r.qa; i++) if (![...this.recs.values()].some(o => o.qa?.f === f && o.qa.i === i)) r.qa = { f, i };
    this.setStep(r, { k: 'qa', f, i: r.qa ? r.qa.i : null }, opt); // every seat taken: wait by the door
  }
  backToDesk(r) { this.leaveCoffee(r); r.spot = null; this.releaseSeat(r); if (!r.desk && !r.slot) this.allocDesk(r); this.setStep(r, r.desk ? this.deskStep(r) : { k: 'slot', f: r.slot.f, d: r.slot.d, i: r.slot.i }); }
  joinCoffee(r) {
    const f = this.floorOf(r), q = this.coffee[f] || (this.coffee[f] = []);
    if (!q.includes(r.id)) q.push(r.id);
    const i = q.indexOf(r.id);
    this.setStep(r, i === 0 ? { k: 'brew', f } : { k: 'queue', f, i });
  }
  startExit(r) {
    r.leaving = true; this.leaveCoffee(r); r.spot = null;
    const lead = this.lead(r), pod = lead?.desk;
    const waved = this.isHelper(r) && pod && !r.wavedBye && r.seatedOnce;
    this.releaseDesk(r); this.releaseSeat(r); r.qa = null; r.reviewing = null; r.meetSeat = null; r.kickoff = null; this.releaseSlot(r); r.queue = [];
    if (waved) { r.wavedBye = true; this.setStep(r, { k: 'bye', f: pod.f, d: pod.d }); return; }
    this.setStep(r, { k: 'exit', f: 0 });
  }

  // ---- real events: the ones that make someone walk (everything else is a gesture the tab plays) ---------------------
  processEvents(events, settling) {
    const now = this.now, list = [...this.pending, ...events.filter(e => !this.processed[e.id])];
    this.pending = [];
    for (const ev of list) {
      if (this.processed[ev.id]) continue;
      if (!(now - ev.at < EVENT_KEEP_MS)) continue;
      const stub = isStub(ev) ? ev.stub : null;
      const from = stub?.side === 'from' ? null : this.rec(ev.from), to = stub?.side === 'to' ? null : this.rec(ev.to);
      if ((stub?.side !== 'from' && !from) || (stub?.side !== 'to' && !to)) {
        if (now - ev.at < 45000) this.pending.push(ev); else this.processed[ev.id] = ev.at;
        continue;
      }
      this.processed[ev.id] = ev.at;
      if (stub || weakLink(ev)) continue; // nobody moves
      const stale = settling || now - ev.at > STALE_EVENT_MS;
      switch (ev.kind) {
        case 'spawn':
          if (!to.seatedOnce) to.pendingBrief = { text: ev.text || null };
          else if (ev.linkKind === 'brief' && !stale) {
            const pod = this.lead(to)?.desk;
            if (!(to.slot && pod && to.slot.f === pod.f && to.slot.d === pod.d)) to.pendingBrief = { text: ev.text || null };
          }
          if (!stale && !to.seatedOnce) this.tryKickoff(from, to);
          break;
        case 'report':
          if (stale) { to.reports++; break; }
          from.queue.push({ type: 'present', to: to.id, text: ev.text || null, copier: true });
          break;
        case 'review': if (!stale) from.queue.push({ type: 'review', to: to.id }); break;
        case 'verdict': if (!stale) from.queue.push({ type: 'verdict', to: to.id, verdict: ev.verdict || null }); break;
        case 'handoff':
          if (stale) break;
          if (!(to.desk || to.slot)) { if (now - ev.at < 45000) { delete this.processed[ev.id]; this.pending.push(ev); } break; } // no desk yet: try again next snapshot
          from.queue.push({ type: 'present', to: to.id, handoff: true, icon: '⇄', text: `Handing over to ${to.name}${ev.text ? `: ${ev.text}` : ''}`, walk: `Off to hand over to ${to.name}`, copier: false });
          break;
        default: break;
      }
    }
    if (Object.keys(this.processed).length > 500) for (const [id, at] of Object.entries(this.processed)) if (!(now - at < EVENT_KEEP_MS + 5 * 60000)) delete this.processed[id];
  }
  startAction(r) {
    const a = r.queue.shift(); if (!a) return false;
    const to = a.to ? this.rec(a.to) : null, pod = to ? (to.desk || to.slot) : null;
    if (a.type === 'present') { // a report (printed first), or a hand-over sheet carried straight to the other desk
      if (!pod) return false;
      if (a.copier) { this.setStep(r, { k: 'collect', f: pod.f, to: a.to, text: a.text }); return true; } // fetch the printout first
      this.setStep(r, { k: 'present', f: pod.f, d: pod.d, to: a.to, text: a.text, icon: a.icon || null, walk2: a.walk || null, handoff: !!a.handoff });
      return true;
    }
    if (a.type === 'review') {
      if (!to?.desk) return false;
      const { f, d } = to.desk;
      if ([...this.recs.values()].some(o => o !== r && o.reviewing?.f === f && o.reviewing.d === d)) { r.queue.unshift(a); return false; }
      r.reviewing = { f, d }; r.qa = null;
      this.setStep(r, { k: 'review', f, d, to: a.to });
      return true;
    }
    if (a.type === 'verdict') {
      if (r.step?.k !== 'qa' || !this.arrived(r)) { r.queue.unshift(a); return false; } // the stamp lands at the QA desk
      const ok = (a.verdict?.outcome || 'allow') === 'allow', risk = a.verdict?.risk ? ` · ${a.verdict.risk} risk` : '';
      r.stampAt = this.now; r.stampEnd = this.now + STAMP_S * 1000; r.stamp = { ok, risk };
      const f = this.floorOf(r); this.qaOut[f] = (this.qaOut[f] || 0) + 1; // in-tray → out-tray
      if (r.reviewTask) r.reviewTask.stamped = true;
      if (to?.desk) r.queue.unshift({ type: 'deliver', to: a.to, ok, text: `${ok ? 'Approved' : 'Flagged'}${risk}` });
      return false;
    }
    if (a.type === 'deliver') { // walk the stamped verdict back to the lead
      if (!to?.desk) { r.reviewTask = null; return false; }
      r.qa = null;
      this.setStep(r, { k: 'handover', f: to.desk.f, d: to.desk.d, to: a.to, ok: a.ok, text: a.text });
      return true;
    }
    return false;
  }

  // ---- kickoffs ---------------------------------------------------------------------------------------------------------
  /** A real spawn: if a room on the lead's floor is free, the lead and its new helpers gather there before helpers take
   *  their desks: one or two new helpers in the huddle room, three or more in the meeting room (either, if the other is
   *  busy). Later spawns within a minute get the desk-side briefing instead. */
  tryKickoff(lead, helper) {
    if (lead.leaving || !lead.step) return false;
    const f = lead.step.f ?? 0, keyOf = room => `${f}:${room}`;
    const hostingKey = ['meeting', 'huddle'].map(keyOf).find(k => this.rooms[k]?.team === lead.id);
    if (hostingKey) { // late joiners welcome while there is a chair for them
      const room = this.rooms[hostingKey];
      if (room.expected.length >= LAYOUT.rooms[room.room]) return false;
      room.expected.push(helper.id); helper.kickoff = hostingKey; room.deadline = Math.max(room.deadline, this.now + 30000);
      return true;
    }
    if (lead.step.k !== 'desk' || !this.arrived(lead) || lead.desk?.f !== f) return false;
    const crew = [...this.recs.values()].filter(o => this.lead(o) === lead && !o.seatedOnce).length || 1; // helpers spawned together are all here already
    const room = (crew >= 3 ? ['meeting', 'huddle'] : ['huddle', 'meeting']).find(name => {
      const cur = this.rooms[keyOf(name)];
      return !cur?.team && LAYOUT.rooms[name] >= Math.min(crew, 4) && !((cur?.cool?.[lead.id] || 0) > this.now);
    });
    if (!room) return false;
    const key = keyOf(room);
    this.rooms[key] = { f, room, team: lead.id, expected: [helper.id], session: false, deadline: this.now + ROOM_WAIT_MS, sessionAt: 0, sessionEnd: 0, cool: this.rooms[key]?.cool || {}, board: null, boardUntil: 0 };
    lead.meeting = key; helper.kickoff = key;
    this.setStep(lead, { k: 'meet', f, room });
    return true;
  }
  endKickoff(key) {
    const room = this.rooms[key];
    for (const id of room.expected) { const o = this.rec(id); if (o) { o.briefed = true; o.kickoff = null; o.meetSeat = null; } }
    const lead = this.rec(room.team);
    if (lead) { room.cool[lead.id] = this.now + ROOM_COOL_MS; lead.meeting = null; }
    if (room.session) { room.boardUntil = this.now + BOARD_KEEP_MS; room.board = { team: room.team, crew: room.expected }; }
    room.team = null; room.expected = []; room.session = false;
  }
  updateRooms() {
    const now = this.now;
    for (const [key, room] of Object.entries(this.rooms)) {
      for (const [id, until] of Object.entries(room.cool || {})) if (until < now) delete room.cool[id];
      if (!room.team) { if (room.boardUntil < now && !Object.keys(room.cool || {}).length) delete this.rooms[key]; else if (room.boardUntil < now) room.board = null; continue; }
      const lead = this.rec(room.team);
      if (!lead || lead.leaving) { this.endKickoff(key); continue; }
      const crew = room.expected.map(id => this.rec(id)).filter(o => o && !o.leaving);
      const there = o => o.step?.k === 'meeting' && this.arrived(o);
      if (!room.session) {
        if (lead.step?.k === 'meet' && this.arrived(lead) && crew.length && crew.every(there)) { room.session = true; room.sessionAt = now; room.sessionEnd = now + SESSION_MS; }
        else if (now > room.deadline || !crew.length) this.endKickoff(key);
      } else {
        if (crew.some(o => !there(o)) && now < room.deadline) room.sessionEnd = Math.max(room.sessionEnd, now + 3000); // wait for late joiners
        if (now > room.sessionEnd) this.endKickoff(key);
      }
    }
  }

  // ---- one worker, one tick ---------------------------------------------------------------------------------------------
  tick(r) {
    const now = this.now, k = r.step.k, here = this.arrived(r), t = this.t(r);
    if (r.leaving && !['bye', 'exit', 'out'].includes(k)) { this.startExit(r); return; }
    if (['desk', 'slot', 'break', 'qa', 'review'].includes(k) && here && r.queue.length && !r.leaving && now >= r.stampEnd && this.startAction(r)) return;
    switch (k) {
      case 'in': if (t > WIPE_S) this.decide(r); break;
      case 'desk': case 'slot': {
        if (here) { r.seatedOnce = true; r.pendingBrief = null; }
        if (this.isHelper(r)) {
          // a helper away from its lead's pod moves in, but only once a seat there is free: with the pod full it keeps
          // its spare desk instead of walking over to find no seat and back again, forever
          const lead = this.lead(r), pod = lead?.desk;
          if (pod && (!r.slot || r.slot.f !== pod.f || r.slot.d !== pod.d) && lead.step?.k === 'desk' && this.arrived(lead) && this.deskSlots(pod.f, pod.d).length < LAYOUT.slots) { this.decide(r); break; }
          if (!lead && r.slot) { this.decide(r); break; }
          break;
        }
        if (this.isReviewer(r) || !here) break;
        if (!this.idle(r) || this.onJob(r)) { r.restUntil = 0; break; }
        // just finished: stay seated a while before stretching and heading for coffee; sleepy people linger, coffee lovers
        // get up sooner. A real hand-back to you keeps them at the desk 90–150 s, so work and owner are found together.
        if (!r.restUntil) {
          const tr = this.traits(r), handedBack = r.readyAt && now - r.readyAt < READY_FRESH_MS && !r.agent.delegator;
          r.restUntil = now + 1000 * (handedBack ? this.rnd(90, 150) : 20 + 40 * clamp(this.rnd(0, 0.45) + 0.35 * tr.sleepy + 0.2 * (1 - tr.coffee), 0, 1));
        }
        if (now >= r.restUntil) { r.restUntil = 0; this.setStep(r, { k: 'stretch', f: r.step.f, d: r.step.d }, { walk: 0 }); }
        break;
      }
      case 'brief':
        if (here) { r.briefed = true; r.pendingBrief = null; }
        if (t > BRIEF_S) { const pod = this.lead(r)?.desk; if (pod) this.goToSlot(r, pod); else this.decide(r); }
        break;
      case 'meeting': {
        const room = r.kickoff ? this.rooms[r.kickoff] : null, lead = this.lead(r);
        if (!room || !lead || room.team !== lead.id) { r.meetSeat = null; r.kickoff = null; r.briefed = true; this.decide(r); }
        break;
      }
      case 'meet': if (!r.meeting || this.rooms[r.meeting]?.team !== r.id) { r.meeting = null; this.decide(r); } break;
      case 'collect':
        if (t > COLLECT_S) {
          const to = this.rec(r.step.to), pod = to ? (to.desk || to.slot) : null;
          if (pod) this.setStep(r, { k: 'present', f: pod.f, d: pod.d, to: r.step.to, text: r.step.text, icon: null, walk2: null, handoff: false });
          else this.afterTrip(r);
        }
        break;
      case 'present':
        if (t > HANDBACK_S) {
          const to = this.rec(r.step.to);
          if (to && !r.step.handoff) to.reports++; // the printout joins the lead's pile (a hand-over sheet is not a report)
          this.afterTrip(r);
        }
        break;
      case 'review':
        if (t > REVIEW_S) { r.reviewTask = { to: r.step.to, stamped: false }; r.reviewing = null; this.goToQa(r); }
        break;
      case 'handover': if (t > HANDOVER_S) { r.reviewTask = null; this.goToQa(r); } break;
      case 'qa': { // waiting by the review room's door: a seat that frees up goes to the next in line
        if (r.step.i === null && here) { const f = r.step.f; for (let i = 0; i < LAYOUT.qa; i++) if (![...this.recs.values()].some(o => o.qa?.f === f && o.qa.i === i)) { this.goToQa(r); break; } }
        break;
      }
      case 'stretch': if (this.onJob(r)) { this.backToDesk(r); break; } if (t > STRETCH_S) { r.deskBreak = this.rand() < 0.3; this.joinCoffee(r); } break;
      case 'queue': {
        if (!this.idle(r) || this.onJob(r)) { this.backToDesk(r); break; }
        const i = (this.coffee[r.step.f] || []).indexOf(r.id);
        if (i < 0) { this.joinCoffee(r); break; }
        if (i < r.step.i) this.setStep(r, i === 0 ? { k: 'brew', f: r.step.f } : { k: 'queue', f: r.step.f, i });
        break;
      }
      case 'brew': {
        if (!this.idle(r) || this.onJob(r)) { this.backToDesk(r); break; }
        if (t > BREW_S) {
          this.leaveCoffee(r);
          const f = r.step.f, seat = r.deskBreak ? null : this.pickSeat(r, f);
          r.breakI = 0; r.breakT = 0;
          if (seat) { r.seat = seat; this.setStep(r, { k: 'break', f, seat, b: 0 }); }
          else if (r.desk) { r.deskBreak = true; this.setStep(r, { k: 'break', f: r.desk.f, d: r.desk.d, atDesk: true, b: 0 }); }
          else this.setStep(r, { k: 'break', f, stand: true, b: 0 });
        }
        break;
      }
      case 'break': {
        if (!this.idle(r) || this.onJob(r)) { this.backToDesk(r); break; }
        if (!here) break;
        const style = r.step.seat?.style || 'sofa', c = BREAK_CYCLES[style];
        if (!r.breakT) { r.breakI = r.step.b || 0; r.breakT = r.step.since + r.step.walk * 1000 + c[r.breakI % c.length][1] * 1000; }
        for (let guard = 0; guard < c.length * 2 && now >= r.breakT; guard++) {
          r.breakI++;
          const [anim, dur] = c[r.breakI % c.length];
          r.breakT += dur * 1000;
          if (anim === 'excursion') { r.breakI++; r.breakT += c[r.breakI % c.length][1] * 1000; if (this.excursion(r)) break; }
        }
        break;
      }
      case 'ambient':
        if ((!this.idle(r) || this.onJob(r)) && (r.step.a !== 'wc' || t > 2)) { this.backToDesk(r); break; }
        if (t > (r.step.dur || 7)) { r.spot = null; this.backToBreak(r); }
        break;
      case 'bye': if (t > BYE_S) this.setStep(r, { k: 'exit', f: 0 }); break;
      case 'exit': if (t > EXIT_S) this.setStep(r, { k: 'out', f: 0 }, { walk: OUT_S }); break;
      case 'out': if (here) this.recs.delete(r.id); break;
      default: break;
    }
  }
  afterTrip(r) { const pod = this.isHelper(r) ? this.lead(r)?.desk : null; if (pod) this.goToSlot(r, pod); else this.decide(r); }
  backToBreak(r) {
    r.breakT = 0;
    if (r.seat) this.setStep(r, { k: 'break', f: r.seat.f, seat: r.seat, b: r.breakI });
    else if (r.desk) this.setStep(r, { k: 'break', f: r.desk.f, d: r.desk.d, atDesk: true, b: r.breakI });
    else this.setStep(r, { k: 'break', f: this.floorOf(r), stand: true, b: r.breakI });
  }
  /** a stop away from the seat, chosen where the cycle says 'excursion'; false when there is nowhere to go */
  excursion(r) {
    const f = this.floorOf(r), tr = this.traits(r), roll = this.rand();
    const go = (a, i, dur, extra = {}) => { r.spot = { a, f, i }; this.setStep(r, { k: 'ambient', a, f, i, dur, ...extra }); return true; };
    const jitter = () => this.rnd(0.75, 1.3);
    const wc = this.freeSpots('wc', f, LAYOUT.wcs)[0]; // the standard ones before the accessible one
    if (wc !== undefined && this.rand() < 0.12) return go('wc', wc, this.rnd(6, 10));
    const bar = this.freeSpots('bar', f, LAYOUT.bar)[0];
    if (bar !== undefined && roll < 0.35 && (tr.social > 0.4 || tr.coffee > 0.5)) return go('bar', bar, 12 * jitter());
    const onBreak = o => o !== r && !o.leaving && o.step?.k === 'break' && o.step.f === f && o.seat && this.arrived(o);
    if (LAYOUT.foos(f) && this.freeSpots('foos', f, 2).length === 2 && roll < 0.6) {
      const mate = this.live().find(onBreak);
      if (mate) {
        const dur = 16;
        mate.spot = { a: 'foos', f, i: 1 }; this.setStep(mate, { k: 'ambient', a: 'foos', f, i: 1, dur });
        return go('foos', 0, dur);
      }
    }
    const plants = this.freeSpots('water', f, LAYOUT.plants), windows = this.freeSpots('window', f, LAYOUT.windows);
    if (tr.plants > 0.55 && roll < 0.5 && plants.length) return go('water', plants[Math.floor(this.rand() * plants.length)], 5 * jitter());
    if (!this.spotTaken('cooler', f, 0) && roll < 0.42 && tr.coffee < 0.6) return go('cooler', 0, 7 * jitter());
    if (roll < 0.75 && windows.length) return go('window', windows[Math.floor(this.rand() * windows.length)], 7 * jitter());
    const buddy = this.live().find(o => onBreak(o) && tr.social + this.traits(o).social > 0.9);
    if (buddy) return go('chat', hash(r.id) % 4, 9 * jitter(), { buddy: buddy.id });
    return false;
  }
  pruneFloors() {
    const now = this.now, used = k => [...this.recs.values()].some(r => r.step?.f === k || r.desk?.f === k || r.slot?.f === k);
    for (let k = 1; k < this.floors; k++) { if (used(k)) delete this.floorEmpty[k]; else this.floorEmpty[k] ??= now; }
    while (this.floors > 1 && this.floorEmpty[this.floors - 1] && now - this.floorEmpty[this.floors - 1] >= FLOOR_KEEP_MS) { delete this.floorEmpty[this.floors - 1]; this.floors--; }
  }

  // ---- what the tabs get ---------------------------------------------------------------------------------------------
  plan() {
    const workers = {};
    for (const r of this.recs.values()) {
      const p = { gen: r.gen, name: r.name, seq: r.seq, step: r.step, from: r.from, enteredAt: r.enteredAt, leaving: r.leaving, readyAt: r.readyAt, errors: r.errors, reports: r.reports,
        desk: r.desk, slot: r.slot, seat: r.seat, qa: r.qa, review: r.reviewTask, stampAt: r.stampAt, stamp: r.stamp || null, reviewing: r.reviewing, kickoff: r.kickoff, meeting: r.meeting, seated: r.seatedOnce };
      if (r.missingSince) p.agent = r.agent; // no longer in the snapshot: a tab that has not met them still needs to draw them leaving
      workers[r.id] = p;
    }
    const rooms = {};
    for (const [key, room] of Object.entries(this.rooms)) if (room.team || room.board) rooms[key] = { f: room.f, room: room.room, team: room.team, crew: room.expected, session: room.session, sessionAt: room.sessionAt, board: room.board };
    return { floors: this.floors, workers, rooms, qaOut: this.qaOut };
  }
}
const thoughtKey = a => `${a.thought.kind}|${a.thought.text}|${a.thought.at}`;
/** enough of a step to find where someone is standing (a tab that joins late starts the walk from there) */
function stepPlace(s) { const { k, f, d, i, a, room, seat, stand, atDesk, buddy } = s; return { k, f, d, i, a, room, seat, stand, atDesk, buddy }; }
