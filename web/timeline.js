// Today timeline: the "Today" pill opens a drawer along the bottom with one bar per session for today.
//   live – GET /api/journal?since=<local midnight> once, then incrementally (since = newest − a small overlap, deduped)
//          every 30 s while the drawer is open; nothing is fetched or drawn while it is closed
//   ?demo, or no journal (error / 404) – the same journal lines, built from what this page itself observes: mgr.workers
//          polled every 2 s for arrivals, departures and state changes, mgr.sync watched for spawn / report / verdict
// Rows: top-level sessions in arrival order, helpers and reviewers nested under their lead (indented, thinner). A bar is
// split into working (the agent's vendor colour), on a break (pale grey), waiting on you (dark ink, mustard edge) and
// gone (empty); markers show real events (report ✓, verdict stamp, spawn ↳). Hover for details, click a row whose agent
// is still in to jump to them (lookAtWorker + showCard from main.js).
// Week tab: GET /api/week (seven per-day digests, refreshed every 30 s while shown): one row per day with a 24-hour heat
// strip of time working and the day's numbers; click a past day for its timeline, read-only (GET /api/journal?day=: no
// polling, no jump-to), or today for the live Today tab. ?demo / no journal: today's row from this page's observations.
import { VENDOR } from './palette.js';

const STORE_KEY = 'ai-office-today';
const TAB_KEY = 'ai-office-today-tab';
const HEAT = '111,154,108'; // sage, the report marker's hue: one calm colour for the week's heat strips
// links (Milestone 11): a `brief` arrives as a spawn (↳), a `reply` as a report (✓); handoff ⇄ and launch ▶ get their own
// marks; approval is logged but not marked. Events may carry channel / confidence / linkKind and a `stub` end.
const ALL_EVENTS = new Set(['spawn', 'message', 'report', 'review', 'verdict', 'handoff', 'approval', 'launch']);
const MARK_EVENTS = new Set(['spawn', 'report', 'verdict', 'handoff', 'launch']);
const stubOf = e => (e?.stub && typeof e.stub === 'object' && (e.stub.side === 'from' || e.stub.side === 'to') ? e.stub : null);
const stubLabel = s => { const l = String(s?.label ?? '').replace(/^name:/, '').trim(); return l || 'someone outside the office'; };
const OBS_POLL_MS = 2000, LIVE_MS = 30000, DEMO_MS = 10000, OVERLAP_MS = 90000, RAW_LIMIT = 500;
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360]; // minutes
const PAD_R = 14; // px of breathing room right of the newest time (matches the CSS)

