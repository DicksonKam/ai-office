// Codex rollout parsing: questions to the user, sync and async (the desktop app's "Question" card); turn markers far
// before the tail of a long turn; and, through collectCodex (a fixture state DB + rollouts in a temp folder) and the
// model, a lead waiting on its helpers, helper threads that persist between turns, and the Guardian's review hold.
// Nothing under ~/.codex is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../server/config.js';
import { extractFromLines, askingFor, rolloutInfo, collectCodex } from '../server/collectors/codex.js';
import { buildSnapshot } from '../server/model.js';
import { createLinkLoader } from '../server/links/index.js';
import { LinkResolver } from '../server/links/resolve.js';

const SEC = 1000, MIN = 60 * SEC;
let n = 0;
const t0 = Date.now() - 120000;
const line = (dt, type, payload) => ({ timestamp: new Date(t0 + dt).toISOString(), type, payload });
const started = line(0, 'event_msg', { type: 'task_started', started_at: t0 / 1000 });
const asyncQ = line(1000, 'response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call_q',
  arguments: JSON.stringify({ questions: [{ title: 'Deploy to staging now?', options: ['Feedback only', 'Deduct 10'] }] }) });
const laterCall = line(5000, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call_x', input: 'text(1)' });
const laterOut = line(6000, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_x', output: 'ok' });
const reply = line(20000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text',
  text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_q\\",0]","answer":"Feedback only"}]\n</send_user_message_question_reply>' }] });
const newPrompt = line(20000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Never mind, check the next one.' }] });
const now = t0 + 60000;

test('an async question stays open while the turn carries on with other calls', () => {
  const info = extractFromLines([started, asyncQ, laterCall, laterOut]);
  assert.equal(askingFor(info, now), 'Question for you: Deploy to staging now?');
});

test('a reply to the question (a user line) closes it', () => {
  const info = extractFromLines([started, asyncQ, laterCall, laterOut, reply]);
  assert.equal(askingFor(info, now), null);
});

test('a new prompt after the question supersedes it', () => {
  const info = extractFromLines([started, asyncQ, laterCall, laterOut, newPrompt]);
  assert.equal(askingFor(info, now), null);
});

test('a question asked after the reply is open again', () => {
  const again = line(30000, 'response_item', { ...asyncQ.payload, call_id: 'call_q2', arguments: JSON.stringify({ questions: [{ title: 'And this one?' }] }) });
  const info = extractFromLines([started, asyncQ, reply, again, laterCall, laterOut]);
  assert.equal(askingFor(info, now), 'Question for you: And this one?');
});

test('a sync question with no output is open while it is the newest call', () => {
  const syncQ = line(1000, 'response_item', { type: 'function_call', name: 'request_user_input', call_id: 'call_s',
    arguments: JSON.stringify({ questions: [{ question: 'Which branch?' }] }) });
  assert.equal(askingFor(extractFromLines([started, syncQ]), now), 'Question for you: Which branch?');
  const answered = line(2000, 'response_item', { type: 'function_call_output', call_id: 'call_s', output: 'main' });
  assert.equal(askingFor(extractFromLines([started, syncQ, answered]), now), null);
});

test('no question once the turn is over', () => {
  const done = line(40000, 'event_msg', { type: 'task_complete', completed_at: (t0 + 40000) / 1000 });
  assert.equal(askingFor(extractFromLines([started, asyncQ, done]), now), null);
});

// ---------------------------------------------------------------- turn markers beyond the tail

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-codex-'));
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const pad = (dt, count) => Array.from({ length: count }, (_, i) => line(dt + i, 'response_item', { type: 'function_call_output', call_id: `pad${dt}-${i}`, output: 'x'.repeat(400) }));
const complete = dt => line(dt, 'event_msg', { type: 'task_complete', completed_at: (t0 + dt) / 1000 });
const aborted = dt => line(dt, 'event_msg', { type: 'turn_aborted', reason: 'interrupted', turn_id: 'turn-1' });

test('a turn_aborted ends the turn and marks a helper thread closed', () => {
  const info = extractFromLines([started, laterCall, laterOut, aborted(3000)]);
  assert.equal(info.turn, 'idle');
  assert.equal(info.closed, true);
  assert.equal(extractFromLines([started, laterCall, laterOut]).closed, false);
  assert.equal(extractFromLines([started, aborted(3000), complete(4000)]).closed, false, 'a later task_complete is the newest marker');
});

test('a long turn whose task_started sits far before the tail is a working turn, and stays one as the file grows', async () => {
  const dir = tmp(), f = path.join(dir, 'rollout-long.jsonl');
  const saved = { tail: CONFIG.tailBytes, scan: CONFIG.codex.scanBackBytes };
  CONFIG.tailBytes = 4096; CONFIG.codex.scanBackBytes = 256 * 1024;
  try {
    fs.writeFileSync(f, jsonl([started, ...pad(1000, 60)])); // ~30 KB of tool output after the marker: well past a 4 KB tail
    let info = await rolloutInfo(f, now);
    assert.equal(info.turn, 'working', 'found by the backward scan');
    assert.equal(info.turnAt, t0);
    fs.appendFileSync(f, jsonl(pad(70000, 20))); // the file grows; the new tail has no marker either
    info = await rolloutInfo(f, now + 1500);
    assert.equal(info.turn, 'working', 'carried forward: the file is append-only');
    assert.equal(info.turnAt, t0);
    fs.appendFileSync(f, jsonl([complete(90000), ...pad(91000, 1)]));
    info = await rolloutInfo(f, now + 3000);
    assert.equal(info.turn, 'idle');
    assert.equal(info.turnAt, t0 + 90000);
    // beyond the bounded scan the turn is unknown, not guessed
    const g = path.join(dir, 'rollout-huge.jsonl');
    CONFIG.codex.scanBackBytes = 8192;
    fs.writeFileSync(g, jsonl([started, ...pad(1000, 60)]));
    assert.equal((await rolloutInfo(g, now)).turn, null);
  } finally { CONFIG.tailBytes = saved.tail; CONFIG.codex.scanBackBytes = saved.scan; }
});

// ---------------------------------------------------------------- through the model

/** buildSnapshot over these collectors only (no live readers). */
function snapshotWith(collectors) {
  const loader = createLinkLoader({ readers: [], log: () => {}, recovered: () => {} });
  const resolver = new LinkResolver(), events = new Map();
  return at => buildSnapshot(at, { collectors, links: loader, resolver, events });
}
const fake = agents => [['[fake]', async () => agents.map(a => ({ ...a }))]];
const worker = (id, extra = {}) => ({ id, vendor: id.split(':')[0], kind: 'desktop', host: 'Codex Desktop', task: 't', cwd: '/tmp/x', project: 'x', model: null, branch: null,
  startedAt: null, alive: true, status: 'working', statusAt: Date.now(), lastActivityAt: Date.now(), thought: null, parentId: null, waiting: false, events: [], ...extra });

test('a Codex lead with an open turn, nothing of its own running and helpers at work is waiting on them', async () => {
  const t = Date.now(), L = `codex:lead-${++n}`, H = `codex:helper-${++n}`;
  const lead = extra => worker(L, { turnOpen: true, callOpen: false, ...extra });
  const helper = extra => worker(H, { kind: 'subagent', parentId: L, ...extra });
  const leadOf = async agents => (await snapshotWith(fake(agents))(t)).agents.find(a => a.id === L);
  let a = await leadOf([lead(), helper()]);
  assert.equal(a.waiting, true);
  assert.equal(a.role, 'lead');
  for (const k of ['turnOpen', 'callOpen', 'closed']) assert.equal(k in a, false, `${k} is not a snapshot field`);
  assert.equal((await leadOf([lead({ callOpen: true }), helper()])).waiting, false, 'its own command still runs: working');
  assert.equal((await leadOf([lead(), helper({ status: 'idle', statusAt: t - SEC })])).waiting, false, 'no helper works: working on its own');
  assert.equal((await leadOf([lead({ waiting: true, callOpen: true }), helper()])).waiting, true, 'an open wait_agent call still counts');
});

test('a Codex helper thread stays while its lead is in; it leaves soon after being closed or once the lead is gone', async () => {
  const t = Date.now(), L = `codex:lead-${++n}`, H = `codex:helper-${++n}`, G = `codex:guardian-${++n}`;
  const lead = extra => worker(L, { turnOpen: true, callOpen: false, ...extra });
  const helper = extra => worker(H, { kind: 'subagent', parentId: L, status: 'idle', statusAt: t - 3 * MIN, ...extra });
  const guardian = extra => worker(G, { kind: 'guardian', parentId: L, status: 'idle', statusAt: t - 3 * MIN, ...extra });
  const ids = async agents => (await snapshotWith(fake(agents))(t)).agents.map(a => a.id);
  let present = await ids([lead(), helper(), guardian()]);
  assert.ok(present.includes(H), 'idle 3 min between its turns while the lead is mid-turn: stays');
  assert.ok(present.includes(G), 'the reviewer too');
  // a lead that works in short bursts (a Guardian reviews each escalation) is between turns, not gone: the threads stay
  present = await ids([lead({ turnOpen: false, status: 'idle', statusAt: t - SEC }), helper(), guardian()]);
  assert.ok(present.includes(H) && present.includes(G), 'the lead\'s turn is over but it is still in: both stay (seen live: a Guardian left and came back 10× in an hour)');
  assert.ok(!(await ids([lead(), helper({ closed: true })])).includes(H), 'closed by its lead (turn_aborted): leaves');
  assert.ok(!(await ids([helper()])).includes(H), 'no lead reported at all: leaves');
  // a Claude helper keeps the short break regardless
  const C = `claude:lead-${++n}`;
  assert.ok(!(await ids([worker(C, { vendor: 'claude' }), worker(`${C}/h1`, { vendor: 'claude', kind: 'subagent', parentId: C, status: 'idle', statusAt: t - 3 * MIN })])).includes(`${C}/h1`));
});

// ---------------------------------------------------------------- through collectCodex: a fixture state DB and rollouts

function stateDb(dir, rows) {
  const file = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT, model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '', name TEXT, originator TEXT)`);
  const ins = db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, agent_nickname, thread_source, created_at_ms, updated_at_ms, originator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.id, r.rollout_path, Math.floor(r.created_at_ms / 1000), Math.floor(r.updated_at_ms / 1000), r.source, '/tmp/ai-office-fixture-project', r.title || '', r.agent_nickname ?? null, r.thread_source ?? null, r.created_at_ms, r.updated_at_ms, 'Codex Desktop');
  db.close();
  return file;
}

test('collectCodex: a lead mid long turn, its reviewer held after a 2 s review, a helper closed by the lead', async () => {
  const dir = tmp(), at = Date.now();
  const rollout = (name, lines) => { const f = path.join(dir, `rollout-${name}.jsonl`); fs.writeFileSync(f, jsonl(lines)); return f; };
  const ev = (t, payload) => ({ timestamp: new Date(t).toISOString(), type: 'event_msg', payload });
  const padAt = (t, count) => Array.from({ length: count }, (_, i) => ({ timestamp: new Date(t + i).toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: `p${t}-${i}`, output: 'x'.repeat(400) } }));
  const spawnSource = p => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'lead1', depth: 1, agent_nickname: p, agent_path: `/root/${p.toLowerCase()}` } } });
  const rows = [
    // the lead: task_started 30 min ago, then ~30 KB of tool output (past a 4 KB tail), last written 20 s ago
    { id: 'lead1', thread_source: 'user', source: 'vscode', title: 'Build the importer', created_at_ms: at - 2 * 3600 * SEC, updated_at_ms: at - 20 * SEC,
      rollout_path: rollout('lead', [ev(at - 30 * MIN, { type: 'task_started', started_at: (at - 30 * MIN) / 1000 }), ...padAt(at - 29 * MIN, 60), ...padAt(at - 20 * SEC, 1)]) },
    // the Guardian: a 2 s review that ended 3 s ago
    { id: 'guard1', thread_source: 'guardian_review', source: '{"subagent":{"other":"guardian"}}', title: 'Guardian review', created_at_ms: at - 10 * MIN, updated_at_ms: at - 3 * SEC,
      rollout_path: rollout('guardian', [ev(at - 5 * SEC, { type: 'task_started', started_at: (at - 5 * SEC) / 1000 }), ev(at - 3 * SEC, { type: 'task_complete', completed_at: (at - 3 * SEC) / 1000 })]) },
    // Euler: closed by the lead 50 s ago (turn_aborted); Gauss: mid-turn
    { id: 'euler1', thread_source: 'subagent', source: spawnSource('Euler'), agent_nickname: 'Euler', created_at_ms: at - 20 * MIN, updated_at_ms: at - 50 * SEC,
      rollout_path: rollout('euler', [ev(at - 5 * MIN, { type: 'task_started', started_at: (at - 5 * MIN) / 1000 }), ev(at - 50 * SEC, { type: 'turn_aborted', reason: 'interrupted' })]) },
    { id: 'gauss1', thread_source: 'subagent', source: spawnSource('Gauss'), agent_nickname: 'Gauss', created_at_ms: at - 20 * MIN, updated_at_ms: at - 5 * SEC,
      rollout_path: rollout('gauss', [ev(at - 2 * MIN, { type: 'task_started', started_at: (at - 2 * MIN) / 1000 }), ...padAt(at - 5 * SEC, 1)]) },
  ];
  CONFIG.codex.stateDb = stateDb(dir, rows);
  const saved = CONFIG.tailBytes;
  CONFIG.tailBytes = 4096;
  try {
    const agents = await collectCodex(at);
    const by = id => agents.find(a => a.id === `codex:${id}`);
    assert.equal(by('lead1').status, 'working', 'the marker 30 KB back still counts');
    assert.equal(by('lead1').turnOpen, true);
    assert.equal(by('lead1').callOpen, false);
    assert.equal(by('guard1').status, 'working', 'held after the review');
    assert.equal(by('guard1').parentId, 'codex:lead1');
    assert.equal(by('euler1').status, 'idle');
    assert.equal(by('euler1').closed, true);
    assert.equal(by('gauss1').status, 'working');

    const later = await collectCodex(at + 15 * SEC);
    assert.equal(later.find(a => a.id === 'codex:guard1').status, 'idle', 'the hold is over');
    assert.equal(later.find(a => a.id === 'codex:lead1').status, 'working', 'carried forward on an unchanged file');

    // through the model: the lead waits on Gauss; Euler is still on its short break, then gone; the lead stays
    const run = snapshotWith([['[codex]', collectCodex]]);
    let snap = await run(at);
    const lead = snap.agents.find(a => a.id === 'codex:lead1');
    assert.equal(lead.waiting, true);
    assert.equal(lead.role, 'lead');
    assert.ok(snap.agents.some(a => a.id === 'codex:euler1'), 'closed 50 s ago: still on its 90 s break');
    assert.equal(snap.teams.find(t => t.id === 'codex:lead1').reviewers.length, 1);
    snap = await run(at + 50 * SEC);
    assert.ok(!snap.agents.some(a => a.id === 'codex:euler1'), 'closed 100 s ago: left');
    assert.ok(snap.agents.some(a => a.id === 'codex:lead1'));
    assert.ok(snap.agents.some(a => a.id === 'codex:gauss1'));
  } finally { CONFIG.tailBytes = saved; }
});
