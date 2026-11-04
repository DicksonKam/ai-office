// Day journal: diff consecutive office snapshots and append the real changes to data/journal/YYYY-MM-DD.jsonl
// (local date in CONFIG.journal.timeZone). Append-only, one small JSON object per line, rotated by date.
// Also serves today's digest (/api/today) and raw entries (/api/journal) from that file, any past day's entries
// (/api/journal?day=) and seven per-day digests for the week view (/api/week; past days cached by file mtime + size).
//
// Restart safety: on startup today's file is replayed to rebuild who was in, their status / asking / role, and which
// event ids were already written (yesterday's too, for events re-sent across midnight), so a restart or a page reload
// never logs the same arrival or event twice. Writing never throws into the caller.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';

const PENDING_MAX = 20000; // journal lines held while the drive is away (a few days of a busy office)
const TOP_KINDS = new Set(['desktop', 'cli']);
const EVENT_KINDS = new Set(['spawn', 'message', 'report', 'review', 'verdict', 'handoff', 'approval', 'launch']);
const ITEM_LIMIT = 200;
const RAW_LIMIT = 500;
const DAY_LIMIT = 5000;        // /api/journal?day=: a whole past day (the newest lines if it was busier than this)
const TODAY_TTL_MS = 30000;    // the week view's digest of today is recomputed at most this often
const DAY_CACHE_MAX = 60;      // digests of past (immutable) days kept in memory
const CACHE_MAX = 4;           // parsed day files kept in memory (today, which is never evicted, plus recent past days)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fmtCache = new Map();
/** YYYY-MM-DD of `ms` in the journal time zone. */
export function localDate(ms = Date.now(), timeZone = CONFIG.journal.timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); fmtCache.set(timeZone, f); }
  return f.format(new Date(ms));
}

export function journalFile(date, dir = CONFIG.journal.dir) { return path.join(dir, `${date}.jsonl`); }

/** A real calendar date written as YYYY-MM-DD (so it is also safe as a file name: no path parts). */
export function isValidDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1970 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The calendar date `n` days after `date` (YYYY-MM-DD; a negative n goes back). */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

const offFmt = new Map();
/** Local wall clock minus UTC at `ms` in `timeZone`, in ms (DST aware). */
function tzOffset(ms, timeZone) {
  let f = offFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    offFmt.set(timeZone, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** ms of the local midnight that starts `date` in `timeZone`. */
export function dayStart(date, timeZone = CONFIG.journal.timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const t = wall - tzOffset(wall, timeZone);
  return wall - tzOffset(t, timeZone); // again at the first guess: right across a DST change
}

const clip = (s, n) => (s == null ? null : (s = String(s).replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s);

/** Parse journal text; tolerant of a torn last line or junk. */
export function parseEntries(txt) {
  const out = [];
  for (const line of String(txt).split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && typeof e.t === 'number' && e.kind) out.push(e); } catch { /* skip torn line */ }
  }
  return out;
}

/** Parse a journal file; tolerant of a torn last line or junk. */
export function readEntries(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return parseEntries(txt);
}

/** Incrementally re-read a growing file (only the new bytes since the last call). */
class FileCache {
  constructor(file) { this.file = file; this.size = 0; this.rest = ''; this.entries = []; this.version = 0; }
  refresh() {
    let st;
    try { st = fs.statSync(this.file); } catch { if (this.size) { this.size = 0; this.rest = ''; this.entries = []; this.version++; } return this; }
    if (st.size < this.size) { this.size = 0; this.rest = ''; this.entries = []; } // truncated / replaced: start over
    if (st.size === this.size) return this;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(st.size - this.size);
      const n = fs.readSync(fd, buf, 0, buf.length, this.size);
      this.size += n;
      const lines = (this.rest + buf.toString('utf8', 0, n)).split('\n');
      this.rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e && typeof e.t === 'number' && e.kind) this.entries.push(e); } catch { /* skip */ }
      }
      this.version++;
    } catch { /* unreadable right now: serve what we have */ } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
    return this;
  }
}

