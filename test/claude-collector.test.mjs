// Claude collector against synthetic transcripts: helpers survive long model replies, finish as soon as they hand back
// (meta.json finished / SubagentHandback, with the report as an event), keep their brief, and a lead whose turn is over
// waits on working helpers or is idle. Fixtures live in a fresh temp folder per test; nothing under ~/.claude is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { collectClaude } from '../server/collectors/claude.js';
import { trackIdle, buildSnapshot } from '../server/model.js';
import { createLinkLoader } from '../server/links/index.js';
import { LinkResolver } from '../server/links/resolve.js';

const SEC = 1000, MIN = 60 * SEC;
let n = 0;

/** A fresh ~/.claude look-alike; the collector is pointed at it. */
function office() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-claude-'));
  const sessionsDir = path.join(root, 'sessions'), projectsDir = path.join(root, 'projects');
  fs.mkdirSync(sessionsDir, { recursive: true }); fs.mkdirSync(projectsDir, { recursive: true });
  CONFIG.claude.sessionsDir = sessionsDir; CONFIG.claude.projectsDir = projectsDir;
  return { root, sessionsDir, projectsDir };
}

const iso = t => new Date(t).toISOString();
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

// transcript line builders
const base = (t, sessionId, cwd) => ({ timestamp: iso(t), sessionId, cwd, entrypoint: 'claude-desktop', uuid: `u${++n}` });
const prompt = (t, s, cwd, text, extra = {}) => ({ ...base(t, s, cwd), type: 'user', message: { role: 'user', content: text }, ...extra });
const toolUse = (t, s, cwd, name, input, id = `toolu_${++n}`) => ({ ...base(t, s, cwd), type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (t, s, cwd, id, extra = {}) => ({ ...base(t, s, cwd), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra });
const say = (t, s, cwd, text, stop = 'end_turn') => ({ ...base(t, s, cwd), type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'text', text }] } });
const apiRequest = (t, s) => ({ type: 'api-request', sessionId: s, id: `req${++n}`, timestamp: iso(t) });
const stopHook = (t, s, cwd) => ({ ...base(t, s, cwd), type: 'system', subtype: 'stop_hook_summary', hookCount: 1 });

const CWD = '/tmp/ai-office-fixture-project';
const slug = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** A lead session (registered when `registry` is given) with helpers. Returns paths and ids. */
function lead(o, { sessionId = `sess-${++n}`, lines, registry } = {}) {
  const dir = path.join(o.projectsDir, slug(CWD));
  const transcript = path.join(dir, `${sessionId}.jsonl`);
  write(transcript, jsonl(lines(sessionId)));
  if (registry) write(path.join(o.sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd: CWD, entrypoint: 'claude-desktop', ...registry }));
  return { sessionId, id: `claude:${sessionId}`, subDir: path.join(dir, sessionId, 'subagents') };
}
function helper(l, agentId, lines, meta) {
  write(path.join(l.subDir, `agent-${agentId}.jsonl`), jsonl(lines(l.sessionId)));
  if (meta) write(path.join(l.subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  return `${l.id}/${agentId}`;
}
const recentLead = now => s => [prompt(now - 2 * MIN, s, CWD, 'Fix the office'), toolUse(now - 90 * SEC, s, CWD, 'Agent', { description: 'Builder' })];

test('a helper waiting minutes on a long model reply stays working', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, { lines: recentLead(now) });
  const id = helper(l, 'a1', s => [
    prompt(now - 9 * MIN, s, CWD, 'Build the thing'),
    toolUse(now - 5 * MIN - 2 * SEC, s, CWD, 'Bash', { description: 'Run tests' }, 'toolu_bash'),
    toolResult(now - 5 * MIN - SEC, s, CWD, 'toolu_bash'),
    apiRequest(now - 5 * MIN, s), // the request went out 5 min ago; the reply is still being written
  ]);
  const a = (await collectClaude(now)).find(x => x.id === id);
  assert.ok(a, 'helper is reported');
  assert.equal(a.status, 'working');
  assert.equal(a.finished, false);

  const later = (await collectClaude(now + 6 * MIN)).find(x => x.id === id); // 11 min without a reply: abandoned
  assert.equal(later?.status, 'idle');
});

test('working -> idle starts the break now, not at the stale last activity', () => {
  const now = Date.now(), id = `t-${++n}`;
  assert.equal(trackIdle({ id, status: 'working', statusAt: now - 4 * MIN }, now - 2 * SEC), null);
  assert.equal(trackIdle({ id, status: 'idle', statusAt: now - 4 * MIN }, now), now);
  assert.equal(trackIdle({ id, status: 'idle', statusAt: now - 4 * MIN }, now + 5 * SEC), now, 'stays at the transition');
  const fresh = `t-${++n}`; // first seen idle: idle since its statusAt
  assert.equal(trackIdle({ id: fresh, status: 'idle', statusAt: now - 4 * MIN }, now), now - 4 * MIN);
});

