// The shared-file reader (Milestone 12, E2): a write by A followed by a read of the same path by B within the window is
// an `artifact` link; ordinary edits inside one shared repo are not, handoff folders are; dedupe, the per-pair cap and
// the window. Plus what each collector reports as file touches, from synthetic transcripts in temp folders; nothing
// under ~/.claude, ~/.codex, ~/.cursor or ~/.gemini is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { artifactLinks, createArtifactReader, isHandoffPath, treeOf, hashPath } from '../server/links/artifact.js';
import { createLinkLoader } from '../server/links/index.js';
import { LinkResolver } from '../server/links/resolve.js';
import { buildSnapshot } from '../server/model.js';
import { collectClaude, touchOf as claudeTouch } from '../server/collectors/claude.js';
import { extractFromLines as codexLines, readPathsOf, resolveTouches } from '../server/collectors/codex.js';
import { touchOf as cursorTouch, extractTranscript as cursorTranscript } from '../server/collectors/cursor.js';
import { touchOf as geminiTouch } from '../server/collectors/gemini.js';

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
let n = 0;
const A = 'claude:aaaaaaaa-0000-4000-8000-000000000001', B = 'codex:01a1699f-a052-7ff3-a8d5-ed67be68fe12', C = 'gemini:g-3';

function agent(id, extra = {}) {
  const vendor = id.split(':')[0];
  return { id, vendor, kind: 'cli', host: vendor, task: id, cwd: `/p/${vendor}`, project: vendor, model: null, branch: null, startedAt: null, alive: true,
    status: 'working', statusAt: Date.now(), lastActivityAt: Date.now(), thought: null, parentId: null, waiting: false, events: [], pid: null, touches: [], ...extra };
}
const w = (p, at) => ({ path: p, op: 'write', at });
const r = (p, at) => ({ path: p, op: 'read', at });

// ---------------------------------------------------------------- the pure reader

test('artifact: a write by A then a read by B of the same path within the window is a dashed message link', () => {
  const now = Date.now(), t = now - 10 * MIN;
  const a = agent(A, { touches: [w('/shared/notes/plan.md', t), r('/p/claude/own.js', t)] });
  const b = agent(B, { touches: [r('/shared/notes/plan.md', t + 5 * MIN), w('/p/codex/x.py', t)] });
  const links = artifactLinks([a, b], { now, windowMs: 30 * MIN, perPairPerHour: 5 });
  assert.equal(links.length, 1);
  const l = links[0];
  assert.deepEqual([l.kind, l.from, l.to, l.channel, l.confidence, l.text, l.at], ['message', A, B, 'file', 'artifact', 'plan.md', t + 5 * MIN]);
  assert.equal(l.id, `artifact:${A}:${B}:${hashPath('/shared/notes/plan.md')}:${t}`);
  assert.match(l.id, /^artifact:claude:[^:]+:codex:[^:]+:[0-9a-f]{12}:\d+$/);
  // direction follows the order: a read before the write is not a message; the same path read by the writer is not one
  assert.deepEqual(artifactLinks([agent(A, { touches: [w('/s/f', t)] }), agent(B, { touches: [r('/s/f', t - SEC)] })], { now }), []);
  assert.deepEqual(artifactLinks([agent(A, { touches: [w('/s/f', t), r('/s/f', t + SEC)] })], { now }), []);
  // the same read again next poll: the same id (dedupe is by id downstream)
  assert.equal(artifactLinks([a, b], { now: now + 5 * SEC })[0].id, l.id);
});

test('artifact: the window', () => {
  const now = Date.now(), t = now - 50 * MIN;
  const mk = dt => [agent(A, { touches: [w('/s/f', t)] }), agent(B, { touches: [r('/s/f', t + dt)] })];
  assert.equal(artifactLinks(mk(30 * MIN), { now, windowMs: 30 * MIN }).length, 1, 'at the edge: in');
  assert.equal(artifactLinks(mk(30 * MIN + SEC), { now, windowMs: 30 * MIN }).length, 0, 'past it: out');
  assert.equal(artifactLinks(mk(2 * MIN), { now, windowMs: MIN }).length, 0, 'a shorter window');
  assert.equal(CONFIG.links.artifactWindowMs, 30 * MIN);
  assert.equal(CONFIG.links.artifactPerPairPerHour, 5);
});

