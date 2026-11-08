// Week view APIs: synthetic journals for 7 days in a temp dir (never data/), checked through the Journal class and a
// throwaway server on a free port.   node --test test/
// The temp dirs are left in the OS temp folder (no deletion here); set TMPDIR to choose where they go.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal, summarizeDay, dayStart, isValidDay, addDays, localDate } from '../server/journal.js';
import { groupMarks } from '../web/timeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Asia/Hong_Kong';
const H = 3600000, M = 60000;
const DAYS = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16'];
const MISSING = '2026-03-12';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-week-'));
const expected = new Map(); // date -> { workingMs, askMs, reports, sessions, helpers, lines }

const agent = (id, extra = {}) => ({ id, vendor: 'claude', agentKind: 'cli', project: '/Users/x/Projects/alpha', task: 'do it', parentId: null, role: null, ...extra });

function writeDay(date, i) {
  const s = dayStart(date, TZ);
  const a = agent(`s${i}`), b = agent(`t${i}`, { vendor: 'codex', project: i % 2 ? '/p/beta' : '/p/gamma' });
  const h = agent(`h${i}`, { agentKind: 'subagent', parentId: `s${i}`, role: 'helper', task: 'Helper: look' });
  const work = (i + 1) * 30 * M; // s_i works 30, 60, 90 … minutes from 09:00
  const L = [
    { t: s + 9 * H, kind: 'arrived', status: 'working', ...a },
    { t: s + 9 * H + work, kind: 'idle', workedMs: work, ...a },
    { t: s + 14 * H, kind: 'arrived', status: 'idle', ...b },
    { t: s + 14 * H + 30 * M, kind: 'working', ...b },
    { t: s + 15 * H, kind: 'asking-start', text: 'may I?', ...b },   // working 30 min, then 10 min waiting on you
    { t: s + 15 * H + 10 * M, kind: 'asking-end', ...b },
    { t: s + 15 * H + 40 * M, kind: 'idle', ...b },                   // another 30 min working
    { t: s + 16 * H, kind: 'left', ...b },
    { t: s + 9 * H + 5 * M, kind: 'arrived', status: 'working', ...h }, // helpers' work is not "working" time
    { t: s + 9 * H + 20 * M, kind: 'left', ...h },
    { t: s + 9 * H + 21 * M, kind: 'report', eid: `r${i}`, ...h, to: a.id, text: 'done' },
  ];
  let lines = L.map(e => JSON.stringify(e));
  lines.push('not json at all', '{"t":"nope","kind":"arrived"}', JSON.stringify({ t: s + 10 * H, kind: 'working', id: 'x', project: 42 }));
  let workingMs = work + 60 * M;
  if (i === 6) { // the last day: someone still working at midnight runs to the end of the day
    lines.push(JSON.stringify({ t: s + 23 * H + 30 * M, kind: 'arrived', status: 'working', ...agent('late') }));
    workingMs += 30 * M;
  }
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), lines.join('\n') + '\n{"t":1,"kind":"tor'); // a torn last line
  expected.set(date, { workingMs, askMs: 10 * M, reports: 1, sessions: i === 6 ? 3 : 2, helpers: 1, lines: L.length + (i === 6 ? 1 : 0) });
}
DAYS.forEach((d, i) => { if (d !== MISSING) writeDay(d, i); });

test('date helpers', () => {
  assert.equal(isValidDay('2026-03-10'), true);
  assert.equal(isValidDay('2028-02-29'), true);
  for (const bad of ['2026-13-40', '2026-02-30', '../etc', '2026-3-1', '', null, '2026-03-10/..', '2026-03-10.jsonl']) assert.equal(isValidDay(bad), false, String(bad));
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(new Date(dayStart('2026-03-10', TZ)).toISOString(), '2026-03-09T16:00:00.000Z');
  assert.equal(new Date(dayStart('2026-03-08', 'America/New_York')).toISOString(), '2026-03-08T05:00:00.000Z'); // DST day
  assert.equal(new Date(dayStart('2026-03-09', 'America/New_York')).toISOString(), '2026-03-09T04:00:00.000Z');
});