const pad2 = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const midnightOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function dur(ms) {
  if (!(ms >= 60000)) return '<1 min';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
/** a short form of a project (the same rule as the day board): its last path part, or that part's first word if long */
function shortProject(p) {
  const s = String(p || '').split('/').filter(Boolean).pop() || '';
  if (s.length <= 14) return s;
  return s.split(/[_\-\s.]+/).filter(Boolean)[0] || s.slice(0, 12);
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = t => { const d = new Date(t); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
/** 'YYYY-MM-DD' (a journal day) → [weekday, '20 Oct'] */
const dayParts = ds => { const [y, m, d] = String(ds).split('-').map(Number); return [WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || '', `${d} ${MONTHS[m - 1] || ''}`]; };
const fmtDate = ds => dayParts(ds).join(' ');
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
/** compact time for the week's columns: 0, 35 min, 4.2 h */
const hrs = ms => (!(ms >= 30000) ? '0' : ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : `${(ms / 3600000).toFixed(1).replace(/\.0$/, '')} h`);

// ---------- journal lines → rows of segments and markers ----------
const FOLD_AT = 4; // more direct helpers than this under one lead fold into one lane
const META = ['vendor', 'agentKind', 'project', 'task', 'parentId', 'role', 'nickname'];
export function buildModel(entries, now, final = false) { // final: a past day, whose open states end at `now` (midnight), not live
  const ag = new Map();
  let first = Infinity;
  const get = id => {
    let a = ag.get(id);
    if (!a) { a = { id, meta: {}, segs: [], marks: [], present: false, status: 'idle', ask: null, open: null, first: Infinity }; ag.set(id, a); }
    return a;
  };
  const meta = (a, e) => { for (const k of META) if (e[k] != null && e[k] !== '' && !(k === 'task' && String(a.meta.task || '').startsWith(e[k] + ':'))) a.meta[k] = e[k]; }; // a bare 'Helper' never overwrites 'Helper: the brief'
  const close = (a, t) => { const s = a.open; if (!s) return; s.to = Math.max(t, s.from); if (s.to > s.from) a.segs.push(s); a.open = null; };
  const open = (a, t) => {
    const st = a.ask != null ? 'ask' : a.status === 'working' ? 'work' : 'idle';
    const last = a.segs[a.segs.length - 1];
    if (last && last.st === st && last.to === t && st !== 'ask') { a.segs.pop(); a.open = last; return; } // same state: one segment
    a.open = { st, from: t, to: t, text: st === 'ask' ? a.ask : null };
  };
  const shift = (a, t) => { close(a, t); open(a, t); };
  const arrive = (a, t) => { // true when the agent was already in (a state change), false for a (possibly implicit) arrival
    if (a.present) return true;
    a.present = true; a.first = Math.min(a.first, t); first = Math.min(first, t);
    return false;
  };
  const sorted = entries.slice().sort((x, y) => Number(x.t) - Number(y.t));
  for (const e of sorted) {
    const t = Number(e.t);
    if (!e || !Number.isFinite(t)) continue;
    if (ALL_EVENTS.has(e.kind)) {
      if (!MARK_EVENTS.has(e.kind)) continue;
      // a link from a party outside the office (stub side 'from') sits on the receiver's row, named by its label
      const stub = stubOf(e), id = e.id || (stub?.side === 'from' ? e.to : null);
      if (!id) continue;
      const at = Number(e.at) || t, a = get(id);
      meta(a, e);
      a.marks.push({ k: e.kind, t: at, to: stub?.side === 'to' ? null : e.to || null, text: e.text || null, outcome: e.outcome ?? null, risk: e.risk ?? null,
        channel: e.channel ? String(e.channel) : null, confidence: e.confidence ? String(e.confidence) : null, linkKind: e.linkKind ? String(e.linkKind) : null,
        by: e.by ?? (stub?.side === 'from' ? stubLabel(stub) : null), toLabel: e.toLabel ?? (stub?.side === 'to' ? stubLabel(stub) : null) });
      a.first = Math.min(a.first, at); first = Math.min(first, at);
      continue;
    }
    if (!e.id) continue;
    const a = get(e.id);
    meta(a, e);
    switch (e.kind) {
      case 'arrived': { const was = arrive(a, t); a.status = e.status === 'working' ? 'working' : 'idle'; a.ask = null; if (was) shift(a, t); else open(a, t); break; }
      case 'working': case 'idle': { const was = arrive(a, t); a.status = e.kind; if (was) shift(a, t); else open(a, t); break; }
      case 'asking-start': { if (e.askTo) break; const was = arrive(a, t); a.ask = e.text || e.asking || 'a question'; if (was) shift(a, t); else open(a, t); break; }
      case 'asking-end': if (a.present && a.ask != null) { a.ask = null; shift(a, t); } break;
      case 'left': if (a.present) { close(a, t); a.present = false; a.ask = null; } break;
      case 'role-change': if (e.role !== undefined) a.meta.role = e.role; break;
      default: break;
    }
  }
  for (const a of ag.values()) {
    if (a.open) { if (!final) a.open.live = true; close(a, Math.max(now, a.open.from)); }
    // rounded ends where someone walks in and out (s0 / s1), square joins between states
    a.segs.forEach((s, i) => { s.s0 = !(i && a.segs[i - 1].to === s.from); s.s1 = !(a.segs[i + 1] && a.segs[i + 1].from === s.to); });
  }
  // rows: top-level sessions in arrival order; helpers / reviewers under their lead (depth capped for the indent)
  const shown = [...ag.values()].filter(a => a.segs.length || a.marks.length);
  const ids = new Set(shown.map(a => a.id));
  const kids = new Map(), tops = [];
  for (const a of shown) {
    const p = a.meta.parentId;
    if (p && p !== a.id && ids.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); } else tops.push(a);
  }
  const byFirst = (x, y) => x.first - y.first || String(x.id).localeCompare(String(y.id));
  tops.sort(byFirst);
  const rows = [], seen = new Set();
  const walk = (a, depth) => {
    if (seen.has(a.id)) return; seen.add(a.id);
    rows.push({ a, depth });
    for (const k of (kids.get(a.id) || []).sort(byFirst)) walk(k, depth + 1);
  };
  for (const a of tops) walk(a, 0);
  for (const a of shown) if (!seen.has(a.id)) walk(a, 0); // a parent loop: show them anyway
  return { rows, first };
}

// markers of the same kind closer than this on screen merge into one, with a count (the tooltip lists them)
const MARK_MERGE_PX = 8;
const MARK_GLYPH = { rep: '✓', ok: '✓', flag: '!', spawn: '↳', hand: '⇄', launch: '▶' };
const markClass = m => (m.k === 'report' ? 'rep' : m.k === 'verdict' ? ((m.outcome ?? 'allow') === 'allow' ? 'ok' : 'flag') : m.k === 'handoff' ? 'hand' : m.k === 'launch' ? 'launch' : 'spawn');
/** " · via <channel>[ · artifact]" for a mark's tooltip: the channel names how the link travelled, weak confidence is said */
const viaText = m => `${m.channel ? ` · via ${esc(m.channel)}` : ''}${m.confidence === 'artifact' || m.confidence === 'inferred' ? ` · ${esc(m.confidence)}` : ''}`;
/** group a row's marks by kind into runs whose neighbours are under MARK_MERGE_PX apart at `xOf(t)` px; each group is
 *  drawn at its members' mean position (so the groups of one kind never overlap each other) */
export function groupMarks(marks, xOf, gap = MARK_MERGE_PX) {
  const byCls = new Map();
  for (const m of marks) { const c = markClass(m); if (!byCls.has(c)) byCls.set(c, []); byCls.get(c).push(m); }
  const out = [];
  for (const [cls, list] of byCls) {
    list.sort((p, q) => p.t - q.t);
    let g = null, lastX = -Infinity;
    for (const m of list) {
      const x = xOf(m.t);
      if (g && x - lastX < gap) { g.ms.push(m); g.sum += x; } else { g = { cls, ms: [m], sum: x }; out.push(g); }
      lastX = x;
    }
  }
  for (const g of out) g.x = g.sum / g.ms.length;
  return out.sort((p, q) => p.x - q.x);
}

// ---------- one agent's day, for the worker card (main.js) ----------
let dayFn = null; // set while the drawer module runs (startTimeline)
/** One agent's day from the data the timeline already holds (no fetch): { segs: [{ st: 'work' | 'idle' | 'ask', from,
 *  to, live, text }], marks: [{ k, t, to, text, outcome, risk }], start, end, first, workMs, partial, since } — the
 *  axis runs from the Today drawer's start to now; `partial` when it rests on what this page has seen itself (since
 *  `since`) rather than on today's journal. null when the timeline has not started or holds nothing yet. */
export function agentDay(id) {
  try { return dayFn ? dayFn(id) : null; } catch (err) { console.warn('timeline:', err); return null; }
}

const isSession = (a, depth) => depth === 0 && a.meta.agentKind !== 'subagent' && a.meta.agentKind !== 'guardian' && !a.meta.parentId;
const isReviewer = a => a.meta.agentKind === 'guardian' || a.meta.role === 'reviewer';

// ---------- the page's own observations (demo, or no journal) ----------
function createObserver(mgr) {
  const obs = { entries: [], since: Date.now(), day: midnightOf(Date.now()), prev: new Map(), seen: new Map() };
  const infoOf = (a, w) => {
    const o = { id: a.id, vendor: a.vendor || null, agentKind: a.kind || null, project: a.project || null, task: clip(a.task, 120) || null,
      parentId: a.parentId || null, role: a.role || w?.role || null };
    if (a.nickname) o.nickname = a.nickname;
    return o;
  };
  const push = (kind, info, extra) => obs.entries.push({ t: Date.now(), kind, ...info, ...extra });
  function dayCheck(now) {
    const d = midnightOf(now);
    if (d === obs.day) return;
    obs.day = d; obs.entries = []; obs.since = now;
    for (const p of obs.prev.values()) p.present = false; // whoever is still in is carried over by the next poll
    for (const [id, at] of obs.seen) if (at < d - 3600000) obs.seen.delete(id);
  }
  function poll() {
    const now = Date.now();
    dayCheck(now);
    for (const [id, w] of mgr.workers) {
      const a = w?.agent; if (!a) continue;
      const p = obs.prev.get(id), gone = w.done || w.leaving;
      if (gone) { if (p?.present) { push('left', p.info); p.present = false; } continue; }
      const info = infoOf(a, w), status = a.status === 'working' ? 'working' : 'idle', asking = a.asking && !a.askTo ? String(a.asking) : null; // an ask to another agent is work, not waiting on you
      if (!p || !p.present) {
        push('arrived', info, { status });
        if (asking) push('asking-start', info, { text: clip(asking, 160) });
        obs.prev.set(id, { present: true, status, asking, role: info.role, info });
        continue;
      }
      if (p.status !== status) { push(status, info); p.status = status; }
      if (!!asking !== !!p.asking) { push(asking ? 'asking-start' : 'asking-end', info, asking ? { text: clip(asking, 160) } : {}); }
      p.asking = asking;
      if (info.role !== p.role) { push('role-change', info, { from: p.role }); p.role = info.role; }
      p.info = info;
    }
    for (const [id, p] of obs.prev) {
      if (mgr.workers.has(id)) continue;
      if (p.present) push('left', p.info);
      obs.prev.delete(id);
    }
  }
  function onEvents(events) {
    const now = Date.now();
    for (const ev of events || []) {
      if (!ev || !ev.id || !ALL_EVENTS.has(ev.kind) || obs.seen.has(ev.id)) continue;
      const at = typeof ev.at === 'number' ? ev.at : Date.parse(ev.at) || now;
      obs.seen.set(ev.id, at);
      if (at < obs.day) continue;
      const stub = stubOf(ev), owner = stub?.side === 'from' ? ev.to : ev.from; // a link from outside sits on the receiver's row
      if (!owner) continue;
      const w = mgr.workers.get(owner), info = w?.agent ? infoOf(w.agent, w) : { id: owner };
      const e = { t: now, kind: ev.kind, eid: ev.id, ...info, to: stub?.side === 'to' ? null : ev.to || null, at };
      if (ev.text) e.text = clip(ev.text, 240);
      if (ev.verdict) { e.outcome = ev.verdict.outcome ?? null; e.risk = ev.verdict.risk ?? null; }
      if (ev.channel) e.channel = clip(ev.channel, 40);
      if (ev.confidence) e.confidence = String(ev.confidence);
      if (ev.linkKind) e.linkKind = String(ev.linkKind);
      if (stub) e[stub.side === 'from' ? 'by' : 'toLabel'] = clip(stubLabel(stub), 60);
      obs.entries.push(e);
    }
  }
  return { obs, poll, onEvents, dayCheck };
}

// ---------- the week's styles (kept here with the markup; style.css holds the rest of the drawer) ----------
function injectWeekStyle() {
  if (document.getElementById('tl-week-style')) return;
  const st = document.createElement('style');
  st.id = 'tl-week-style';
  st.textContent = `
#timeline .tl-head { align-items: center; }
.tl-tabs { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(236,232,240,.75); }
.tl-tab { margin: 0; border: 0; background: transparent; font: inherit; font-size: 12px; font-weight: 700; line-height: 1.35; letter-spacing: .02em;
  color: var(--ink-soft); padding: 2px 11px; border-radius: 999px; cursor: pointer; }
.tl-tab:hover { color: var(--ink); }
.tl-tab[aria-selected="true"] { background: #fff; color: var(--ink); font-weight: 800; box-shadow: 0 1px 2px rgba(60,40,90,.14); }
.tl-tab:focus-visible, .tl-back:focus-visible { outline: 2px solid #b9b2c6; outline-offset: 1px; }
.tl-back { margin: 0; border: 0; background: transparent; font: inherit; font-size: 11px; font-weight: 700; color: var(--ink-soft);
  padding: 2px 8px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
.tl-back:hover { color: var(--ink); background: rgba(236,232,240,.75); }
.tl-back[hidden] { display: none; }
.tl-head .tl-date.past { color: var(--ink); font-weight: 800; font-size: 12px; margin-left: 0; }
.tl-week[hidden] { display: none; }
.tl-whead, .tl-wrow { display: grid; grid-template-columns: var(--lw, 156px) minmax(96px, 1fr) 62px 56px 62px 96px 58px; align-items: center; }
.tl-whead { position: sticky; top: 0; z-index: 2; height: 18px; font-size: 10px; font-weight: 600; color: var(--ink-soft);
  background: linear-gradient(#fffdfa 75%, rgba(255,253,250,0)); }
.tl-hours { position: relative; height: 100%; }
.tl-hours span { position: absolute; top: 1px; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
.tl-hours span:first-child { transform: none; }
.tl-hours .end { left: auto; right: 0; transform: none; }
.tl-whead .n, .tl-wrow .n { text-align: right; padding-right: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tl-whead .n .sm { display: none; }
.tl-wrow { height: 26px; border-radius: 8px; }
.tl-wrow + .tl-wrow { border-top: 1px dashed #ece8f0; border-radius: 0 0 8px 8px; }
.tl-wrow[role] { cursor: pointer; }
.tl-wrow[role]:hover { background: rgba(236,232,240,.6); }
.tl-wrow[role]:focus-visible { outline: 2px solid #b9b2c6; outline-offset: -2px; }
.tl-wrow.today { background: rgba(255,243,214,.5); }
.tl-wrow.today[role]:hover { background: rgba(255,243,214,.9); }
.tl-wlab { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding: 0 8px 0 4px; white-space: nowrap; overflow: hidden; }
.tl-wlab b { font-weight: 800; min-width: 26px; }
.tl-wlab span { color: var(--ink-soft); font-weight: 600; font-size: 11px; }
.tl-wrow.quiet .tl-wlab b { color: var(--ink-soft); font-weight: 700; }
.tl-tday { font-style: normal; font-size: 9.5px; font-weight: 800; letter-spacing: .04em; color: #94701f; background: rgba(240,178,58,.2);
  padding: 1px 6px; border-radius: 999px; }
.tl-heat { display: flex; gap: 2px; height: 12px; }
.tl-heat .hc { flex: 1; min-width: 0; border-radius: 3px; background: rgba(${HEAT}, var(--a, 0)); }
.tl-heat .hc.z { background: rgba(90,70,110,.06); }
.tl-heat .hc.f { background: transparent; box-shadow: inset 0 0 0 1px rgba(90,70,110,.07); }
.tl-heat .hc.q { margin-left: 3px; }
.tl-heat .hc:hover { box-shadow: inset 0 0 0 1.5px rgba(59,51,70,.3); }
.tl-wrow .n { font-weight: 800; }
.tl-wrow .n.z { color: #c9c3d3; font-weight: 600; }
.mk.many { overflow: visible; }
.mk .mk-n { position: absolute; top: -6px; left: 8px; min-width: 9px; height: 9px; padding: 0 2px; box-sizing: border-box; border-radius: 999px;
  background: var(--m); color: #fff; font-style: normal; font-size: 7px; font-weight: 800; line-height: 9px; text-align: center;
  box-shadow: 0 0 0 1px #fff; pointer-events: none; }
.tl-row.sub .mk .mk-n { top: -6px; left: 7px; }
.mk.ok .mk-n, .mk.flag .mk-n { transform: rotate(8deg); }
.tl-wnote { margin: 8px 4px 4px; text-align: center; color: var(--ink-soft); font-size: 11px; font-weight: 600; }
@media (max-width: 760px) {
  .tl-whead, .tl-wrow { grid-template-columns: var(--lw, 92px) minmax(64px, 1fr) 52px 54px 54px; }
  .tl-whead .n, .tl-wrow .n { padding-right: 6px; }
  .tl-whead .h, .tl-wrow .h, .tl-tday { display: none; }
  .tl-whead .n .lg { display: none; }
  .tl-whead .n .sm { display: inline; }
}`;
  document.head.appendChild(st);
}

// ---------- the drawer ----------
/** Start the Today timeline. `mgr` is the OfficeManager; `demo` true in ?demo; lookAtWorker / showCard come from main.js. */
export function startTimeline({ mgr, demo = false, lookAtWorker, showCard } = {}) {
  const pill = document.getElementById('todayToggle');
  if (!mgr || !pill || mgr.__timeline) return mgr?.__timeline;

  // --- DOM
  const el = document.createElement('section');
  el.id = 'timeline'; el.hidden = true;
  el.setAttribute('role', 'region'); el.setAttribute('aria-label', "Today's timeline");
  el.innerHTML = `<header class="tl-head"><div class="tl-tabs" role="tablist" aria-label="timeline range">`
    + `<button type="button" role="tab" class="tl-tab" data-tab="today" aria-selected="true">Today</button>`
    + `<button type="button" role="tab" class="tl-tab" data-tab="week" aria-selected="false">Week</button></div>`
    + `<button type="button" class="tl-back" hidden title="back to the week">‹ back to week</button><span class="tl-date"></span>
    <div class="tl-sum"></div><span class="tl-src"></span>
    <button type="button" class="tl-close" aria-label="close the timeline">×</button></header>
    <div class="tl-scroll"><div class="tl-grid"><div class="tl-axis"><div class="tl-ticks"></div></div>
    <div class="tl-area tl-lines"></div><div class="tl-rows"></div><div class="tl-area tl-nowa"><i class="tl-now"></i></div></div>
    <div class="tl-week" hidden></div><p class="tl-empty" hidden>Nothing yet today</p></div>`;
  document.body.appendChild(el);
  injectWeekStyle();
  const tip = document.createElement('div');
  tip.className = 'tl-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  const $ = s => el.querySelector(s);
  const dateEl = $('.tl-date'), sumEl = $('.tl-sum'), srcEl = $('.tl-src'), scrollEl = $('.tl-scroll'), gridEl = $('.tl-grid');
  const ticksEl = $('.tl-ticks'), linesEl = $('.tl-lines'), rowsEl = $('.tl-rows'), nowEl = $('.tl-now'), emptyEl = $('.tl-empty');
  const weekEl = $('.tl-week'), backEl = $('.tl-back'), tabEls = [...el.querySelectorAll('.tl-tab')];
  pill.hidden = false;
  pill.setAttribute('aria-controls', 'timeline');

  // --- data
  const { obs, poll, onEvents, dayCheck } = createObserver(mgr);
  const names = new Map(); // id -> the name the office gave that agent (kept after they leave; pruned at midnight)
  const expanded = new Set(); // leads whose folded helpers are shown one per row (pruned at midnight)
  const remember = () => { for (const [id, w] of mgr.workers) if (w?.name) names.set(id, w.name); };
  const sync = mgr.sync;
  mgr.sync = function (agents, events, now) {
    const r = sync.apply(this, arguments);
    try { onEvents(events); remember(); } catch (err) { console.warn('timeline:', err); }
    return r;
  };
  remember(); poll();
  let pruneDay = midnightOf(Date.now());
  /** at midnight: forget names and unfolded leads of anyone not still in and not in today's entries, so a tab left
   *  open for days does not keep every agent it ever saw */
  function pruneAtMidnight(now) {
    const day = midnightOf(now);
    if (day === pruneDay) return;
    pruneDay = day;
    const keep = new Set(mgr.workers.keys());
    for (const list of [jEntries, obs.entries]) for (const e of list) if (e?.id && Number(e.t) >= day) { keep.add(e.id); if (e.parentId) keep.add(e.parentId); }
    for (const id of names.keys()) if (!keep.has(id)) names.delete(id);
    for (const id of expanded) if (!keep.has(id)) expanded.delete(id);
  }
  const obsTimer = setInterval(() => {
    try { const now = Date.now(); poll(); remember(); pruneAtMidnight(now); } catch (err) { console.warn('timeline:', err); }
  }, OBS_POLL_MS);

  let mode = demo ? 'observe' : 'journal';
  let jEntries = [], jSeen = new Set(), jDay = midnightOf(Date.now()), jLoaded = false, jTrimmed = false, jNewest = 0, fetching = false;
  let jPulledAt = 0; // when the last good pull was asked for: the journal covers up to here, this page's observations after
  const sig = e => `${e.t}|${e.kind}|${e.id}|${e.eid || ''}|${e.at || ''}|${e.status || ''}`;
  function resetJournal(day) { jEntries = []; jSeen = new Set(); jDay = day; jLoaded = false; jTrimmed = false; jNewest = 0; }
  async function pull() {
    if (demo || fetching) return;
    fetching = true;
    const day = midnightOf(Date.now());
    if (day !== jDay) resetJournal(day);
    const firstPull = !jLoaded;
    const since = firstPull ? day : Math.max(day, jNewest - OVERLAP_MS); // a departure is written up to ~10 s back-dated
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), 6000), askedAt = Date.now();
    try {
      const res = await fetch(`/api/journal?since=${since}`, { cache: 'no-store', signal: ctl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const list = Array.isArray(j) ? j : Array.isArray(j?.entries) ? j.entries : null;
      if (!list) throw new Error('unexpected shape');
      if (midnightOf(Date.now()) !== jDay) return; // the day turned while we waited: the next pull starts the new one
      if (firstPull && list.length >= RAW_LIMIT) jTrimmed = true; // the server sends the newest 500: earlier hours are missing
      for (const e of list) {
        if (!e || typeof e !== 'object' || !e.kind || !(Number(e.t) >= day)) continue;
        const k = sig(e); if (jSeen.has(k)) continue;
        jSeen.add(k); jEntries.push(e); jNewest = Math.max(jNewest, Number(e.t));
      }
      jLoaded = true; mode = 'journal'; jPulledAt = askedAt;
    } catch {
      if (!jLoaded) mode = 'observe'; // no journal (old server, offline): what this page has seen itself
    } finally { clearTimeout(timer); fetching = false; }
  }
  async function getJson(url) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), 8000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // --- the week (GET /api/week) and a past day (GET /api/journal?day=)
  let tab = 'today', pastDay = null; // pastDay: { date, data, error } while a past day is shown under the Week tab
  let week = null, weekFailed = false, weekFetching = false, pastSeq = 0;
  try { if (localStorage.getItem(TAB_KEY) === 'week') tab = 'week'; } catch { /* ignore */ }
  const view = () => (tab === 'today' ? 'today' : pastDay ? 'past' : 'week');
  async function pullWeek() {
    if (demo || weekFetching) return;
    weekFetching = true;
    try {
      const j = await getJson('/api/week');
      if (!j || !Array.isArray(j.days)) throw new Error('unexpected shape');
      week = j; weekFailed = false;
    } catch { weekFailed = true; } finally { weekFetching = false; }
  }
  async function openPast(date) {
    const seq = ++pastSeq;
    pastDay = { date, data: null, error: false };
    render();
    try {
      const j = await getJson(`/api/journal?day=${encodeURIComponent(date)}`);
      if (!j || !Array.isArray(j.entries)) throw new Error('unexpected shape');
      if (seq === pastSeq && pastDay?.date === date) pastDay.data = j;
    } catch { if (seq === pastSeq && pastDay?.date === date) pastDay.error = true; }
    if (seq === pastSeq) render();
  }
  function setTab(t, persist = true) {
    tab = t === 'week' ? 'week' : 'today'; pastDay = null; pastSeq++;
    if (persist) { try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ } }
    render(); tick();
  }
  /** today's week row from the timeline this page already has (?demo, or no /api/week): same numbers as the drawer */
  function localToday(now) {
    const { rows } = buildModel(mode === 'journal' ? jEntries : obs.entries, now);
    const day = midnightOf(now), hourly = new Array(24).fill(0);
    const d = { date: isoDay(now), sessions: 0, helpers: 0, workingMs: 0, askMs: 0, reports: 0, projects: [], hourly };
    for (const { a, depth } of rows) {
      const session = isSession(a, depth);
      if (session) d.sessions++; else if (a.meta.agentKind === 'subagent' || a.meta.role === 'helper') d.helpers++;
      for (const s of a.segs) {
        const from = Math.max(s.from, day);
        if (s.to <= from) continue;
        if (s.st === 'ask') d.askMs += s.to - from;
        else if (s.st === 'work' && session) {
          d.workingMs += s.to - from;
          for (let t = from; t < s.to;) { const next = Math.min(s.to, new Date(t).setMinutes(60, 0, 0)); hourly[new Date(t).getHours()] += next - t; t = next; }
        }
      }
      for (const m of a.marks) if (m.k === 'report') d.reports++;
    }
    d.hourly = hourly.map(ms => ms / 60000);
    return d;
  }

  // --- render
  let isOpen = false, timer = null, items = [], renderRows = [], resizeT = null;
  const labelW = () => (window.innerWidth <= 760 ? 92 : 156);
  const briefOf = a => (a.meta.agentKind === 'subagent' || a.meta.role === 'helper') && /^Helper: ./.test(a.meta.task || '') ? a.meta.task.slice(8) : null; // a helper who left: what they were asked to do
  const nameOf = a => mgr.workers.get(a.id)?.name || names.get(a.id) || a.meta.nickname || briefOf(a) || shortProject(a.meta.project) || 'someone';
  const nameOfId = (id, rows) => { if (!id) return null; const r = rows.find(x => x.a.id === id); return r ? nameOf(r.a) : mgr.workers.get(id)?.name || names.get(id) || null; };

  function axisFor(first, now, compact, day = midnightOf(now)) {
    let start;
    if (compact) { // the page's own observations: from the first one, at least 8 min
      start = Math.min(Number.isFinite(first) ? first - 60000 : now, now - 8 * 60000); // a few minutes of demo should fill the track, not a sliver
    } else { // the first entry or 08:00, whichever is earlier, on the hour; at least an hour
      const eight = day + 8 * 3600000;
      start = Math.min(Number.isFinite(first) ? first - 10 * 60000 : eight, eight, now - 3600000);
      const d = new Date(Math.max(start, day)); d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0); start = d.getTime(); // on the half hour, so an early start wastes no empty hour
    }
    start = Math.max(start, day);
    const end = now + Math.max(60000, (now - start) * 0.012);
    return { start, end, now };
  }

  function syncHead() {
    const v = view();
    for (const b of tabEls) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    backEl.hidden = v !== 'past';
    dateEl.classList.toggle('past', v === 'past');
    el.setAttribute('aria-label', v === 'today' ? "Today's timeline" : v === 'week' ? 'The week' : `Timeline of ${fmtDate(pastDay.date)}`);
  }

  function render() {
    if (!isOpen) return;
    syncHead();
    const v = view();
    weekEl.hidden = v !== 'week';
    if (v === 'week') return renderWeek();
    if (v === 'past') {
      const pd = pastDay;
      if (pd.data) return renderDay({ entries: pd.data.entries, past: { date: pd.date, start: Number(pd.data.start), end: Number(pd.data.end), trimmed: !!pd.data.trimmed } });
      hideTip(); items = [];
      dateEl.textContent = fmtDate(pd.date); sumEl.innerHTML = ''; srcEl.textContent = '';
      gridEl.hidden = true; emptyEl.hidden = false;
      emptyEl.textContent = pd.error ? 'Could not load that day' : 'Loading…';
      return;
    }
    renderDay({ entries: null, past: null });
  }

  /** a day's timeline: today (live), or a past day (`past`: { date, start, end, trimmed }; read-only, no jump-to) */
  function renderDay({ entries, past }) {
    let now = Date.now();
    if (!past && (mode === 'observe' || demo)) dayCheck(now);
    if (!past) entries = mode === 'journal' ? jEntries : obs.entries;
    const pastEnd = past && Number.isFinite(past.end) ? past.end : midnightOf(now);
    const { rows, first } = past ? buildModel(entries, pastEnd, true) : buildModel(entries, now);
    let day = midnightOf(now);
    if (past) { // the axis runs to the day's last activity (midnight if someone was still in), not to now
      day = Number.isFinite(past.start) ? past.start : midnightOf(pastEnd - 1);
      let last = Number.isFinite(first) ? first : day + 8 * 3600000;
      for (const { a } of rows) { for (const s of a.segs) last = Math.max(last, s.to); for (const m of a.marks) last = Math.max(last, m.t); }
      now = Math.min(Math.max(last, day + 3600000), pastEnd);
    }
    const compact = !past && mode !== 'journal';
    const ax = axisFor(first, now, compact, day);
    const span = ax.end - ax.start;
    const pct = t => Math.max(0, Math.min(100, (t - ax.start) / span * 100));
    const lw = labelW();
    gridEl.style.setProperty('--lw', `${lw}px`);
    dateEl.textContent = past ? fmtDate(past.date) : fmtDay(now);
    srcEl.textContent = past ? (past.trimmed && Number.isFinite(first) ? `from ${hhmm(first)} (earlier trimmed)` : 'read-only')
      : demo ? `demo · seen since ${hhmm(obs.since)}` : compact ? `seen here since ${hhmm(obs.since)}`
      : jTrimmed && Number.isFinite(first) ? `from ${hhmm(first)} (earlier trimmed)` : '';
    hideTip();
    items = [];
    nowEl.hidden = !!past;
    emptyEl.textContent = past ? 'Nothing that day' : 'Nothing yet today';

    if (!rows.length) {
      sumEl.innerHTML = ''; rowsEl.innerHTML = ''; ticksEl.innerHTML = ''; linesEl.innerHTML = '';
      gridEl.hidden = true; emptyEl.hidden = false;
      renderRows = [];
      return;
    }
    gridEl.hidden = false; emptyEl.hidden = true;
    const isIn = id => { if (past) return false; const w = mgr.workers.get(id); return !!(w && !w.done && !w.leaving); };

    // ticks: the smallest step that keeps labels ~56 px apart
    const trackW = Math.max(80, scrollEl.clientWidth - lw - PAD_R);
    const spanMin = span / 60000;
    const step = TICK_STEPS.find(s => trackW * s / spanMin >= 56) || 720;
    const tickDay = midnightOf(ax.start), nowX = past ? -1e9 : pct(now) / 100 * trackW;
    let ticks = '', lines = '';
    const s0 = new Date(ax.start), m0 = s0.getHours() * 60 + s0.getMinutes();
    for (let m = Math.ceil(m0 / step) * step; ; m += step) {
      const d = new Date(tickDay); d.setHours(0, m, 0, 0);
      const t = d.getTime(); if (t > ax.end) break;
      const p = pct(t), x = p / 100 * trackW;
      lines += `<i style="left:${p.toFixed(3)}%"></i>`;
      if (Math.abs(x - nowX) > 30) ticks += `<span class="tl-tick" style="left:${p.toFixed(3)}%">${hhmm(t)}</span>`;
    }
    if (!past) ticks += `<span class="tl-tick tl-nowlab" style="left:${pct(now).toFixed(3)}%">now</span>`;
    ticksEl.innerHTML = ticks; linesEl.innerHTML = lines;
    nowEl.style.left = `${pct(now).toFixed(3)}%`;

    // rows
    let sessions = 0, helpers = 0, workMs = 0, askMs = 0, reports = 0;
    const vendors = new Set();
    let html = '';
    // a lead with a crowd of helpers: the live ones and the latest two stay, the rest fold into one lane
    const shownRows = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; shownRows.push(r);
      if (r.depth !== 0) continue;
      let j = i + 1; while (j < rows.length && rows[j].depth > 0) j++;
      const kids = rows.slice(i + 1, j); i = j - 1;
      const direct = kids.filter(k => k.depth === 1);
      if (direct.length <= FOLD_AT) { shownRows.push(...kids); continue; }
      if (expanded.has(r.a.id)) { shownRows.push({ foldBack: r.a, n: direct.length }, ...kids); continue; }
      const isLive = k => isIn(k.a.id);
      const keep = new Set(direct.filter(isLive).map(k => k.a.id));
      for (const k of direct.slice(-2)) keep.add(k.a.id);
      const folded = []; let keepSub = false;
      for (const k of kids) { if (k.depth === 1) keepSub = keep.has(k.a.id); (keepSub ? shownRows : folded).push(k); }
      if (folded.length) shownRows.splice(shownRows.length - (kids.length - folded.length), 0, { fold: folded, lead: r.a });
    }
    for (const row of shownRows) {
      if (row.foldBack) {
        html += `<div class="tl-row sub fold" data-fold="${esc(row.foldBack.id)}" role="button" tabindex="0" aria-expanded="true">`
          + `<div class="tl-lab" title="fold them into one lane"><i class="dot" style="--c:#b9b2c6"></i><b>↳ all ${row.n} helpers ▾</b></div><div class="tl-track"></div></div>`;
        continue;
      }
      if (row.fold) { // one lane: every folded helper's bars, lighter; click to unfold
        let segs = '', n = 0;
        for (const { a } of row.fold) {
          if (a.meta.agentKind === 'subagent' || a.meta.role === 'helper') { helpers++; n++; }
          const vendor = VENDOR[a.meta.vendor] ? a.meta.vendor : null;
          for (const s of a.segs) {
            if (s.to <= ax.start) continue;
            if (s.st === 'ask') askMs += s.to - s.from;
            const l = pct(s.from), r = pct(s.to), k = items.push({ type: 'seg', a, s }) - 1;
            segs += `<i class="sg ${s.st} s0 s1" data-k="${k}" style="left:${l.toFixed(3)}%;width:${Math.max(0, r - l).toFixed(3)}%;--c:${vendor ? VENDOR[vendor].css : '#9aa0b0'}"></i>`;
          }
          for (const m of a.marks) if (m.k === 'report') reports++;
        }
        html += `<div class="tl-row sub fold" data-fold="${esc(row.lead.id)}" role="button" tabindex="0" aria-expanded="false">`
          + `<div class="tl-lab" title="show each of them"><i class="dot" style="--c:#b9b2c6"></i><b>↳ ${n || row.fold.length} earlier ${(n || row.fold.length) === 1 ? 'helper' : 'helpers'} ▸</b></div>`
          + `<div class="tl-track">${segs}</div></div>`;
        continue;
      }
      const { a, depth } = row;
      const live = isIn(a.id);
      const vendor = VENDOR[a.meta.vendor] ? a.meta.vendor : null;
      const col = vendor ? VENDOR[vendor].css : '#9aa0b0';
      const session = isSession(a, depth), reviewer = isReviewer(a);
      if (session) sessions++; else if (a.meta.agentKind === 'subagent' || a.meta.role === 'helper') helpers++;
      const name = nameOf(a), proj = shortProject(a.meta.project);
      let segs = '';
      for (const s of a.segs) {
        if (s.to <= ax.start) continue;
        const d = s.to - s.from;
        if (s.st === 'work') { if (session) workMs += d; if (vendor) vendors.add(vendor); }
        else if (s.st === 'ask') askMs += d;
        const l = pct(s.from), r = pct(s.to);
        const k = items.push({ type: 'seg', a, s }) - 1;
        segs += `<i class="sg ${s.st}${s.s0 ? ' s0' : ''}${s.s1 ? ' s1' : ''}" data-k="${k}" style="left:${l.toFixed(3)}%;width:${Math.max(0, r - l).toFixed(3)}%"></i>`;
      }
      for (const m of a.marks) if (m.k === 'report') reports++;
      for (const g of groupMarks(a.marks, t => pct(t) / 100 * trackW)) {
        const k = items.push(g.ms.length > 1 ? { type: 'marks', a, ms: g.ms, cls: g.cls } : { type: 'mark', a, m: g.ms[0] }) - 1;
        const n = g.ms.length;
        segs += `<b class="mk ${g.cls}${n > 1 ? ' many' : ''}" data-k="${k}" style="left:${(g.x / trackW * 100).toFixed(3)}%">${MARK_GLYPH[g.cls]}${n > 1 ? `<i class="mk-n">${n > 99 ? '99+' : n}</i>` : ''}</b>`;
      }
      const lastSeg = a.segs[a.segs.length - 1];
      const title = [name, a.meta.project || '', a.meta.task || '', live ? 'click to jump to them' : past && lastSeg && lastSeg.to >= pastEnd ? 'still in at midnight' : lastSeg && !lastSeg.live ? `left at ${hhmm(lastSeg.to)}` : ''].filter(Boolean).join(' · ');
      const glyph = reviewer ? '✓ ' : depth > 0 ? '↳ ' : '';
      const cls = `tl-row ${depth === 0 ? 'top' : depth === 1 ? 'sub' : 'sub sub2'}${live ? ' live' : ''}`;
      html += `<div class="${cls}" data-id="${esc(a.id)}"${live ? ' role="button" tabindex="0"' : ''}>`
        + `<div class="tl-lab" title="${esc(title)}"><i class="dot" style="--c:${col}"></i><b>${esc(glyph + name)}</b>${depth === 0 && proj && proj !== name ? `<span class="pj">${esc(proj)}</span>` : ''}</div>`
        + `<div class="tl-track" style="--c:${col}">${segs}</div></div>`;
    }
    rowsEl.innerHTML = html;

    // summary: sessions, time working (top-level sessions), time waiting on you, reports
    const vs = [...vendors].map(v => VENDOR[v].css);
    const grad = vs.length > 1 ? `linear-gradient(90deg, ${vs.map((c, i) => `${c} ${(i / vs.length * 100).toFixed(1)}% ${((i + 1) / vs.length * 100).toFixed(1)}%`).join(', ')})` : vs[0] || '#9aa0b0';
    const parts = [`<span><b>${sessions}</b> ${sessions === 1 ? 'session' : 'sessions'}</span>`];
    if (helpers) parts.push(`<span><b>${helpers}</b> ${helpers === 1 ? 'helper' : 'helpers'}</span>`);
    parts.push(`<span title="summed over the top-level sessions"><i class="sw" style="background:${grad}"></i><b>${workMs ? dur(workMs) : '0 min'}</b> working</span>`);
    parts.push(`<span title="summed over everyone who waited on you"><i class="sw ask"></i><b>${askMs ? dur(askMs) : '0 min'}</b> waiting on you</span>`);
    parts.push(`<span><i class="sw idle"></i>on a break</span>`);
    parts.push(`<span><b>${reports}</b> ${reports === 1 ? 'report' : 'reports'}</span>`);
    sumEl.innerHTML = parts.join('');
    renderRows = rows;
  }

  // --- the week: one row per day, oldest first, today last
  function renderWeek() {
    const now = Date.now();
    hideTip(); items = [];
    gridEl.hidden = true; emptyEl.hidden = true;
    if (!demo && !week && !weekFailed) { // the first fetch is on its way
      weekEl.innerHTML = '<p class="tl-wnote">Loading the week…</p>';
      dateEl.textContent = ''; srcEl.textContent = ''; sumEl.innerHTML = '';
      return;
    }
    const fallback = demo || !week; // no journal: only what this page has seen today
    if (fallback && (mode === 'observe' || demo)) dayCheck(now);
    const days = fallback ? [localToday(now)] : week.days.filter(d => d && typeof d.date === 'string');
    const today = fallback ? days[0].date : week.today;
    const nowHour = new Date(now).getHours();
    const lw = labelW();
    weekEl.style.setProperty('--lw', `${lw}px`);
    let scale = 30; // minutes: the busiest hour of the week is the darkest cell (at least half an hour)
    for (const d of days) for (const m of d.hourly || []) if (Number(m) > scale) scale = Number(m);
    const tot = { sessions: 0, helpers: 0, workingMs: 0, askMs: 0, reports: 0 };
    let busiest = null;
    let html = `<div class="tl-whead" aria-hidden="true"><span></span><div class="tl-hours">`
      + [0, 6, 12, 18].map(h => `<span style="left:${(h / 24 * 100).toFixed(3)}%">${pad2(h)}</span>`).join('')
      + `<span class="end">24</span></div><span class="n">sessions</span><span class="n h">helpers</span><span class="n">working</span>`
      + `<span class="n"><span class="lg">waiting on you</span><span class="sm">waiting</span></span><span class="n h">reports</span></div>`;
    for (const d of days) {
      const num = k => Math.max(0, Number(d[k]) || 0);
      for (const k of Object.keys(tot)) tot[k] += num(k);
      if (num('workingMs') > 0 && (!busiest || num('workingMs') > busiest.workingMs)) busiest = { date: d.date, workingMs: num('workingMs') };
      const isToday = d.date === today;
      const quiet = !num('sessions') && !num('helpers') && !num('workingMs') && !num('askMs') && !num('reports');
      const [wd, dm] = dayParts(d.date);
      let cells = '';
      for (let h = 0; h < 24; h++) {
        const m = Math.max(0, Number(d.hourly?.[h]) || 0);
        const fut = isToday && h > nowHour;
        const k = items.push({ type: 'hour', date: d.date, h, m, fut }) - 1;
        const a = m > 0 ? (0.16 + 0.84 * Math.sqrt(Math.min(1, m / scale))).toFixed(3) : 0;
        cells += `<i class="hc${fut ? ' f' : m > 0 ? '' : ' z'}${h && h % 6 === 0 ? ' q' : ''}" data-k="${k}"${m > 0 ? ` style="--a:${a}"` : ''}></i>`;
      }
      const projects = Array.isArray(d.projects) ? d.projects.filter(p => p && p.project).map(p => `${shortProject(p.project)} ${p.count}`).join(', ') : '';
      const extra = [projects, num('finished') ? `${num('finished')} finished` : '', num('verdicts') ? `${num('verdicts')} ${num('verdicts') === 1 ? 'verdict' : 'verdicts'}` : ''].filter(Boolean).join(' · ');
      const open = isToday || (!quiet && !fallback);
      const title = [`${wd} ${dm}`, extra, isToday ? 'click for the live day' : open ? "click for that day's timeline" : quiet ? 'quiet' : ''].filter(Boolean).join(' · ');
      const n = (v, txt, cls = '') => `<span class="n${cls}${v ? '' : ' z'}">${txt}</span>`;
      html += `<div class="tl-wrow${isToday ? ' today' : ''}${quiet ? ' quiet' : ''}" data-date="${esc(d.date)}"${open ? ' role="button" tabindex="0"' : ''} title="${esc(title)}">`
        + `<div class="tl-wlab"><b>${esc(wd)}</b><span>${esc(dm)}</span>${isToday ? '<i class="tl-tday">today</i>' : ''}</div>`
        + `<div class="tl-heat">${cells}</div>`
        + n(num('sessions'), num('sessions')) + n(num('helpers'), num('helpers'), ' h')
        + n(num('workingMs') >= 30000, hrs(num('workingMs'))) + n(num('askMs') >= 30000, hrs(num('askMs')))
        + n(num('reports'), num('reports'), ' h') + `</div>`;
    }
    if (fallback) html += `<p class="tl-wnote">Week view needs the live journal${demo ? '' : weekFailed ? ' (not reachable right now)' : ''} · today only, as seen by this page</p>`;
    weekEl.innerHTML = html;

    // header: the range, then the week's totals and its busiest day
    dateEl.textContent = days.length > 1 ? `${fmtDate(days[0].date)} – ${fmtDate(days[days.length - 1].date)}` : fmtDate(today);
    srcEl.textContent = fallback ? (demo ? 'demo · today only' : 'today only') : '';
    const parts = [`<span><b>${tot.sessions}</b> ${tot.sessions === 1 ? 'session' : 'sessions'}</span>`];
    if (tot.helpers) parts.push(`<span><b>${tot.helpers}</b> ${tot.helpers === 1 ? 'helper' : 'helpers'}</span>`);
    parts.push(`<span title="summed over the top-level sessions"><i class="sw" style="background:rgb(${HEAT})"></i><b>${tot.workingMs ? dur(tot.workingMs) : '0 min'}</b> working</span>`);
    parts.push(`<span title="summed over everyone who waited on you"><i class="sw ask"></i><b>${tot.askMs ? dur(tot.askMs) : '0 min'}</b> waiting on you</span>`);
    parts.push(`<span><b>${tot.reports}</b> ${tot.reports === 1 ? 'report' : 'reports'}</span>`);
    if (busiest && days.length > 1) parts.push(`<span title="the most time working">busiest <b>${esc(fmtDate(busiest.date))}</b> (${hrs(busiest.workingMs)})</span>`);
    sumEl.innerHTML = parts.join('');
  }

  // --- tooltip
  function tipHtml(it) {
    if (it.type === 'hour') {
      const head = `${fmtDate(it.date)} · ${pad2(it.h)}:00–${pad2((it.h + 1) % 24)}:00`;
      const body = it.fut ? 'still to come' : it.m >= 0.5 ? `${dur(it.m * 60000)} working${it.m > 60 ? ' (summed over sessions)' : ''}` : 'quiet';
      return `<div class="h">${head}</div><div class="t">${body}</div>`;
    }
    const name = nameOf(it.a);
    if (it.type === 'seg') {
      const s = it.s;
      const label = s.st === 'work' ? 'Working' : s.st === 'ask' ? 'Waiting on you' : 'On a break';
      const sw = s.st === 'work' ? `<i class="st" style="background:${VENDOR[it.a.meta.vendor]?.css || '#9aa0b0'}"></i>` : `<i class="st ${s.st}"></i>`;
      return `<div class="h">${sw}${label} · ${esc(name)}</div><div class="t">${hhmm(s.from)}–${s.live ? 'now' : hhmm(s.to)} · ${dur(s.to - s.from)}</div>`
        + (s.st === 'ask' && s.text ? `<div class="q">🙋 ${esc(clip(s.text, 200))}</div>` : '');
    }
    if (it.type === 'marks') {
      const ms = it.ms, n = ms.length;
      const what = it.cls === 'rep' ? `✓ ${n} reports` : it.cls === 'ok' ? `✓ ${n} approvals` : it.cls === 'flag' ? `! ${n} flagged`
        : it.cls === 'hand' ? `⇄ ${n} hand-overs` : it.cls === 'launch' ? `▶ Started ${n}×` : `↳ Called for help ${n}×`;
      const t0 = ms[0].t, t1 = ms[n - 1].t;
      const SHOW = 6;
      const lines = ms.slice(0, SHOW).map(m => {
        const to = nameOfId(m.to, renderRows) || m.toLabel;
        const txt = [m.risk && it.cls !== 'rep' && it.cls !== 'spawn' ? `risk ${m.risk}` : '', m.text ? clip(m.text, 70) : ''].filter(Boolean).join(' · ');
        return `<div class="x"><b>${hhmm(m.t)}</b>${m.by ? ` by ${esc(m.by)}` : to ? ` → ${esc(to)}` : ''}${txt ? ` · ${esc(txt)}` : ''}${viaText(m)}</div>`;
      }).join('');
      return `<div class="h">${what} · ${esc(name)}</div><div class="t">${hhmm(t0)}${hhmm(t1) !== hhmm(t0) ? `–${hhmm(t1)}` : ''}</div>${lines}`
        + (n > SHOW ? `<div class="t">+ ${n - SHOW} more</div>` : '');
    }
    const m = it.m, to = nameOfId(m.to, renderRows) || m.toLabel;
    const body = `<div class="t">${hhmm(m.t)}${m.k === 'verdict' && m.risk ? ` · risk ${esc(m.risk)}` : ''}${viaText(m)}</div>${m.text ? `<div class="x">${esc(clip(m.text, 200))}</div>` : ''}`;
    const arrow = to ? ` → ${esc(to)}` : '';
    if (m.k === 'report') return `<div class="h">✓ ${m.linkKind === 'reply' ? 'Reply' : 'Report'} · ${esc(name)}${arrow}</div>${body}`;
    if (m.k === 'verdict') {
      const ok = (m.outcome ?? 'allow') === 'allow';
      return `<div class="h">${ok ? '✓ Approved' : '! Flagged'} · ${esc(name)}${to ? ` for ${esc(to)}` : ''}</div>${body}`;
    }
    if (m.k === 'handoff') return `<div class="h">⇄ Handed over · ${esc(name)}${arrow}</div>${body}`;
    if (m.k === 'launch') return `<div class="h">▶ ${m.by ? `Started by ${esc(m.by)}` : 'Started'} · ${esc(name)}${m.by ? '' : arrow}</div>${body}`;
    return `<div class="h">↳ ${m.linkKind === 'brief' ? 'Briefed' : 'Called for help'} · ${esc(name)}${m.by ? ` by ${esc(m.by)}` : arrow}</div>${body}`;
  }
  let tipK = -1;
  function hideTip() { tip.hidden = true; tipK = -1; }
  function placeTip(x, y) {
    const r = tip.getBoundingClientRect(), W = window.innerWidth;
    let left = x + 12, top = y - r.height - 12;
    if (left + r.width > W - 8) left = Math.max(8, x - r.width - 12);
    if (top < 8) top = y + 18;
    tip.style.left = `${Math.round(left)}px`; tip.style.top = `${Math.round(top)}px`;
  }
  el.addEventListener('pointermove', e => {
    const t = e.target.closest?.('[data-k]');
    const k = t ? Number(t.dataset.k) : -1;
    if (k < 0 || !items[k]) { if (tipK >= 0) hideTip(); return; }
    if (k !== tipK) { tipK = k; tip.innerHTML = tipHtml(items[k]); tip.hidden = false; }
    placeTip(e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', hideTip);
  scrollEl.addEventListener('scroll', hideTip, { passive: true });

  // --- click a row: jump to that agent (only while they are still in)
  const jump = row => {
    const w = row && mgr.workers.get(row.dataset.id);
    if (!w || w.done || w.leaving) return;
    try { lookAtWorker?.(w); showCard?.(w); } catch (err) { console.warn('timeline:', err); }
  };
  const unfold = row => { if (!row) return false; const id = row.dataset.fold; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); return true; };
  rowsEl.addEventListener('click', e => { if (!unfold(e.target.closest('.tl-row.fold'))) jump(e.target.closest('.tl-row.live')); });
  rowsEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.tl-row.fold')) { e.preventDefault(); unfold(e.target.closest('.tl-row.fold')); return; }
    const row = e.target.closest('.tl-row.live'); if (!row) return;
    e.preventDefault(); jump(row);
  });

  // --- tabs, the week's rows, back to the week
  const pickDay = (row, byKey = false) => {
    if (!row || !row.hasAttribute('role')) return false;
    if (row.classList.contains('today')) { setTab('today'); if (byKey) tabEls[0].focus(); } else { openPast(row.dataset.date); if (byKey) backEl.focus(); }
    return true;
  };
  for (const b of tabEls) b.addEventListener('click', () => { if (b.dataset.tab !== tab || pastDay) setTab(b.dataset.tab); });
  el.querySelector('.tl-tabs').addEventListener('keydown', e => { // arrow keys move between the two tabs
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'today' ? 'week' : 'today';
    setTab(next); tabEls.find(b => b.dataset.tab === next)?.focus();
  });
  backEl.addEventListener('click', () => {
    const date = pastDay?.date, refocus = document.activeElement === backEl;
    pastDay = null; pastSeq++; render(); tick();
    if (refocus) [...weekEl.querySelectorAll('.tl-wrow[role]')].find(r => r.dataset.date === date)?.focus();
  });
  weekEl.addEventListener('click', e => { pickDay(e.target.closest('.tl-wrow')); });
  weekEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (pickDay(e.target.closest('.tl-wrow'), true)) e.preventDefault();
  });

  // --- open / close
  const setDrawerHeight = px => { // the panels and the camera fit keep clear of the drawer
    const v = `${Math.round(px)}px`;
    if (document.documentElement.style.getPropertyValue('--tl-h') === v) return;
    document.documentElement.style.setProperty('--tl-h', v); window.dispatchEvent(new Event('office:drawer'));
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    setDrawerHeight(el.offsetHeight);
  }) : null;
  ro?.observe(el);
  async function tick() {
    if (!isOpen || document.hidden) return;
    const v = view();
    if (v === 'past') return; // a past day is read-only: nothing to poll
    if (!demo) {
      if (v === 'week') {
        await pullWeek();
        // no /api/week: the "today only" fallback is built from today's journal, which was never fetched when the
        // drawer opened straight onto the saved Week tab
        if (weekFailed && view() === 'week') await pull();
      } else await pull();
    }
    render();
  }
  function setOpen(v, persist = true) {
    v = !!v;
    if (v === isOpen) return;
    isOpen = v;
    el.hidden = !v;
    pill.classList.toggle('on', v); pill.setAttribute('aria-expanded', String(v));
    document.body.classList.toggle('tl-open', v);
    if (persist) { try { localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch { /* ignore */ } }
    clearInterval(timer); timer = null; hideTip();
    if (v) {
      setDrawerHeight(el.offsetHeight);
      render(); // what we have at once, then the fresh journal
      tick();
      timer = setInterval(tick, demo ? DEMO_MS : LIVE_MS);
    }
  }
  pill.addEventListener('click', () => setOpen(!isOpen));
  $('.tl-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('click', e => {
    if (!isOpen || !e.target.isConnected) return; // a row that re-rendered under the click is still inside
    if (e.target.closest?.('#timeline, #todayToggle, #card, #hud, .tl-tip')) return;
    setOpen(false);
  });
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isOpen) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    setOpen(false);
  });
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    clearTimeout(resizeT); resizeT = setTimeout(render, 150);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isOpen) tick(); });

  try { if (localStorage.getItem(STORE_KEY) === '1') setOpen(true, false); } catch { /* ignore */ }

  // --- one agent's day for the worker card (agentDay): today's journal as last pulled (the drawer pulls it only while
  // open), continued by this page's own observations since that pull, so a drawer closed hours ago does not freeze the
  // strip; no journal yet: this page's observations alone (partial). Rebuilt at most every 5 s or when the data grows.
  const dayCache = { key: '', model: null, byId: null };
  let cardPullAt = 0;
  dayFn = id => {
    const now = Date.now(), day = midnightOf(now), t = Math.floor(now / 5000) * 5000;
    const full = !demo && mode === 'journal' && jLoaded && jDay === day;
    // an open card is worth one journal pull (at most a minute apart): "seen since 04:25" undersells a whole day's work
    if (!full && !demo && !fetching && now - cardPullAt > 60000) { cardPullAt = now; pull(); }
    if (!full && obs.day !== day) return null; // the observer turns its day on its next poll
    const key = `${full}|${jEntries.length}|${obs.entries.length}|${jPulledAt}|${t}`;
    if (key !== dayCache.key) {
      const entries = full ? jEntries.concat(obs.entries.filter(e => Number(e.t) > jPulledAt)) : obs.entries;
      dayCache.model = entries.length ? buildModel(entries, t) : null;
      dayCache.byId = dayCache.model ? new Map(dayCache.model.rows.map(r => [r.a.id, r.a])) : null;
      dayCache.key = key;
    }
    if (!dayCache.model) return null;
    const ax = axisFor(dayCache.model.first, t, !full, day);
    const a = dayCache.byId.get(id);
    const segs = [], marks = [];
    let workMs = 0;
    for (const s of a?.segs || []) {
      if (s.to <= ax.start) continue;
      const from = Math.max(s.from, ax.start);
      if (s.st === 'work') workMs += s.to - Math.max(s.from, day);
      segs.push({ st: s.st, from, to: s.to, live: !!s.live, text: s.text || null });
    }
    for (const m of a?.marks || []) if (m.t >= ax.start) marks.push({ ...m });
    return { segs, marks, start: ax.start, end: t, first: a && Number.isFinite(a.first) ? a.first : null, workMs, partial: !full, since: full ? null : obs.since };
  };

  mgr.__timeline = {
    open: () => setOpen(true), close: () => setOpen(false), refresh: tick,
    stop() { dayFn = null; clearInterval(obsTimer); clearInterval(timer); ro?.disconnect(); mgr.sync = sync; el.remove(); tip.remove(); pill.hidden = true; delete mgr.__timeline; },
  };
  return mgr.__timeline;
}