test('artifact: two agents editing one repo is teamwork, not a handoff; handoff folders and notes are', () => {
  const now = Date.now(), t = now - MIN;
  const lead = agent(A, { cwd: '/repo/office', project: 'office' });
  const mate = agent(B, { cwd: '/repo/office', project: 'office' });
  const tree = agent(C, { cwd: '/repo/office/.claude/worktrees/agent-1', project: 'office' });
  const pair = (p, x = lead, y = mate) => artifactLinks([{ ...x, touches: [w(p, t)] }, { ...y, touches: [r(p, t + SEC)] }], { now });
  assert.deepEqual(pair('/repo/office/server/model.js'), [], 'an ordinary file inside the shared project');
  assert.deepEqual(pair('/repo/office/server/model.js', lead, tree), [], 'a worktree belongs to the same repo');
  assert.deepEqual(pair('/repo/office/.claude/worktrees/agent-1/web/main.js', tree, lead), [], 'and the other way round');
  assert.equal(pair('/repo/office/collaboration/brief.md').length, 1, 'a handoff folder');
  assert.equal(pair('/repo/office/handoff/2026-10-26.md').length, 1);
  assert.equal(pair('/repo/office/inbox/for-codex.md').length, 1);
  assert.equal(pair('/repo/office/docs/mailbox/note.txt').length, 1);
  assert.equal(pair('/repo/office/STATUS.md').length, 1, 'a status note');
  assert.equal(pair('/repo/office/outputs/HANDOFF.md').length, 1);
  assert.equal(pair('/tmp/shared/spec.md').length, 1, 'outside both trees');
  // different projects: a path inside the writer's own tree still counts (the reader came over to fetch it)
  const other = agent(B, { cwd: '/repo/other', project: 'other' });
  assert.equal(pair('/repo/office/server/model.js', lead, other).length, 1);
  assert.equal(isHandoffPath('/x/Collaboration/a.md'), true); assert.equal(isHandoffPath('/x/status.md'), true); assert.equal(isHandoffPath('/x/inbox'), false, 'a folder itself is not a note');
  assert.equal(isHandoffPath('/x/src/handoff.js'), false);
  assert.equal(treeOf({ cwd: '/r/.claude/worktrees/w1/sub' }), '/r'); assert.equal(treeOf({ cwd: '/r/' }), '/r');
});

test('artifact: at most five links per ordered pair per hour, the earliest kept; the other direction counts apart', () => {
  const now = Date.now(), t0 = Math.floor((now - HOUR) / HOUR) * HOUR + MIN; // the start of the previous clock hour
  const files = Array.from({ length: 8 }, (_, i) => `/s/f${i}.md`);
  const a = agent(A, { touches: files.map((f, i) => w(f, t0 + i * MIN)) });
  const b = agent(B, { touches: [...files.map((f, i) => r(f, t0 + i * MIN + 10 * SEC)), w('/s/back.md', t0 + 5 * MIN)] });
  a.touches.push(r('/s/back.md', t0 + 6 * MIN));
  const links = artifactLinks([a, b], { now, windowMs: 30 * MIN, perPairPerHour: 5 });
  const ab = links.filter(l => l.from === A), ba = links.filter(l => l.from === B);
  assert.deepEqual(ab.map(l => l.text), ['f0.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md']);
  assert.deepEqual(ba.map(l => l.text), ['back.md']);
  // the next clock hour has its own budget
  const later = agent(B, { touches: files.map((f, i) => r(f, t0 + HOUR - 5 * MIN + i * 10 * SEC)) });
  const a2 = agent(A, { touches: files.map((f, i) => w(f, t0 + HOUR - 6 * MIN + i * 10 * SEC)) });
  assert.equal(artifactLinks([a2, later], { now: t0 + 2 * HOUR, windowMs: 30 * MIN, perPairPerHour: 5 }).length, 5);
});

test('artifact reader through buildSnapshot: an artifact event with channel file; agents carry no touches', async () => {
  const now = Date.now(), t = now - 2 * MIN;
  const agents = [agent(A, { touches: [w('/shared/plan.md', t)] }), agent(B, { touches: [r('/shared/plan.md', t + MIN)] })];
  const loader = createLinkLoader({ readers: [createArtifactReader()], log: () => {}, recovered: () => {} });
  const snap = await buildSnapshot(now, { collectors: [['[fake]', async () => agents.map(a => ({ ...a }))]], links: loader, resolver: new LinkResolver(), events: new Map() });
  assert.equal(snap.events.length, 1);
  const ev = snap.events[0];
  assert.deepEqual([ev.kind, ev.linkKind, ev.from, ev.to, ev.channel, ev.confidence, ev.text, ev.stub], ['message', 'message', A, B, 'file', 'artifact', 'plan.md', undefined]);
  for (const a of snap.agents) { assert.equal(a.touches, undefined); assert.equal(a.pid, null); assert.equal(a.pidWeak, false); }
  assert.equal(snap.agents.find(a => a.id === B).parentId, null, 'a dashed message adopts nobody');
  assert.deepEqual(snap.links, { files: 0, malformed: 0, lastRead: now, read: 1 });
});

// ---------------------------------------------------------------- what the collectors report