test('week digests from the Journal', async () => {
  const j = new Journal({ dir, timeZone: TZ, log: { error() {} } });
  const now = dayStart('2026-03-20', TZ);
  const w = await j.week('2026-03-16', now);
  assert.equal(w.end, '2026-03-16');
  assert.equal(w.today, '2026-03-20');
  assert.deepEqual(w.days.map(d => d.date), DAYS);
  for (const d of w.days) {
    assert.equal(d.hourly.length, 24);
    if (d.date === MISSING) {
      assert.equal(d.sessions, 0); assert.equal(d.workingMs, 0); assert.equal(d.hourly.reduce((a, b) => a + b, 0), 0);
      continue;
    }
    const x = expected.get(d.date);
    assert.equal(d.workingMs, x.workingMs, d.date);
    assert.equal(d.askMs, x.askMs, d.date);
    assert.equal(d.reports, x.reports);
    assert.equal(d.sessions, x.sessions);
    assert.equal(d.helpers, x.helpers);
    assert.equal(d.asks, 1);
    assert.ok(Math.abs(d.hourly.reduce((a, b) => a + b, 0) - x.workingMs / M) < 0.5, 'hourly sums to the time working');
    assert.ok(d.projects.length <= 3 && d.projects[0].project === '/Users/x/Projects/alpha');
  }
  const first = w.days[0]; // s0 works 09:00–09:30, t0 14:30–15:00 and 15:10–15:40
  assert.equal(first.hourly[9], 30); assert.equal(first.hourly[14], 30); assert.equal(first.hourly[15], 30);
  assert.equal(w.days[6].hourly[23], 30); // still working at midnight
  assert.equal(w.days[6].finished, 1);    // s6 worked 3.5 h then went idle

  // past days are cached by mtime + size, and a change is picked up
  const again = await j.dayDigest('2026-03-10', now);
  assert.equal(again, first);
  const f = path.join(dir, '2026-03-10.jsonl');
  const s = dayStart('2026-03-10', TZ);
  fs.appendFileSync(f, '\n' + JSON.stringify({ t: s + 20 * H, kind: 'report', eid: 'extra', ...agent('s0') }) + '\n');
  const changed = await j.dayDigest('2026-03-10', now);
  assert.notEqual(changed, first);
  assert.equal(changed.reports, 2);
});

