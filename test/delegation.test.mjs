// Who gave the work (N1, N3, N5): a worker started from inside another vendor's chat (the process tree recorded live on
// 2026-10-30: ChatGPT/Codex app -> `codex app-server` -> a coordination tool -> `claude -p`), who its asks and its
// finish are for, how long it stays, and which project a worker that changed folder belongs to. Synthetic process
// tables and temp folders only; nothing under ~/.claude, ~/.codex or ~/.ai-office is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { createLinkLoader } from '../server/links/index.js';
import { createProcessReader, parsePs, inferDelegations, hostOf, interactiveShell } from '../server/links/process.js';
import { LinkResolver } from '../server/links/resolve.js';
import { buildSnapshot } from '../server/model.js';
import { Journal, digest, summarizeDay } from '../server/journal.js';
import { startingCwd } from '../server/collectors/claude.js';

const SEC = 1000, MIN = 60 * SEC;
const T = s => Date.parse(`Fri Oct 30 ${s} 2026`);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `ai-office-${prefix}-`));

// the chain seen live (commands shortened; the shapes are the real ones)
const PS = `  PID  PPID STARTED                  COMMAND
    1     0 Fri Oct 30 15:00:00 2026 /sbin/launchd
22223     1 Fri Oct 30 15:18:35 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
22271 22223 Fri Oct 30 15:18:37 2026 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled
45637 22271 Fri Oct 30 22:47:26 2026 /opt/homebrew/Cellar/python@3.13/3.13.4/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python -B server.py --config projects/some-project.json
46309 45637 Fri Oct 30 22:50:10 2026 claude -p --output-format stream-json
  500     1 Fri Oct 30 15:00:01 2026 /Applications/Cursor.app/Contents/MacOS/Cursor
  501   500 Fri Oct 30 15:00:02 2026 /bin/zsh -il
  502   501 Fri Oct 30 22:00:00 2026 claude
  600 22271 Fri Oct 30 22:40:00 2026 /bin/zsh -lc claude -p "review"
  601   600 Fri Oct 30 22:40:01 2026 claude -p review
`;
const SORA = 'codex:01a14593-5957-7412-ae03-d55f23724fc3', SUZU = 'claude:0e6ead3e-a357-4ca8-bbee-1ef5b3526a83';
const GUARD = 'codex:01a18d48-0000-4000-8000-000000000001';

function agent(id, extra = {}) {
  const vendor = id.split(':')[0];
  return { id, vendor, kind: 'cli', host: vendor, task: id, cwd: '/Users/me/Projects/some-project', project: 'some-project', model: null, branch: null,
    startedAt: null, alive: true, status: 'working', statusAt: T('22:48:00'), lastActivityAt: T('22:50:00'), thought: null, parentId: null, waiting: false, events: [], pid: null, ...extra };
}

test('host: the first vendor host above a process, not through another agent or a person\'s terminal', () => {
  const table = parsePs(PS);
  assert.deepEqual(hostOf(46309, table), { vendor: 'codex', pid: 22271 }, 'claude -p under the tool under codex app-server');
  assert.deepEqual(hostOf(601, table), { vendor: 'codex', pid: 22271 }, 'a tool shell (`zsh -lc`) is not a person');
  assert.equal(hostOf(502, table), null, 'claude typed in Cursor\'s own terminal: a person started it');
  assert.equal(hostOf(46309, table, new Map([[45637, 'claude:x']])), null, 'another agent in between: its own launch link covers it');
  assert.equal(interactiveShell('-zsh'), true);
  assert.equal(interactiveShell('/bin/zsh -il'), true);
  assert.equal(interactiveShell('/bin/bash -lc "claude -p"'), false);
  assert.equal(interactiveShell('node server.js'), false);
});

test('inferred delegation: exactly one lead of the host vendor at work in the same project', () => {
  const table = parsePs(PS);
  const suzu = agent(SUZU, { pid: 46309 });
  const sora = agent(SORA);
  const guardian = agent(GUARD, { kind: 'guardian', parentId: SORA });
  assert.deepEqual(inferDelegations(table, [suzu, sora, guardian]).map(d => [d.from, d.to, d.hostPid]), [[SORA, SUZU, 22271]],
    'the lead, not its Guardian (a helper never counts as the one who gave the work)');
  const other = agent('codex:other', {});
  assert.deepEqual(inferDelegations(table, [suzu, sora, other]), [], 'two Codex chats at work in the project: ambiguous, no guess');
  assert.deepEqual(inferDelegations(table, [suzu, sora, agent('codex:elsewhere', { project: 'AI-Office', cwd: '/x/AI-Office' })]).length, 1, 'another project does not count');
  const asleep = agent(SORA, { status: 'idle', lastActivityAt: T('22:30:00') });
  assert.deepEqual(inferDelegations(table, [suzu, asleep]), [], 'a chat idle long before the worker started did not start it');
  const justDone = agent(SORA, { status: 'idle', lastActivityAt: T('22:49:30') });
  assert.equal(inferDelegations(table, [suzu, justDone]).length, 1, 'a chat active moments before the start still counts');
  assert.deepEqual(inferDelegations(table, [agent(SUZU, { pid: 46309, parentId: 'claude:lead' }), sora]), [], 'an agent with a parent already has its giver');
});

