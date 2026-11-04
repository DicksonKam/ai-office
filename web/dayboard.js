// The day board: a whiteboard on every floor (built by office.js on the core's side, facing the pantry) that fills
// with what was really finished today and a few honest numbers.
//   live  – GET /api/today every 30 s (the server's day journal), plus an early re-fetch when this page sees a report,
//           a verdict or a finished task go by
//   no journal (error / 404) or ?demo – only what this page has itself seen since it was opened: every snapshot that
//           reaches the office (mgr.sync) is watched for reports, verdicts, finished tasks and questions; never invented
// office.js owns the physical board and calls paintDayBoard() on its canvas; every floor's board shares one canvas, so a
// floor added later shows the current content at once.

const INK = '#3f3a4a', TERRA = '#b5705a';
const FONT = '"M PLUS Rounded 1c", sans-serif';
const DONE_KINDS = new Set(['report', 'verdict', 'finished']);
const MAX_ITEMS = 6, POLL_MS = 30000, MGR_POLL_MS = 3000;
const FORGET_MS = 60 * 60 * 1000; // an agent (or event id) not seen for an hour is forgotten: the page stays open for days
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DAYBOARD_W = 1280, DAYBOARD_H = 800; // canvas pixels; the board face is 1.76 × 1.1 m (same 1.6 ratio)

const pad2 = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hhmm = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : ''; };
function fmtDate(date) { // 'YYYY-MM-DD' (the journal's day) or today → 'Mon 26 Oct'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function fitText(ctx, text, maxW) { let t = String(text || ''); if (ctx.measureText(t).width <= maxW) return t; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
/** a short form of a project for people who are no longer in the office: its first word, if the name is long */
function shortProject(p) {
  const s = String(p || '').split('/').filter(Boolean).pop() || '';
  if (s.length <= 14) return s;
  return s.split(/[_\-\s.]+/).filter(Boolean)[0] || s.slice(0, 12);
}
/** today as 23:00, another day as Thu 20:00 */
const nextTime = t => { const d = new Date(t); return dayKey(t) === dayKey(Date.now()) ? hhmm(t) : `${WEEKDAYS[d.getDay()]} ${hhmm(t)}`; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------- painting (called by office.js on the shared board canvas) ----------
// The board is read from across the room, at a slant and only a few dozen pixels wide: two huge marker numbers carry it,
// up to three sticky notes with the latest finished work add a few words, everything else is small print on the header.
// Designed on a 1280 × 800 grid (scaled to the canvas).
const DEEP = { sage: '#4c7a4a', terracotta: '#a35a43', slate: '#56607a', mustard: '#9a6f22', ink: INK }; // marker ink, high contrast
const NOTES = ['#f6df8a', '#cfe2c0', '#f3ccb6'];                                                        // mustard, sage, blush stickies
const NOTE_INK = '#2f2b38', SMALL = '#5d5768';
const NEXT_NOTE = '#cfe6ec', NEXT_INK = '#1f6f80';                                                       // what runs next, a blue note of its own

function marker(ctx, x0, y, x1, color, width, seed = 1) { // a hand-drawn, slightly wavy marker line
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y + Math.sin(seed) * 1.5);
  const n = Math.max(2, Math.round((x1 - x0) / 90));
  for (let i = 1; i <= n; i++) ctx.lineTo(x0 + (x1 - x0) * i / n, y + Math.sin(seed * 3.7 + i * 1.9) * 2.2);
  ctx.stroke();
}
function check(ctx, x, y, color, s = 1) {
  ctx.strokeStyle = color; ctx.lineWidth = 6.5 * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x - 13 * s, y - 15 * s); ctx.lineTo(x - 3 * s, y - 4 * s); ctx.quadraticCurveTo(x + 4 * s, y - 20 * s, x + 15 * s, y - 31 * s); ctx.stroke();
}
/** word-wrap into at most `maxLines` lines of `maxW`; what does not fit ends the last line with an ellipsis */
function wrap(ctx, text, maxW, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean), lines = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = fitText(ctx, words[i++], maxW);
    while (i < words.length && ctx.measureText(line + ' ' + words[i]).width <= maxW) line += ' ' + words[i++];
    lines.push(line);
  }
  if (i < words.length && lines.length) lines[lines.length - 1] = fitText(ctx, lines[lines.length - 1] + ' ' + words.slice(i).join(' '), maxW);
  return lines;
}

