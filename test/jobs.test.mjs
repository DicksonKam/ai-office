import test from 'node:test';
import assert from 'node:assert/strict';
import { JobBook, LIMITS } from '../server/jobbook.js';
import { nextOccurrence } from '../server/rrule.js';
import { parseDropLine } from '../server/jobdrop.js';
import { holdsWorker, waitingOnJob, jobSummary, TIMER_HOLD_MS } from '../web/jobs.js';

const T = Date.UTC(2026, 10, 3, 6, 0, 0), MIN = 60000;
const run = (over = {}) => ({ id: 'a:1', owner: 'x:a', kind: 'run', state: 'running', label: 'Build', startedAt: T, ...over });
const owners = (status = 'idle', pid = null) => new Map([['x:a', { id: 'x:a', status, pid }]]);

test('a run stays until its end note, and the note is final', () => {
  const b = new JobBook();
  b.observe([run()], T); b.sweep(T + 5 * MIN, owners());
  assert.equal(b.listFor('x:a')[0].state, 'running');
  b.observe([{ id: 'a:1', state: 'failed', endedAt: T + 6 * MIN }], T + 6 * MIN);
  b.observe([run()], T + 7 * MIN); // the transcript's tail still shows it starting
  assert.equal(b.listFor('x:a')[0].state, 'failed');
});

test('an end note for a job never reported, or a new job from long-gone history, adds nothing', () => {
  const b = new JobBook();
  b.observe([{ id: 'a:9', state: 'done' }], T);
  b.observe([run({ id: 'a:old', startedAt: T - LIMITS.maxRunMs - MIN })], T);
  b.observe([run({ id: 'a:ended', state: 'done', endedAt: T - LIMITS.endedMaxMs - MIN })], T);
  assert.equal(b.listFor('x:a').length, 0);
});

test('no end note: closed owner, lost shell, dead pid and old age all end as unknown, never done', () => {
  const end = (setup, step) => { const b = new JobBook(); b.observe([run(setup)], T); step(b); return b.listFor('x:a')[0]?.state; };
  assert.equal(end({}, b => b.sweep(T + MIN, owners('gone'))), 'unknown');
  assert.equal(end({ pid: 42 }, b => b.sweep(T + MIN, owners(), { pidAlive: () => false })), 'unknown');
  assert.equal(end({}, b => b.sweep(T + LIMITS.maxRunMs + MIN, owners())), 'unknown');
  assert.equal(end({}, b => b.sweep(T + MIN, new Map())), 'running', 'an owner missing one poll is not enough');
  assert.equal(end({}, b => { b.sweep(T + MIN, owners()); b.sweep(T + MIN + LIMITS.ownerGraceMs + 1, new Map()); }), 'unknown');
  const shell = { shellsUnder: () => 0 };
  assert.equal(end({ needsShell: true }, b => { b.sweep(T + MIN, owners('idle', 7), shell); b.sweep(T + 2 * MIN, owners('idle', 7), shell); }), 'unknown');
  assert.equal(end({ needsShell: true }, b => { b.sweep(T + MIN, owners('idle', 7), shell); b.sweep(T + MIN + 5000, owners('idle', 7), { shellsUnder: () => 1 }); b.sweep(T + 3 * MIN, owners('idle', 7), { shellsUnder: () => 1 }); }), 'running');
  assert.equal(end({ needsShell: true }, b => b.sweep(T + 3 * MIN, owners('idle', 7), { shellsUnder: () => null })), 'running', 'no process table: no conclusion');
});

test('an ended job is seen for a minute even if it wakes the agent, then goes when they work', () => {
  const b = new JobBook();
  b.observe([run({ state: 'done', endedAt: T })], T);
  b.sweep(T + 30000, owners('working'));
  assert.equal(b.listFor('x:a').length, 1);
  b.sweep(T + LIMITS.endedMinMs + 1, owners('working'));
  assert.equal(b.listFor('x:a').length, 0);
  b.observe([run({ state: 'done', endedAt: T + 2 * MIN })], T + 2 * MIN); // the tail still says so
  assert.equal(b.listFor('x:a').length, 0);
});

test('an ended job waits for a resting agent, within limits', () => {
  const b = new JobBook();
  b.observe([run({ state: 'failed', endedAt: T })], T);
  b.sweep(T + 20 * MIN, owners('idle'));
  assert.equal(b.listFor('x:a').length, 1);
  b.sweep(T + LIMITS.endedMaxMs + 1, owners('idle'));
  assert.equal(b.listFor('x:a').length, 0);
});