test('meta.json finished marks the helper finished at once', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, { lines: recentLead(now) });
  const id = helper(l, 'a2', s => [
    prompt(now - 3 * MIN, s, CWD, 'Audit it'),
    toolUse(now - 10 * SEC, s, CWD, 'Bash', { description: 'Last check' }, 'toolu_x'),
    toolResult(now - 9 * SEC, s, CWD, 'toolu_x'),
    say(now - 5 * SEC, s, CWD, 'All done here.'),
  ], { agentType: 'general-purpose', description: 'Audit builder', finished: true });
  const a = (await collectClaude(now)).find(x => x.id === id);
  assert.equal(a.status, 'idle', 'not left working for the 40 s idle timer');
  assert.equal(a.finished, true);
  assert.ok(a.statusAt <= now);
});

test('a SubagentHandback call finishes the helper and carries its report', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, { lines: recentLead(now) });
  const id = helper(l, 'a3', s => [
    prompt(now - 4 * MIN, s, CWD, 'Fix five bugs'),
    toolUse(now - 3 * SEC, s, CWD, 'SubagentHandback', { message: '## Q2 report\nAll five bugs fixed, tests pass.' }, 'toolu_hb'),
  ], { description: 'Q2 fixes builder' }); // meta not rewritten yet
  const a = (await collectClaude(now)).find(x => x.id === id);
  assert.equal(a.status, 'idle');
  assert.equal(a.finished, true);
  assert.equal(a.thought.text, 'Handing in the report');
  const report = a.events.find(e => e.kind === 'report');
  assert.ok(report, 'report event emitted');
  assert.equal(report.id, 'claude-report:a3:toolu_hb');
  assert.equal(report.from, id);
  assert.equal(report.to, l.id);
  assert.match(report.text, /Q2 report All five bugs fixed/);

  // a reply after the hand-back (a late notification) does not add a second report
  helper(l, 'a3', s => [
    prompt(now - 4 * MIN, s, CWD, 'Fix five bugs'),
    toolUse(now - 3 * SEC, s, CWD, 'SubagentHandback', { message: '## Q2 report\nAll five bugs fixed, tests pass.' }, 'toolu_hb'),
    toolResult(now - 2 * SEC, s, CWD, 'toolu_hb'),
    say(now - SEC, s, CWD, 'The background job stopped as planned.'),
  ]);
  const b = (await collectClaude(now + 1)).find(x => x.id === id);
  assert.equal(b.finished, true);
  assert.deepEqual(b.events.filter(e => e.kind === 'report').map(e => e.id), ['claude-report:a3:toolu_hb']);
});

test('the brief comes from meta.json and survives it changing; image placeholders are never a brief', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, { lines: recentLead(now) }); // no Agent tool result in the lead's tail
  const id = helper(l, 'a4', s => [
    prompt(now - 60 * SEC, s, CWD, '[Image: original 2426x294, displayed at 2000x242. Multiply coordinates by 1.21 to map to original image.]', { isMeta: true }),
    prompt(now - 50 * SEC, s, CWD, '[Image: original 800x600, displayed at 800x600.]'),
    toolUse(now - 5 * SEC, s, CWD, 'Read', { file_path: '/x/a.js' }),
  ], { description: 'Q2 live accuracy fixes builder' });
  let a = (await collectClaude(now)).find(x => x.id === id);
  assert.equal(a.task, 'Helper: Q2 live accuracy fixes builder');

  write(path.join(l.subDir, 'agent-a4.meta.json'), JSON.stringify({ agentType: 'general-purpose', finishedSoon: true }));
  a = (await collectClaude(now + SEC)).find(x => x.id === id);
  assert.equal(a.task, 'Helper: Q2 live accuracy fixes builder', 'remembered for the process lifetime');

  const id2 = helper(l, 'a5', s => [ // no meta, no brief in the tail: only placeholders
    prompt(now - 60 * SEC, s, CWD, '[Image: original 2426x294, displayed at 2000x242.]', { isMeta: true }),
    prompt(now - 50 * SEC, s, CWD, '[Image: original 800x600, displayed at 800x600.]'),
  ]);
  const b = (await collectClaude(now + 2 * SEC)).find(x => x.id === id2);
  assert.equal(b.task, 'Helper');
  assert.doesNotMatch(b.thought?.text || '', /\[Image/);
});