/** Paint a day-board view ({ title, source, note, big:[{n,label,tone}] ×2, stats, items:[{text,time,mark,tone}], empty })
 *  or null (a clean board with today's date) onto a DAYBOARD_W × DAYBOARD_H canvas. Without `big`, the first two stats
 *  are the big numbers. */
export function paintDayBoard(ctx, view, W = DAYBOARD_W, H = DAYBOARD_H) {
  ctx.save();
  ctx.scale(W / 1280, H / 800);
  ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, 1280, 800);
  // faint ghosts of earlier writing: a whiteboard is never perfectly clean
  ctx.strokeStyle = 'rgba(122,133,153,0.06)'; ctx.lineWidth = 14; ctx.lineCap = 'round';
  for (const [a, b, c, d] of [[880, 466, 1200, 458], [70, 790, 380, 772], [700, 150, 900, 132]]) { ctx.beginPath(); ctx.moveTo(a, b); ctx.quadraticCurveTo((a + c) / 2, Math.min(b, d) - 40, c, d); ctx.stroke(); }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const L = 56, R = 1224;
  // header: the day, with the small print on the right
  const title = view?.title || `Today · ${fmtDate()}`;
  ctx.fillStyle = INK; ctx.font = `800 54px ${FONT}`;
  const t = fitText(ctx, title, 620); ctx.fillText(t, L, 80);
  marker(ctx, L, 102, L + ctx.measureText(t).width, TERRA, 7, 2);
  const small = [view?.note, view?.source].filter(Boolean).join(' · ');
  if (small) { ctx.font = `700 30px ${FONT}`; ctx.fillStyle = SMALL; ctx.textAlign = 'right'; ctx.fillText(fitText(ctx, small, R - L - 660), R, 78); ctx.textAlign = 'left'; }
  if (!view) { ctx.restore(); return; }

  // the two numbers, huge, side by side, a marker stroke between them; never ruler-straight
  const big = (view.big?.length ? view.big : (view.stats || [])).slice(0, 2), colW = (R - L) / 2;
  big.forEach((s, i) => {
    ctx.save(); ctx.translate(L + colW * (i + 0.5), 0); ctx.rotate(i ? 0.012 : -0.009);
    ctx.textAlign = 'center';
    ctx.fillStyle = DEEP[s.tone] || INK; ctx.font = `800 250px ${FONT}`; ctx.fillText(fitText(ctx, String(s.n), colW - 40), 0, 350);
    ctx.fillStyle = INK; ctx.font = `800 54px ${FONT}`; ctx.fillText(fitText(ctx, s.label, colW - 40), 0, 424);
    ctx.restore();
  });
  if (big.length === 2) {
    ctx.strokeStyle = 'rgba(86,96,122,0.5)'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(640, 170); ctx.quadraticCurveTo(646, 290, 638, 410); ctx.stroke();
  }

  // the latest finished work: up to three sticky notes, newest on the left
  const items = (view.items || []).slice(0, view.next ? 2 : 3), NW = 356, NH = 268, gap = (R - L - 3 * NW) / 2, top = 486;
  if (!items.length) {
    ctx.fillStyle = 'rgba(86,96,122,0.75)'; ctx.font = `700 44px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, view.empty || 'nothing finished yet today', R - L - 40), 640, top + NH / 2 + 14); ctx.textAlign = 'left';
  }
  if (view.next) { // the third note is what runs next, its time big enough to read across the room
    ctx.save(); ctx.translate(L + 2 * (NW + gap) + NW / 2, top + NH / 2); ctx.rotate(-0.011);
    const x0 = -NW / 2, y0 = -NH / 2;
    ctx.fillStyle = 'rgba(63,58,74,0.16)'; ctx.fillRect(x0 + 7, y0 + 10, NW, NH);
    ctx.fillStyle = NEXT_NOTE; ctx.fillRect(x0, y0, NW, NH);
    ctx.fillStyle = 'rgba(63,58,74,0.07)'; ctx.fillRect(x0, y0, NW, 30);
    ctx.fillStyle = NEXT_INK; ctx.font = `800 84px ${FONT}`; ctx.fillText(fitText(ctx, view.next.time, NW - 44), x0 + 22, y0 + 116);
    ctx.fillStyle = NOTE_INK; ctx.font = `800 38px ${FONT}`;
    wrap(ctx, view.next.text, NW - 44, 2).forEach((ln, k) => ctx.fillText(ln, x0 + 22, y0 + 172 + k * 44));
    ctx.restore();
  }
  items.forEach((it, i) => {
    ctx.save(); ctx.translate(L + i * (NW + gap) + NW / 2, top + NH / 2); ctx.rotate([-0.026, 0.017, -0.011][i]);
    const x0 = -NW / 2, y0 = -NH / 2;
    ctx.fillStyle = 'rgba(63,58,74,0.16)'; ctx.fillRect(x0 + 7, y0 + 10, NW, NH);         // it lifts off the board a little
    ctx.fillStyle = NOTES[i % NOTES.length]; ctx.fillRect(x0, y0, NW, NH);
    ctx.fillStyle = 'rgba(63,58,74,0.07)'; ctx.fillRect(x0, y0, NW, 30);                    // the sticky strip
    ctx.fillStyle = NOTE_INK; ctx.font = `800 44px ${FONT}`;
    wrap(ctx, it.text, NW - 44, 3).forEach((ln, k) => ctx.fillText(ln, x0 + 22, y0 + 86 + k * 52));
    const col = DEEP[it.tone] || DEEP.sage;
    if (it.mark === '!') { ctx.fillStyle = col; ctx.font = `800 52px ${FONT}`; ctx.fillText('!', x0 + 26, y0 + NH - 22); }
    else check(ctx, x0 + 40, y0 + NH - 22, col, 1.25);
    if (it.time) { ctx.fillStyle = SMALL; ctx.font = `700 32px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(it.time, x0 + NW - 22, y0 + NH - 24); }
    ctx.restore();
  });
  ctx.restore();
}