test('process reader: the inferred launch, remembered across resumed jobs and after the process ends', async () => {
  const reg = tmp('registry');
  let ps = PS;
  const r = createProcessReader({ ps: async () => ps, everyMs: 0, registryDir: reg, cwdOf: async () => null });
  const read = async (now, agents) => { const ctx = { agents, links: [], pidMap: new Map(), pidWeak: new Set() }; const links = await r.read(now, ctx); return { links, ctx }; };
  const sora = agent(SORA);
  let { links, ctx } = await read(T('22:50:12'), [agent(SUZU, { pid: 46309 }), sora]);
  const l = links.find(x => x.id.startsWith('process:host:'));
  assert.deepEqual([l.kind, l.from, l.to, l.confidence, l.channel, l.at], ['launch', SORA, SUZU, 'inferred', 'process', T('22:50:10')]);
  assert.deepEqual(ctx.delegations.get(SUZU), { from: SORA, confidence: 'inferred', at: T('22:50:10') });
  // the job ends (no pid, process gone) while another Codex chat comes in: the relation stays, no new launch link
  ps = PS.replace(/^46309 .*\n/m, '');
  ({ links, ctx } = await read(T('22:55:30'), [agent(SUZU, { pid: null }), sora, agent('codex:other')]));
  assert.equal(links.filter(x => x.id.startsWith('process:host:')).length, 0);
  assert.equal(ctx.delegations.get(SUZU)?.from, SORA);
  // resumed in a new process: a new launch (a new job), the same giver
  ps = PS.replace('46309 45637 Fri Oct 30 22:50:10', '47184 45637 Fri Oct 30 22:56:20');
  ({ links, ctx } = await read(T('22:56:25'), [agent(SUZU, { pid: 47184 }), sora]));
  assert.deepEqual(links.filter(x => x.id.startsWith('process:host:')).map(x => [x.id, x.at]), [['process:host:22271:47184', T('22:56:20')]]);
  // the giver leaves: forgotten
  ({ ctx } = await read(T('23:30:00'), [agent(SUZU, { pid: 47184 })]));
  assert.equal(ctx.delegations.has(SUZU), false);
});

test('process reader: a new agent whose process the last ps missed gets ps run at once, once', async () => {
  const reg = tmp('registry');
  let calls = 0, ps = PS.replace(/^46309 .*\n/m, '');
  const r = createProcessReader({ ps: async () => { calls++; return ps; }, everyMs: 10 * SEC, registryDir: reg, cwdOf: async () => null });
  const read = async (now, agents) => { const ctx = { agents, links: [], pidMap: new Map(), pidWeak: new Set() }; await r.read(now, ctx); return ctx; };
  await read(T('22:50:00'), [agent(SORA)]);
  assert.equal(calls, 1);
  ps = PS;                                                   // the job starts between two ps runs
  const ctx = await read(T('22:50:12') - 8 * SEC, [agent(SUZU, { pid: 46309 }), agent(SORA)]);
  assert.equal(calls, 2, 'not 10 s later: as soon as the worker shows up');
  assert.equal(ctx.delegations.get(SUZU)?.from, SORA, 'its giver is known as it walks in');
  const gone = agent('claude:gone', { pid: 99999 });            // a pid ps never shows (the process already ended)
  await read(T('22:50:12') - 6 * SEC, [agent(SUZU, { pid: 46309 }), agent(SORA), gone]);
  await read(T('22:50:12') - 4 * SEC, [agent(SUZU, { pid: 46309 }), agent(SORA), gone]);
  assert.equal(calls, 3, 'run once for it, not on every poll');
});