test('today is recomputed at most every 30 s', async () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-today-'));
  const j = new Journal({ dir: tdir, timeZone: TZ, log: { error() {} } });
  const date = '2026-04-01', s = dayStart(date, TZ), now = s + 12 * H;
  const f = path.join(tdir, `${date}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ t: s + 10 * H, kind: 'arrived', status: 'working', ...agent('a') }) + '\n');
  const d1 = await j.dayDigest(date, now);
  assert.equal(d1.workingMs, 2 * H); // still working: runs to now
  fs.appendFileSync(f, JSON.stringify({ t: s + 11 * H, kind: 'idle', ...agent('a') }) + '\n');
  assert.equal(await j.dayDigest(date, now + 1000), d1);
  const d2 = await j.dayDigest(date, now + 31000);
  assert.equal(d2.workingMs, 1 * H);
  const w = await j.week(undefined, now);
  assert.equal(w.end, date);
  assert.equal(w.days[6].date, date);
});

test('summarizeDay is robust to junk', () => {
  const d = summarizeDay('2026-03-10', [null, 5, 'x', {}, { t: NaN, kind: 'arrived', id: 'a' }, { t: 1, kind: 'left', id: 'a' }], { start: 0, end: 10, timeZone: TZ });
  assert.equal(d.workingMs, 0);
  assert.equal(d.hourly.length, 24);
});

test('opening past days never evicts today\'s parsed file', () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-cache-'));
  const j = new Journal({ dir: tdir, timeZone: TZ, log: { error() {} } });
  const today = localDate(Date.now(), TZ);
  fs.writeFileSync(path.join(tdir, `${today}.jsonl`), JSON.stringify({ t: Date.now(), kind: 'arrived', status: 'working', ...agent('a') }) + '\n');
  assert.equal(j.entries({ date: today }).length, 1);
  const cached = j.caches.get(today);
  assert.ok(cached);
  for (let i = 1; i <= 6; i++) j.day(addDays(today, -i));
  assert.equal(j.caches.get(today), cached, 'today kept');
  assert.ok(j.caches.size <= 4, `small cache (${j.caches.size})`);
  assert.ok(j.caches.has(addDays(today, -6)), 'the day just opened is cached');
  assert.equal(j.entries({ date: today }).length, 1);
});

test('timeline markers of one kind closer than 8 px merge', () => {
  const mk = (k, t, extra = {}) => ({ k, t, ...extra });
  const marks = [mk('spawn', 0), mk('spawn', 5), mk('spawn', 11), mk('spawn', 16), mk('spawn', 40), mk('report', 3), mk('report', 9),
    mk('verdict', 20, { outcome: 'allow' }), mk('verdict', 22, { outcome: 'deny' })];
  const g = groupMarks(marks, t => t);
  const spawn = g.filter(x => x.cls === 'spawn');
  assert.deepEqual(spawn.map(x => x.ms.length), [4, 1]);          // 0, 5, 11, 16 chain (gaps < 8 px); 40 stands alone
  assert.equal(spawn[0].x, 8);                                      // drawn at the members' mean
  assert.deepEqual(g.filter(x => x.cls === 'rep').map(x => x.ms.length), [2]);
  assert.equal(g.filter(x => x.cls === 'ok').length, 1);            // an approval and a flag never merge
  assert.equal(g.filter(x => x.cls === 'flag').length, 1);
  for (let i = 1; i < g.length; i++) assert.ok(g[i].x >= g[i - 1].x, 'sorted by position');
  for (const cls of ['spawn', 'rep']) {
    const xs = g.filter(x => x.cls === cls).map(x => x.x);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 8, 'groups of one kind do not overlap');
  }
  assert.equal(groupMarks([], t => t).length, 0);
});

// ---------- HTTP: a throwaway server on a free port, journal dir = the temp dir ----------
let child = null, base = '';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, AI_OFFICE_PORT: String(port), AI_OFFICE_JOURNAL_DIR: dir, AI_OFFICE_TIME_ZONE: TZ },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/week`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('test server did not start');
});
after(() => { child?.kill(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };

test('GET /api/week', async () => {
  const { status, body } = await get('/api/week?end=2026-03-16');
  assert.equal(status, 200);
  assert.equal(body.timeZone, TZ);
  assert.deepEqual(body.days.map(d => d.date), DAYS);
  const d = body.days[1];
  for (const k of ['sessions', 'helpers', 'workingMs', 'askMs', 'reports', 'verdicts', 'finished', 'projects', 'hourly']) assert.ok(k in d, k);
  assert.equal(d.workingMs, expected.get(DAYS[1]).workingMs);
  const today = await get('/api/week');
  assert.equal(today.status, 200);
  assert.equal(today.body.end, localDate(Date.now(), TZ));
  assert.equal(today.body.days.length, 7);
});

test('GET /api/journal?day=', async () => {
  const { status, body } = await get('/api/journal?day=2026-03-13');
  assert.equal(status, 200);
  assert.equal(body.date, '2026-03-13');
  assert.equal(body.entries.length, expected.get('2026-03-13').lines + 1); // + the junk line with a numeric project (a valid entry)
  assert.equal(body.start, dayStart('2026-03-13', TZ));
  assert.equal(body.end, dayStart('2026-03-14', TZ));
  assert.equal(body.trimmed, false);
  const missing = await get(`/api/journal?day=${MISSING}`);
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.entries, []);
});

test('bad dates are refused', async () => {
  for (const q of ['day=../etc', 'day=2026-13-40', 'day=2026-02-30', 'day=', 'day=..%2F..%2Fpackage', 'day=2026-03-13%2F..', 'day=%2E%2E']) {
    assert.equal((await get(`/api/journal?${q}`)).status, 400, q);
  }
  for (const q of ['end=2026-13-40', 'end=../x', 'end=']) assert.equal((await get(`/api/week?${q}`)).status, 400, q);
});

test('existing journal APIs are unchanged', async () => {
  const j = await get('/api/journal?since=0');
  assert.equal(j.status, 200);
  assert.ok(Array.isArray(j.body.entries) && 'date' in j.body && 'since' in j.body);
  const t = await get('/api/today');
  assert.equal(t.status, 200);
  assert.ok(t.body.stats && Array.isArray(t.body.items));
});

test('journal lines that fail to write (drive away) are held and written, in order, once it works again', async () => {
  const { Journal } = await import('../server/journal.js');
  const fsm = await import('node:fs'), osm = await import('node:os'), pathm = await import('node:path');
  const base = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'ai-office-hold-'));
  const dir = pathm.join(base, 'journal');
  const errors = [];
  const j = new Journal({ dir, log: { error: (...a) => errors.push(a.join(' ')) } });
  fsm.writeFileSync(dir, 'a file where the folder should be'); // mkdir fails, like an unmounted drive
  j._append('2026-10-30', [{ t: 1, kind: 'arrived', id: 'claude:a' }]);
  j._append('2026-10-30', [{ t: 2, kind: 'left', id: 'claude:a' }]);
  assert.equal(errors.length, 1, 'one failure logged, not one per line');
  fsm.renameSync(dir, `${dir}.blocked`); // the drive is back
  j._append('2026-10-30', [{ t: 3, kind: 'arrived', id: 'claude:b' }]);
  const lines = fsm.readFileSync(pathm.join(dir, '2026-10-30.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).t);
  assert.deepEqual(lines, [1, 2, 3], 'held lines first, in order');
  assert.match(errors.at(-1), /writing again/);
});

test('a session that came and went within seconds is left out of the day; a short real one with an event is not', async () => {
  const { withoutBlips } = await import('../server/journal.js');
  const T = 1_000_000;
  const rows = [
    { t: T, kind: 'arrived', id: 'quick' }, { t: T + 3000, kind: 'working', id: 'quick' }, { t: T + 5000, kind: 'left', id: 'quick' },
    { t: T, kind: 'arrived', id: 'stayed' }, { t: T + 60000, kind: 'left', id: 'stayed' },
    { t: T, kind: 'arrived', id: 'asked' }, { t: T + 1000, kind: 'asking-start', id: 'asked' }, { t: T + 5000, kind: 'left', id: 'asked' },
    { t: T, kind: 'arrived', id: 'still-in' },
  ];
  assert.deepEqual([...new Set(withoutBlips(rows).map(r => r.id))], ['stayed', 'asked', 'still-in']);
});