test('a timer goes when it wakes its owner, and is not believed long past due', () => {
  const b = new JobBook(), timer = { id: 'a:t', owner: 'x:a', kind: 'timer', state: 'waiting', nextAt: T + 5 * MIN };
  b.observe([timer], T); b.sweep(T + MIN, owners('working'));
  assert.equal(b.listFor('x:a')[0].state, 'waiting', 'working before it is due');
  b.sweep(T + 6 * MIN, owners('working'));
  assert.equal(b.listFor('x:a').length, 0);
  const c = new JobBook();
  c.observe([timer], T); c.sweep(T + 5 * MIN + LIMITS.timerGraceMs + 1, owners('idle'));
  assert.equal(c.listFor('x:a').length, 0, 'an ended timer is not left on the desk');
});

test('the book survives a restart', () => {
  const b = new JobBook(); b.observe([run()], T);
  const c = new JobBook(JSON.parse(JSON.stringify(b)));
  assert.equal(c.listFor('x:a')[0].label, 'Build');
});

test('what holds a worker: a run always, a timer only when close, a schedule never', () => {
  assert.ok(holdsWorker({ kind: 'run', state: 'running' }, T));
  assert.ok(!holdsWorker({ kind: 'run', state: 'done' }, T));
  assert.ok(holdsWorker({ kind: 'timer', state: 'waiting', nextAt: T + TIMER_HOLD_MS - 1 }, T));
  assert.ok(!holdsWorker({ kind: 'timer', state: 'waiting', nextAt: T + TIMER_HOLD_MS + 1 }, T));
  assert.ok(!holdsWorker({ kind: 'schedule', state: 'waiting', nextAt: T + 1 }, T));
  assert.ok(waitingOnJob({ jobs: [{ kind: 'run', state: 'running' }] }, T));
  assert.deepEqual(jobSummary({ jobs: [{ kind: 'run', state: 'running' }, { kind: 'run', state: 'failed' }] }, T), { running: 1, nextAt: 0, failed: 1 });
});

const local = (...a) => new Date(...a).getTime();
test('schedule times from the shapes seen in real rules', () => {
  const made = local(2026, 9, 28, 10, 30, 0), now = local(2026, 10, 3, 14, 12, 0);
  assert.equal(nextOccurrence('FREQ=HOURLY;INTERVAL=1;BYMINUTE=0;BYSECOND=0', made, now), local(2026, 10, 3, 15, 0, 0));
  assert.equal(nextOccurrence('RRULE:FREQ=MINUTELY;INTERVAL=30', local(2026, 10, 3, 14, 0, 0), now), local(2026, 10, 3, 14, 30, 0));
  assert.equal(nextOccurrence('FREQ=DAILY;INTERVAL=3;BYHOUR=20;BYMINUTE=0;BYSECOND=0', local(2026, 10, 1, 9, 0, 0), now), local(2026, 10, 4, 20, 0, 0));
  assert.equal(nextOccurrence('FREQ=DAILY;BYHOUR=9;UNTIL=20261101T000000Z', made, now), null, 'past its end');
  assert.equal(nextOccurrence('RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=40;COUNT=1', made, now), null, 'a one-off already fired');
  assert.equal(nextOccurrence('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0', made, now), local(2026, 10, 6, 9, 0, new Date(made).getSeconds()));
  assert.equal(nextOccurrence('FREQ=YEARLY', made, now), null, 'a rule it cannot read shows no time');
});

test('the drop-in contract', () => {
  const ok = parseDropLine({ v: 1, id: 'grok:b1', owner: 'grok:c1', kind: 'run', state: 'running', label: 'Build', at: '2026-11-03T06:00:00Z' });
  assert.equal(ok.owner, 'grok:c1'); assert.equal(ok.kind, 'run');
  assert.equal(parseDropLine({ v: 1, id: 'grok:b1', state: 'done', at: T }).state, 'done', 'an end note needs no owner');
  for (const bad of [{ v: 2, id: 'g:1', state: 'done', at: T }, { v: 1, id: 'noprefix', state: 'done', at: T }, { v: 1, id: 'g:1', state: 'maybe', at: T }, { v: 1, id: 'g:1', state: 'done' }, { v: 1, id: 'g:1', owner: 'g:2', kind: 'nope', state: 'running', at: T }]) assert.equal(parseDropLine(bad), null);
});

import { jobsFromLines } from '../server/collectors/claude.js';
import { parseAutomation } from '../server/collectors/codex.js';
import { backgroundShells, terminalState } from '../server/collectors/cursor.js';