const iso = t => new Date(t).toISOString();
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test('claude: Write / Edit / MultiEdit / NotebookEdit are writes, Read is a read, Grep and Glob are nothing; the registry pid is the agent pid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-art-claude-'));
  CONFIG.claude.sessionsDir = path.join(root, 'sessions'); CONFIG.claude.projectsDir = path.join(root, 'projects');
  fs.mkdirSync(CONFIG.claude.sessionsDir, { recursive: true });
  const now = Date.now(), cwd = '/tmp/ai-office-fixture', sid = `sess-${++n}`;
  const base = t => ({ timestamp: iso(t), sessionId: sid, cwd, entrypoint: 'claude-desktop', uuid: `u${++n}` });
  const tool = (t, name, input) => ({ ...base(t), type: 'assistant', message: { role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${++n}`, name, input }] } });
  write(path.join(CONFIG.claude.projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`), jsonl([
    { ...base(now - 60 * SEC), type: 'user', message: { role: 'user', content: 'go' } },
    tool(now - 50 * SEC, 'Read', { file_path: '/shared/spec.md' }),
    tool(now - 40 * SEC, 'Grep', { pattern: 'x', path: '/shared' }),
    tool(now - 30 * SEC, 'Glob', { pattern: '**/*.md' }),
    tool(now - 20 * SEC, 'Write', { file_path: '/shared/plan.md', content: 'secret body never reported' }),
    tool(now - 15 * SEC, 'Edit', { file_path: '/shared/plan.md', old_string: 'a', new_string: 'b' }),
    tool(now - 10 * SEC, 'NotebookEdit', { notebook_path: '/shared/nb.ipynb' }),
    tool(now - 5 * SEC, 'Read', { file_path: 'relative/not/absolute.md' }),
  ]));
  write(path.join(CONFIG.claude.sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd, status: 'busy', entrypoint: 'claude-desktop' }));
  const [a] = await collectClaude(now);
  assert.equal(a.id, `claude:${sid}`);
  assert.equal(a.pid, process.pid, 'explicit from the registry');
  assert.deepEqual(a.touches, [
    { path: '/shared/nb.ipynb', op: 'write', at: now - 10 * SEC },
    { path: '/shared/plan.md', op: 'write', at: now - 15 * SEC },
    { path: '/shared/plan.md', op: 'write', at: now - 20 * SEC },
    { path: '/shared/spec.md', op: 'read', at: now - 50 * SEC },
  ]);
  for (const t of a.touches) assert.deepEqual(Object.keys(t).sort(), ['at', 'op', 'path'], 'paths only, never contents');
  assert.equal(claudeTouch('MultiEdit', { file_path: '/x/y.js' }, 1).op, 'write');
  assert.equal(claudeTouch('Bash', { command: 'cat /x' }, 1), null);
});

test('codex: apply_patch targets and FileChange items are writes, parsed_cmd and read commands are reads, paths resolve against the cwd', () => {
  const t0 = Date.now() - MIN, cwd = '/w/proj';
  const line = (dt, type, payload) => ({ timestamp: iso(t0 + dt), type, payload });
  const info = codexLines([
    line(0, 'event_msg', { type: 'task_started', started_at: t0 / 1000 }),
    line(1000, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** Add File: notes/HANDOFF.md\n+hello\n*** Delete File: old.txt\n*** End Patch' }),
    line(2000, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'i1', changes: { '/w/proj/out/report.md': { type: 'add', content: 'body never reported' } }, status: 'completed' } }),
    line(3000, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i2', process_id: '19910', command: ['/bin/zsh', '-lc', 'cat /shared/spec.md'], cwd: 'file:///w/proj', parsed_cmd: [{ type: 'read', cmd: 'cat /shared/spec.md', name: 'spec.md', path: '/shared/spec.md' }], status: 'completed' } }),
    line(4000, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i3', process_id: '19911', command: ['/bin/zsh', '-lc', 'sed -n 1,40p docs/plan.md'], cwd: 'file:///w/proj/sub', parsed_cmd: [{ type: 'unknown', cmd: 'sed -n 1,40p docs/plan.md' }], status: 'completed' } }),
    line(5000, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'text(await tools.exec_command({cmd:"rg -n \\"delete\\" ~/inbox/for-codex.md && head -20 ./STATUS.md"}));\n' }),
    line(6000, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'tail -5 /var/log/x.log'] }) }),
    line(7000, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c4', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la && rg TODO'] }) }),
  ]);
  const touches = resolveTouches(info.touches, cwd);
  assert.deepEqual(touches.map(t => [t.op, t.path]), [
    ['read', '/var/log/x.log'],
    ['read', path.join(os.homedir(), 'inbox/for-codex.md')],
    ['read', '/w/proj/STATUS.md'],
    ['read', '/w/proj/sub/docs/plan.md'],
    ['read', '/shared/spec.md'],
    ['write', '/w/proj/out/report.md'],
    ['write', '/w/proj/src/app.js'],
    ['write', '/w/proj/notes/HANDOFF.md'],
  ]);
  assert.deepEqual(touches.map(t => t.at), [t0 + 6000, t0 + 5000, t0 + 5000, t0 + 4000, t0 + 3000, t0 + 2000, t0 + 1000, t0 + 1000]);
  for (const t of touches) assert.deepEqual(Object.keys(t).sort(), ['at', 'op', 'path']);
  // the read-command heuristics
  assert.deepEqual(readPathsOf('cat a.txt'), ['a.txt']);
  assert.deepEqual(readPathsOf('sed 1d file.txt'), [], 'sed without -n edits, it does not read');
  assert.deepEqual(readPathsOf('grep -rn foo src/'), [], 'a directory is not a file anyone wrote');
  assert.deepEqual(readPathsOf('grep -n foo src/x.md'), ['src/x.md']);
  assert.deepEqual(readPathsOf('rg pattern'), [], 'a search with no path');
  assert.deepEqual(readPathsOf('head -c 200 "/My Docs/x.md"'), ['Docs/x.md']); // a quoted path with spaces is beyond this best effort
  assert.deepEqual(readPathsOf('text(await tools.exec_command({cmd:"cat notes/a.md"}));'), ['notes/a.md'], 'the exec tool wraps the command in JS');
  assert.deepEqual(readPathsOf('echo cat'), []);
  assert.deepEqual(readPathsOf('concatenate /x'), [], 'only whole words');
  assert.deepEqual(resolveTouches([{ path: '-n', op: 'read', at: 1 }, { path: 'x', op: 'read', at: 1 }], ''), [], 'options and unresolvable relatives are dropped');
});