test('a lead whose turn is over waits on working helpers, and is idle once none works (registry says busy)', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, {
    registry: { status: 'busy', statusUpdatedAt: now - 3 * 3600 * SEC, startedAt: now - 4 * 3600 * SEC },
    lines: s => [
      prompt(now - 3 * MIN, s, CWD, 'Fix the office'),
      toolUse(now - 150 * SEC, s, CWD, 'Agent', { description: 'Builder', run_in_background: true }, 'toolu_agent'),
      toolResult(now - 149 * SEC, s, CWD, 'toolu_agent', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'b1', description: 'Builder', resolvedModel: 'claude-opus-5-5' } }),
      say(now - 140 * SEC, s, CWD, 'The builder is on it.'),
      stopHook(now - 139 * SEC, s, CWD),
    ],
  });
  const hid = helper(l, 'b1', s => [
    prompt(now - 148 * SEC, s, CWD, 'Build it'),
    toolUse(now - 4 * SEC, s, CWD, 'Edit', { file_path: '/x/claude.js' }),
  ]);
  let agents = await collectClaude(now);
  let leadA = agents.find(x => x.id === l.id), h = agents.find(x => x.id === hid);
  assert.equal(h.status, 'working');
  assert.equal(h.task, 'Helper: Builder');
  assert.equal(leadA.status, 'working');
  assert.equal(leadA.waiting, true, 'waiting on its helpers');

  // the helper hands back: nobody works any more -> the lead is idle (your turn), whatever the registry says
  helper(l, 'b1', s => [
    prompt(now - 148 * SEC, s, CWD, 'Build it'),
    toolUse(now - 4 * SEC, s, CWD, 'Edit', { file_path: '/x/claude.js' }, 'toolu_e'),
    toolResult(now - 3 * SEC, s, CWD, 'toolu_e'),
    toolUse(now - SEC, s, CWD, 'SubagentHandback', { message: 'Done.' }, 'toolu_hb2'),
  ]);
  agents = await collectClaude(now + SEC);
  leadA = agents.find(x => x.id === l.id); h = agents.find(x => x.id === hid);
  assert.equal(h.status, 'idle');
  assert.equal(leadA.status, 'idle');
  assert.equal(leadA.waiting, false);
  assert.equal(leadA.statusAt, now - 139 * SEC, 'idle since its turn ended');
});

test('a lead genuinely mid-turn stays working', async () => {
  const o = office(), now = Date.now();
  const l = lead(o, {
    registry: { status: 'busy', statusUpdatedAt: now - 10 * MIN },
    lines: s => [
      prompt(now - 3 * MIN, s, CWD, 'Run the suite'),
      say(now - 2 * MIN, s, CWD, 'Running it now.', 'tool_use'),
      toolUse(now - 2 * MIN, s, CWD, 'Bash', { description: 'Long test suite' }), // still running
    ],
  });
  let leadA = (await collectClaude(now)).find(x => x.id === l.id);
  assert.equal(leadA.status, 'working');
  assert.equal(leadA.waiting, false);

  // a prompt handed to the model, reply pending
  const l2 = lead(o, {
    sessionId: 'sess-mid-2',
    lines: s => [say(now - 5 * MIN, s, CWD, 'Earlier answer.'), stopHook(now - 5 * MIN, s, CWD), prompt(now - 20 * SEC, s, CWD, 'And now this')],
  });
  leadA = (await collectClaude(now)).find(x => x.id === l2.id);
  assert.equal(leadA.status, 'working');
});

// ---------------------------------------------------------------- through the model: admission and labels

/** buildSnapshot over these collectors only (no live readers). */
function snapshotWith(collectors) {
  const loader = createLinkLoader({ readers: [], log: () => {}, recovered: () => {} });
  const resolver = new LinkResolver(), events = new Map();
  return now => buildSnapshot(now, { collectors, links: loader, resolver, events });
}
const fake = agents => [['[fake]', async () => agents.map(a => ({ ...a }))]];
const worker = (id, extra = {}) => ({ id, vendor: 'claude', kind: 'desktop', host: 'Claude Desktop', task: 't', cwd: CWD, project: 'p', model: null, branch: null,
  startedAt: null, alive: true, status: 'working', statusAt: Date.now(), lastActivityAt: Date.now(), thought: null, parentId: null, waiting: false, events: [], ...extra });