const LEAVE_GRACE_MS = 8000;

export class Journal {
  constructor({ dir = CONFIG.journal.dir, timeZone = CONFIG.journal.timeZone, finishedMinMs = CONFIG.journal.finishedMinMs, todayTtlMs = TODAY_TTL_MS, log = console } = {}) {
    this.dir = dir; this.timeZone = timeZone; this.finishedMinMs = finishedMinMs; this.todayTtlMs = todayTtlMs; this.log = log;
    this.dayDigests = new Map(); // past date -> { key: mtime:size, value } (week view)
    this.todayDigest = null;     // { date, at, value } (week view)
    this.prev = null;            // Map id -> { status, asking, role, workingSince, info }
    this.seenEvents = new Map(); // event id -> t first written (kept ~1 day, survives the midnight rotation)
    this.date = null;
    this.caches = new Map();     // date -> FileCache
    this.todayMemo = { key: null, value: null };
    this.failures = 0;
    this.dirReady = false;
  }

  /** Rebuild state from the journal so a restart continues where it stopped. */
  load(now = Date.now()) {
    try {
      const today = localDate(now, this.timeZone);
      const yesterday = localDate(now - 86400000, this.timeZone);
      for (const e of readEntries(journalFile(yesterday, this.dir))) if (e.eid) this.seenEvents.set(e.eid, e.t);
      const state = new Map();
      for (const e of readEntries(journalFile(today, this.dir))) {
        if (e.eid) { this.seenEvents.set(e.eid, e.t); continue; }
        const info = pickInfo(e, true);
        let s = state.get(e.id);
        switch (e.kind) {
          case 'arrived': state.set(e.id, { status: e.status || 'idle', asking: null, role: e.role || null, workingSince: e.status === 'working' ? e.t : null, info }); break;
          case 'left': state.delete(e.id); break;
          case 'working': if (s) { s.status = 'working'; s.workingSince = e.t; s.info = info; } break;
          case 'idle': if (s) { s.status = 'idle'; s.workingSince = null; s.info = info; } break;
          case 'asking-start': if (s) s.asking = e.text || 'asking'; break;
          case 'asking-end': if (s) s.asking = null; break;
          case 'role-change': if (s) s.role = e.role; break;
        }
      }
      this.prev = state;
      this.date = today;
    } catch (err) {
      this.log.error?.('[journal] load failed:', err.message);
      this.prev = new Map();
    }
    return this;
  }

  /** Diff `snap` against the previous one and append the changes. Never throws. */
  record(snap) {
    try { this._record(snap); } catch (err) { this._fail(err); }
  }

