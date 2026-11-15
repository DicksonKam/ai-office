// What agents really made: test runs and commits recognised from commands, a test run's verdict from its runner's own
// summary (a pipe hides the exit code), each vendor's records turned into running totals, read incrementally, journalled
// as counts only and replayed. Fixtures only; nothing under ~/.claude, ~/.codex or ~/.gemini is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, testVerdict, pipedOf, Ledger, ledgerOf, claudeLine, codexLine, geminiLine, antigravityLedger, exitCodeOf, hasOutput } from '../server/output.js';

test('test runs and commits are recognised from the command, not from a word in it', () => {
  for (const c of ['npm test', 'npm run test:unit', 'pnpm test -- --watch=false', 'npx vitest run', 'pytest -q tests/', 'python3 -m pytest', 'go test ./...',
    'cargo test', 'node --test test/*.test.mjs', 'node --no-warnings --test x.mjs', 'cd app && npm test 2>&1 | tail -20', 'make check', './gradlew app:test', 'bun test'])
    assert.equal(classify(c), 'test', c);
  for (const c of ['git commit -m "x"', 'git add -A && git commit -q -m "y"', 'git -C repo commit --amend --no-edit', 'git -c user.name=a commit -m z'])
    assert.equal(classify(c), 'commit', c);
  for (const c of ['ls test/', 'grep -r "test" src', 'cat test.txt', 'git log --oneline', 'git commit --dry-run', 'echo npm-test', 'node scripts/smoke.mjs', 'git status'])
    assert.equal(classify(c), null, c);
});

test("a test run's verdict comes from its runner's own summary when there is one", () => {
  assert.equal(testVerdict('ℹ tests 170\nℹ pass 169\nℹ fail 1'), false);
  assert.equal(testVerdict('ℹ pass 174\nℹ fail 0'), true);
  assert.equal(testVerdict('Tests:       2 failed, 30 passed, 32 total'), false);
  assert.equal(testVerdict('======== 12 passed in 0.31s ========'), true);
  assert.equal(testVerdict('--- FAIL: TestX\nFAIL\tpkg 0.01s'), false);
  assert.equal(testVerdict('ok  \tpkg\t0.2s'), true);
  assert.equal(testVerdict('test result: FAILED. 3 passed; 1 failed'), false);
  assert.equal(testVerdict('3 passing (20ms)\n1 failing'), false);
  assert.equal(testVerdict('all 8 passed'), true);
  assert.equal(testVerdict('compiling…'), null);
  assert.equal(pipedOf('npm test | tail'), true);
  assert.equal(pipedOf('set -o pipefail; npm test | tail'), false);
  assert.equal(pipedOf('npm test || true'), false);
  assert.deepEqual(['Exit code: 1', 'Exited with code 6', 'Command exited with code 0.', '{"exit_code":2}', 'hello'].map(exitCodeOf), [1, 6, 0, 2, null]);
});