test('snapshot: asks and finishes go to the one who gave the work; an unanswered ask becomes the person\'s', async () => {
  const fake = (t, ctx) => { ctx.delegations = new Map([[SUZU, { from: SORA, confidence: 'inferred', at: t0 }]]); return []; };
  const loader = createLinkLoader({ readers: [{ name: 'fake', read: fake }], log: () => {}, recovered: () => {} });
  const t0 = T('22:51:00');
  const snap = (now, list) => buildSnapshot(now, { collectors: [['[fake]', async () => list.map(a => ({ ...a }))]], links: loader, resolver: new LinkResolver(), events: new Map() });
  const ask = 'Needs your OK: Running: Scan simulation';
  let s = await snap(t0, [agent(SUZU, { asking: ask, pid: 46309 }), agent(SORA)]);
  let suzu = s.agents.find(a => a.id === SUZU);
  assert.deepEqual(suzu.delegator, { id: SORA, certain: false });
  assert.equal(suzu.askTo, SORA, 'the hand goes up for Sora');
  assert.equal(suzu.parentId, null, 'an inferred link adopts nobody');
  assert.equal(s.agents.find(a => a.id === SORA).delegator, null);
  s = await snap(t0 + 2 * CONFIG.askEscalateMs, [agent(SUZU, { asking: ask, pid: 46309 }), agent(SORA)]);
  assert.equal(s.agents.find(a => a.id === SUZU).askTo, SORA, 'open long, but Sora is still at work: still Sora\'s (seen live: answered after 6 min)');
  const stop = t0 + 3 * CONFIG.askEscalateMs;
  const soraIdle = agent(SORA, { status: 'idle', statusAt: stop, lastActivityAt: stop });
  s = await snap(stop, [agent(SUZU, { asking: ask, pid: 46309 }), soraIdle]);
  s = await snap(stop + CONFIG.askEscalateMs - SEC, [agent(SUZU, { asking: ask, pid: 46309 }), soraIdle]);
  assert.equal(s.agents.find(a => a.id === SUZU).askTo, SORA, 'Sora just stopped: a short pause between its turns');
  s = await snap(stop + CONFIG.askEscalateMs + SEC, [agent(SUZU, { asking: ask, pid: 46309 }), soraIdle]);
  assert.equal(s.agents.find(a => a.id === SUZU).askTo, null, 'Sora stopped and did not answer: the person is told');
  s = await snap(stop + CONFIG.askEscalateMs + 2 * SEC, [agent(SUZU, { asking: 'Needs your OK: next', pid: 46309 }), agent(SORA, { asking: 'Question for you: which?' })]);
  assert.equal(s.agents.find(a => a.id === SUZU).askTo, null, 'the giver is itself waiting on the person: the chain ends there');
  // finished: idle, and gone after the helper timer rather than a person's break
  const idleAt = t0 + 10 * MIN;
  await snap(idleAt, [agent(SUZU, { status: 'idle', statusAt: idleAt, pid: null }), agent(SORA)]);
  s = await snap(idleAt + CONFIG.helperLeaveAfterIdleMs + SEC, [agent(SUZU, { status: 'idle', statusAt: idleAt, pid: null }), agent(SORA)]);
  assert.equal(s.agents.some(a => a.id === SUZU), false, 'handed back: it goes like a helper');
});

test('journal: an ask to an agent and a delegated finish are not the person\'s', () => {
  const dir = tmp('journal');
  const j = new Journal({ dir, timeZone: 'Asia/Hong_Kong', log: { error() {} } });
  const base = { vendor: 'claude', kind: 'cli', project: 'some-project', task: 'review', parentId: null, role: 'member' };
  const t0 = Date.parse('2026-10-30T22:50:00+08:00'); // not T(), which reads the machine's own zone: the journal's day is Hong Kong's here
  const step = (t, agents) => j.record({ now: t, agents, events: [] });
  const suzu = (extra = {}) => ({ id: SUZU, ...base, status: 'working', delegator: { id: SORA, certain: false }, ...extra });
  step(t0, [suzu()]);
  step(t0 + 10 * SEC, [suzu({ asking: 'Needs your OK: x', askTo: SORA })]);
  step(t0 + 4 * MIN, [suzu({ asking: 'Needs your OK: x', askTo: null })]); // escalated: now the person's
  step(t0 + 5 * MIN, [suzu()]);
  step(t0 + 10 * MIN, [suzu({ status: 'idle', idleSince: t0 + 10 * MIN })]);
  const entries = fs.readFileSync(path.join(dir, '2026-10-30.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const asks = entries.filter(e => e.kind === 'asking-start');
  assert.deepEqual(asks.map(e => e.askTo || null), [SORA, null]);
  const d = digest('2026-10-30', entries);
  assert.equal(d.stats.askedYou, 1, 'only the escalated ask was the person\'s');
  assert.equal(d.stats.finished, 0, 'its finish was Sora\'s turn');
  assert.ok(entries.every(e => e.delegatedBy === SORA));
  const sum = summarizeDay('2026-10-30', entries, { end: t0 + 11 * MIN, timeZone: 'Asia/Hong_Kong' });
  assert.equal(sum.askMs, 1 * MIN, 'waiting on you: only from the escalation to the answer');
});

test('collector: a worker that changed folder still belongs to the project it started in', () => {
  const folder = '-Users-me-Projects-some-project';
  assert.equal(startingCwd('/Users/me/Projects/some-project/outputs/run-1/claude-workspace', folder), '/Users/me/Projects/some-project');
  assert.equal(startingCwd('/Users/me/Projects/some-project', folder), '/Users/me/Projects/some-project');
  assert.equal(startingCwd('/somewhere/else', folder), '/somewhere/else', 'no matching ancestor: unchanged');
  assert.equal(startingCwd(null, folder), null);
});