  _record(snap) {
    const now = snap.now || Date.now();
    if (!this.prev) this.load(now);
    const date = localDate(now, this.timeZone);
    const out = [];
    const rotated = this.date && date !== this.date;
    this.date = date;

    const cur = new Map();
    for (const a of snap.agents || []) cur.set(a.id, a);
    const infoOf = new Map();

    // a new day: everyone still in is carried over, so today's file is self-contained
    if (rotated) {
      for (const [id, s] of this.prev) {
        const a = cur.get(id);
        if (!a) continue;
        out.push({ ...entryBase(now, 'arrived', a), status: s.status, carried: true });
        if (s.asking) out.push({ ...entryBase(now, 'asking-start', a), text: clip(s.asking, 160), carried: true });
      }
    }

    for (const [id, a] of cur) {
      const p = this.prev.get(id);
      const asking = a.asking ? String(a.asking) : null;
      const info = pickInfo(a);
      infoOf.set(id, info);
      if (!p) {
        out.push({ ...entryBase(now, 'arrived', a), status: a.status });
        if (asking) out.push(askEntry(now, a, asking));
        this.prev.set(id, { status: a.status, asking, askTo: a.askTo || null, role: a.role || null, workingSince: a.status === 'working' ? now : null, info });
        continue;
      }
      p.missingSince = null; // back within the grace period: nothing was logged, carry on
      if (p.status !== a.status) {
        if (a.status === 'working') {
          out.push(entryBase(now, 'working', a));
          p.workingSince = now;
        } else if (a.status === 'idle') {
          const idleAt = Math.min(a.idleSince || now, now);
          const e = entryBase(now, 'idle', a);
          if (p.workingSince) e.workedMs = Math.max(0, idleAt - p.workingSince);
          out.push(e);
          p.workingSince = null;
        }
        p.status = a.status;
      }
      if (!!asking !== !!p.asking) {
        out.push(asking ? askEntry(now, a, asking) : entryBase(now, 'asking-end', a));
        p.asking = asking; p.askTo = a.askTo || null;
      } else if (asking && (a.askTo || null) !== (p.askTo || null)) { // the same ask, now for someone else (escalated to you)
        out.push(askEntry(now, a, asking));
        p.askTo = a.askTo || null;
      }
      if ((a.role || null) !== p.role) {
        out.push({ ...entryBase(now, 'role-change', a), from: p.role });
        p.role = a.role || null;
      }
      p.info = info;
    }
    for (const [id, p] of this.prev) {
      if (cur.has(id)) continue;
      // grace period, like the office itself (it waits 6 s): one dropped poll must not log a departure and a new
      // arrival (that double counted asks and cut short the time worked)
      if (!p.missingSince) { p.missingSince = now; continue; }
      if (now - p.missingSince < LEAVE_GRACE_MS) continue;
      const e = { t: p.missingSince, kind: 'left', ...p.info };
      if (p.workingSince && p.status === 'working') e.workedMs = Math.max(0, p.missingSince - p.workingSince); // went straight from working to gone
      if (p.asking) out.push({ t: now, kind: 'asking-end', ...p.info });
      out.push(e);
      this.prev.delete(id);
    }

    // interaction events, the first time each id is seen
    for (const ev of snap.events || []) {
      if (!ev?.id || !EVENT_KINDS.has(ev.kind) || this.seenEvents.has(ev.id)) continue;
      this.seenEvents.set(ev.id, now);
      const from = cur.get(ev.from);
      const e = { t: now, kind: ev.kind, eid: ev.id, ...(from ? pickInfo(from) : { id: ev.from }), to: ev.to || null };
      if (ev.at && ev.at !== now) e.at = ev.at;
      if (ev.text) e.text = clip(ev.text, ev.kind === 'report' ? 240 : 160);
      if (ev.verdict) { e.outcome = ev.verdict.outcome ?? null; e.risk = ev.verdict.risk ?? null; }
      // how the link travelled and how surely we know (Milestone 11); a stub names the end the office could not resolve
      if (ev.channel) e.channel = ev.channel;
      if (ev.confidence) e.confidence = ev.confidence;
      if (ev.linkKind && ev.linkKind !== ev.kind) e.linkKind = ev.linkKind;
      if (ev.stub) e.stub = { side: ev.stub.side, label: clip(ev.stub.label, 80) };
      out.push(e);
    }
    for (const [id, t] of this.seenEvents) if (now - t > 26 * 3600 * 1000) this.seenEvents.delete(id);

    if (out.length) this._append(date, out);
  }

