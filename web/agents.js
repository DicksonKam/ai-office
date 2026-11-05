// Workers: map live agent records onto chibi characters and draw the director's plan (director.js decides who sits where
// and who goes where, so every tab shows one office); this file turns a plan step into a walk and a pose, and plays the
// small gestures and bubbles of the real interaction events plus some ambient office life.
import * as THREE from 'three';
import { Chibi, lookFor } from './character.js';
import { buildOffice, FLOOR_H, FLOOR_COLS, FLOOR_ROWS, stairHeight, PAL } from './office.js';
import { toon, mesh, box, cyl } from './toon.js';
import { Threads } from './threads.js';
import { freezeStatic } from './merge.js';
import { NAMES, hash, pick, VENDOR } from './palette.js';
import { iconFor } from './bubbles.js';
import { setMode } from './ghost.js';
import { buildSite } from './site.js';
import { breakAnim } from './director.js';
import { waitingOnJob } from './jobs.js';
const JOB_SWIVEL = -0.52; // the chair turned part of the way toward the laptop beside the desk; the head does the rest
import { pulseJobLights } from './jobprops.js';

const SPEED = 2.4;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const STANDING = new Set(['brief', 'present', 'collect', 'byeWave', 'ambient', 'handover', 'review', 'meet', 'wipe']);
const PERSONAL_SPACE = 0.55; // how far apart standing people keep, centre to centre: a chibi head is about half a metre wide
// idle picks for finished helpers / reviewers: [anim, min s, max s], drawn at random (never a fixed loop)
const HELPER_IDLE = [['idle', 3, 7], ['idle', 2.5, 6], ['stretch', 2, 3.2], ['shoulders', 1.4, 2.2], ['leanback', 3, 6], ['phone', 3, 6]];
const QA_IDLE_SIT = [['idle', 3, 6], ['read', 4, 9], ['read', 3, 7], ['leanback', 3, 5], ['shoulders', 1.4, 2]];
const QA_IDLE_STAND = [['idle', 3, 6], ['inspect', 4, 9], ['inspect', 3, 6], ['shoulders', 1.4, 2]];
// the camera looks along -(1, 1.32, 1): a person facing +x+z faces the viewer
const CAM_HEADING = Math.atan2(1, 1);
// "finished · your turn": a top-level session that worked at least this long and went idle (the journal and the day
// board use the same rule; snapshot.config.finishedMinMs overrides it). The flag stays until the session works again or
// walks out, which it does after leaveAfterIdleMs (snapshot.config, 6 min by default); a minute of slack on top.
const FINISHED_MIN_MS = 2 * 60 * 1000, LEAVE_AFTER_IDLE_MS = 6 * 60 * 1000, READY_SLACK_MS = 60 * 1000;
const SETTLE_GAP_MS = 30000;            // a first snapshot, or one after this long a silence: what happened before is not acted out
const LATE_S = 3;                       // a step this old when a tab first sees it starts from where they came from
const CATCH_UP_S = 0.3;                 // a step this old when it reaches a tab: the walk is advanced by the time gone
const WALK_DRIFT_MS = 2000;             // a walk this far past its planned arrival is over (a slow tab, a crowd in the way)
const WALK_LAG_S = 2;                   // a walk this far behind the plan jumps ahead (the tab stalled); less is made up gradually
const EVENT_KEEP_MS = 60 * 60 * 1000;   // processed event ids are forgotten after an hour; older events are ignored outright
const IMPOSTOR_MIN_S = 10;              // a dimmed person's frozen copy is rebuilt at most this often
// invented beats between tool calls: never a thinking pose (those mean real thinking)
const PAUSES = [['mouse', 2.2, 3.8], ['mouse', 1.8, 3.2], ['read', 2.4, 4], ['shoulders', 1.4, 1.7]];
// "finished · your turn" and its hand-back only show once the state has held this long (a 3 s blip of work, or a
// finish that is followed at once by more work, must not flash the flag on and off)
const READY_DEBOUNCE_MS = 8000;
const READY_FRESH_MS = 20000;           // a finish this recent still gets the hand-back and the long stay at the desk
const HISTORY_MAX = 12;                // the worker card's "recent actions": a ring of this many real actions per worker
const LINKS_MAX = 40;                  // the worker card's "Messages": this worker's links today (never evicted by thoughts)
const HANDBACK_S = 5.2;                 // a helper's report at the lead's desk: long enough to be seen
// Links (Milestone 11): an event may carry `confidence` ('declared' | 'structural' | 'artifact' | 'inferred'; missing →
// structural, today's vendor-native evidence), `channel` (how it travelled), `linkKind` ('brief' arrives as a spawn,
// 'reply' as a report) and `stub: { side, label }` when one end is a party the office does not know. Only declared and
// structural links drive what people do (walks, briefings, hand-overs); weaker links only change what is drawn.
const CONF_RANK = { declared: 3, structural: 3, artifact: 2, inferred: 1 };
const confRank = ev => CONF_RANK[ev?.confidence] ?? 3;
const weakLink = ev => confRank(ev) < 3;
const stubOf = ev => (ev?.stub && typeof ev.stub === 'object' && (ev.stub.side === 'from' || ev.stub.side === 'to') ? ev.stub : null);
const stubLabel = stub => { const l = String(stub?.label ?? '').replace(/^name:/, '').trim(); return l || 'someone outside the office'; };
/** a bubble for a link event: solid amber for declared / structural, the grey ambient look for artifact and a "?" chip on
 *  top for inferred (bubbles.js reads `cls`); `calm` is the quiet sage look of an approval */