test('cursor: Read is a read, Write / StrReplace are writes, from the newest turn only; IDE tool names likewise', () => {
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: 'first' }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/old/turn.md' } }] } },
    { type: 'turn_ended' },
    { role: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/shared/spec.md', limit: 20 } }, { type: 'tool_use', name: 'Grep', input: { path: '/shared', pattern: 'x' } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'StrReplace', input: { path: 'src/a.cpp', old_string: 'a', new_string: 'b' } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: '/shared/out.md', contents: 'never reported' } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'cat /x' } }] } },
  ];
  const info = cursorTranscript(lines);
  assert.deepEqual(info.touches.map(t => [t.op, t.path]), [['write', '/shared/out.md'], ['write', 'src/a.cpp'], ['read', '/shared/spec.md']]);
  assert.equal(info.ended, false);
  assert.deepEqual(cursorTranscript(lines.slice(0, 3)).touches.map(t => t.path), ['/old/turn.md'], 'a closed transcript: its last turn');
  assert.deepEqual(cursorTouch('read_file_v2', { targetFile: 'src/x.ts' }, 5), { path: 'src/x.ts', op: 'read', at: 5 });
  assert.deepEqual(cursorTouch('edit_file', { relativeWorkspacePath: 'a/b.js' }, 5), { path: 'a/b.js', op: 'write', at: 5 });
  assert.deepEqual(cursorTouch('search_replace', { effectiveUri: 'file:///x/y.md', path: 'file:///x/y.md' }, 5), { path: '/x/y.md', op: 'write', at: 5 });
  assert.equal(cursorTouch('ripgrep_raw_search', { path: '/x' }, 5), null);
  assert.equal(cursorTouch('run_terminal_command_v2', { command: 'cat /x' }, 5), null);
});

test('gemini: read_file is a read, write_file / replace are writes, only finished calls with absolute paths', () => {
  assert.deepEqual(geminiTouch({ name: 'read_file', args: { absolute_path: '/shared/spec.md' }, status: 'success' }, 7), { path: '/shared/spec.md', op: 'read', at: 7 });
  assert.deepEqual(geminiTouch({ name: 'write_file', args: { file_path: '/shared/out.md', content: 'never reported' }, status: 'success' }, 7), { path: '/shared/out.md', op: 'write', at: 7 });
  assert.deepEqual(geminiTouch({ name: 'replace', args: { file_path: '/shared/out.md' }, status: 'success' }, 7).op, 'write');
  assert.equal(geminiTouch({ name: 'write_file', args: { file_path: '/shared/out.md' }, status: 'awaiting_approval' }, 7), null, 'not written yet');
  assert.equal(geminiTouch({ name: 'read_file', args: { absolute_path: 'relative.md' }, status: 'success' }, 7), null);
  assert.equal(geminiTouch({ name: 'search_file_content', args: { path: '/x' }, status: 'success' }, 7), null);
});