test('a registry-only session idle for almost its whole break is not admitted for one poll (no phantom arrival)', async () => {
  const o = office(), now = Date.now();
  const reg = (name, sid, statusUpdatedAt) => write(path.join(o.sessionsDir, `${name}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: CWD, entrypoint: 'claude-desktop', status: 'idle', statusUpdatedAt, startedAt: statusUpdatedAt - MIN }));
  reg('p1', 'phantom-1', now - (CONFIG.leaveAfterIdleMs - 10 * SEC)); // 10 s of break left: would walk in and straight out
  reg('p2', 'fresh-2', now - MIN);                                    // 5 min left: a real break
  const reported = await collectClaude(now);
  assert.equal(reported.find(a => a.id === 'claude:phantom-1')?.status, 'idle', 'the collector still reports it');
  const run = snapshotWith([['[claude]', collectClaude]]);
  const ids = (await run(now)).agents.map(a => a.id);
  assert.ok(!ids.includes('claude:phantom-1'), 'not shown: it would leave within seconds');
  assert.ok(ids.includes('claude:fresh-2'));
  assert.ok(!(await run(now + 20 * SEC)).agents.some(a => a.id === 'claude:phantom-1'), 'and not later either');
});

test('a worker that went idle while in keeps its break to the end (the admission guard is only for first sight)', async () => {
  const id = `claude:break-${++n}`, t = Date.now();
  await snapshotWith(fake([worker(id)]))(t);
  const idle = snapshotWith(fake([worker(id, { status: 'idle', statusAt: t + SEC })]));
  await idle(t + 2 * SEC); // the break starts at this poll (working -> idle), not at the stale statusAt
  assert.ok((await idle(t + 2 * SEC + CONFIG.leaveAfterIdleMs - 5 * SEC)).agents.some(a => a.id === id), 'still in with 5 s left');
  assert.ok(!(await idle(t + 2 * SEC + CONFIG.leaveAfterIdleMs + 5 * SEC)).agents.some(a => a.id === id), 'gone after the break');
});

test('a session keeps its title when the leaving path only knows its first prompt', async () => {
  const id = `claude:label-${++n}`, t = Date.now();
  const taskOf = async (task, taskRank) => (await snapshotWith(fake([worker(id, { task, taskRank })]))(t)).agents.find(a => a.id === id).task;
  assert.equal(await taskOf('ai-office', 0), 'ai-office', 'the folder, until the registry carries a title');
  assert.equal(await taskOf('AI office agent visualization', 2), 'AI office agent visualization');
  assert.equal(await taskOf('Did you test it? Like asking codex to…', 1), 'AI office agent visualization', 'the registry went: the first prompt does not replace the title');
  assert.equal(await taskOf('ai-office', 0), 'AI office agent visualization');
  assert.equal(await taskOf('AI office: round two', 2), 'AI office: round two', 'a renamed title does replace it');
  assert.equal(await taskOf('Helper: whatever', undefined), 'AI office: round two', 'no rank counts as the first-prompt strength');
  const snap = await snapshotWith(fake([worker(id, { task: 'x', taskRank: 0 })]))(t);
  assert.equal('taskRank' in snap.agents.find(a => a.id === id), false, 'the rank is not a snapshot field');
});

test('a program\'s run with no transcript is a quick question while young, and a worker once it has kept going', async () => {
  const { isQuickHeadlessRun: quick } = await import('../server/collectors/claude.js');
  const SEC = 1000;
  assert.ok(quick('sdk-cli', null, 5 * SEC), 'a menu-bar app asking for usage');
  assert.ok(!quick('sdk-cli', null, 45 * SEC), 'still going: really working');
  assert.ok(!quick('sdk-cli', null, Infinity), 'no start time: do not hide it');
  assert.ok(!quick('sdk-cli', '/x/run.jsonl', 5 * SEC), 'keeps a transcript');
  assert.ok(!quick('claude-desktop', null, 5 * SEC), 'a chat just opened has no transcript yet');
  assert.ok(!quick('cli', null, 5 * SEC));
  assert.ok(!quick(undefined, null, 5 * SEC));
});

test('from the registry: a young headless run with no transcript stays out, an older one comes in', async () => {
  const run = async ageMs => {
    const o = office(), now = Date.now(), sessionId = `headless-${++n}`;
    write(path.join(o.sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd: CWD, entrypoint: 'sdk-cli', name: 'a nightly job', status: 'busy', startedAt: now - ageMs }));
    return (await collectClaude(now)).find(a => a.id === `claude:${sessionId}`);
  };
  assert.equal(await run(5 * SEC), undefined, 'a quick question');
  const worker = await run(60 * SEC);
  assert.ok(worker, 'still going after a minute');
  assert.equal(worker.status, 'working'); assert.equal(worker.task, 'a nightly job'); assert.equal(worker.thought, null);
});

test('a chat merely opened again counts from its last real work, not from being opened', async () => {
  const o = office(), now = Date.now(), old = now - 3 * 24 * 3600 * SEC;
  const l = lead(o, { registry: { status: 'idle', statusUpdatedAt: now - 2 * SEC, updatedAt: now - 2 * SEC, startedAt: now - 2 * SEC }, lines: s => [prompt(old - 60 * SEC, s, CWD, 'Fix it'), say(old, s, CWD, 'Done.')] });
  const a = (await collectClaude(now)).find(x => x.id === l.id);
  assert.ok(a, 'it is registered'); assert.equal(a.status, 'idle');
  assert.ok(now - a.statusAt > 24 * 3600 * SEC, 'its idle time runs from the old work');
  assert.ok(now - a.lastActivityAt > 24 * 3600 * SEC);
});