const at = s => new Date(Date.UTC(2026, 10, 16, 9, 0, s)).toISOString();
const use = (id, name, input, s = 0, sid = 'S') => ({ type: 'assistant', sessionId: sid, timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, isError = false, s = 1, sid = 'S') => ({ type: 'user', sessionId: sid, timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const feed = (lines, fn, ctx) => { const led = new Ledger(); for (const l of lines) fn(l, led, ctx || {}); return led.summary(); };

test('Claude: files once each, verdicts, nothing counted that is not known', () => {
  const o = feed([
    use('w1', 'Write', { file_path: '/p/a.js' }), res('w1', 'ok'),
    use('w2', 'Edit', { file_path: '/p/a.js' }), res('w2', 'ok'),                               // the same file again
    use('w3', 'Edit', { file_path: '/p/b.js' }), res('w3', 'old_string not found', true),     // a failed edit writes nothing
    use('t1', 'Bash', { command: 'npm test 2>&1 | tail -3' }), res('t1', 'ℹ pass 9\nℹ fail 1'), // piped: the summary decides
    use('t2', 'Bash', { command: 'npm test | grep ok' }), res('t2', 'ok'),                       // piped, no summary: unknown
    use('t3', 'Bash', { command: 'pytest' }), res('t3', 'Exit code 1', true),                    // exit code: failed
    use('t4', 'Bash', { command: 'go test ./...', run_in_background: true }), res('t4', 'Command running in background'), // not its result
    use('t5', 'Bash', { command: 'cargo test' }), res('t5', '[Request interrupted by user]', true), // interrupted: unknown
    use('c1', 'Bash', { command: 'git commit -m one' }), res('c1', '[main abc123] one'),
    use('c2', 'Bash', { command: 'git commit -m two' }), res('c2', 'nothing to commit', true),
    use('c3', 'Bash', { command: 'git commit -m old' }, 0, 'OLD'), res('c3', 'ok', false, 1, 'OLD'), // a continued chat's copied history
    use('t6', 'Bash', { command: 'node --test' }),                                                    // still running
  ], claudeLine, { sessionId: 'S' });
  assert.equal(o.files, 1);
  assert.deepEqual([o.tests.pass, o.tests.fail, o.tests.last, o.tests.running], [0, 2, 'fail', true]);
  assert.equal(o.commits, 1);
});

test('Codex: finished commands with their exit codes and file changes; older rollouts from their calls', () => {
  const item = (it, s = 0) => ({ type: 'event_msg', timestamp: at(s), payload: { type: 'item_completed', item: it } });
  const o = feed([
    item({ id: 'a', type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'], exit_code: 0, aggregated_output: 'all 3 passed' }),
    item({ id: 'b', type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'pytest'], exit_code: -1 }),                 // killed: unknown
    item({ id: 'c', type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'git commit -m x'], exit_code: 0 }),
    item({ id: 'c', type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'git commit -m x'], exit_code: 0 }),       // the same item again
    item({ id: 'd', type: 'FileChange', status: 'completed', changes: { '/p/a.ts': {}, '/p/b.ts': {} } }),
    item({ id: 'e', type: 'FileChange', status: 'failed', changes: { '/p/c.ts': {} } }),
  ], codexLine);
  assert.deepEqual([o.files, o.tests.pass, o.tests.fail, o.commits], [2, 1, 0, 1]);
  const call = (call_id, name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id, arguments: JSON.stringify(args) } });
  const out = (call_id, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id, output } });
  const old = feed([
    call('1', 'shell', { command: ['bash', '-lc', 'cargo test'] }), out('1', 'Exit code: 101\nOutput: test result: FAILED. 2 passed; 1 failed'),
    call('2', 'apply_patch', { input: '*** Begin Patch\n*** Update File: /p/x.rs\n*** Add File: /p/y.rs\n*** End Patch' }), out('2', 'Success. Updated the following files'),
  ], codexLine);
  assert.deepEqual([old.files, old.tests.fail, old.tests.last], [2, 1, 'fail']);
});

test('Gemini CLI: a call counted once, when it first shows an ending; running while it runs', () => {
  const msg = calls => ({ id: 'g1', type: 'gemini', timestamp: at(0), toolCalls: calls });
  const led = new Ledger();
  geminiLine(msg([{ id: 'x', name: 'run_shell_command', status: 'executing', args: { command: 'npm test' } }]), led);
  assert.equal(led.summary().tests.running, true);
  geminiLine(msg([{ id: 'x', name: 'run_shell_command', status: 'success', args: { command: 'npm test' }, result: [{ functionResponse: { response: { output: 'Exit Code: 1' } } }] }]), led);
  geminiLine(msg([{ id: 'x', name: 'run_shell_command', status: 'success', args: { command: 'npm test' }, result: 'Exit Code: 1' }]), led); // written again
  geminiLine(msg([{ id: 'y', name: 'write_file', status: 'success', args: { file_path: '/p/notes.md' } }]), led);
  const o = led.summary();
  assert.deepEqual([o.files, o.tests.pass, o.tests.fail, o.tests.running], [1, 0, 1, false]);
});