// ---------- what this page has seen itself (no journal, or the demo) ----------
class Observer {
  constructor(minWorkMs) { this.minWorkMs = minWorkMs; this.agents = new Map(); this.info = new Map(); this.prunedAt = 0; this.reset(Date.now()); }
  reset(now) {
    this.day = dayKey(now); this.since = now; this.primed = false;
    this.seen = new Map(); // event id -> its time
    this.sessions = new Set(); this.helpers = new Set(); this.projects = new Map();
    this.reports = 0; this.reviews = 0; this.verdicts = 0; this.finished = 0; this.askedYou = 0; this.items = [];
  }
  push(item) { this.items.unshift(item); this.items.sort((a, b) => b.at - a.at); if (this.items.length > 40) this.items.length = 40; }
  /** watch one snapshot; returns true when something got done (a reason to re-read the journal early) */
  observe(agents, events, now) {
    if (dayKey(now) !== this.day) { this.reset(now); for (const s of this.agents.values()) if (s.workingSince) s.workingSince = now; }
    let done = false;
    if (now - this.prunedAt > 5 * 60000) this.prune(now);
    for (const a of agents) {
      if (!a || !a.id) continue;
      const info = { id: a.id, vendor: a.vendor, agentKind: a.kind, nickname: a.nickname || null, project: a.project, task: a.task, parentId: a.parentId || null, seenAt: now };
      this.info.set(a.id, info);
      const top = !a.parentId && a.kind !== 'subagent' && a.kind !== 'guardian';
      if (top) this.sessions.add(a.id); else if (a.kind === 'subagent') this.helpers.add(a.id);
      if (a.project && a.kind !== 'guardian') { if (!this.projects.has(a.project)) this.projects.set(a.project, new Set()); this.projects.get(a.project).add(a.id); }
      const working = a.status === 'working', prev = this.agents.get(a.id);
      if (prev) prev.seenAt = now;
      if (!prev) {
        const mine = a.asking && !a.askTo ? a.asking : null; // asked you (not the agent that gave it the work)
        this.agents.set(a.id, { working, asking: mine, workingSince: working ? now : null, seenAt: now });
        if (this.primed && mine) { this.askedYou++; this.push({ ...info, at: now, kind: 'asked' }); }
        continue;
      }
      const mine = a.asking && !a.askTo ? a.asking : null;
      if (mine && !prev.asking) { this.askedYou++; this.push({ ...info, at: now, kind: 'asked' }); }
      prev.asking = mine;
      if (working && !prev.working) prev.workingSince = now;
      else if (!working && prev.working) {
        if (top && !a.delegator && prev.workingSince != null && now - prev.workingSince >= this.minWorkMs) { this.finished++; this.push({ ...info, at: now, kind: 'finished' }); done = true; }
        prev.workingSince = null;
      }
      prev.working = working;
    }
    for (const ev of events) {
      if (!ev || !ev.id || this.seen.has(ev.id)) continue;
      const at = typeof ev.at === 'number' ? ev.at : Date.parse(ev.at) || now;
      if (now - at > FORGET_MS) continue; // older than the id memory (the server only resends a few minutes)
      this.seen.set(ev.id, at);
      if (dayKey(at) !== this.day) continue;
      const from = this.info.get(ev.from) || { id: ev.from }, base = { ...from, at, to: ev.to || null };
      if (ev.kind === 'report') { this.reports++; this.push({ ...base, kind: 'report', text: ev.text || null }); done = true; }
      else if (ev.kind === 'review') this.reviews++;
      else if (ev.kind === 'verdict') { this.verdicts++; this.push({ ...base, kind: 'verdict', outcome: ev.verdict?.outcome ?? null }); done = true; }
      else continue;
      this.since = Math.min(this.since, at);
    }
    this.primed = true;
    return done;
  }
  /** forget agents not seen for an hour and event ids older than an hour (items keep their own copies) */
  prune(now) {
    this.prunedAt = now;
    for (const [id, s] of this.agents) if (!(now - s.seenAt < FORGET_MS)) this.agents.delete(id);
    for (const [id, s] of this.info) if (!(now - s.seenAt < FORGET_MS)) this.info.delete(id);
    for (const [id, at] of this.seen) if (!(now - at < FORGET_MS + 5 * 60000)) this.seen.delete(id);
  }
  digest() {
    if (dayKey(Date.now()) !== this.day) this.reset(Date.now());
    return {
      date: this.day,
      stats: {
        sessions: this.sessions.size, helpers: this.helpers.size, reviews: this.reviews, reports: this.reports, verdicts: this.verdicts,
        finished: this.finished, askedYou: this.askedYou,
        projects: [...this.projects].map(([project, ids]) => ({ project, count: ids.size })).sort((a, b) => b.count - a.count || String(a.project).localeCompare(String(b.project))),
      },
      items: this.items,
    };
  }
}