function linkBubble(ev, icon, text, calm = false) {
  const cls = weakLink(ev) ? (ev.confidence === 'inferred' ? 'weak inferred' : 'weak') : calm ? 'calm' : '';
  return cls ? { icon, text, kind: 'event', cls } : { icon, text, kind: 'event' };
}
// the hour for greetings: the same `?hour=` override main.js uses for the daylight
const HOUR_Q = (() => { try { const q = new URLSearchParams(globalThis.location?.search || ''); const h = q.has('hour') ? Number(q.get('hour')) : NaN; return Number.isFinite(h) ? ((h % 24) + 24) % 24 : null; } catch { return null; } })();
const GREET = {
  morning: [['good morning~', '👋'], ['morning!', '👋']],
  afternoon: [['good afternoon~', '👋'], ['afternoon!', '👋']],
  evening: [['good evening~', '👋'], ['evening!', '👋']],
  late: [['night owl mode~', '🌙'], ['late one tonight~', '🌙']],
};
/** an arrival's hello, by the local hour (ambient: invented office life) */
export function greetingFor(id) {
  const d = new Date(), h = HOUR_Q ?? d.getHours() + d.getMinutes() / 60;
  const set = GREET[h < 5 || h >= 22 ? 'late' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'];
  const [text, icon] = set[hash(String(id)) % set.length];
  return { text, icon, kind: 'ambient' };
}

// asking: a soft amber pool on the floor under someone who has stood up to catch your eye
let poolTex = null;
function poolTexture() {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // a flat-topped falloff: the person's own body covers the centre from this camera, so the pool must still read
  // around the feet, out to the ring
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.6, 'rgba(255,255,255,0.85)'); grad.addColorStop(0.88, 'rgba(255,255,255,0.4)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}
const poolGeo = new THREE.CircleGeometry(0.7, 32);
const ringGeo = new THREE.RingGeometry(0.645, 0.68, 48); // a thin mustard edge (about 2 px at a close zoom) that breathes
const POOL_Y = 0.03;       // above the carpet (0.006), the team rugs (0.0068) and the team threads (0.024)
const RING_MS = 3200;      // one breath of the ring

// errors piling up: a crumpled page tossed at the desk bin (the bin's crumple count itself is the real error count)
const tossGeo = new THREE.IcosahedronGeometry(0.036, 0);
const tossMat = new THREE.MeshLambertMaterial({ color: 0xf1ede4, flatShading: true }); tossMat.userData.shared = true; // a floor's dispose() leaves it alone
const BIN = { x: 1.12, y: 0.25, z: 0.15 }; // desk-local, see makePod in office.js

/** "finished · your turn": a paper-white pennant with a sage tick on a 0.78 m pole, built here (office.js owns the
 *  asking flag); white cloth with an ink edge reads against the oak desk and stays calm beside the amber ask */
function buildDoneFlag(desk, floorGroup) {
  const POLE = 0.78;
  const g = new THREE.Group(); g.position.set(-0.74, 0.755, 0.33); g.visible = false; g.userData.dynamic = true; g.name = 'done-flag';
  g.add(cyl(0.035, 0.04, 0.03, toon(PAL.slateDark), { y: 0.015 }, 12));
  g.add(cyl(0.01, 0.01, POLE, toon(PAL.slate), { y: 0.03 + POLE / 2 }, 6));
  const cloth = new THREE.Group(); cloth.position.y = 0.03 + POLE - 0.01; g.add(cloth);
  const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(0.32, -0.095); tri.lineTo(0, -0.2); tri.closePath();
  cloth.add(mesh(new THREE.ShapeGeometry(tri), toon(PAL.paper, { side: THREE.DoubleSide }), { outline: 0.007, cast: false }));
  for (const zz of [0.004, -0.004]) { // the tick, on both faces
    const a = box(0.058, 0.024, 0.004, toon(PAL.sageDeep), { x: 0.064, y: -0.118, z: zz, cast: false }); a.rotation.z = -0.8;
    const b = box(0.105, 0.024, 0.004, toon(PAL.sageDeep), { x: 0.118, y: -0.1, z: zz, cast: false }); b.rotation.z = 0.75;
    cloth.add(a); cloth.add(b);
  }
  desk.group.add(g);
  const m = floorGroup?.userData.mode;
  if (m && m !== 'normal') setMode(g, m, { force: true, floor: true });
  return { group: g, cloth, t: 0, shownAt: 0 };
}

export class OfficeManager {
  constructor(scene, onFloors) {
    this.scene = scene; this.onFloors = onFloors;
    this.workers = new Map(); this.floors = []; this.activeFloor = 0;
    this.processed = new Map(); this.pending = []; // event id -> its time (pruned after an hour)
    this.finishedMinMs = FINISHED_MIN_MS; this.readyMs = LEAVE_AFTER_IDLE_MS + READY_SLACK_MS;
    this.readyCount = 0; // top-level sessions that just finished and have not been picked up again (HUD: "✓ N ready for you")
    this.tosses = [];
    this.ensureFloor(0);
    this.threads = new Threads(scene, this);
    this.site = buildSite(scene, this.ground);
    this.applyFloorVisibility();
  }
  get office() { return this.floors[this.activeFloor] || this.floors[0]; }
  get ground() { return this.floors[0]; }

  ensureFloor(k) {
    let built = false;
    while (this.floors.length <= k) {
      const level = this.floors.length;
      const office = buildOffice(this.scene, FLOOR_COLS, FLOOR_ROWS, { level });
      this.floors.push(office); built = true;
    }
    if (built) { this.applyFloorVisibility(); this.onFloors?.(this); } // only a new floor refits the camera (every desk allocation calls this, and a refit snaps the glide)
    return this.floors[k];
  }
  /** snapshot.config from the server (missing or partial: the defaults stand) */
  setConfig(c) {
    if (!c || typeof c !== 'object') return;
    const ms = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    this.finishedMinMs = ms(c.finishedMinMs, this.finishedMinMs);
    this.readyMs = ms(c.leaveAfterIdleMs, this.readyMs - READY_SLACK_MS) + READY_SLACK_MS;
  }
  /** the director says how many floors there are (an empty upper floor stays a while, so no build / dispose churn) */
  trimFloors(n) {
    while (this.floors.length > Math.max(1, n)) {
      const f = this.floors.pop(); f.dispose();
      if (this.activeFloor >= this.floors.length) this.setActiveFloor(this.floors.length - 1);
      this.onFloors?.(this);
    }
    this.applyFloorVisibility();
  }
  /** forget processed event ids after an hour (the server only resends the last few minutes) */
  pruneEvents(t = Date.now()) {
    for (const [id, at] of this.processed) if (!(t - at < EVENT_KEEP_MS + 5 * 60000)) this.processed.delete(id);
  }
  setActiveFloor(k) {
    k = clamp(k, 0, this.floors.length - 1);
    if (k === this.activeFloor) return;
    this.activeFloor = k;
    this.applyFloorVisibility();
    this.onFloors?.(this);
  }
  modeFor(k) { return k === this.activeFloor ? 'normal' : k === this.activeFloor + 1 ? 'ghost' : k < this.activeFloor ? 'dim' : 'hidden'; }
  applyFloorVisibility() {
    // active floor solid, the one above a faint ghost, floors below dimmed, anything higher hidden (it would only pile up)
    this.floors.forEach((f, k) => {
      const mode = this.modeFor(k);
      f.group.visible = mode !== 'hidden';
      if (mode !== 'hidden') { setMode(f.group, mode); f.setMode(mode); }
      f.setCeiling(k + 1 < this.floors.length);
    });
    for (const w of this.workers.values()) w.applyGhost();
  }
  floorCounts() { const c = this.floors.map(() => 0); for (const w of this.workers.values()) if (!w.done && c[w.floor] !== undefined) c[w.floor]++; return c; }

  sync(agents, events, now, plan) {
    now = Number(now) || Date.now();
    // the server's clock (plan times are in it): a message that arrives late must not make it look slow, so the least
    // delayed one sets it, with a slow decay in case the clocks really do differ
    const off = now - Date.now(); this.clockOffset = this.clockOffset === undefined ? off : Math.max(off, this.clockOffset - 50);
    // what happened before the page was looking (or before a long silence) is recorded, not acted out
    const settling = !(now - this.lastSyncAt < SETTLE_GAP_MS); this.lastSyncAt = now;
    this.ensureFloor(Math.max(1, plan.floors) - 1);
    const ids = new Set(agents.map(a => a.id));
    // parents first (a link-adopted helper may arrive with parentId set but no depth); a parent that helpers point to is a
    // lead even if its own record still says member (a cross-vendor adoption the server has not re-roled yet)
    const depthOf = a => (Number.isFinite(a.depth) ? a.depth : a.parentId ? 1 : 0);
    const ordered = [...agents].sort((a, b) => depthOf(a) - depthOf(b));
    const parents = new Set(agents.filter(a => a.parentId && ids.has(a.parentId) && a.role !== 'reviewer').map(a => a.parentId));
    // someone leaving is no longer in the snapshot, but a tab that has not met them still draws them going
    for (const [id, p] of Object.entries(plan.workers)) if (!ids.has(id) && p.agent && !this.workers.has(id) && p.step.k !== 'out') ordered.push(p.agent);
    for (let a of ordered) {
      if (parents.has(a.id) && (a.role || 'member') === 'member') a = { ...a, role: 'lead' };
      const p = plan.workers[a.id]; if (!p) continue;
      let w = this.workers.get(a.id);
      if (w && w.gen !== p.gen) { w.finish(); this.workers.delete(a.id); w = null; } // gone and back: a fresh arrival
      if (!w) { if (p.step.k === 'out') continue; w = new Worker(a, this, p); this.workers.set(a.id, w); }
      w.applyAgent(a, now);
    }
    // three passes: everyone lets go of what the plan took away before anyone takes it up, then people move
    const live = [...this.workers.values()].filter(w => !w.done);
    for (const w of live) { const p = plan.workers[w.id]; if (!p) { if (w.planStep?.k !== 'out') w.finish(); continue; } w.letGo(p); }
    for (const w of live) { const p = plan.workers[w.id]; if (p && !w.done) w.takeUp(p); }
    for (const w of live) { const p = plan.workers[w.id]; if (p && !w.done) w.followPlan(p, now); }
    for (const [id, w] of this.workers) if (w.done) this.workers.delete(id);
    this.trimFloors(plan.floors);
    this.applyRooms(plan.rooms || {}, now);
    this.qaOut = plan.qaOut || {};
    this.processEvents(events || [], now, settling);
  }
  processEvents(events, now, settling = false) {
    const list = [...this.pending, ...events.filter(e => !this.processed.has(e.id))];
    this.pending = [];
    for (const ev of list) {
      if (this.processed.has(ev.id)) continue;
      if (!(now - ev.at < EVENT_KEEP_MS)) continue; // older than the id memory: never act it out (or file its report) twice
      // a stub end (a party the office does not know) has no worker: only the known end must be in
      const stub = stubOf(ev);
      const from = stub?.side === 'from' ? null : this.workers.get(ev.from), to = stub?.side === 'to' ? null : this.workers.get(ev.to);
      const missing = (stub?.side !== 'from' && (!from || from.done)) || (stub?.side !== 'to' && (!to || to.done));
      if (missing) {
        if (now - ev.at < 45000) this.pending.push(ev); else this.processed.set(ev.id, ev.at);
        continue;
      }
      this.processed.set(ev.id, ev.at);
      recordEvent(ev, from, to, stub); // the card's recent actions and messages, at the event's own time (stale replays included)
      const stale = settling || now - ev.at > 60000;
      if (stub) { if (!stale) this.actStub(ev, from || to, stub); continue; } // no walking or handing to someone who is not here
      from.noteLink(to.id, ev); to.noteLink(from.id, ev); // the thread's line style follows the strongest link between the two
      if (weakLink(ev)) { if (!stale) this.actWeak(ev, from, to); continue; } // artifact / inferred: drawn, never acted out
      const txt = ev.text ? `: ${ev.text}` : '';
      switch (ev.kind) {
        case 'spawn': { // a vendor spawn, or a `brief` link: the new helper gets briefed at the lead's desk (or in a kickoff)
          if (stale) break;
          if (ev.linkKind === 'brief' && to.seatedOnce && to.slot && to.lead?.desk === to.slot.pod) { // already seated in the team's pod: a desk-side brief, no walk
            from.react('talk', 3.4, { lookAt: to, bubble: { icon: '📋', text: `Briefing ${to.name}${txt}`, kind: 'event' } }); to.react('listen', 3.4, { lookAt: from }); to.mark('!');
            break;
          }
          from.react('call', 3, { lookAt: to, bubble: { icon: '📣', text: `Calling for help: ${ev.text || to.name}`, kind: 'event' } }); from.mark('!');
          break;
        }
        case 'message':
          if (stale) break;
          from.react('talk', 2.8, { lookAt: to, bubble: { icon: '📨', text: `To ${to.name}${txt}`, kind: 'event' } });
          to.react('listen', 2.8, { lookAt: from }); to.mark('📩'); // one bubble per message: the sender's
          break;
        case 'report': { // printed at the print island, carried over by hand (a `reply` link is a report too)
          if (!stale) this.threads?.pulse(from.id); // the team thread flashes for the real report (the walk is in the plan)
          break;
        }
        case 'approval': // a human decision relayed: a calm nod on the receiver, no walk
          if (stale) break;
          to.react('nod', 2.8, { lookAt: from, bubble: linkBubble(ev, '👍', `approved${txt}`, true) });
          from.react('talk', 1.6, { lookAt: to });
          break;
        case 'launch': // structure, not a message: the launched agent says once who started it
          if (!stale) to.react('nod', 2.8, { bubble: linkBubble(ev, '▶', `started by ${from.name}`) });
          break;
        default: break;
      }
    }
  }
  /** a link with one end outside the office: the known end says so in a bubble (no walk, no hand-over) */
  actStub(ev, w, stub) {
    if (!w || w.done) return;
    const label = stubLabel(stub), gotIt = stub.side === 'from'; // gotIt: the known end is the receiver
    const txt = ev.text ? `: ${ev.text}` : '';
    const ok = (ev.verdict?.outcome || 'allow') === 'allow';
    let icon = '🔗', text = `${ev.kind} ${gotIt ? 'from' : 'to'} ${label}${txt}`, anim = gotIt ? 'listen' : 'talk', calm = false;
    switch (ev.kind) {
      case 'spawn': [icon, text] = gotIt ? ['📥', `brief from ${label}${txt}`] : ['📣', `calling ${label} for help${txt}`]; break;
      case 'message': [icon, text] = gotIt ? ['📥', `from ${label}${txt}`] : ['📨', `to ${label}${txt}`]; break;
      case 'report': [icon, text] = gotIt ? ['📥', `${ev.linkKind === 'reply' ? 'reply' : 'report'} from ${label}${txt}`] : ['📝', `${ev.linkKind === 'reply' ? 'replied' : 'reported'} to ${label}${txt}`]; break;
      case 'handoff': [icon, text] = gotIt ? ['⇄', `took over from ${label}${txt}`] : ['⇄', `handed over to ${label}${txt}`]; break;
      case 'approval': [icon, text, anim, calm] = gotIt ? ['👍', `approved by ${label}${txt}`, 'nod', true] : ['👍', `approved ${label}${txt}`, 'nod', true]; break;
      case 'launch': [icon, text, anim] = gotIt ? ['▶', `started by ${label}`, 'nod'] : ['▶', `started ${label}`, 'nod']; break;
      case 'review': [icon, text] = gotIt ? ['🔍', `${label} is reviewing the work`] : ['🔍', `reviewing ${label}'s work`]; break;
      case 'verdict': [icon, text] = gotIt ? [ok ? '✅' : '⚠️', `${label} ${ok ? 'approved' : 'flagged'} the work`] : [ok ? '✅' : '⚠️', `${ok ? 'approved' : 'flagged'} ${label}'s work`]; break;
      default: break;
    }
    w.react(anim, 3, { bubble: linkBubble(ev, icon, text, calm) });
  }
  /** an artifact or inferred link: the same words as the real thing, in the grey look, and nobody moves */
  actWeak(ev, from, to) {
    const txt = ev.text ? `: ${ev.text}` : '';
    const ok = (ev.verdict?.outcome || 'allow') === 'allow';
    const say = (w, anim, icon, text, other, calm = false) => w.react(anim, 3, { lookAt: other, bubble: linkBubble(ev, icon, text, calm) });
    switch (ev.kind) {
      case 'spawn': say(from, 'talk', '📋', `Briefing ${to.name}${txt}`, to); to.react('listen', 3, { lookAt: from }); break;
      case 'message': say(from, 'talk', '📨', `To ${to.name}${txt}`, to); to.react('listen', 3, { lookAt: from }); break;
      case 'report': say(from, 'talk', '📝', `${ev.linkKind === 'reply' ? 'Replied' : 'Reported'} to ${to.name}${txt}`, to); to.react('nod', 3, { lookAt: from }); break;
      case 'review': say(from, 'inspect', '🔍', `Reviewing ${to.name}'s work`, to); break;
      case 'verdict': say(from, 'nod', ok ? '✅' : '⚠️', `${ok ? 'Approved' : 'Flagged'} ${to.name}'s work`, to); break;
      case 'handoff': say(from, 'talk', '⇄', `Handing over to ${to.name}${txt}`, to); to.react('nod', 3, { lookAt: from }); break;
      case 'approval': say(to, 'nod', '👍', `approved${txt}`, from, true); break;
      case 'launch': // work handed over without a word in the office: the desk phone rings and the worker takes the call
        to.ringAt = performance.now(); to.mark('📞');
        to.react('phone', 2.8, { bubble: linkBubble(ev, '📞', ev.confidence === 'inferred' ? `Probably work from ${from.name}` : `Work from ${from.name}`) });
        if (!from.reaction && from.state === 'work' && from.floor === to.floor) from.react('talk', 1.6, { lookAt: to });
        break;
      default: break;
    }
  }
  /** the kickoffs in the plan: each room's host and crew (the office draws its sign and door from them), the board */
  applyRooms(rooms, now) {
    this.floors.forEach((f, level) => {
      for (const name of ['meeting', 'huddle']) {
        const room = f[name], e = rooms[`${level}:${name}`]; if (!room) continue;
        const lead = e?.team ? this.workers.get(e.team) || null : null, crew = (e?.crew || []).map(id => this.workers.get(id)).filter(Boolean);
        room.team = lead; room.expected = new Set(e?.crew || []);
        const session = !!e?.session;
        if (session && !room.session && lead && now - e.sessionAt < LATE_S * 1000) { // the kickoff starts now (a tab joining later just sees people listening)
          lead.react('present', 6.8, { bubble: { icon: '🗂️', text: `Kickoff: briefing ${crew.map(w => w.name).join(', ')}`, kind: 'event' } });
          for (const w of crew) w.react('listen', 6.8, { lookAt: lead }); // the host's bubble carries the kickoff
        }
        room.session = session;
        const b = e?.board || (session ? { team: e.team, crew: e.crew } : null), key = b ? `${b.team}|${b.crew.join()}` : '';
        if (key !== (room.boardKey || '')) {
          room.boardKey = key;
          const host = b ? this.workers.get(b.team) : null;
          room.setBoard?.(b ? { title: `Kickoff · ${host?.agent.project || host?.name || ''}`, items: b.crew.map(id => this.workers.get(id)).filter(Boolean).map(w => `${w.name}: ${(w.agent.task || '').replace(/^Helper:\s*/, '')}`) } : null);
        }
      }
    });
  }
  syncProps(now) {
    for (const w of this.workers.values()) {
      const d = w.desk;
      if (!d || d.taken !== w || d.owner !== w || w.done) continue;
      const atDesk = w.state === 'work' || (w.state === 'break' && !w.seat) || (w.state === 'walk' && w.targetSeat === d.chair);
      const away = !atDesk && w.idle && w.state !== 'meet';
      const mode = w.asksYou ? 'asking' : w.agent.askTo ? 'waiting' : away ? 'away' : w.idle ? 'idle' : now - (w.lastErrorAt || -1e9) < 8000 ? 'error'
        : w.agent.waiting ? 'waiting' : w.agent.thought?.kind === 'think' ? 'thinking' : 'working';
      const start = w.agent.startedAt || w.firstSeen || (w.firstSeen = Date.now());
      d.setWorkState({ mode, accent: VENDOR[w.look.vendorKey]?.accent ?? 0xffffff, away, minutes: (Date.now() - start) / 60000,
        errors: Math.max(0, (w.errors || 0) - (w.crumpleLag || 0)), project: w.agent.project || '' }); // a tossed page joins the bin when it lands
      for (; (w.reportsShown || 0) < (w.reports || 0); w.reportsShown = (w.reportsShown || 0) + 1) d.addReport?.(); // the sheets in the in-tray, however late the tab opened
      const g = w.agent.delegator ? w.giver : null; // a work order on the monitor while another agent's work is on the desk
      d.setWorkOrder(g ? { color: VENDOR[g.look.vendorKey]?.accent ?? 0x9aa0b0, guess: !w.agent.delegator.certain } : null);
    }
    // work going on outside the turn: on the owner's desk, or their lead's if they sit at one
    const deskJobs = new Map();
    for (const w of this.workers.values()) {
      if (!w.agent.jobs?.length || w.done) continue;
      const d = w.desk?.owner === w ? w.desk : w.lead?.desk;
      if (d) deskJobs.set(d, [...(deskJobs.get(d) || []), ...w.agent.jobs]);
    }
    for (const f of this.floors) for (const d of f.desks) {
      const o = d.owner; // the lid moves under someone's hand: an empty desk's stays as it was left, for the next person to close
      const free = !!o && o.state === 'work' && o.sittingOn === d.chair && (!o.reaction || o.reaction.ambient);
      if (d.jobKit.setJobs(deskJobs.get(d) || [], Date.now(), free)) o.react('reach', 1.25);
    }
    // "finished · your turn": a sage flag on the desk of a top-level session that finished a real task, until it works
    // again or leaves
    let ready = 0;
    const wanted = new Set();
    for (const w of this.workers.values()) {
      if (!w.isReady(now)) continue;
      ready++;
      const d = w.desk;
      if (!d || d.owner !== w) continue;
      if (!d.doneFlag) d.doneFlag = buildDoneFlag(d, this.floors[d.floor]?.group);
      wanted.add(d.doneFlag);
      if (!d.doneFlag.group.visible) { d.doneFlag.group.visible = true; d.doneFlag.t = 0; d.doneFlag.group.scale.setScalar(0.01); }
    }
    this.readyCount = ready;
    for (const f of this.floors) for (const d of f.desks) if (d.doneFlag && d.doneFlag.group.visible && !wanted.has(d.doneFlag)) d.doneFlag.group.visible = false;
    this.activeFlags = [...wanted];
    for (const f of this.floors) {
      const reviewing = this.list.filter(w => w.isReviewer && !w.done && w.floor === f.level && w.reviewTask && !w.reviewTask.stamped && w.state === 'qa').length;
      f.qa.setTrays?.(reviewing, this.qaOut?.[f.level] || 0);
    }
  }
  /** workers whose real session finished and is waiting for you to pick it up (for the HUD) */
  readyList(now = performance.now()) { return this.list.filter(w => w.isReady(now)); }
  /** a crumpled page arcs from the worker's hand into the desk bin */
  tossPaper(w) {
    const d = w.desk;
    if (!d || d.owner !== w || w.sittingOn !== d.chair || (w.visFloor ?? w.floor) !== this.activeFloor) { w.crumpleLag = 0; return; }
    const ball = new THREE.Mesh(tossGeo, tossMat); ball.castShadow = false; ball.userData.dynamic = true;
    const s = w.look.scale;
    const from = { x: d.chair.x - d.x + 0.22 * s, y: 1.02 * s, z: d.chair.z - d.z + 0.05 };
    ball.position.set(from.x, from.y, from.z); d.group.add(ball);
    this.tosses.push({ ball, from, t: 0, dur: 0.62, w, desk: d });
  }
  updateTosses(dt) {
    for (let i = this.tosses.length - 1; i >= 0; i--) {
      const k = this.tosses[i]; k.t += dt;
      const p = Math.min(1, k.t / k.dur), f = k.from;
      k.ball.position.set(f.x + (BIN.x - f.x) * p, f.y + (BIN.y - f.y) * p + Math.sin(Math.PI * p) * 0.38, f.z + (BIN.z - f.z) * p);
      k.ball.rotation.set(k.t * 9, k.t * 6, 0);
      if (p >= 1) { k.ball.parent?.remove(k.ball); k.w.crumpleLag = 0; this.propsT = 1; this.tosses.splice(i, 1); } // lands: the bin shows it (real count)
    }
  }
  update(dt, now) {
    this.propsT = (this.propsT || 0) + dt;
    if (this.propsT > 0.4) { this.propsT = 0; this.syncProps(now); }
    const g = this.ground;
    let nearDoor = false;
    for (const w of [...this.workers.values()]) {
      w.update(dt, now);
      if (w.state === 'walk' && w.floor === 0 && g.door && Math.abs(w.pos.z - g.door.z) < 1.4 && w.pos.x < g.door.x + 2.0 && w.pos.x > g.door.x - 2.6) nearDoor = true;
      if (w.done) this.workers.delete(w.id);
    }
    if (g.door) g.door.wantOpen = nearDoor;
    for (const f of this.floors) f.update(dt);
    this.updateTosses(dt);
    pulseJobLights(now / 1000);
    for (const fl of this.activeFlags || []) { // pop up, then a gentle sway
      fl.t += dt;
      const k = Math.min(1, fl.t / 0.45), over = 1 + Math.sin(k * Math.PI) * 0.18;
      fl.group.scale.setScalar(Math.max(0.01, k * over));
      fl.cloth.rotation.y = Math.sin(fl.t * 2.3) * 0.22 + Math.sin(fl.t * 5.1) * 0.05;
    }
    this.threads?.update(dt, now);
    this.site?.update(dt);
    this.eventPruneT = (this.eventPruneT || 0) + dt;
    if (this.eventPruneT > 60) { this.eventPruneT = 0; this.pruneEvents(); }
  }
  /** multi-floor route: legs on each floor joined by stair climbs (points carry `floor`; climb points carry the flight) */
  route(worker, target, targetFloor) {
    const pts = [];
    let f = worker.floor, from = { x: worker.pos.x, z: worker.pos.z };
    let guard = 0;
    while (f !== targetFloor && guard++ < 8) {
      if (targetFloor > f) {
        if (!this.floors[f + 1]) break;
        const fl = this.floors[f].stair;                       // flight starting on floor f
        for (const p of this.floors[f].route(from, fl.foot).slice(1)) pts.push({ ...p, floor: f });
        pts.push({ x: fl.x, z: fl.ze, floor: f + 1, climb: { flight: fl, offset: 0 } });     // up the treads
        pts.push({ x: fl.exit.x, z: fl.exit.z, floor: f + 1 });                            // step off onto floor f+1
        from = fl.exit; f++;
      } else {
        if (!this.floors[f - 1]) break;
        const fl = this.floors[f - 1].stair;                   // flight arriving at floor f from below
        for (const p of this.floors[f].route(from, fl.exit).slice(1)) pts.push({ ...p, floor: f });
        pts.push({ x: fl.x, z: fl.ze, floor: f });                                          // to the edge of the opening
        pts.push({ x: fl.foot.x, z: fl.foot.z, floor: f - 1, climb: { flight: fl, offset: -FLOOR_H } }); // down the treads
        from = fl.foot; f--;
      }
    }
    for (const p of this.floors[f].route(from, target).slice(1)) pts.push({ ...p, floor: f });
    return pts;
  }
  /** the server's clock now */
  get serverNow() { return Date.now() + (this.clockOffset || 0); }
  get list() { return [...this.workers.values()]; }
}

/** a real interaction event in both ends' recent actions and messages (a stub end is named by its label); the entry's
 *  `meta` carries from / to / channel / confidence for the card's "Messages" list */
function recordEvent(ev, from, to, stub = null) {
  const at = ev.at, txt = ev.text ? `: ${ev.text}` : '';
  const label = stub ? stubLabel(stub) : null;
  const fromName = from ? from.name : label, toName = to ? to.name : label;
  const meta = { link: true, kind: ev.kind, linkKind: ev.linkKind || null, from: fromName, to: toName, channel: ev.channel ? String(ev.channel) : null,
    confidence: CONF_RANK[ev.confidence] ? ev.confidence : null, stub: stub ? stub.side : null };
  const rec = (w, kind, icon, text) => w?.recordAction(kind, icon, text, at, meta);
  const reply = ev.linkKind === 'reply';
  switch (ev.kind) {
    case 'spawn': rec(from, 'event', '📣', ev.linkKind === 'brief' ? `Briefed ${toName}${txt}` : `Called ${toName} for help${txt}`); rec(to, 'event', '📥', `Brief from ${fromName}${txt}`); break;
    case 'message': rec(from, 'event', '📨', `To ${toName}${txt}`); rec(to, 'event', '📩', `From ${fromName}${txt}`); break;
    case 'report': rec(from, 'report', '📝', `${reply ? 'Replied' : 'Reported'} to ${toName}${txt}`); rec(to, 'report', '📥', `${reply ? 'Reply' : 'Report'} from ${fromName}${txt}`); break;
    case 'review': rec(from, 'event', '🔍', `Reviewing ${toName}'s work`); rec(to, 'event', '🔍', `${fromName} is reviewing the work`); break;
    case 'verdict': {
      const ok = (ev.verdict?.outcome || 'allow') === 'allow', risk = ev.verdict?.risk ? ` · ${ev.verdict.risk} risk` : '';
      rec(from, 'event', ok ? '✅' : '⚠️', `${ok ? 'Approved' : 'Flagged'} ${toName}'s work${risk}`);
      rec(to, 'event', ok ? '✅' : '⚠️', `${fromName} ${ok ? 'approved' : 'flagged'} the work${risk}`);
      break;
    }
    case 'handoff': rec(from, 'event', '⇄', `Handed over to ${toName}${txt}`); rec(to, 'event', '⇄', `Took over from ${fromName}${txt}`); break;
    case 'approval': rec(from, 'event', '👍', `Approved ${toName}${txt}`); rec(to, 'event', '👍', `Approved by ${fromName}${txt}`); break;
    case 'launch': rec(from, 'event', '▶', `Started ${toName}`); rec(to, 'event', '▶', `Started by ${fromName}`); break;
    default: rec(from, 'event', '🔗', `${ev.kind} → ${toName}${txt}`); rec(to, 'event', '🔗', `${ev.kind} ← ${fromName}${txt}`); break;
  }
}

export class Worker {
  constructor(agent, mgr, plan) {
    this.id = agent.id; this.agent = agent; this.mgr = mgr; this.gen = plan.gen;
    this.name = plan.name;
    const door = mgr.ground.door;
    this.floor = 0; this.y = 0; this.climb = null;
    const start = mgr.site ? mgr.site.approach[0] : { x: door.outside.x - 0.9, z: door.outside.z };
    this.pos = new THREE.Vector3(start.x, 0, start.z);
    this.heading = Math.PI / 2; this.yaw = Math.PI / 2;
    this.state = 'spawn'; this.next = null; this.path = []; this.timer = 0; this.fade = 0;
    this.desk = null; this.slot = null; this.seat = null; this.qaSpot = null; this.parent = null; this.targetSeat = null;
    this.leaving = false; this.done = false; this.seatedOnce = false; this.pendingBrief = null;
    this.queue = []; this.reaction = null; this.marks = []; this.action = null;
    this.history = []; this.historyV = 0; this.askRec = null; // recent real actions (recordAction), newest last; V bumps on change
    this.links = []; this.linkRanks = new Map(); // links today (the card's "Messages"); other id -> strongest confidence rank seen
    this.thoughtAt = 0; this.lastThoughtKey = null; this.thinkPauseT = 12 + Math.random() * 15; this.quirkT = 8 + Math.random() * 10;
    this.enteredAt = performance.now() - Math.max(0, mgr.serverNow - plan.enteredAt); this.ambientKind = null;
    this.raiseT = rnd(2, 6); this.planSeq = null; this.planStep = null;
    this.errorTimes = []; this.readyAt = 0; this.askStand = null; this.askPool = null; this.askRing = null; this.askPoolK = 0;
    this.readyOn = false; this.readyFlipAt = 0; this.finishMoment = false; this.workAgainAt = 0; // debounced "finished · your turn"
    this.camGlanceUntil = 0; this.camLook = new THREE.Vector3(); this.camLookOn = false;
    this.buildChibi();
  }
  buildChibi() {
    const old = this.chibi;
    this.look = lookFor(this.agent);
    this.chibi = new Chibi(this.look);
    // while a reaction runs it owns the body: the state's per-frame anim must not flip-flop with it (each switch resets
    // the anim clock, so a stretch, a sip or an oops would never get past its first frame)
    const chibi = this.chibi, rawSetAnim = chibi.setAnim.bind(chibi);
    chibi.setAnim = a => rawSetAnim(this.animLock && a !== 'walk' ? this.animLock : a);
    this.traits = this.look.traits;
    if (this.look.role === 'helper') this.chibi.setProp('laptop');
    if (this.look.role === 'reviewer') this.chibi.setProp('clipboard');
    if (old) {
      this.dropImpostor(); // the snapshot shows the old outfit otherwise
      if (this.askPool) old.group.remove(this.askPool); // the pool moves to the new body (dispose would free it)
      this.chibi.setPose(old.pose, old.seatY); this.chibi.setAnim(old.anim); if (old.props.cup) this.chibi.setProp('cup'); old.dispose();
      if (this.askPool) this.chibi.group.add(this.askPool);
    }
    this.chibi.group.position.copy(this.pos); this.chibi.group.rotation.y = this.yaw;
    this.mgr.scene.add(this.chibi.group);
    this.ghosted = null; this.applyGhost();
  }
  /** People on the floors you are not looking at are context, not detail. A floor below shows its closed facade, so
   *  people inside it are not drawn at all (and not animated); people out of doors on a dimmed ground floor (the path,
   *  the porch) are drawn as one merged snapshot of their pose (a handful of draw calls instead of ~28), rebuilt only
   *  when the pose or what they hold changes, and at most every IMPOSTOR_MIN_S. Back on the active floor the live,
   *  animated character returns. Returns true when the live rig should not be animated this frame. */
  syncImpostor(dt) {
    const c = this.chibi, mode = this.ghosted;
    const want = !this.hiddenFloor && !this.stairFadeOn && (mode === 'dim' || mode === 'ghost') && this.fade > 0.02;
    if (!want) { if (this.imp) this.dropImpostor(); return false; }
    if (mode === 'dim' && !this.outdoors) { // behind the facade: nothing to draw
      if (this.imp) this.dropImpostor();
      c.group.visible = false; this._alpha = -1;
      return true;
    }
    const key = `${mode}|${c.pose}|${c.seatY}|${Object.keys(c.props).join()}`;
    this.impT = (this.impT || 0) + dt;
    if (!this.imp || (key !== this.impKey && this.impT > IMPOSTOR_MIN_S)) { c.update(0.5); this.buildImpostor(key); } // pose the live rig first (and let eased poses settle), or the snapshot is stale
    this.imp.position.copy(c.group.position); this.imp.quaternion.copy(c.group.quaternion);
    c.group.visible = false; this.imp.visible = true; this._alpha = -1; // re-evaluate the live group's visibility when the impostor goes
    return true;
  }
  buildImpostor(key) {
    this.dropImpostor();
    const src = this.chibi.group; src.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(src.matrixWorld).invert();
    const root = new THREE.Group(); root.scale.copy(src.scale);
    const vis = o => { for (let p = o; p && p !== src.parent; p = p.parent) if (!p.visible && p !== src) return false; return true; };
    src.traverse(o => {
      if (!o.isMesh || o.userData.noMode || !vis(o)) return;
      const m = new THREE.Mesh(o.geometry, o.userData.origMat || o.material);
      m.matrixAutoUpdate = false; m.matrix.multiplyMatrices(inv, o.matrixWorld); // in the group's own (unscaled) frame; the root carries the scale
      m.renderOrder = o.renderOrder;
      m.castShadow = false; m.receiveShadow = false; root.add(m);
    });
    root.updateMatrixWorld(true);
    freezeStatic(root, { ignoreDynamic: true });
    setMode(root, this.ghosted);
    this.mgr.scene.add(root); this.imp = root; this.impKey = key; this.impT = 0;
  }
  dropImpostor() {
    if (!this.imp) return;
    this.imp.traverse(o => { if (o.isMesh && o.userData.merged) o.geometry.dispose(); });
    this.imp.parent?.remove(this.imp); this.imp = null; this._alpha = -1;
  }
  applyGhost() {
    const vf = this.visFloor, fadeStep = this.stairFade;
    this._visApplied = vf; this.stairFadeOn = fadeStep;
    const mode = this.mgr.modeFor(vf);
    this.hiddenFloor = mode === 'hidden' || mode === 'ghost'; // people on the faint floor above would float over the heads below; their floor pill counts them
    // the top steps toward (or from) a floor whose people are not drawn: a faint look in between, so nobody pops
    const look = fadeStep ? 'ghost' : mode;
    if (!this.hiddenFloor && look !== this.ghosted) { this.ghosted = look; setMode(this.chibi.group, look); }
    this.chibi.group.visible = !this.hiddenFloor && this.fade > 0.02;
  }
  /** The floor a person is drawn on. On the stairs it is the floor that owns the flight (the lower one): someone walking
   *  down to the floor you are looking at is visible all the way down, not only from the stair foot. */
  get visFloor() {
    const t = this.state === 'walk' ? this.path[0] : null;
    return t?.climb ? Math.min(this.floor, t.floor) : this.floor;
  }
  /** on the last 0.6 m of a climb up to (or the first 0.6 m down from) a floor whose people are not drawn */
  get stairFade() {
    const t = this.state === 'walk' ? this.path[0] : null;
    if (!t?.climb) return false;
    const m = this.mgr.modeFor(Math.max(this.floor, t.floor));
    if (m !== 'ghost' && m !== 'hidden') return false;
    if (t.floor > this.floor) return Math.hypot(t.x - this.pos.x, t.z - this.pos.z) < 0.6;
    const fl = t.climb.flight; return Math.hypot(fl.x - this.pos.x, fl.ze - this.pos.z) < 0.6;
  }
  /** remaining fraction of an ascent's last 0.6 m toward a floor whose people are hidden (1 = not fading) */
  ascentFade() {
    const t = this.state === 'walk' ? this.path[0] : null;
    if (!t?.climb || t.floor <= this.floor) return 1;
    const m = this.mgr.modeFor(t.floor); if (m !== 'ghost' && m !== 'hidden') return 1;
    return clamp(Math.hypot(t.x - this.pos.x, t.z - this.pos.z) / 0.6, 0, 1);
  }
  /** "finished · your turn" as it stands right now (undebounced): a top-level session that finished a real task and has
   *  not worked again, left or started asking */
  isReadyRaw(now) { return !!this.readyAt && !this.done && !this.leaving && this.agent.status !== 'working' && !this.agent.asking && !waitingOnJob(this.agent, Date.now()) && now - this.readyAt < this.mgr.readyMs; }
  /** "finished · your turn" as everyone shows it (tag, desk flag, HUD, card): debounced by READY_DEBOUNCE_MS, so it
   *  turns on only once the finish has held (never for a single snapshot, which made the header count flicker) */
  isReady(now) { return this.readyOn && !this.done && !this.leaving && !this.agent.delegator; }
  /** the same finish, when another agent gave the work: it is that agent's turn ("✓ Sora's turn"), never counted as yours */
  isHandedBack(now) { return this.readyOn && !this.done && !this.leaving && !!this.agent.delegator; }
  /** a qualifying finish happened in this very snapshot (true only within the task that applied it): the office log
   *  calls it "finished" rather than "on a break" */
  justFinished() { return this.finishMoment && !this.done && !this.leaving; }
  /** settle the debounced ready state (every frame; leaving and asking end it at once) */
  updateReady(now) {
    if (this.done || this.leaving || this.agent.asking) { if (this.readyOn) { this.readyOn = false; this.presentPending = false; } this.readyFlipAt = 0; return; }
    const raw = this.isReadyRaw(now);
    if (raw === this.readyOn) { this.readyFlipAt = 0; return; }
    if (!this.readyFlipAt) this.readyFlipAt = now;
    if (now - this.readyFlipAt < READY_DEBOUNCE_MS) return;
    this.readyOn = raw; this.readyFlipAt = 0;
    if (raw) this.presentPending = true; // the hand-back plays once the finish has held
    else { this.presentPending = false; if (this.agent.status === 'working') this.readyAt = 0; } // really working again
  }

  /** the agent that gave this one its work (`agent.delegator`, from the server), when it is in the office */
  /** the chat that started this one (`agent.startedBy`), when it is in the office */
  get starter() { const id = this.agent.startedBy?.id; const w = id ? this.mgr.workers.get(id) : null; return w && !w.done ? w : null; }
  get giver() { const id = this.agent.delegator?.id; const w = id ? this.mgr.workers.get(id) : null; return w && !w.done ? w : null; }
  /** an open ask addressed to the person; one addressed to the agent that gave the work (`askTo`) is not */
  get asksYou() { return !!this.agent.asking && !this.agent.askTo; }
  /** the ask in words, addressed to whoever it is for: "Needs Sora's OK: …", "Probably needs Sora's OK: …" when the
   *  giver is only inferred, the server's own words when it is the person's */
  askLine() {
    const a = this.agent, txt = String(a.asking || '');
    if (!a.askTo) return txt;
    const nm = this.mgr.workers.get(a.askTo)?.name || 'whoever gave the work';
    let t = txt.replace(/^Needs your OK/, `Needs ${nm}'s OK`).replace(/^Question for you/, `Question for ${nm}`).replace(/^Plan ready for your review/, `Plan ready for ${nm}'s review`);
    if (t === txt) t = `For ${nm}: ${txt}`;
    return a.delegator && !a.delegator.certain ? `Probably ${t[0].toLowerCase()}${t.slice(1)}` : t;
  }
  /** "Sora's turn" for a hand-back to the giver ("probably Sora's turn" when inferred) */
  turnWords() {
    const nm = this.giver?.name || this.mgr.workers.get(this.agent.delegator?.id)?.name || 'the one who asked';
    return `${this.agent.delegator && !this.agent.delegator.certain ? 'probably ' : ''}${nm}'s turn`;
  }
  get role() { return this.agent.role || 'member'; }
  get isHelper() { return this.role === 'helper'; }
  get isReviewer() { return this.role === 'reviewer'; }
  get idle() { return this.agent.status !== 'working'; }
  get outdoors() { return this.floor === 0 && !!this.mgr.site?.isOutdoor(this.pos.x); }
  get office() { return this.mgr.floors[this.floor] || this.mgr.ground; }
  get lead() { let w = this; let guard = 0; while (w.parent && guard++ < 6) w = w.parent; return w === this ? null : w; }
  get visibleOnActiveFloor() { return this.visFloor === this.mgr.activeFloor; }
  applyAgent(a, now) {
    const prev = this.agent, met = this.appliedOnce; this.agent = a; this.appliedOnce = true;
    const key = a.thought ? `${a.thought.kind}|${a.thought.text}|${a.thought.at}` : null;
    if (key && key !== this.lastThoughtKey) {
      const t = performance.now();
      // aged by the thought's own time, so a bubble shows and goes alike in every tab (an old thought shows no bubble)
      this.lastThoughtKey = key; this.thoughtAt = t - clamp(this.mgr.serverNow - (Number(a.thought.at) || this.mgr.serverNow), 0, 3600000);
      this.recordAction(a.thought.kind, iconFor(a.thought.kind), a.thought.text, a.thought.at);
      if (!met) { /* found when the tab opened: nothing to react to */ }
      else if (a.thought.kind === 'error') {
        this.mark('💦'); this.lastErrorAt = t;
        this.errorTimes = this.errorTimes.filter(x => t - x < 60000); this.errorTimes.push(t);
        const free = !this.reaction || this.reaction.ambient;
        // errors piling up (2+ within a minute): head down for a while, then the page goes in the bin; one error: "oops"
        if (free && this.state === 'work' && this.errorTimes.length >= 2 && t > (this.slumpCool || 0) && !this.agent.asking) {
          this.react('slump', 3, {}); this.slumpCool = t + 15000; this.slumpEnd = t + 3000; this.recoverUntil = t + 3000 + 20000;
          if (this.desk && this.sittingOn === this.desk.chair) { this.crumpleLag = 1; this.tossAt = t + 1950; }
        } else if (free && (this.state === 'work' || this.state === 'qa')) this.react('oops', 1.8);
      }
      else if (a.thought.kind === 'tool' && this.recoverUntil > t && t > (this.slumpEnd || 0)) { // back at it after the slump: a small nod to self
        this.recoverUntil = 0;
        if (!this.reaction && this.state === 'work') this.react('nod', 1.1, {});
      }
      else if (a.thought.kind === 'think' && prev.thought?.kind !== 'think' && Math.random() < 0.5) this.mark('?');
      else if (a.thought.kind === 'say' && prev.thought?.kind === 'think') this.mark('💡');
    }
    if (a.asking && a.asking !== this.askRec) this.recordAction('ask', '🙋', a.asking);
    this.askRec = a.asking || null;
    this.parent = a.parentId ? this.mgr.workers.get(a.parentId) || null : null;
    if (prev.status !== a.status && met) {
      this.statusChangedAt = performance.now();
      if (a.status !== 'working' && prev.status === 'working') {
        this.mark('✨');
        const l = this.isHelper ? this.lead : null; // the lead notices a helper finishing (a small nod, no words)
        if (l && !l.done && l.state === 'work' && !l.reaction && !l.agent.asking && l.floor === this.floor) l.react('nod', 1.3, { lookAt: this });
      }
    }
    if ((a.role || 'member') !== this.look.role) { this.buildChibi(); if (this.desk && this.desk.taken === this) this.desk.setLead(this.role === 'lead'); }
  }
  /** One real action for the card's "recent actions" (tool / think / say / error / event / report / ask; never ambient):
   *  kept in time order, at most HISTORY_MAX; the same line again only moves its time. `at` is epoch ms. */
  recordAction(kind, icon, text, at, meta = null) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim(); if (!t) return;
    const now = Date.now(), when = Number(at) > 0 ? Math.min(Number(at), now) : now;
    const h = this.history, last = h[h.length - 1];
    if (last && last.kind === kind && last.text === t) { if (when > last.at) { last.at = when; this.historyV++; } return; }
    const e = { at: when, kind, icon: icon || '', text: t.length > 200 ? `${t.slice(0, 199)}…` : t, meta };
    const insert = (list, max) => { let i = list.length; while (i > 0 && list[i - 1].at > when) i--; list.splice(i, 0, e); if (list.length > max) list.shift(); }; // a replayed event can be older than the newest line
    insert(h, HISTORY_MAX);
    if (meta?.link) insert(this.links, LINKS_MAX); // a link stays listed under "Messages" however many thoughts follow
    this.historyV++;
  }
  /** the strongest link seen between this worker and `otherId` (threads draw the team by it) */
  noteLink(otherId, ev) { if (otherId == null) return; const r = confRank(ev); if (r > (this.linkRanks.get(otherId) || 0)) this.linkRanks.set(otherId, r); }
  /** the thread line style for this helper's link to its team: 'solid' (declared / structural, or no link event seen at
   *  all: a vendor team), 'dashed' (artifact: a shared file) or 'dotted' (inferred: timing or echo, a hint only) */
  linkStyleFor(lead) {
    const r = this.linkRanks.get(this.parent?.id) ?? this.linkRanks.get(lead?.id) ?? 3;
    return r >= 3 ? 'solid' : r === 2 ? 'dashed' : 'dotted';
  }
  react(anim, dur, opts = {}) {
    if (this.reaction) this.endReaction(this.reaction); // a sip cut short still puts the mug back
    this.reaction = { anim, until: performance.now() + dur * 1000, ...opts }; this.animLock = null;
  }
  /** tidy up after a reaction (finished or cut short): props back, heading back */
  endReaction(r) {
    if (r.dropProp) { this.chibi.setProp(null); this.setMug(true); }
    if (r.sheet && this.chibi.props.sheet) this.chibi.setProp(null);
    if (r.faceCam && this.state === 'work' && !this.askStand && this.sittingOn) this.heading = this.sittingOn.facing ?? this.heading; // swivel back to the desk
    if (r.anim === 'slump') { this.tossAt = 0; if (!this.mgr.tosses.some(k => k.w === this)) this.crumpleLag = 0; }
  }
  mark(sym, opts) { if (this.marks.length < 2) this.marks.push({ sym, at: performance.now(), ambient: !!opts?.ambient }); }

  // ---- positions -----------------------------------------------------------
  worldY() { return this.office.baseY + this.y; }
  anchor(out) {
    const s = this.look.scale;
    const sitting = this.chibi.pose === 'sit';
    out.set(this.pos.x, this.worldY() + (sitting ? this.chibi.seatY - 0.3 : 0) * s + 1.58 * s, this.pos.z);
    return out;
  }
  goTo(target, next, facing = null, finalStep = null, floor = null) {
    const targetFloor = floor ?? target.floor ?? this.floor;
    const from = this.chibi.pose === 'sit' ? this.sittingOn : null;
    this.sittingOn = null; this.standAt = this.claim || null; this.claim = null;
    if (this.askStand) { this.askStand = null; } // the pool fades out on its own once nobody is standing to ask
    if (from?.approach && (from.floor ?? this.floor) === this.floor) { // stand up and step out the way you sat down
      const ap = { x: from.approach.x, z: from.approach.z };
      this.path = [{ ...ap, floor: this.floor }, ...this.mgr.route({ pos: ap, floor: this.floor }, target, targetFloor)];
    } else this.path = this.mgr.route(this, target, targetFloor);
    if (finalStep) this.path.push({ x: finalStep.x, z: finalStep.z, floor: targetFloor });
    this.next = next; this.arriveFacing = facing;
    this.state = 'walk';
    this.chibi.setPose('stand'); this.chibi.setAnim('walk'); this.chibi.lookAtPoint(null);
    if (!this.path.length) this.arrive();
  }
  /** A shared standing point (a desk's brief spot, the copier pickup): each arrival takes a lateral slot (centre, or
   *  0.5 m either side along the spot) that nobody else is standing on or heading to. */
  sharedSpot(base, floor) {
    const f = base.facing ?? 0, lx = Math.cos(f), lz = -Math.sin(f);
    const nav = this.mgr.floors[floor]?.nav;
    const claimed = this.mgr.list.filter(o => o !== this && !o.done && o.standAt?.base === base).map(o => o.standAt);
    for (const k of hash(this.id) % 2 ? [0, 0.5, -0.5] : [0, -0.5, 0.5]) {
      const p = { x: base.x + lx * k, z: base.z + lz * k, facing: f, base };
      if (k && nav && !nav.isFree(p.x, p.z)) continue;
      if (claimed.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 0.3)) continue;
      return p;
    }
    const k = ((hash(this.id) % 60) - 30) / 100;
    return { x: base.x + lx * k, z: base.z + lz * k, facing: f, base };
  }
  goToShared(base, next, floor) { const s = this.sharedSpot(base, floor); this.claim = s; this.goTo(s, next, s.facing, null, floor); }
  goToSeat(seat, facing = seat.facing) {
    if (this.desk && seat === this.desk.chair) this.desk.setChairOut?.(true);
    this.targetSeat = seat;
    if (seat.approach) this.goTo(seat.approach, 'toSeat', facing, seat, seat.floor); else this.goTo(seat, 'toSeat', facing, null, seat.floor);
  }
  setMug(v) { this.desk?.setMug(v); this.deskMug = !!(v && this.desk); }
  releaseDesk() { if (this.desk) { this.desk.taken = null; this.desk.setOwner(null); this.desk.setOccupant(null); this.setMug(false); this.desk.setLead(false); this.desk = null; } }
  releaseSlot() { if (this.slot) { this.slot.seat.taken = null; this.slot.pod.removeHelperDesk(this.slot.index); this.slot = null; } } // the seat holds the reservation (clearing it on the wrapper leaked every seat ever taken)
  releaseSeat() { if (this.seat) { this.seat.taken = false; this.seat = null; } }
  releaseMeetSeat() { if (this.meetSeat) { this.meetSeat.taken = null; this.meetSeat = null; } }
  releaseQa() { if (this.qaSpot) { this.qaSpot.taken = null; this.qaSpot = null; } }
  releaseReview() { if (this.reviewing && this.reviewing.reviewSpot.taken === this) this.reviewing.reviewSpot.taken = null; this.reviewing = null; }
  /** what the current stop was holding on the set: the foosball count, a marked spot, the coffee machine running */
  dropHolds() {
    if (this.foosIn) { const fo = this.foosOf; if (fo) fo.players = Math.max(0, fo.players - 1); this.foosIn = false; }
    if (this.ambientSpot) { if (this.ambientSpot.taken === this) this.ambientSpot.taken = null; this.ambientSpot = null; }
    if (this.brewingAt) { this.brewingAt.brewing = Math.max(0, this.brewingAt.brewing - 1); this.brewingAt = null; }
    this.ambientKind = null; this.buddy = null;
  }

  // ---- following the director's plan ---------------------------------------------------------------------------------
  deskOf(f, d) { return d ? this.mgr.floors[f]?.desks.find(x => x.id === d) || null : null; }
  seatOf(seat) { const fl = seat ? this.mgr.floors[seat.f] : null; return fl ? (seat.kind === 'cafe' ? fl.cafe : fl.lounge)?.seats[seat.i] || null : null; }
  /** first pass: let go of whatever the plan no longer gives this worker (before anyone else takes it up) */
  letGo(p) {
    const desk = p.desk ? this.deskOf(p.desk.f, p.desk.d) : null;
    if (this.desk && this.desk !== desk) this.releaseDesk();
    const pod = p.slot ? this.deskOf(p.slot.f, p.slot.d) : null;
    if (this.slot && (this.slot.pod !== pod || this.slot.index !== p.slot.i)) this.releaseSlot();
    if (this.seat && this.seat !== this.seatOf(p.seat)) this.releaseSeat();
    const qa = p.qa ? this.mgr.floors[p.qa.f]?.qa.spots[p.qa.i] : null;
    if (this.qaSpot && this.qaSpot !== qa) this.releaseQa();
    const rv = p.reviewing ? this.deskOf(p.reviewing.f, p.reviewing.d) : null;
    if (this.reviewing && this.reviewing !== rv) this.releaseReview();
    if (p.step.k !== 'meeting') this.releaseMeetSeat();
  }
  /** second pass: what the plan gives this worker, and the facts it keeps for every tab alike */
  takeUp(p) {
    const m = this.mgr, srv = m.serverNow, t = performance.now();
    this.leaving = p.leaving; this.name = p.name; this.errors = p.errors; this.reports = p.reports; this.seatedOnce = this.seatedOnce || p.seated;
    if (p.readyAt !== this.readyWall) {
      const wasMet = this.readyWall !== undefined;
      this.readyWall = p.readyAt; this.readyAt = p.readyAt ? t - Math.max(0, srv - p.readyAt) : 0;
      if (p.readyAt && wasMet && srv - p.readyAt < 5000) { this.finishMoment = true; queueMicrotask(() => { this.finishMoment = false; }); } // read by the office log in this same task
      if (p.readyAt && srv - p.readyAt >= READY_DEBOUNCE_MS) this.readyOn = true; // long since held: no hand-back to replay
      if (!p.readyAt) this.readyFlipAt = 0;
    }
    if (p.desk) { const d = this.deskOf(p.desk.f, p.desk.d); if (d) { this.desk = d; d.taken = this; } }
    if (p.slot) {
      const pod = this.deskOf(p.slot.f, p.slot.d), free = pod?.slots[p.slot.i];
      if (free && !this.slot) {
        free.taken = this; this.slot = { pod, index: p.slot.i, seat: free };
        pod.ensureHelperDesk(p.slot.i);
        if (free.lidGlow) free.lidGlow.material.color.setHex(VENDOR[this.look.vendorKey]?.screen ?? 0xffffff); // the vendor's own screen tint
      }
    }
    if (p.seat) { const seat = this.seatOf(p.seat); if (seat) { this.seat = seat; seat.taken = true; seat.floor = p.seat.f; } }
    if (p.qa) { const q = m.floors[p.qa.f]?.qa.spots[p.qa.i]; if (q) { this.qaSpot = q; q.taken = this; q.floor = p.qa.f; } }
    if (p.reviewing) { const d = this.deskOf(p.reviewing.f, p.reviewing.d); if (d) { this.reviewing = d; d.reviewSpot.taken = this; } }
    this.reviewTask = p.review ? { to: m.workers.get(p.review.to) || null, stamped: p.review.stamped } : null;
    const roomAt = key => { if (!key) return null; const [f, name] = key.split(':'); return m.floors[f]?.[name] || null; };
    this.kickoff = roomAt(p.kickoff); this.meetingRoom = roomAt(p.meeting);
    if (p.stampAt !== (this.stampSeen ?? p.stampAt)) { // the verdict lands on the review desk
      if (srv - p.stampAt < 3000 && p.stamp) this.react('stamp', 2.6, { bubble: { icon: p.stamp.ok ? '✅' : '⚠️', text: `${p.stamp.ok ? 'Approved' : 'Flagged'}${p.stamp.risk}`, kind: 'event' } });
    }
    this.stampSeen = p.stampAt;
  }
  /** third pass: a new step means a new walk */
  followPlan(p) { if (p.seq !== this.planSeq) this.enterStep(p); }
  /** roughly where someone at this step is standing: where a walk joined late starts from */
  placeOf(s) {
    const m = this.mgr, f = s?.f ?? 0, fl = m.floors[f] || m.ground, door = m.ground.door;
    const at = (o, floor = f) => ({ x: (o.approach || o).x, z: (o.approach || o).z, f: floor });
    if (!s) return at(door.inside, 0);
    const desk = this.deskOf(f, s.d);
    switch (s.k) {
      case 'desk': case 'stretch': if (desk) return at(desk.chair); break;
      case 'slot': if (desk?.slots[s.i]) return at(desk.slots[s.i]); break;
      case 'brief': case 'present': case 'bye': if (desk) return at(desk.briefSpot); break;
      case 'review': case 'handover': if (desk) return at(desk.reviewSpot); break;
      case 'meeting': { const seat = fl[s.room]?.seats[s.i]; if (seat) return at(seat); break; }
      case 'meet': if (fl[s.room]) return at(fl[s.room].presenter); break;
      case 'qa': return at(s.i != null ? fl.qa.spots[s.i] : fl.qa.wait || fl.qa.stand);
      case 'collect': return at(fl.copier.pickup);
      case 'queue': case 'brew': return at(fl.coffee.spotFor(s.i || 0));
      case 'break': { const seat = this.seatOf(s.seat); if (seat) return at(seat); if (desk) return at(desk.chair); return { x: fl.xR, z: fl.walkways.at(-1) - 0.8, f }; }
      case 'ambient': { const spot = this.ambientSpotFor(s, fl); return at(spot || fl.lounge.center); }
      default: break;
    }
    return at(door.inside, 0);
  }
  ambientSpotFor(s, fl) {
    switch (s.a) {
      case 'wc': return fl.wcs?.[s.i]?.spot;
      case 'bar': return fl.barSpots?.[s.i];
      case 'foos': return fl.foos?.spots[s.i];
      case 'water': return fl.plantSpots?.[s.i];
      case 'window': return fl.windowSpots?.[s.i];
      case 'cooler': return fl.cooler?.spot;
      default: return null;
    }
  }
  /** sit down at a seat (already there: no getting up and back) */
  sitAt(seat, floor, isBreak = false) {
    this.withFloor(seat, floor); this.nextIsBreak = isBreak;
    if (this.sittingOn === seat && this.chibi.pose === 'sit') { this.targetSeat = seat; this.next = 'toSeat'; this.path = []; this.arrive(); return; }
    this.goToSeat(seat);
  }
  /** a new step from the director: turn it into a walk (its arrival sets the pose). A step already under way when the tab
   *  first sees it is joined partway: the walk starts from where they came from and is advanced by the time gone. */
  enterStep(p) {
    const s = p.step, m = this.mgr, prevK = this.planStep?.k, first = this.planSeq === null, c = this.chibi;
    const elapsed = (m.serverNow - s.since) / 1000, late = first || elapsed > LATE_S;
    this.planSeq = p.seq; this.planStep = s;
    this.dropHolds();
    const f = s.f ?? 0, fl = m.floors[f] || m.ground, carry = this.isHelper ? 'laptop' : this.isReviewer ? 'clipboard' : null, door = m.ground.door;
    if (late && s.k !== 'in') { const from = this.placeOf(p.from); this.pos.set(from.x, 0, from.z); this.floor = from.f; this.y = 0; this.sittingOn = null; c.setPose('stand'); }
    if (first && s.k !== 'in') this.fade = 1;
    if (prevK === 'collect' && s.k === 'present') m.floors[this.planFloor ?? f]?.copier?.take?.();
    if (['collect', 'present', 'handover', 'review'].includes(prevK) && !['present', 'handover'].includes(s.k)) c.setProp(carry);
    if (prevK === 'brew' && s.k === 'break') { c.setProp('cup'); c.smile(1.5); }
    this.planFloor = f;
    const toWorker = s.to ? m.workers.get(s.to) || null : null, desk = this.deskOf(f, s.d);
    switch (s.k) {
      case 'in': { // up the path from the street to the door mat
        const site = m.site, start = site ? site.approach[0] : { x: door.outside.x - 0.9, z: door.outside.z };
        this.pos.set(start.x, 0, start.z); this.floor = 0;
        this.path = [...(site ? site.approach.slice(1) : []), door.inside].map(q => ({ ...q, floor: 0 })); this.next = 'wipe'; this.state = 'walk'; c.setPose('stand'); c.setAnim('walk');
        break;
      }
      case 'desk': if (desk) this.sitAt(desk.chair, f); break;
      case 'slot': { const seat = desk?.slots[s.i]; if (seat) this.sitAt(seat, f); break; }
      case 'stretch':
        if (desk && this.sittingOn !== desk.chair) { this.sitAt(desk.chair, f); this.catchUp(Infinity, 0); }
        this.state = 'stretch'; this.timer = 0; c.setAnim('stretch');
        return;
      case 'meeting': {
        const seat = fl[s.room]?.seats[s.i];
        if (seat) { seat.taken = this; this.meetSeat = seat; this.sitAt(seat, f); }
        break;
      }
      case 'meet': { const pr = fl[s.room]?.presenter; if (pr) this.goTo(pr, 'meet', pr.facing, null, f); break; }
      case 'brief': if (desk) { this.pendingBrief = s.text ? { text: s.text } : null; this.goToShared(desk.briefSpot, 'brief', f); } break;
      case 'qa':
        if (s.i != null) { const spot = fl.qa.spots[s.i]; if (spot.approach) this.goTo(spot.approach, 'qa', spot.facing, spot, f); else this.goTo(spot, 'qa', spot.facing, null, f); }
        else this.goToShared(fl.qa.wait || { x: fl.qa.stand.x, z: fl.qa.stand.z + 0.9, facing: Math.PI }, 'qa', f); // every seat taken: wait by the door, each on their own spot
        break;
      case 'review': if (desk) { this.action = { to: toWorker }; this.goTo(desk.reviewSpot, 'review', desk.reviewSpot.facing, null, f); } break;
      case 'handover': if (desk) { this.action = { to: toWorker, ok: s.ok, text: s.text }; c.setProp('clipboard'); this.goTo(desk.reviewSpot, 'handover', desk.reviewSpot.facing, null, f); } break;
      case 'collect':
        this.action = { to: toWorker, text: s.text };
        if (!late) fl.copier?.print();
        c.setProp(null); this.goToShared(fl.copier.pickup, 'collect', f);
        break;
      case 'present':
        this.action = { to: toWorker, text: s.text, icon: s.icon, walk: s.walk2, handoff: s.handoff };
        c.setProp('sheet');
        if (desk) this.goToShared(desk.briefSpot, 'present', f);
        break;
      case 'queue': this.goTo(fl.coffee.spotFor(s.i), 'queue', Math.PI, null, f); break;
      case 'brew': this.goTo(fl.coffee.spotFor(0), 'brew', Math.PI, null, f); break;
      case 'break': {
        const seat = this.seatOf(s.seat);
        if (seat) this.sitAt(seat, f);
        else if (desk) this.sitAt(desk.chair, f, true);
        else this.goTo({ x: fl.xR, z: fl.walkways.at(-1) - 0.8 }, 'break', Math.PI / 2, null, f);
        break;
      }
      case 'ambient': {
        this.ambientKind = s.a; this.ambientDur = s.dur; this.foosOf = fl.foos;
        if (s.a === 'wc') c.setProp(null);
        if (s.a === 'bar' && !c.props.cup) c.setProp('cup');
        if (s.a === 'chat') { // stand where there is floor: in front of their seat, else beside it
          const b = m.workers.get(s.buddy); this.buddy = b || null;
          const face = b?.seat?.facing ?? 0, base = b?.pos || fl.lounge.center;
          const spots = [[Math.sin(face), Math.cos(face)], [Math.cos(face), -Math.sin(face)], [-Math.cos(face), Math.sin(face)], [-Math.sin(face), -Math.cos(face)]].map(([dx, dz]) => ({ x: base.x + dx * 1.1, z: base.z + dz * 1.1 }));
          const spot = spots.find(q => fl.nav.isFree(q.x, q.z)) || spots[0];
          this.goTo(spot, 'ambient', Math.atan2(base.x - spot.x, base.z - spot.z), null, f);
          break;
        }
        const spot = this.ambientSpotFor(s, fl);
        if (spot) { spot.taken = this; this.ambientSpot = spot; this.goTo(spot, 'ambient', spot.facing, null, f); }
        break;
      }
      case 'bye': c.setProp(carry); if (desk) this.goToShared(desk.briefSpot, 'byeWave', f); break;
      case 'exit': c.setProp(carry); this.goToShared(door.inside, 'exitWave', 0); break; // each leaver waves from their own spot by the door, not all on one point
      case 'out': this.goTo(door.outside, m.site ? 'leaveSite' : 'gone', null, null, 0); break;
      default: break;
    }
    this.walkSpent = 0;
    if (late || elapsed > CATCH_UP_S) { this.catchUp(elapsed, s.walk); this.walkSpent = elapsed; }
  }
  /** advance a walk by the time already gone (a walk the director counts as over is simply over) */
  catchUp(elapsed, walk) {
    if (this.state === 'walk') {
      const speed = SPEED * (0.88 + this.traits.fidget * 0.24);
      let left = elapsed >= walk ? Infinity : elapsed * speed;
      while (this.state === 'walk' && this.path.length) {
        const tgt = this.path[0], v = tgt.climb ? 0.6 : 1, d = Math.hypot(tgt.x - this.pos.x, tgt.z - this.pos.z), need = d / v;
        if (left >= need) {
          left -= need; this.pos.set(tgt.x, 0, tgt.z);
          if (tgt.climb) { this.floor = tgt.floor; this.y = 0; } else this.floor = tgt.floor ?? this.floor;
          this.path.shift(); if (!this.path.length) this.arrive();
        } else {
          this.pos.x += (tgt.x - this.pos.x) / d * left * v; this.pos.z += (tgt.z - this.pos.z) / d * left * v; this.heading = Math.atan2(tgt.x - this.pos.x, tgt.z - this.pos.z);
          if (tgt.climb) this.y = stairHeight(tgt.climb.flight, this.pos.z) + tgt.climb.offset;
          break;
        }
      }
      if (this.state !== 'walk') this.timer = Math.max(0, elapsed - walk);
    } else this.timer = Math.max(0, elapsed - walk);
    this.yaw = this.heading; this.chibi.group.rotation.y = this.yaw; this.applyGhost();
  }
  withFloor(seat, floor) { return seat.floor === floor ? seat : Object.assign(seat, { floor }); }

  arrive() {
    this.state = this.next;
    const c = this.chibi;
    this.timer = 0; this.idleT = 0; this.restUntil = 0;
    switch (this.state) {
      case 'toSeat': {
        const seat = this.targetSeat;
        this.pos.set(seat.x, 0, seat.z); this.heading = seat.facing;
        c.setPose('sit', seat.seatY); this.sittingOn = seat;
        if (seat.meeting) { this.state = 'meeting'; c.setProp(null); c.setAnim('idle'); break; }
        if (this.desk && seat === this.desk.chair && this.desk.owner !== this) { this.desk.setOwner(this); this.reportsShown = 0; }
        if (this.seat === seat || this.nextIsBreak) {
          this.nextIsBreak = false; this.state = 'break'; c.setAnim('sip');
          if (this.desk && seat === this.desk.chair) this.desk.setOccupant(this.look.vendorKey);
          break;
        }
        if (c.props.cup && this.desk && seat === this.desk.chair) this.setMug(true); // the mug comes back with them
        c.setProp(null);
        this.seatedOnce = true; this.pendingBrief = null;
        if (this.desk && seat === this.desk.chair) {
          this.desk.setOccupant(this.look.vendorKey); this.desk.setLead(this.role === 'lead');
        }
        if (this.isHelper && this.lead) { this.glanceLeadUntil = performance.now() + rnd(900, 1300); this.leadGlanceT = rnd(20, 40); } // a look over at the lead on sitting down
        this.state = 'work'; c.setAnim('type');
        break;
      }
      case 'brief': {
        this.heading = this.arriveFacing ?? 0; c.setPose('stand'); c.setAnim('listen');
        const lead = this.lead;
        if (lead) lead.react('talk', 3.4, { lookAt: this, bubble: { icon: '📋', text: `Briefing ${this.name}${this.pendingBrief?.text ? `: ${this.pendingBrief.text}` : ''}`, kind: 'event' } });
        this.mark('!'); this.briefed = true; this.pendingBrief = null;
        break;
      }
      case 'collect': { this.heading = this.arriveFacing ?? Math.PI; c.setPose('stand'); c.setAnim('inspect'); break; }
      case 'present': {
        this.heading = this.arriveFacing ?? 0; c.setPose('stand'); c.setAnim('present');
        const to = this.action?.to;
        if (to && !to.done) { to.react('nod', HANDBACK_S, { lookAt: this }); setTimeout(() => { if (!to.done) to.mark('👍'); }, 2200); } // the report bubble is the presenter's
        break;
      }
      case 'review': { this.heading = this.arriveFacing ?? 0; c.setPose('stand'); c.setAnim('inspect'); c.lookAtPoint(null); break; }
      case 'handover': {
        this.heading = this.arriveFacing ?? 0; c.setPose('stand'); c.setAnim('present');
        const a = this.action, to = a?.to;
        if (to && !to.done) { to.react(a.ok ? 'cheer' : 'nod', 2.4, { lookAt: this, bubble: { icon: a.ok ? '✅' : '⚠️', text: `${this.name}: ${a.text}`, kind: 'event' } }); to.mark(a.ok ? '✨' : '💦'); if (a.ok) to.chibi.smile(2); }
        break;
      }
      case 'meet': { this.heading = this.arriveFacing ?? 0; c.setPose('stand'); c.setAnim('host'); break; } // hosting, not waiting
      case 'qa': {
        this.heading = this.arriveFacing ?? 0;
        if (this.qaSpot?.seatY) { this.pos.set(this.qaSpot.x, 0, this.qaSpot.z); c.setPose('sit', this.qaSpot.seatY); c.setAnim('read'); this.sittingOn = this.qaSpot; }
        else { c.setPose('stand'); c.setAnim('inspect'); }
        break;
      }
      case 'brew': { this.heading = Math.PI; c.setPose('stand'); c.setAnim('idle'); this.brewingAt = this.office.coffee; this.brewingAt.brewing++; break; }
      case 'queue': { this.heading = Math.PI; c.setPose('stand'); c.setAnim('idle'); break; }
      case 'ambient': {
        this.heading = this.arriveFacing ?? 0; c.setPose('stand');
        if (this.ambientKind === 'wc') { c.setAnim('idle'); break; }
        if (this.ambientKind === 'foos') { c.setProp(null); c.setAnim('foos'); this.office.foos.players++; this.foosIn = true; break; } c.setAnim(this.ambientKind === 'window' ? 'gaze' : this.ambientKind === 'water' ? 'water' : this.ambientKind === 'cooler' || this.ambientKind === 'bar' ? 'sip' : 'chat'); if (this.ambientKind === 'cooler') this.office.cooler?.use(3); break; }
      case 'byeWave': { this.heading = this.arriveFacing ?? Math.PI / 2; c.setPose('stand'); c.setAnim('wave'); const l = this.lead; if (l && !l.done) l.react('wave', 1.6, { lookAt: this }); break; }
      case 'exitWave': this.heading = Math.PI / 2; c.setPose('stand'); c.setAnim('wave'); break;
      case 'wipe': { // feet on the mat, until the director sends them on
        this.greet = greetingFor(this.id);
        this.heading = Math.PI / 2; c.setPose('stand'); c.setAnim('wipe'); break;
      }
      case 'leaveSite': { // back down the path to the street
        const site = this.mgr.site;
        if (!site) { this.finish(); break; }
        this.path = site.approach.slice(0, -1).reverse().map(p => ({ ...p, floor: 0 })); this.next = 'gone'; this.state = 'walk'; c.setPose('stand'); c.setAnim('walk');
        break;
      }
      case 'gone': this.finish(); break;
      default: c.setAnim('idle');
    }
  }
  finish() { this.setAskPool(false); this.dropImpostor(); this.dropHolds(); this.releaseDesk(); this.releaseSeat(); this.releaseSlot(); this.releaseQa(); this.releaseReview(); this.releaseMeetSeat(); this.chibi.dispose(); this.done = true; }

  // ---- asking: stand up beside the chair and turn to the viewer --------------
  /** find a free spot ~0.5 m beside the chair (the side toward the camera first) and stand up there */
  beginAskStand() {
    const seat = this.sittingOn, f = seat.facing ?? 0, lx = Math.cos(f), lz = -Math.sin(f), bx = -Math.sin(f), bz = -Math.cos(f);
    const nav = this.office.nav;
    const sides = lx + lz >= 0 ? [1, -1] : [-1, 1];
    for (const back of [0, 0.15]) for (const sd of sides) for (const d of [0.55, 0.65, 0.75]) {
      const x = seat.x + lx * sd * d + bx * back, z = seat.z + lz * sd * d + bz * back;
      if (!nav.isFree(x, z)) continue;
      if (this.mgr.list.some(o => o !== this && !o.done && o.floor === this.floor && Math.hypot(o.pos.x - x, o.pos.z - z) < 0.45)) continue;
      this.askStand = { seat, x, z, t: 0, waveT: rnd(1.2, 2.5), there: false };
      this.chibi.setPose('stand'); this.setAskPool(true);
      return true;
    }
    this.askTried = true; // no room: ask from the chair
    return false;
  }
  /** stand up, step aside, face the viewer, hand up, a two-handed wave every 4–6 s; once answered, step back and sit */
  updateAskStand(dt, now) {
    const a = this.askStand, c = this.chibi, seat = a.seat, asking = !!this.agent.asking;
    a.t += dt;
    if (a.t < 0.3) { c.setAnim('idle'); return; } // getting up
    const goal = asking ? a : seat;
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d > 0.02) {
      const step = Math.min(d, 1.1 * dt);
      this.pos.x += dx / d * step; this.pos.z += dz / d * step;
      this.heading = Math.atan2(dx, dz); c.advanceWalk?.(step); c.setAnim('walk');
      a.there = false;
      return;
    }
    if (!asking) { // back in the chair
      this.pos.set(seat.x, 0, seat.z); this.heading = seat.facing ?? 0; c.setPose('sit', seat.seatY); c.setAnim('type');
      this.askStand = null; this.raiseT = rnd(2, 6);
      return;
    }
    if (!a.there) { a.there = true; this.heading = CAM_HEADING; this.chibi.smile(0.8); }
    a.waveT -= dt;
    if (a.waveT < -1.6) a.waveT = rnd(4, 6);
    c.setAnim(a.waveT < 0 ? 'wave2' : 'raise');
  }
  /** the amber pool under an asking person: eases in while they stand, out once they sit (then it is removed). Normal
   *  blending (an additive pool washes out to nothing on the pale carpet by day), drawn after the floor's own decals
   *  (rugs, light pools, threads) and without depth writes, so the person still stands in it */
  setAskPool(on) {
    if (on && !this.askPool) {
      const m = new THREE.MeshBasicMaterial({ color: 0xf0a83c, map: poolTexture(), transparent: true, opacity: 0, blending: THREE.NormalBlending,
        depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const p = new THREE.Mesh(poolGeo, m); p.rotation.x = -Math.PI / 2; p.position.y = POOL_Y; p.renderOrder = 5;
      p.castShadow = false; p.receiveShadow = false; p.userData.noMode = true; // not dimmed / ghosted, never baked into an impostor
      const rm = new THREE.MeshBasicMaterial({ color: 0xe2b35d, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
      const ring = new THREE.Mesh(ringGeo, rm); ring.position.z = 0.002; ring.renderOrder = 6;
      ring.castShadow = false; ring.receiveShadow = false; ring.userData.noMode = true;
      p.add(ring);
      this.askPool = p; this.askRing = ring;
    }
    if (on && this.askPool.parent !== this.chibi.group) this.chibi.group.add(this.askPool);
    if (!on && this.askPool) {
      this.askPool.parent?.remove(this.askPool); this.askPool.material.dispose(); this.askRing?.material.dispose();
      this.askPool = null; this.askRing = null; this.askPoolK = 0;
    }
  }
  updateAskPool(dt, now) {
    if (!this.askPool) return;
    const want = this.askStand && this.agent.asking ? 1 : 0;
    this.askPoolK += (want - this.askPoolK) * Math.min(1, dt * (want ? 2.5 : 5));
    if (!want && this.askPoolK < 0.02) { this.setAskPool(false); return; }
    // the pool holds at about 0.5; its mustard ring breathes between 0.4 and 0.55 (a slow, calm pulse, not a flash)
    const br = 0.5 + 0.5 * Math.sin(now * (Math.PI * 2 / RING_MS));
    this.askPool.material.opacity = this.askPoolK * (0.46 + 0.04 * br);
    const s = 1 + 0.03 * br; this.askPool.scale.set(s, s, 1);
    if (this.askRing) this.askRing.material.opacity = this.askPoolK * (0.4 + 0.15 * br);
  }

  /** a random idle from [anim, min s, max s] options, held for a jittered while */
  idlePick(dt, opts) {
    this.idleT = (this.idleT ?? 0) - dt;
    if (this.idleT <= 0 || !this.idleAnim) {
      let o = opts[Math.floor(Math.random() * opts.length)];
      if (o[0] === this.idleAnim && o[0] !== 'idle') o = opts[0];
      this.idleAnim = o[0]; this.idleT = rnd(o[1], o[2]);
    }
    return this.idleAnim;
  }
  /** seated idles right after finishing a prompt: lean back, chin on hand, phone, a sip from the desk mug */
  /** waiting on a job, they swing the chair toward the laptop beside the desk: seat and body as one, over about a second */
  updateJobSwivel(dt) {
    const d = this.desk, seated = this.state === 'work' && d?.owner === this && this.sittingOn === d.chair && !this.reaction?.faceCam;
    this.jobTurned = seated && this.idle && waitingOnJob(this.agent, Date.now());
    const was = this.jobSwivel || 0;
    this.jobSwivel = was + ((this.jobTurned ? JOB_SWIVEL : 0) - was) * Math.min(1, dt * 2.8);
    if (!was && !this.jobTurned) return;
    if (d) d.chairSwivel = this.jobSwivel;
    if (seated) this.heading = (this.sittingOn.facing ?? 0) + this.jobSwivel;
  }
  restPick(dt) {
    this.restT -= dt;
    if (this.restT <= 0) {
      const opts = waitingOnJob(this.agent, Date.now()) ? ['leanback', 'chin', 'leanback', 'idle'] : ['leanback', 'chin', 'phone', 'idle']; // waiting on a job: attentive, no phone
      if (this.deskMug && this.desk?.taken === this) opts.push('sip', 'sip');
      let a = opts[Math.floor(Math.random() * opts.length)];
      if (a === this.restAnim) a = opts[(opts.indexOf(a) + 1) % opts.length];
      this.restAnim = a; this.restT = rnd(4, 9);
      if (a === 'sip') { const d = rnd(3.2, 4.8); this.setMug(false); this.chibi.setProp('cup'); this.react('sip', d, { ambient: true, dropProp: true }); this.restT = d + rnd(0.5, 1.5); }
    }
    return this.restAnim === 'sip' ? 'idle' : this.restAnim;
  }

  update(dt, now) {
    const c = this.chibi;
    const site = this.mgr.site;
    const fadingOut = this.state === 'gone' || (this.state === 'walk' && this.next === 'gone' && this.floor === 0 &&
      (site ? this.pos.z > site.fadeZ - 0.1 && site.isOutdoor(this.pos.x) : this.pos.x < this.mgr.ground.door.x - 0.4)) ||
      (this.state === 'ambient' && this.ambientKind === 'wc' && this.timer > 0.5 && this.timer < (this.ambientDur || 8) - 0.5); // in the restroom: out of sight
    this.fade += (fadingOut ? -3 : 3) * dt;
    this.fade = clamp(this.fade, 0, 1);
    if (this.state === 'walk' && this.path[0]?.climb) this.fade = Math.min(this.fade, this.ascentFade()); // the last steps up to a floor you are not viewing
    if (this.tossAt && now >= this.tossAt) { this.tossAt = 0; if (this.reaction?.anim === 'slump') this.mgr.tossPaper(this); else this.crumpleLag = 0; }
    this.updateJobSwivel(dt);
    this.timer += dt;
    if (this.state === 'walk' && this.planStep) { // the walk keeps to the plan: past its arrival it is over, and a tab that stalled jumps to where it should be
      const gone = (this.mgr.serverNow - this.planStep.since) / 1000, behind = gone - (this.walkSpent || 0);
      if (gone > this.planStep.walk + WALK_DRIFT_MS / 1000) this.catchUp(Infinity, 0);
      else if (behind > WALK_LAG_S) { this.catchUp(behind, behind + 1); this.walkSpent = gone; }
    }
    this.updateReady(now);
    this.animLock = this.reaction && now <= this.reaction.until && this.state !== 'walk' ? this.reaction.anim : null;

    switch (this.state) {
      case 'walk': {
        const tgt = this.path[0];
        const dx = tgt.x - this.pos.x, dz = tgt.z - this.pos.z, dist = Math.hypot(dx, dz);
        // follow, don't push: slow down behind someone just ahead who is walking the same way (never a full stop)
        let follow = 1;
        if (dist > 0.001) {
          const ux = dx / dist, uz = dz / dist;
          for (const o of this.mgr.workers.values()) {
            if (o === this || o.done || o.floor !== this.floor || o.state !== 'walk' || o.fade < 0.3) continue;
            const vx = o.pos.x - this.pos.x, vz = o.pos.z - this.pos.z, along = vx * ux + vz * uz;
            if (along <= 0 || along > 0.9 || Math.abs(vx * uz - vz * ux) > 0.42) continue;
            if (Math.sin(o.heading) * ux + Math.cos(o.heading) * uz < 0.4) continue; // head-on or crossing: let separation handle it
            follow = Math.min(follow, Math.max(0.2, (along - 0.45) / 0.45));
          }
        }
        // the walk keeps to the plan's clock, not to the frames this tab happened to get, so every tab has them at one
        // point: slowed behind someone, it makes the time up afterwards (at most at twice the pace)
        const pace = SPEED * (0.88 + this.traits.fidget * 0.24) * (tgt.climb ? 0.6 : 1);
        const owed = this.planStep ? (this.mgr.serverNow - this.planStep.since) / 1000 - (this.walkSpent || 0) : dt;
        const step = pace * clamp(owed, 0, dt * 2) * follow;
        this.walkSpent = (this.walkSpent || 0) + Math.min(dist, step) / pace;
        c.advanceWalk?.(Math.min(dist, step)); // the gait follows the distance actually covered (slower behind someone, on stairs)
        if (dist <= step) {
          this.pos.set(tgt.x, 0, tgt.z);
          if (tgt.climb) { this.floor = tgt.floor; this.y = 0; this.applyGhost(); }
          this.path.shift(); if (!this.path.length) this.arrive();
        } else {
          this.pos.x += dx / dist * step; this.pos.z += dz / dist * step; this.heading = Math.atan2(dx, dz);
          if (tgt.climb) this.y = stairHeight(tgt.climb.flight, this.pos.z) + tgt.climb.offset; else if (this.path.length > 1 || dist > 0.8) {
            // soft separation from other people on the same floor
            let px = 0, pz = 0;
            const ux = dx / dist, uz = dz / dist;
            for (const o of this.mgr.workers.values()) {
              if (o === this || o.done || o.floor !== this.floor) continue;
              const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z, d = Math.hypot(ox, oz);
              if (d > 0.001 && d < 0.6) { const f = (0.6 - d) / 0.6; px += ox / d * f * 1.2; pz += oz / d * f * 1.2; }
              // someone in the way, standing or coming the other way: step aside early instead of sliding through them
              if (o.chibi?.pose === 'sit' || d > 1.1) continue;
              const along = -ox * ux - oz * uz, side = -ox * uz + oz * ux;
              if (along <= 0 || Math.abs(side) > 0.55 || (o.state === 'walk' && Math.sin(o.heading) * ux + Math.cos(o.heading) * uz > 0.4)) continue; // beside us, or going our way: `follow` slows us instead
              const away = (side > 0.05 ? -1 : 1) * (1 - along / 1.1); // dead ahead: each keeps to their own right, so two people pass
              px += uz * away; pz += -ux * away;
            }
            if (px || pz) { const nx = this.pos.x + px * dt, nz = this.pos.z + pz * dt; if (this.office.nav.isFree(nx, nz) || this.outdoors) { this.pos.x = nx; this.pos.z = nz; } } // outside the grid (the path) people still keep apart
          }
        }
        break;
      }
      case 'work': {
        if (this.isHelper && this.lead) { // a look over at the lead now and then
          this.leadGlanceT = (this.leadGlanceT ?? rnd(20, 40)) - dt;
          if (this.leadGlanceT < 0) { this.leadGlanceT = rnd(20, 40); this.glanceLeadUntil = now + rnd(800, 1300); }
        }
        if (this.askStand && !this.agent.asking) { this.updateAskStand(dt, now); break; } // answered: sit back down first
        if (this.idle) {
          if (this.isHelper || this.isReviewer) { c.setAnim(this.idlePick(dt, HELPER_IDLE)); break; }
          // just handed back to you: swivel toward you and lift the result for a moment (the sage flag stays on the desk)
          // (debounced: presentPending is set once the finish has held READY_DEBOUNCE_MS)
          if (this.presentPending && this.agent.delegator) { // handed back to the agent that gave the work, not to you
            this.presentPending = false;
            const g = this.giver;
            if (now - this.readyAt < READY_FRESH_MS && (!this.reaction || this.reaction.ambient)) {
              this.react('talk', HANDBACK_S, { lookAt: g, bubble: { icon: '↩', text: `Done · ${this.turnWords()}`, kind: 'event', ...(this.agent.delegator.certain ? {} : { cls: 'weak' }) } });
              if (g && g.state === 'work' && !g.reaction && !g.agent.asking && g.floor === this.floor) g.react('nod', 2, { lookAt: this });
            }
          }
          if (this.presentPending) {
            this.presentPending = false;
            if (now - this.readyAt < READY_FRESH_MS && this.desk && this.sittingOn === this.desk.chair && (!this.reaction || this.reaction.ambient)) {
              this.react('present', 3.4, { faceCam: true, sheet: true, bubble: { icon: '✅', text: 'finished · your turn', kind: 'done' } }); // first: a sip cut short tidies its cup away
              c.setProp('sheet'); this.heading = CAM_HEADING;
              this.restUntil = 0;
            }
          }
          // just finished: stay seated (lean back, chin, phone, a sip from the desk mug) until the director sends them off
          if (!this.restUntil) { this.restUntil = 1; this.restT = rnd(1.5, 3.5); this.restAnim = 'idle'; }
          if (this.reaction?.faceCam) this.restT = Math.max(this.restT, 3.8); // let the hand-back finish before the first rest pose
          // waiting for you to pick it up: a look over toward you now and then
          if (this.readyOn && !this.reaction && this.desk && this.sittingOn === this.desk.chair) {
            this.camGlanceT = (this.camGlanceT ?? rnd(4, 8)) - dt;
            if (this.camGlanceT < 0) { this.camGlanceT = rnd(9, 16); this.camGlanceUntil = now + rnd(1200, 1900); if (Math.random() < 0.5) c.smile(1.2); }
          }
          c.setAnim(this.restPick(dt));
          break;
        }
        this.restUntil = 0;
        if (this.agent.askTo && !this.askStand) { // asking the agent that gave the work: hand up at the desk, head turned
          // toward them (no standing, no amber pool: that is how someone asks *you*); the giver glances over now and then
          this.raiseT -= dt;
          if (this.raiseT < -1.2) this.raiseT = rnd(6, 12);
          c.setAnim(this.raiseT < 0 ? 'wave' : 'raise');
          const g = this.giver;
          this.giverGlanceT = (this.giverGlanceT ?? rnd(0.6, 1.4)) - dt;
          if (this.giverGlanceT < 0) {
            this.giverGlanceT = rnd(9, 15);
            if (g && g.state === 'work' && !g.reaction && !g.agent.asking && g.floor === this.floor) g.react('nod', 1.5, { lookAt: this });
          }
          break;
        }
        this.giverGlanceT = null;
        if (this.agent.asking) { // blocked on the user: stand up beside the chair, turn to you, hand up, a two-handed wave now and then
          if (!this.askStand && !this.askTried && c.pose === 'sit' && this.sittingOn?.approach && !this.sittingOn.meeting) this.beginAskStand();
          if (this.askStand) { this.updateAskStand(dt, now); break; }
          this.raiseT -= dt; // no room to stand: hand up at the desk (each on their own beat)
          if (this.raiseT < -1.2) this.raiseT = rnd(5, 11);
          c.setAnim(this.raiseT < 0 ? 'wave' : 'raise'); break;
        }
        this.askTried = false;
        if (this.agent.waiting && this.role === 'lead') { c.setAnim('wait'); break; }
        const k = this.agent.thought?.kind;
        const fresh = now - this.thoughtAt < 6000;
        this.thinkPauseT -= dt;
        if (k === 'think') { if (!this.thinkSince) this.thinkSince = now; this.thinkPauseT = Math.max(this.thinkPauseT, 4); } else this.thinkSince = 0;
        const thinkPose = (this.thinkSince && now - this.thinkSince > 6000 && this.traits.fidget < 0.5) ? 'leanback' : this.traits.social > 0.5 ? 'chin' : 'think';
        if (this.thinkPauseT < 0) { // an invented beat between tool calls: a hand on the mouse, a look at the screen, a shoulder roll
          if (!this.pauseAnim) { const o = PAUSES[Math.floor(Math.random() * PAUSES.length)]; this.pauseAnim = o[0]; this.pauseDur = rnd(o[1], o[2]); }
          if (this.thinkPauseT > -this.pauseDur) { c.setAnim(this.pauseAnim); break; }
          this.thinkPauseT = 14 + Math.random() * 18; this.pauseAnim = null;
        }
        this.quirkT -= dt;
        if (this.quirkT < 0) {
          this.quirkT = 12 + Math.random() * 20;
          if (this.traits.coffee > 0.6 && this.desk && this.desk.taken === this) { this.setMug(false); c.setProp('cup'); this.react('sip', 3.5, { ambient: true, dropProp: true }); }
          else if (this.traits.fidget > 0.65) this.react(Math.random() < 0.5 ? 'stretch' : 'shoulders', 1.6, { ambient: true });
          else if (this.traits.cheer > 0.7) this.mark('♪', { ambient: true }); // humming: office life, a grey mark
          else if (this.traits.sleepy > 0.8 && k !== 'tool') this.react('yawn', 1.8, { ambient: true });
        }
        if (this.role === 'lead') { // a lead glances over at a teammate now and then
          this.glanceT = (this.glanceT ?? 6 + Math.random() * 8) - dt;
          if (this.glanceT < 0) {
            this.glanceT = 10 + Math.random() * 10;
            const team = this.mgr.list.filter(w => w.lead === this && w.isHelper && !w.done && w.floor === this.floor);
            if (team.length) { this.glanceAt = team[Math.floor(Math.random() * team.length)]; this.glanceUntil = now + 1500; }
          }
        }
        c.setAnim(k === 'think' ? thinkPose : k === 'error' ? 'read' : k === 'say' ? (fresh ? 'talk' : 'type') : k === 'read' ? 'read' : 'type'); // thinking poses only for real thinking
        break;
      }
      case 'meeting': {
        const room = this.kickoff;
        c.setAnim(room?.session ? 'listen' : 'idle');
        if (this.lead && this.lead.floor === this.floor) c.lookAtPoint(this.lead.pos);
        break;
      }
      case 'meet': {
        if (!this.reaction) c.setAnim(this.agent.asking ? 'raise' : 'host');
        break;
      }
      case 'qa': {
        const sit = !!this.qaSpot?.seatY; if (this.agent.asking) { c.setAnim('raise'); break; } c.setAnim(this.reviewTask && !this.reviewTask.stamped ? (sit ? 'read' : 'inspect') : this.idle ? this.idlePick(dt, sit ? QA_IDLE_SIT : QA_IDLE_STAND) : (sit ? 'type' : 'inspect')); break; }
      case 'stretch': c.setAnim('stretch'); break;
      case 'queue': c.setAnim(this.timer % 8 < 4 ? 'idle' : 'phone'); break; // waiting in line, phone out
      case 'break': { // the same pose in every tab: it comes from the time since sitting down
        const ps = this.planStep, gone = ps ? (this.mgr.serverNow - ps.since) / 1000 - ps.walk : this.timer;
        let anim = breakAnim(ps?.seat?.style, ps?.b || 0, gone);
        if (anim === 'chat' && !this.mgr.list.some(w => w !== this && !w.done && w.floor === this.floor && w.state === 'break' && w.seat?.style === 'cafe')) anim = 'sip'; // nobody across the table: just the coffee
        const wantProp = anim === 'readbook' ? 'book' : (anim === 'sip' ? 'cup' : null);
        if (wantProp && !c.props[wantProp]) c.setProp(wantProp);
        c.setAnim(anim);
        break;
      }
      case 'ambient': {
        if (this.ambientKind === 'chat' && this.buddy && !this.buddy.done && this.buddy.state === 'break') this.buddy.react('chat', 1.0, { lookAt: this, ambient: true, bubble: { text: Math.sin(this.timer) > 0 ? '♪' : '…', kind: 'ambient' } });
        if (this.ambientKind === 'bar') { const other = (this.office.barSpots || []).find(s => s.taken && s.taken !== this && s.taken.state === 'ambient'); c.setAnim(other && Math.sin(this.timer * 0.9) > 0 ? 'chat' : 'sip'); }
        break;
      }
      default: break;
    }

    // standing people keep a little apart (two arrivals at one spot, a queue, a chat): a weak push, never through furniture
    if (STANDING.has(this.state) && c.pose !== 'sit' && !(this.state === 'ambient' && (this.ambientKind === 'foos' || this.ambientKind === 'wc'))) {
      let px = 0, pz = 0;
      for (const o of this.mgr.workers.values()) {
        if (o === this || o.done || o.floor !== this.floor || o.fade < 0.3) continue;
        const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z, d = Math.hypot(ox, oz);
        if (d >= PERSONAL_SPACE) continue;
        if (d > 0.001) { const f = (PERSONAL_SPACE - d) / PERSONAL_SPACE; px += ox / d * f; pz += oz / d * f; } else { const a = (hash(this.id) % 628) / 100; px += Math.cos(a) * 0.5; pz += Math.sin(a) * 0.5; }
      }
      if (px || pz) { const nx = this.pos.x + px * dt * 1.4, nz = this.pos.z + pz * dt * 1.4; if (this.office.nav.isFree(nx, nz) || this.outdoors) { this.pos.x = nx; this.pos.z = nz; } }
    }

    if (this.reaction) {
      if (now > this.reaction.until) { this.animLock = null; const r = this.reaction; this.reaction = null; this.endReaction(r); c.lookAtPoint(null); }
      else if (this.state !== 'walk') { c.setAnim(this.reaction.anim); if (this.reaction.lookAt && !this.reaction.lookAt.done && this.reaction.lookAt.floor === this.floor) c.lookAtPoint(this.reaction.lookAt.pos); }
    } else if (this.state === 'work' && this.agent.askTo && !this.askStand) { // asking the giver: eyes on them
      const g = this.giver;
      c.lookAtPoint(g && g.floor === this.floor ? g.pos : null);
    } else if (this.askStand) {
      c.lookAtPoint(null); // eyes on you
    } else if (this.state === 'work' && this.readyOn && this.camGlanceUntil > now) { // finished: a glance toward you
      this.camLook.set(this.pos.x + 5, 0, this.pos.z + 5); c.lookAtPoint(this.camLook); this.camLookOn = true;
    } else if (this.state === 'work' && this.jobTurned) { // waiting on a job: eyes on the laptop
      (this.jobLook ??= new THREE.Vector3()).set(this.pos.x - 0.45, 0.85, this.pos.z + 0.95); c.lookAtPoint(this.jobLook); this.jobLookOn = true;
    } else if (this.jobLookOn) {
      this.jobLookOn = false; c.lookAtPoint(null);
    } else if (this.camLookOn) {
      this.camLookOn = false; c.lookAtPoint(null);
    } else if (this.state === 'work' && this.role === 'lead' && !this.agent.waiting && this.glanceUntil > now && this.glanceAt && !this.glanceAt.done) {
      c.lookAtPoint(this.glanceAt.pos);
    } else if (this.state === 'work' && this.role === 'lead' && !this.agent.waiting) {
      c.lookAtPoint(null);
    } else if (this.state === 'work' && this.agent.waiting && this.role === 'lead') {
      // waiting on the team: glances from helper to helper on an own, uneven beat (now and then back at the screen)
      this.waitGlanceT = (this.waitGlanceT ?? 0) - dt;
      if (this.waitGlanceT <= 0) { this.waitGlanceT = rnd(1.8, 3.5); this.waitGlanceIdx = (this.waitGlanceIdx ?? hash(this.id)) + 1 + (Math.random() < 0.3 ? 1 : 0); this.waitGlanceAway = Math.random() < 0.2; }
      const helpers = this.waitGlanceAway ? [] : this.mgr.list.filter(w => w.parent === this && !w.done && w.isHelper && w.floor === this.floor);
      const h = helpers.length ? helpers[this.waitGlanceIdx % helpers.length] : null;
      c.lookAtPoint(h ? h.pos : null);
    } else if (this.state === 'work' && this.isHelper) { // a short look over at the lead (on sitting down, every 20–40 s)
      const l = this.lead;
      c.lookAtPoint(l && !l.done && l.floor === this.floor && this.glanceLeadUntil > now ? l.pos : null);
    }

    let d = this.heading - this.yaw; if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 9);
    c.group.rotation.y = this.yaw;
    if (this.visFloor !== this._visApplied || this.stairFade !== this.stairFadeOn) this.applyGhost(); // stairs: drawn with the floor that owns the flight
    c.setSilhouette(this.state === 'walk' && this.visFloor === this.mgr.activeFloor && !this.stairFadeOn && this.fade > 0.5);
    this.updateAskPool(dt, now);
    if (site && this.floor === 0 && !this.path[0]?.climb && site.isOutdoor(this.pos.x)) this.y = site.groundY(this.pos.x, this.pos.z);
    else if (this.floor === 0 && !this.path[0]?.climb && this.y < 0) this.y = 0;
    c.group.position.set(this.pos.x, this.worldY(), this.pos.z);
    const alpha = this.fade;
    if (this._alpha !== alpha) { this._alpha = alpha; c.group.visible = alpha > 0.02 && !this.hiddenFloor; }
    if (!this.syncImpostor(dt)) c.update(dt); // on a dimmed / ghosted floor a frozen, merged copy stands in
    this.marks = this.marks.filter(m => now - m.at < 2200);
  }

  bubbleFor(nowMs) {
    // waiting on you outranks everything, in every state (walking, in a meeting, at the QA desk, listening…)
    if (this.agent.asking && !this.leaving && !this.done) return this.agent.askTo ? { text: this.askLine(), icon: '🙋', kind: 'ask', cls: 'agent' } : { text: this.agent.asking, icon: '🙋', kind: 'ask' };
    if (this.reaction?.bubble) return this.reaction.bubble;
    const sinceThought = nowMs - this.thoughtAt;
    const lead = this.lead;
    switch (this.state) {
      // greetings and goodbyes are invented office life: ambient (grey), never presented as agent communication
      case 'wipe': return this.greet || (this.greet = greetingFor(this.id));
      case 'walk': // on the way somewhere: `transit` bubbles yield to interactions
        if (this.path[0]?.climb) return { text: this.path[0].climb.offset === 0 ? 'going up~' : 'heading down', icon: '🪜', kind: 'ambient', transit: true };
        if (this.next === 'exitWave' || this.next === 'gone') return { text: 'see you~', icon: '👋', kind: 'ambient' };
        if (this.next === 'byeWave') return null;
        if (this.next === 'brew') return { text: 'coffee time', icon: '☕', kind: 'ambient', transit: true };
        if (this.next === 'collect') return { text: `Printing my report for ${this.action?.to?.name || 'the lead'}`, icon: '🖨️', kind: 'event', transit: true };
        if (this.next === 'present') return { text: this.action?.walk || `Off to report to ${this.action?.to?.name || 'the lead'}`, icon: this.action?.icon || '📝', kind: 'event', transit: true };
        if (this.next === 'review') return { text: `Going to review ${this.action?.to?.name || ''}'s work`, icon: '🔍', kind: 'event', transit: true };
        if (this.next === 'brief' && lead) return { text: `Joining ${lead.name}'s team`, icon: '👋', kind: 'event', transit: true };
        if (this.next === 'meet') return { text: 'Off to the meeting room', icon: '🗂️', kind: 'event', transit: true };
        if (nowMs - this.enteredAt < 4000) return { text: 'hi!', icon: '👋', kind: 'ambient' };
        return null;
      case 'brief': return null;   // the lead's "Briefing …" bubble carries it
      case 'meeting': return null; // the host's kickoff bubble carries it
      case 'meet': {
        const crew = this.meetingRoom ? [...this.meetingRoom.expected].map(id => this.mgr.workers.get(id)?.name).filter(Boolean) : [];
        return { text: `Gathering ${crew.join(', ') || 'the team'} for a kickoff`, icon: '🗂️', kind: 'event' };
      }
      case 'collect': return { text: 'Picking up the printout', icon: '🖨️', kind: 'event', transit: true };
      case 'present': return { text: this.action?.text || 'Reporting back', icon: this.action?.icon || '📝', kind: 'event' };
      case 'review': return { text: `Collecting ${this.reviewing?.taken?.name || 'the team'}'s work`, icon: '🗂️', kind: 'event', transit: true };
      case 'handover': return null;
      case 'qa': if (this.reviewTask && !this.reviewTask.stamped) return { text: `Reviewing ${this.reviewTask.to?.name || 'the team'}'s work`, icon: '🔍', kind: 'event' };
        return this.agent.thought && sinceThought < 9000 ? { text: this.agent.thought.text, icon: iconFor(this.agent.thought.kind), kind: this.agent.thought.kind } : null;
      case 'byeWave': return { text: `Bye, ${lead?.name || 'team'}!`, icon: '👋', kind: 'ambient' };
      case 'exitWave': return { text: 'bye bye!', icon: '👋', kind: 'ambient' };
      case 'stretch': return { text: 'done~ stretch!', icon: '🙆', kind: 'ambient' };
      case 'brew': return { text: 'brewing…', icon: '☕', kind: 'ambient' };
      case 'queue': return null;
      case 'ambient': if (this.ambientKind === 'wc') return null;
        if (this.ambientKind === 'bar') return this.chibi.anim === 'chat' ? { text: '♪ …', kind: 'ambient' } : null;
        if (this.ambientKind === 'foos') return { text: Math.sin(this.timer * 1.7) > 0.6 ? 'goal!' : '⚽', kind: 'ambient' };
        return this.ambientKind === 'water' ? { text: '🌱', kind: 'ambient' } : this.ambientKind === 'window' ? { text: '🌤', kind: 'ambient' } : this.ambientKind === 'cooler' ? { text: 'glug glug', icon: '💧', kind: 'ambient' } : { text: '♪ …', kind: 'ambient' };
      case 'break': {
        const anim = this.chibi.anim;
        if (anim === 'sip') return { text: 'ahh, coffee', icon: '☕', kind: 'ambient' };
        if (anim === 'yawn') return { text: 'yawn…', icon: '😪', kind: 'ambient' };
        if (anim === 'sleepy') return { text: 'zzz', icon: '💤', kind: 'ambient' };
        return null;
      }
      case 'work': {
        if (this.agent.waiting && this.role === 'lead') {
          const helpers = this.mgr.list.filter(w => w.parent === this && !w.done && w.isHelper).map(w => w.name);
          return { text: `Waiting for ${helpers.length ? helpers.slice(0, 3).join(', ') : 'the team'}`, icon: '⏳', kind: 'event' };
        }
        const th = this.agent.thought;
        if (th && sinceThought < 9000) return { text: th.text, icon: iconFor(th.kind), kind: th.kind };
        if (!this.idle && (sinceThought % 12000) < 2500) return { text: '•••', kind: 'dots' };
        return null;
      }
      default: return null;
    }
  }
}
