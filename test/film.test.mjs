// The film: journal lines in, the office at any moment out. Every answer here is known from the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFilm, applyLine } from '../web/film.js';

const T0 = 1800000000000, MIN = 60000;
const base = (id, extra = {}) => ({ id, vendor: 'claude', agentKind: 'desktop', project: 'p', task: 'a job', parentId: null, role: null, ...extra });
const arrived = (t, id, extra) => ({ t: T0 + t, kind: 'arrived', status: 'working', ...base(id, extra) });
const line = (t, kind, id, extra) => ({ t: T0 + t, kind, ...base(id), ...extra });
const who = (film, t) => film.at(T0 + t).agents.map(a => a.id).sort();
const agent = (film, t, id) => film.at(T0 + t).agents.find(a => a.id === id);

const DAY = [
  arrived(0, 'a'),
  line(5 * MIN, 'idle', 'a', { workedMs: 5 * MIN }),
  arrived(6 * MIN, 'b'),
  line(7 * MIN, 'asking-start', 'b', { text: 'Which file?' }),
  line(9 * MIN, 'asking-end', 'b'),
  line(10 * MIN, 'working', 'a'),
  line(12 * MIN, 'left', 'b'),
];
const span = { from: T0, to: T0 + 20 * MIN };

test('who is in, and doing what, at any moment', () => {
  const f = makeFilm(DAY, span);
  assert.deepEqual(who(f, 3 * MIN), ['a']);
  assert.equal(agent(f, 3 * MIN, 'a').status, 'working');
  assert.equal(agent(f, 5.5 * MIN, 'a').status, 'idle');
  assert.deepEqual(who(f, 8 * MIN), ['a', 'b']);
  assert.equal(agent(f, 8 * MIN, 'b').asking, 'Which file?');
  assert.equal(agent(f, 9.5 * MIN, 'b').asking, null);
  assert.equal(agent(f, 11 * MIN, 'a').status, 'working');
  assert.deepEqual(who(f, 15 * MIN), ['a']);
});

test('the same records make the same film', () => {
  const strip = f => f.frames.map(x => [x.t, x.plan, x.agents]);
  assert.deepEqual(strip(makeFilm(DAY, span)), strip(makeFilm(DAY, span)));
});

test('frames are in time order and a frame is only kept when something changed', () => {
  const f = makeFilm(DAY, span);
  for (let i = 1; i < f.frames.length; i++) assert.ok(f.frames[i].t > f.frames[i - 1].t);
  assert.ok(f.frames.length < 20 * MIN / 1500, `${f.frames.length} frames for 800 ticks`);
});

test('a film starting mid-day knows who was already in, and they are at their places', () => {
  const f = makeFilm(DAY, { from: T0 + 8 * MIN, to: T0 + 20 * MIN });
  const first = f.at(f.from);
  assert.deepEqual(first.agents.map(a => a.id).sort(), ['a', 'b']);
  assert.equal(first.agents.find(a => a.id === 'b').asking, 'Which file?');
  assert.equal(f.frames[0].t, f.from);
  assert.equal(first.plan.workers.a.step.k !== 'in', true, 'not walking in');
});

test('an empty span is an empty office, not an error', () => {
  const f = makeFilm([], span);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.at(T0 + MIN).agents, []);
  assert.deepEqual(f.marks, []);
});

test('marks: waiting on you, top-level arrivals and reports; not helpers, not asks between agents, not carried lines', () => {
  const lines = [
    arrived(0, 'lead'),
    arrived(MIN, 'help', { role: 'helper', parentId: 'lead' }),
    line(2 * MIN, 'asking-start', 'lead', { text: 'Ok?' }),
    line(3 * MIN, 'asking-start', 'help', { text: 'Which?', askTo: 'lead' }),
    { ...arrived(4 * MIN, 'lead'), carried: true },
    line(5 * MIN, 'report', 'help', { eid: 'r1', to: 'lead', text: 'done' }),
  ];
  const f = makeFilm(lines, span);
  assert.deepEqual(f.marks.map(m => [m.t - T0, m.kind]), [[0, 'in'], [2 * MIN, 'ask'], [5 * MIN, 'report']]);
});

test('marks and changes before the span are not on the bar', () => {
  const f = makeFilm(DAY, { from: T0 + 8 * MIN, to: T0 + 20 * MIN });
  assert.ok(f.marks.every(m => m.t >= f.from));
  assert.ok(f.changes.every(t => t >= f.from));
});

test('events reach the frame they happened in, once', () => {
  const lines = [arrived(0, 'a'), arrived(0, 'b'), line(3 * MIN, 'report', 'a', { eid: 'e1', to: 'b', text: 'hello' })];
  const f = makeFilm(lines, span);
  const carrying = f.frames.filter(x => x.events.length);
  assert.equal(carrying.length, 1);
  assert.equal(carrying[0].events[0].id, 'e1');
  assert.ok(Math.abs(carrying[0].t - (T0 + 3 * MIN)) <= 1500);
});