test('Antigravity: tool steps with their "exited with code" text', () => {
  const o = antigravityLedger([
    { idx: 2, status: 3, tool: { name: 'write_file', args: { Path: '/p/hello.txt' } }, texts: [] },
    { idx: 4, status: 3, tool: { name: 'run_command', args: { CommandLine: 'npm test' } }, texts: ['· Exited with code 0'] },
    { idx: 6, status: 3, tool: { name: 'run_command', args: { CommandLine: 'pytest -q' } }, texts: ['Command exited with code 1.'] },
    { idx: 8, status: 3, tool: { name: 'run_command', args: { CommandLine: 'wc -l hello.txt' } }, texts: ['Exited with code 0'] }, // not a test
    { idx: 9, status: 3, tool: { name: 'run_command', args: { CommandLine: 'go test ./...' } }, texts: [] },                     // no result: unknown
    { idx: 10, status: 2, tool: { name: 'run_command', args: { CommandLine: 'cargo test' } }, texts: [] },                       // running
  ]);
  assert.deepEqual([o.files, o.tests.pass, o.tests.fail, o.tests.last, o.tests.running, o.commits], [1, 1, 1, 'fail', true, 0]);
});

test('transcripts are read incrementally: only what was appended, and from the start again when replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-output-')), f = path.join(dir, 's.jsonl');
  const w = rows => fs.appendFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  w([use('w1', 'Write', { file_path: '/p/a' }), res('w1', 'ok')]);
  assert.equal((await ledgerOf(f, claudeLine, 1, { sessionId: 'S' })).files, 1);
  w([use('w2', 'Write', { file_path: '/p/b' })]);
  fs.appendFileSync(f, JSON.stringify(res('w2', 'ok')).slice(0, 20)); // a line still being written
  assert.equal((await ledgerOf(f, claudeLine, 2, { sessionId: 'S' })).files, 1);
  fs.appendFileSync(f, JSON.stringify(res('w2', 'ok')).slice(20) + '\n');
  assert.equal((await ledgerOf(f, claudeLine, 3, { sessionId: 'S' })).files, 2);
  fs.writeFileSync(f, JSON.stringify(use('w9', 'Write', { file_path: '/p/z' })) + '\n' + JSON.stringify(res('w9', 'ok')) + '\n'); // replaced, shorter
  assert.equal((await ledgerOf(f, claudeLine, 4, { sessionId: 'S' })).files, 1);
});

test('the journal writes what each one has made when it changes, counts only; a film replays it', async () => {
  const { Journal, readEntries, journalFile, localDate } = await import('../server/journal.js');
  const { applyLine } = await import('../web/film.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-outj-'));
  const j = new Journal({ dir, timeZone: 'UTC', log: { log() {}, warn() {}, error() {} } });
  const T = Date.UTC(2026, 10, 16, 9), a = output => ({ id: 'a', vendor: 'claude', kind: 'cli', project: 'p', task: 't', status: 'working', output });
  const o1 = { files: 2, tests: { pass: 1, fail: 0, last: 'pass', running: false }, commits: 0 };
  j.record({ now: T, agents: [a(null)] });
  j.record({ now: T + 1500, agents: [a(o1)] });
  j.record({ now: T + 3000, agents: [a(o1)] });
  j.record({ now: T + 4500, agents: [a({ ...o1, commits: 1 })] });
  const lines = readEntries(journalFile(localDate(T, 'UTC'), dir)).filter(e => e.kind === 'output');
  assert.deepEqual(lines.map(e => e.output.commits), [0, 1]);
  assert.equal(JSON.stringify(lines).includes('/p'), false, 'no paths');
  const agents = new Map([['a', { id: 'a' }]]);
  assert.equal(applyLine(agents, lines[1]), true);
  assert.deepEqual([agents.get('a').output.files, agents.get('a').output.commits, agents.get('a').output.tests.last], [2, 1, 'pass']);
  assert.equal(hasOutput(agents.get('a').output), true);
});