// ---------- the board ----------
/** Start filling every floor's day board. `mgr` is the OfficeManager; `demo` true in ?demo (no journal is read). */
export function startDayBoard({ mgr, demo = false } = {}) {
  if (!mgr || mgr.__dayBoard) return mgr?.__dayBoard;
  // the journal counts a finished task after 2 min of work (snapshot.config.finishedMinMs, which the office keeps on mgr)
  const obs = new Observer(mgr.finishedMinMs || (demo ? 30000 : 120000));
  const names = new Map();                        // id -> the name the office gave that agent (kept after they leave)
  const namedAt = new Map();                      // id -> when that agent was last in the office
  let live = null, liveAt = 0, fetching = false, lastFetch = 0, nudgeT = null;
  const drawn = new WeakMap();                    // floor -> key of what is on its board

  let namesPrunedAt = Date.now();
  const rememberNames = () => {
    const t = Date.now();
    for (const [id, w] of mgr.workers) if (w.name) { names.set(id, w.name); namedAt.set(id, t); }
    if (t - namesPrunedAt < 5 * 60000) return;
    namesPrunedAt = t; // keep a name while today's board still mentions that agent, else for an hour after they left
    const cited = new Set();
    for (const it of [...obs.items, ...(live?.items || [])]) { if (it?.id) cited.add(it.id); if (it?.to) cited.add(it.to); }
    for (const [id, at] of namedAt) if (!cited.has(id) && !mgr.workers.has(id) && t - at > FORGET_MS) { names.delete(id); namedAt.delete(id); }
  };
  const officeName = id => (id && (mgr.workers.get(id)?.name || names.get(id))) || null;
  const nameOf = (id, fb = {}) => officeName(id) || fb.nickname || shortProject(fb.project) || 'someone';
  const taskShort = task => String(task || '').replace(/^helper:\s*/i, '').trim();
  const snippet = text => { const s = String(text || '').replace(/\s+/g, ' ').trim(); const m = /^(.{8,}?[.!?])\s/.exec(s + ' '); return (m ? m[1] : s).replace(/[.!]$/, ''); };

  function line(it) {
    const from = nameOf(it.id, it), time = hhmm(it.at);
    if (it.kind === 'report') {
      const to = it.to ? nameOf(it.to, { project: it.project }) : null;
      const what = taskShort(it.task) ? `${taskShort(it.task)} done` : snippet(it.text) || 'report handed in';
      return { text: `${from}${to ? ` → ${to}` : ''}: ${what}`, time, mark: '✓', tone: 'sage' };
    }
    if (it.kind === 'verdict') {
      const ok = (it.outcome ?? 'allow') === 'allow', to = it.to ? officeName(it.to) : null;
      const whose = to ? `${to}'s work` : it.project ? `the ${shortProject(it.project)} work` : 'the work';
      return ok ? { text: `${from} approved ${whose}`, time, mark: '✓', tone: 'slate' } : { text: `${from} flagged ${whose}`, time, mark: '!', tone: 'terracotta' };
    }
    const who = officeName(it.id), proj = shortProject(it.project);
    return { text: who ? `${who} finished a task${proj ? ` · ${proj}` : ''}` : `${proj || it.nickname || 'someone'}: finished a task`, time, mark: '✓', tone: 'mustard' };
  }

  function view() {
    const data = live || obs.digest(), s = data.stats || {};
    const n = v => Math.max(0, Number(v) || 0);
    const source = demo ? 'demo' : live ? '' : `seen here since ${hhmm(obs.since)}`;
    const projects = (s.projects || []).filter(p => p && p.project).slice(0, 3).map(p => `${shortProject(p.project)} ×${n(p.count)}`);
    const footer = [n(s.sessions) ? plural(n(s.sessions), 'session') : '', n(s.helpers) ? plural(n(s.helpers), 'helper') : '', ...projects].filter(Boolean).join(' · ');
    // the board's two big numbers: who is working right now (the office itself) and what got done today (finished tasks
    // and helpers' reports); reviews and waits go to the small print
    const working = [...mgr.workers.values()].filter(w => !w.done && !w.leaving && w.agent?.status === 'working').length;
    const reviews = Math.max(n(s.reviews), n(s.verdicts));
    const note = [reviews ? plural(reviews, 'review') : '', n(s.askedYou) ? `${n(s.askedYou)} waited on you` : ''].filter(Boolean).join(' · ');
    return {
      title: `Today · ${fmtDate(data.date)}`, source, note,
      big: [{ n: working, label: 'working now', tone: 'ink' }, { n: n(s.finished) + n(s.reports), label: 'done today', tone: 'sage' }],
      stats: [
        { n: n(s.finished), label: 'finished', tone: 'sage' },
        { n: n(s.reports), label: n(s.reports) === 1 ? 'report' : 'reports', tone: 'slate' },
        { n: Math.max(n(s.reviews), n(s.verdicts)), label: Math.max(n(s.reviews), n(s.verdicts)) === 1 ? 'review' : 'reviews', tone: 'mustard' },
        { n: n(s.askedYou), label: 'waited on you', tone: 'terracotta' },
      ],
      items: (data.items || []).filter(it => it && DONE_KINDS.has(it.kind)).slice(0, MAX_ITEMS).map(line),
      next: mgr.schedules?.[0] ? { time: `${mgr.schedules[0].approx ? '~' : ''}${nextTime(mgr.schedules[0].nextAt)}`, text: mgr.schedules[0].label } : null,
      footer, empty: 'nothing finished yet today',
    };
  }

  function refresh(force = false) {
    const v = view(), key = JSON.stringify(v);
    let first = true;
    for (const f of mgr.floors) {
      if (!f?.dayBoard) continue;
      if (force || drawn.get(f) !== key) { f.dayBoard.draw(v, force && first); drawn.set(f, key); first = false; }
    }
  }

  async function fetchToday() {
    if (demo || fetching) return;
    fetching = true; lastFetch = Date.now();
    try {
      const r = await fetch('/api/today', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || typeof j !== 'object' || !j.stats || !Array.isArray(j.items)) throw new Error('unexpected shape');
      live = j; liveAt = Date.now();
    } catch {
      // a brief hiccup keeps the journal's numbers for a few minutes; after that, only what this page has seen
      if (live && Date.now() - liveAt > 5 * 60000) live = null;
    } finally { fetching = false; refresh(); }
  }
  const nudge = () => { // something got done: read the journal again soon, not in 30 s
    if (demo || nudgeT) return;
    nudgeT = setTimeout(() => { nudgeT = null; fetchToday(); }, Math.max(3000, 8000 - (Date.now() - lastFetch)));
  };

  // every snapshot the office sees passes through mgr.sync: watch it (after the office has named any newcomers)
  const sync = mgr.sync;
  mgr.sync = function (agents, events, now) {
    const r = sync.apply(this, arguments);
    try { rememberNames(); if (mgr.finishedMinMs) obs.minWorkMs = mgr.finishedMinMs; if (obs.observe(agents || [], events || [], now || Date.now())) { nudge(); } refresh(); } catch (err) { console.warn('day board:', err); }
    return r;
  };
  // whoever is already in when the board starts
  rememberNames();
  obs.observe([...mgr.workers.values()].filter(w => !w.done && w.agent).map(w => w.agent), [], Date.now());

  const timers = [setInterval(() => { rememberNames(); refresh(); }, MGR_POLL_MS)]; // names, new floors, midnight
  if (!demo) { fetchToday(); timers.push(setInterval(fetchToday, POLL_MS)); }
  if (document.fonts?.load) Promise.all(['800 64px', '500 38px', '700 30px'].map(f => document.fonts.load(`${f} ${FONT}`))).then(() => refresh(true)).catch(() => {}); // repaint once the rounded font is in
  refresh();
  mgr.__dayBoard = { refresh, stop() { timers.forEach(clearInterval); clearTimeout(nudgeT); mgr.sync = sync; delete mgr.__dayBoard; } };
  return mgr.__dayBoard;
}