test('over a midnight: those carried stay, and keep the time they really came in', () => {
  const midnight = T0 + 10 * MIN;
  const lines = [
    arrived(0, 'stays'), arrived(MIN, 'gone'),
    { ...arrived(10 * MIN + 500, 'stays'), carried: true },
    line(11 * MIN, 'idle', 'stays', { workedMs: 1 }),
  ];
  const f = makeFilm(lines, { ...span, dayStarts: [midnight] });
  assert.deepEqual(who(f, 9 * MIN), ['gone', 'stays']);
  assert.deepEqual(who(f, 12 * MIN), ['stays']);
  assert.equal(agent(f, 12 * MIN, 'stays').startedAt, T0, 'not restarted by the new file');
});

test('someone carried over a midnight, with no earlier file, is at a desk from the start', () => {
  const lines = [{ ...arrived(1000, 'x'), carried: true }];
  const f = makeFilm(lines, { from: T0, to: T0 + 5 * MIN });
  assert.notEqual(f.at(T0 + 2 * MIN).plan.workers.x.step.k, 'in');
});

test('the server off over a midnight: yesterday\'s people are gone when the new file starts', () => {
  const midnight = T0 + 10 * MIN;
  const lines = [arrived(0, 'old'), arrived(15 * MIN, 'new')];
  const f = makeFilm(lines, { ...span, dayStarts: [midnight] });
  assert.deepEqual(who(f, 16 * MIN), ['new']);
});

test('nothing after the end of the span leaks in', () => {
  const f = makeFilm([arrived(0, 'a'), arrived(30 * MIN, 'late')], span);
  assert.deepEqual(who(f, 25 * MIN), ['a']);
  assert.ok(f.marks.every(m => m.t <= f.to));
});

test('a working count for the bar: busier stretches read higher', () => {
  const f = makeFilm([arrived(0, 'a'), line(10 * MIN, 'idle', 'a')], span);
  const n = f.heat.length;
  assert.ok(f.heat[Math.floor(n / 4)] > 0.5);
  assert.equal(f.heat[Math.floor(n * 3 / 4)], 0);
});

test('gaps outside the span are dropped', () => {
  const f = makeFilm(DAY, { ...span, gaps: [{ from: T0 - 2 * MIN, to: T0 - MIN }, { from: T0 + MIN, to: T0 + 2 * MIN }] });
  assert.deepEqual(f.gaps.map(g => g.from - T0), [MIN]);
});

test('odd lines do no harm: a change for someone never seen, a torn entry', () => {
  const agents = new Map();
  assert.equal(applyLine(agents, line(0, 'working', 'ghost')), false);
  assert.equal(applyLine(agents, line(0, 'asking-end', 'ghost')), false);
  assert.equal(agents.size, 0);
  const f = makeFilm([null, { kind: 'arrived' }, arrived(0, 'a')], span);
  assert.deepEqual(who(f, MIN), ['a']);
});

test('a seat line puts the worker at the desk they really had, when it is free', async () => {
  const { LAYOUT } = await import('../web/director.js');
  const desk = { f: 0, d: LAYOUT.desks[LAYOUT.desks.length - 1] };
  const without = makeFilm([arrived(0, 'a')], span).at(T0 + 3 * MIN).plan.workers.a.desk;
  assert.notDeepEqual(without, desk, 'the fixture needs a desk the director would not pick by itself');
  const lines = [arrived(0, 'a'), { t: T0 + 1500, kind: 'seat', id: 'a', desk }];
  assert.deepEqual(makeFilm(lines, span).at(T0 + 3 * MIN).plan.workers.a.desk, desk);
  // the same desk already taken by someone else: they keep a free one
  const two = [arrived(0, 'b'), { t: T0 + 1500, kind: 'seat', id: 'b', desk }, arrived(MIN, 'a'), { t: T0 + MIN + 1500, kind: 'seat', id: 'a', desk }];
  const plan = makeFilm(two, span).at(T0 + 4 * MIN).plan;
  assert.deepEqual(plan.workers.b.desk, desk);
  assert.notDeepEqual(plan.workers.a.desk, desk);
});

test('the journal writes where each one sits once, and again only when it changes', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { Journal, readEntries, journalFile, localDate } = await import('../server/journal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-seat-'));
  const j = new Journal({ dir, timeZone: 'UTC', log: { log() {}, warn() {}, error() {} } });
  const a = { id: 'a', vendor: 'claude', kind: 'cli', project: 'p', task: 't', status: 'working' };
  const plan = d => ({ workers: { a: { desk: { f: 0, d } } } });
  j.record({ now: T0, agents: [a], plan: plan(3) });
  j.record({ now: T0 + 1500, agents: [a], plan: plan(3) });
  j.record({ now: T0 + 3000, agents: [a], plan: plan(5) });
  const seats = readEntries(journalFile(localDate(T0, 'UTC'), dir)).filter(e => e.kind === 'seat');
  assert.deepEqual(seats.map(e => e.desk.d), [3, 5]);
  assert.equal(seats[0].task, undefined, 'only where, nothing about the work');
});