  _append(date, entries) {
    // lines that could not be written (the journal's drive asleep, unplugged or not yet mounted after a wake) wait
    // here, in order, and go out with the next write that succeeds: a lost "left" would otherwise show the worker as
    // still in for the rest of the day, and a lost "arrived" as leaving without having come in
    const pend = this.pending || (this.pending = []);
    pend.push({ date, entries });
    let held = pend.reduce((n, p) => n + p.entries.length, 0);
    while (held > PENDING_MAX && pend.length > 1) held -= pend.shift().entries.length; // a very long outage keeps the newest
    try {
      if (!this.dirReady) { fs.mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
      while (pend.length) {
        const p = pend[0];
        fs.appendFileSync(journalFile(p.date, this.dir), p.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
        pend.shift();
      }
      if (this.failures) this.log.error?.(`[journal] ${new Date().toISOString()} writing again after ${this.failures} failed attempt(s); held lines written`);
      this.failures = 0;
    } catch (err) { this.dirReady = false; this._fail(err); }
  }

  _fail(err) {
    // log the first failure and then only occasionally, so a full or unplugged disk can't flood the log
    if (this.failures++ % 200 === 0) this.log.error?.(`[journal] ${new Date().toISOString()} write failed (lines held in memory until it works again):`, err?.message || err);
  }

  /** The incremental cache of a day's file. A small LRU (most recently used last) that never evicts today: opening a
   *  few past days must not make the next live poll re-read and re-parse today's whole file. */
  _cache(date) {
    let c = this.caches.get(date);
    if (c) this.caches.delete(date); // re-insert below: most recently used last
    else c = new FileCache(journalFile(date, this.dir));
    this.caches.set(date, c);
    if (this.caches.size > CACHE_MAX) {
      const today = localDate(Date.now(), this.timeZone);
      for (const k of this.caches.keys()) {
        if (this.caches.size <= CACHE_MAX) break;
        if (k !== date && k !== today && k !== this.date) this.caches.delete(k);
      }
    }
    return c.refresh();
  }

  /** Raw entries of a day (default today) with t >= since, oldest first, at most `limit` (the newest ones). */
  entries({ since = 0, date = localDate(Date.now(), this.timeZone), limit = RAW_LIMIT } = {}) {
    const all = this._cache(date).entries;
    let i = all.length;
    while (i > 0 && all[i - 1].t >= since) i--;
    const list = all.slice(i);
    return list.length > limit ? list.slice(list.length - limit) : list;
  }

  /** A whole day's raw entries (any date: validate it first) for the read-only past-day timeline. */
  day(date, { since = 0, limit = DAY_LIMIT, now = Date.now() } = {}) {
    const all = this._cache(date).entries;
    let i = all.length;
    while (i > 0 && all[i - 1].t >= since) i--;
    const total = all.length - i;
    const list = all.slice(Math.max(i, all.length - limit));
    const start = dayStart(date, this.timeZone), end = dayStart(addDays(date, 1), this.timeZone);
    return { date, today: localDate(now, this.timeZone), start, end, total, trimmed: list.length < total, entries: list };
  }

  /** One day's digest for the week view. Past days are cached by file mtime + size, today is recomputed at most every
   *  todayTtlMs. A missing or unreadable file is an empty day. */
  async dayDigest(date, now = Date.now()) {
    const today = localDate(now, this.timeZone);
    const start = dayStart(date, this.timeZone), end = dayStart(addDays(date, 1), this.timeZone);
    const upTo = date === today ? Math.min(now, end) : date > today ? start : end;
    const opts = { start, end: upTo, timeZone: this.timeZone, finishedMinMs: this.finishedMinMs };
    const file = journalFile(date, this.dir);
    let st = null;
    try { st = await fsp.stat(file); } catch { /* no journal that day */ }
    if (!st?.isFile() || date > today) return summarizeDay(date, [], opts);
    const key = `${st.mtimeMs}:${st.size}`;
    if (date === today) {
      const m = this.todayDigest;
      if (m && m.date === date && now >= m.at && now - m.at < this.todayTtlMs) return m.value;
    } else {
      const c = this.dayDigests.get(date);
      if (c && c.key === key) return c.value;
    }
    let entries = [];
    try { entries = parseEntries(await fsp.readFile(file, 'utf8')); } catch { /* vanished or unreadable: an empty day */ }
    const value = summarizeDay(date, entries, opts);
    if (date === today) this.todayDigest = { date, at: now, value };
    else {
      this.dayDigests.delete(date);
      this.dayDigests.set(date, { key, value });
      while (this.dayDigests.size > DAY_CACHE_MAX) this.dayDigests.delete(this.dayDigests.keys().next().value);
    }
    return value;
  }

  /** Seven per-day digests ending with `end` (a valid YYYY-MM-DD, default today), oldest first. */
  async week(end, now = Date.now()) {
    const today = localDate(now, this.timeZone);
    end = end || today;
    const dates = [];
    for (let i = 6; i >= 0; i--) dates.push(addDays(end, -i));
    const days = await Promise.all(dates.map(d => this.dayDigest(d, now)));
    return { end, today, timeZone: this.timeZone, days };
  }

  /** Today's digest: honest stats and the newest notable items. */
  today(date = localDate(Date.now(), this.timeZone)) {
    const c = this._cache(date);
    const key = `${date}:${c.version}:${c.entries.length}`;
    if (this.todayMemo.key === key) return this.todayMemo.value;
    const value = digest(date, c.entries, this.finishedMinMs);
    this.todayMemo = { key, value };
    return value;
  }
}

/** The identifying fields of an agent (or, with fromEntry, of a journal entry, whose `kind` is the entry kind). */
function pickInfo(a, fromEntry = false) {
  const o = {
    id: a.id,
    vendor: a.vendor || null,
    agentKind: (fromEntry ? a.agentKind : a.kind) || null,
    project: a.project || null,
    task: clip(a.task, 120),
    parentId: a.parentId || null,
    role: a.role || null,
  };
  if (a.nickname) o.nickname = a.nickname;
  const by = fromEntry ? a.delegatedBy : a.delegator?.id;
  if (by) o.delegatedBy = by; // another agent gave it the work: its finish is that agent's turn, not the person's
  return o;
}

function entryBase(t, kind, a) { return { t, kind, ...pickInfo(a) }; }
/** asking-start; `askTo` names the agent it is addressed to when it is not the person */
function askEntry(t, a, asking) {
  const e = { ...entryBase(t, 'asking-start', a), text: clip(asking, 160) };
  if (a.askTo) e.askTo = a.askTo;
  return e;
}

export function isFinished(e, minMs = CONFIG.journal.finishedMinMs) {
  return e.kind === 'idle' && TOP_KINDS.has(e.agentKind) && !e.parentId && !e.delegatedBy && (e.workedMs || 0) >= minMs;
}

/** Build the /api/today payload from a day's entries. */
export function digest(date, entries, finishedMinMs = CONFIG.journal.finishedMinMs) {
  const sessions = new Set(), helpers = new Set();
  const projects = new Map(); // project -> Set(agent id)
  let reviews = 0, reports = 0, verdicts = 0, finished = 0, askedYou = 0;
  const items = [];
  const item = (e, kind, extra) => {
    const it = { at: e.at || e.t, kind, id: e.id, vendor: e.vendor, agentKind: e.agentKind };
    if (e.nickname) it.nickname = e.nickname;
    it.project = e.project;
    if (e.task) it.task = e.task;
    if (e.to) it.to = e.to;
    if (e.text) it.text = e.text;
    if (e.outcome != null) it.outcome = e.outcome;
    items.push(Object.assign(it, extra));
  };
  for (const e of entries) {
    const top = TOP_KINDS.has(e.agentKind) && !e.parentId;
    if (e.id && e.agentKind) {
      if (top) sessions.add(e.id);
      else if (e.agentKind === 'subagent') helpers.add(e.id);
      if (e.project && e.agentKind !== 'guardian') {
        if (!projects.has(e.project)) projects.set(e.project, new Set());
        projects.get(e.project).add(e.id);
      }
    }
    switch (e.kind) {
      case 'report': reports++; item(e, 'report'); break;
      case 'verdict': verdicts++; item(e, 'verdict'); break;
      case 'review': reviews++; break;
      case 'spawn': item(e, 'spawn'); break;
      case 'asking-start': if (!e.carried && !e.askTo) { askedYou++; item(e, 'asked'); } break; // an ask to another agent is not one to you
      case 'idle': if (isFinished(e, finishedMinMs)) { finished++; item(e, 'finished', { workedMs: e.workedMs }); } break;
      case 'arrived': if (top && !e.carried) item(e, 'arrived'); break;
      case 'left':
        if (e.workedMs != null && isFinished({ ...e, kind: 'idle' }, finishedMinMs)) { finished++; item(e, 'finished', { workedMs: e.workedMs }); } // went straight from working to gone
        if (top) item(e, 'left');
        break;
    }
  }
  items.sort((a, b) => b.at - a.at);
  return {
    date,
    stats: {
      sessions: sessions.size, helpers: helpers.size, reviews, reports, verdicts, finished, askedYou,
      projects: [...projects].map(([project, ids]) => ({ project, count: ids.size })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project)),
    },
    items: items.slice(0, ITEM_LIMIT),
  };
}

/** The week view's digest of one day: digest()'s counts plus time spent working (top-level sessions) and waiting on you
 *  (everyone), and working minutes per local hour. Replays the client timeline's state machine: someone is "asking"
 *  while a question is open, else working or on a break; a state still open at the end of the file runs to `end`
 *  (midnight for a past day, now for today). Robust to junk: entries without an id or a numeric t are skipped. */
export function summarizeDay(date, entries, { start = -Infinity, end = Infinity, timeZone = CONFIG.journal.timeZone, finishedMinMs = CONFIG.journal.finishedMinMs } = {}) {
  const list = (entries || []).filter(e => e && typeof e === 'object' && e.id && e.kind && Number.isFinite(e.t) && (e.project == null || typeof e.project === 'string'));
  const { stats } = digest(date, list, finishedMinMs);
  const hourly = new Array(24).fill(0);
  let workingMs = 0, askMs = 0;
  const addWork = (from, to) => { // split at local hour boundaries (the offset is re-read per hour: DST, half-hour zones)
    for (let t = from; t < to;) {
      const local = t + tzOffset(t, timeZone);
      const hour = Math.floor((((local % 86400000) + 86400000) % 86400000) / 3600000);
      const next = Math.min(to, t + 3600000 - (((local % 3600000) + 3600000) % 3600000));
      hourly[hour] += next - t;
      t = next;
    }
  };
  const close = (s, t) => {
    const from = Math.max(s.from, start), to = Math.min(Math.max(t, s.from), end);
    if (to > from) {
      if (s.ask != null && !s.askTo) askMs += to - from; // waiting on another agent is not waiting on you
      else if (s.status === 'working' && s.top) { workingMs += to - from; addWork(from, to); }
    }
    s.from = t;
  };
  const people = new Map(); // id -> { top, present, status, ask, from }
  for (const e of list.slice().sort((a, b) => a.t - b.t)) {
    if (EVENT_KINDS.has(e.kind)) continue;
    let s = people.get(e.id);
    if (!s) { s = { top: false, present: false, status: 'idle', ask: null, from: e.t }; people.set(e.id, s); }
    if (e.agentKind) s.top = TOP_KINDS.has(e.agentKind) && !e.parentId;
    const enter = () => { if (s.present) close(s, e.t); else { s.present = true; s.from = e.t; } };
    switch (e.kind) {
      case 'arrived': enter(); s.status = e.status === 'working' ? 'working' : 'idle'; s.ask = null; break;
      case 'working': case 'idle': enter(); s.status = e.kind; break;
      case 'asking-start': enter(); if (s.ask != null) close(s, e.t); s.ask = e.text || 'asking'; s.askTo = e.askTo || null; break;
      case 'asking-end': if (s.present && s.ask != null) { close(s, e.t); s.ask = null; } break;
      case 'left': if (s.present) { close(s, e.t); s.present = false; s.ask = null; } break;
      default: break;
    }
  }
  if (Number.isFinite(end)) for (const s of people.values()) if (s.present) close(s, end);
  return {
    date,
    sessions: stats.sessions, helpers: stats.helpers, workingMs, askMs, asks: stats.askedYou,
    reports: stats.reports, verdicts: stats.verdicts, finished: stats.finished,
    projects: stats.projects.slice(0, 3),
    hourly: hourly.map(ms => Math.round(ms / 6000) / 10), // working minutes per local hour, summed over the sessions
  };
}