const iso = ms => new Date(ms).toISOString();
test('Claude: a background command, its end note, and a wake-up timer', () => {
  const lines = [
    { type: 'assistant', timestamp: iso(T), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Long build', run_in_background: true } }] } },
    { type: 'user', timestamp: iso(T + 1000), toolUseResult: { backgroundTaskId: 'abc' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background' }] } },
    { type: 'assistant', timestamp: iso(T + 2000), message: { content: [{ type: 'tool_use', id: 't2', name: 'ScheduleWakeup', input: { delaySeconds: 600, reason: 'Check the deploy' } }] } },
  ];
  let jobs = jobsFromLines(lines);
  assert.equal(jobs.find(j => j.kind === 'run').label, 'Long build');
  assert.equal(jobs.find(j => j.kind === 'run').state, 'running');
  assert.equal(jobs.find(j => j.kind === 'timer').nextAt, T + 2000 + 600000);
  lines.push({ type: 'user', timestamp: iso(T + 5000), message: { content: '<task-notification>\n<task-id>abc</task-id>\n<status>failed</status>\n</task-notification>' } });
  jobs = jobsFromLines(lines);
  assert.equal(jobs.find(j => j.kind === 'run').state, 'failed');
  assert.equal(jobs.find(j => j.kind === 'run').endedAt, T + 5000);
});

test('Claude: an end note for a job older than the tail is passed on; a background helper is not a job; a new timer replaces the old', () => {
  const j = jobsFromLines([{ type: 'user', timestamp: iso(T), message: { content: '<task-notification><task-id>old</task-id><status>completed</status></task-notification>' } }]);
  assert.deepEqual([j[0].key, j[0].state, j[0].kind], ['job:old', 'done', undefined]);
  const h = jobsFromLines([
    { type: 'assistant', timestamp: iso(T), message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { run_in_background: true } }] } },
    { type: 'user', timestamp: iso(T), toolUseResult: { backgroundTaskId: 'h' }, message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
  ]);
  assert.equal(h.length, 0);
  const two = jobsFromLines([1, 2].map(i => ({ type: 'assistant', timestamp: iso(T + i), message: { content: [{ type: 'tool_use', id: `w${i}`, name: 'ScheduleWakeup', input: { delaySeconds: 60 } }] } })));
  assert.deepEqual(two.map(x => x.state), ['stopped', 'waiting']);
});

test('Codex: a schedule file, read without its prompt', () => {
  const a = parseAutomation('version = 1\nid = "hourly"\nname = "Check mail"\nprompt = "secret"\nstatus = "ACTIVE"\nrrule = "FREQ=HOURLY"\ntarget_thread_id = "abc"\ncreated_at = 1793300886238\n');
  assert.deepEqual([a.id, a.name, a.status, a.rrule, a.thread, a.createdAt], ['hourly', 'Check mail', 'ACTIVE', 'FREQ=HOURLY', 'abc', 1793300886238]);
  assert.ok(!Object.values(a).includes('secret'));
});

test('Cursor: only a command the chat did not wait for, and what its terminal file says', () => {
  const s = backgroundShells([{ message: { content: [
    { type: 'tool_use', name: 'Shell', input: { command: 'npm run dev', description: 'Dev server', block_until_ms: 0 } },
    { type: 'tool_use', name: 'Shell', input: { command: 'ls', block_until_ms: 5000 } },
  ] } }]);
  assert.deepEqual([...s.keys()], ['npm run dev']);
  const head = '---\npid: 82220\ncwd: "/x"\ncommand: "npm run dev"\nstarted_at: 2026-06-23T10:03:16.541Z\nrunning_for_ms: 180035\n---\noutput', t = terminalState(head, 'output');
  assert.deepEqual([t.pid, t.command, t.exit], [82220, 'npm run dev', null]);
  assert.equal(terminalState(head, '---\nexit_code: 1\nelapsed_ms: 9\nended_at: 2026-06-23T10:06:16.541Z\n---').exit, 1);
});

test('Claude: an end note arriving mid-turn, and one only quoted in a command\'s output', () => {
  const start = [
    { type: 'assistant', timestamp: iso(T), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Build' } }] } },
    { type: 'user', timestamp: iso(T), toolUseResult: { backgroundTaskId: 'abc' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
  ];
  const note = '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>';
  const quoted = jobsFromLines([...start, { type: 'user', timestamp: iso(T + 1), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: note }] } }]);
  assert.equal(quoted[0].state, 'running');
  for (const line of [{ type: 'queue-operation', content: note }, { type: 'attachment', attachment: { prompt: note } }]) {
    const j = jobsFromLines([...start, { ...line, timestamp: iso(T + 9) }, { ...line, timestamp: iso(T + 99) }]);
    assert.deepEqual([j[0].state, j[0].endedAt], ['done', T + 9], line.type);
  }
});


import * as THREE from 'three';
import { buildJobKit } from '../web/jobprops.js';
const material = () => new THREE.MeshBasicMaterial();
const kit = () => buildJobKit(new THREE.Group(), { toon: material, PAL: new Proxy({}, { get: () => 0x888888 }), applyMode: () => {} });
const running = [{ kind: 'run', state: 'running' }];
const settle = (k, s = 2) => { for (let i = 0; i < s * 20; i++) k.update(0.05); };
test('the lid: only under a hand, after it arrives, and a tab opened mid-job finds it open', () => {
  const k = kit();
  assert.equal(k.setJobs([], T, true), false, 'the first look, nothing on');
  assert.equal(k.setJobs(running, T, false), false, 'nobody in the chair');
  settle(k); assert.equal(k.lidAngle, 0);
  assert.equal(k.setJobs(running, T, true), true, 'in the chair: they reach');
  assert.equal(k.setJobs(running, T, true), false, 'once');
  k.update(0.2); assert.equal(k.lidAngle, 0, 'the hand is not there yet');
  settle(k); assert.ok(k.lidAngle < -1.8, 'up');
  assert.equal(k.setJobs([], T, false), false, 'job over, chair empty: left as it was');
  settle(k); assert.ok(k.lidAngle < -1.8);
  assert.equal(k.setJobs([], T, true), true, 'the next person closes it');
  settle(k); assert.equal(k.lidAngle, 0);
  const mid = kit();
  assert.equal(mid.setJobs(running, T, true), false, 'no reach on a tab opened mid-job');
  assert.ok(mid.lidAngle < -1.8);
});

import { StartedBy } from '../server/startedby.js';
import { sessionStartsFromLines } from '../server/collectors/claude.js';
import { parseParty } from '../server/links/link.js';

test('who started whom: only the result of a start call, matched by id, and remembered', () => {
  const res = 'Started session "Test it" (session_id: local_a0d5-02bc, name: test). It runs on its own';
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'mcp__ccd_session__start_session', input: {} }] } },
    { type: 'user', timestamp: iso(T), message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: res }] } },
    { type: 'user', timestamp: iso(T), message: { content: [{ type: 'tool_result', tool_use_id: 'other', content: 'Started session "Quoted" (session_id: local_ffff)' }] } },
    { type: 'user', timestamp: iso(T), message: { content: 'Started session "Typed" (session_id: local_eeee)' } },
  ];
  assert.deepEqual(sessionStartsFromLines(lines), [{ hostId: 'local_a0d5-02bc', at: T, by: null }]);
  const copied = [lines[0], { ...lines[1], sessionId: 'original' }]; // a continued chat's file, carrying its history
  assert.equal(sessionStartsFromLines(copied)[0].by, 'claude:original', 'the session that made the call, not the file it is in');
  const declined = [lines[0], { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Proposed "X" (task_id: task_1). The user sees a card' }] } }];
  assert.equal(sessionStartsFromLines(declined).length, 0, 'a card nobody started is not a start');

  const s = new StartedBy();
  s.noteHost('claude:child', 'local_a0d5-02bc');
  assert.equal(s.of('claude:child'), null, 'not known yet');
  s.noteCall('claude:parent', 'local_a0d5-02bc', T);
  s.noteHost('claude:child', 'local_a0d5-02bc');
  assert.equal(s.of('claude:child').parent, 'claude:parent');
  s.noteHost('claude:parent', 'local_a0d5-02bc');
  assert.equal(s.of('claude:parent'), null, 'never its own parent');
  const back = new StartedBy(JSON.parse(JSON.stringify(s)));
  assert.equal(back.of('claude:child').parent, 'claude:parent', 'survives a restart');
  s.prune(T + 15 * 24 * 60 * 60 * 1000);
  assert.equal(s.of('claude:child'), null, 'forgotten in time');
});

test('a link from any tool, by any name', () => {
  assert.deepEqual(parseParty('grok:chat-7'), { scheme: 'grok', id: 'chat-7' });
  assert.equal(parseParty('nocolon'), null);
  const s = new StartedBy();
  s.noteLink('grok:a', 'grok:b', T);
  assert.equal(s.of('grok:b').parent, 'grok:a');
  s.noteLink('grok:c', 'grok:b', T - 1);
  assert.equal(s.of('grok:b').parent, 'grok:a', 'an older word does not win');
});

