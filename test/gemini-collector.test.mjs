// Gemini: the current Gemini CLI's appended session files (metadata $set, a message written again with the same id,
// $patch results, rewinds, helpers in a sub-folder) and the Antigravity CLI's SQLite conversations (step states read
// from a copy, so nothing is ever created beside the CLI's own files). Fixtures in temp folders; nothing under ~/.gemini
// is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../server/config.js';
import { foldRecords, collectGemini } from '../server/collectors/gemini.js';
import { collectAntigravity, protoStrings, toolOf, timeOf } from '../server/collectors/antigravity.js';

const SEC = 1000, MIN = 60 * SEC;

test('an appended session folds into what the CLI would load', () => {
  const t = i => new Date(Date.UTC(2026, 10, 16, 9, 0, i)).toISOString();
  const { meta, messages } = foldRecords([
    { sessionId: 's1', projectHash: 'h', startTime: t(0), lastUpdated: t(0), kind: 'main' },
    { id: 'u1', timestamp: t(1), type: 'user', content: [{ text: 'Fix the parser' }] },
    { id: 'g1', timestamp: t(2), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'run_shell_command', status: 'awaiting_approval', args: { command: 'npm test' } }] },
    { $set: { lastUpdated: t(3), summary: 'Parser fix' } },
    { id: 'g1', timestamp: t(2), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'run_shell_command', status: 'success', args: { command: 'npm test' } }] },
    { $patch: { updates: [{ id: 'g1', toolCalls: [{ id: 'c1', result: [{ text: 'ok' }] }] }] } },
    { id: 'u2', timestamp: t(4), type: 'user', content: 'and the tests' },
    { id: 'g2', timestamp: t(5), type: 'gemini', content: 'On it' },
    { $rewindTo: 'u2' },
  ]);
  assert.equal(meta.sessionId, 's1');
  assert.equal(meta.summary, 'Parser fix');
  assert.equal(meta.lastUpdated, t(3));
  assert.deepEqual(messages.map(m => m.id), ['u1', 'g1'], 'the rewind took u2 and after; g1 once, not twice');
  assert.equal(messages[1].toolCalls[0].status, 'success', 'the last copy of a message wins');
  assert.deepEqual(messages[1].toolCalls[0].result, [{ text: 'ok' }], 'the patch added the result');
  assert.deepEqual(foldRecords([{ id: 'a', type: 'user', content: 'x' }, { $patch: { removeIds: ['a'] } }]).messages, []);
});

test('the Gemini CLI: waiting for your OK, and a helper under its lead', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-gemini-'));
  const pdir = path.join(home, 'tmp', 'parser-app'), chats = path.join(pdir, 'chats');
  fs.mkdirSync(path.join(chats, 'lead-1'), { recursive: true });
  fs.writeFileSync(path.join(pdir, '.project_root'), '/work/parser-app\n');
  const now = Date.now(), iso = dt => new Date(now + dt).toISOString();
  const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(chats, 'session-2026-11-16T09-00-lead-1.jsonl'), jsonl([
    { sessionId: 'lead-1', projectHash: 'h', startTime: iso(-5 * MIN), lastUpdated: iso(-5 * MIN), kind: 'main' },
    { id: 'c0', timestamp: iso(-5 * MIN), type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>' }] },
    { id: 'u1', timestamp: iso(-5 * MIN), type: 'user', content: [{ text: 'Fix the subtitle parser' }] },
    { id: 'g1', timestamp: iso(-20 * SEC), type: 'gemini', content: '', model: 'gemini-3-pro', toolCalls: [{ id: 'c1', name: 'run_shell_command', status: 'executing', args: { command: 'rm -r build' }, timestamp: iso(-20 * SEC) }] },
    { id: 'g1', timestamp: iso(-20 * SEC), type: 'gemini', content: '', model: 'gemini-3-pro', toolCalls: [{ id: 'c1', name: 'run_shell_command', status: 'awaiting_approval', args: { command: 'rm -r build', description: 'Clear the build folder' }, timestamp: iso(-10 * SEC) }] },
    { $set: { lastUpdated: iso(-10 * SEC) } },
  ]));
  fs.writeFileSync(path.join(chats, 'session-2026-11-16T09-04-fresh-2.jsonl'), jsonl([
    { sessionId: 'fresh-2', projectHash: 'h', startTime: iso(-30 * SEC), lastUpdated: iso(-30 * SEC), kind: 'main' },
    { id: 'c0', timestamp: iso(-30 * SEC), type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>' }] },
    { $set: { lastUpdated: iso(-30 * SEC) } },
  ]));
  fs.writeFileSync(path.join(chats, 'lead-1', 'helper-9.jsonl'), jsonl([
    { sessionId: 'helper-9', projectHash: 'h', startTime: iso(-2 * MIN), lastUpdated: iso(-5 * SEC), kind: 'subagent' },
    { id: 'u1', timestamp: iso(-2 * MIN), type: 'user', content: 'Find where timestamps are parsed' },
    { id: 'g1', timestamp: iso(-5 * SEC), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'read_file', status: 'executing', args: { file_path: '/work/parser-app/srt.js' }, timestamp: iso(-5 * SEC) }] },
  ]));
  const saved = CONFIG.gemini.home;
  CONFIG.gemini.home = home;
  try {
    const agents = await collectGemini(now), by = id => agents.find(a => a.id === `gemini:${id}`);
    assert.equal(agents.length, 3);
    assert.equal(by('lead-1').asking, 'Needs your OK: Running: Clear the build folder');
    assert.equal(by('lead-1').status, 'working');
    assert.equal(by('lead-1').project, 'parser-app');
    assert.equal(by('lead-1').cwd, '/work/parser-app');
    assert.equal(by('lead-1').model, 'gemini-3-pro');
    assert.equal(by('lead-1').task, 'Fix the subtitle parser');
    assert.equal(by('helper-9').parentId, 'gemini:lead-1');
    assert.equal(by('fresh-2').status, 'idle', 'only the CLI\'s own opening message: opened, not used yet');
    assert.equal(by('fresh-2').task, 'parser-app', 'the opening message is not a request');
    assert.equal(by('helper-9').kind, 'subagent');
    assert.equal(by('helper-9').task, 'Helper: Find where timestamps are parsed');
    assert.equal(by('helper-9').thought.text, 'Reading srt.js');
  } finally { CONFIG.gemini.home = saved; }
});

// ---- Antigravity ----
const varint = n => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const field = (no, v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'); return Buffer.concat([varint((no << 3) | 2), varint(b.length), b]); };
const userInput = text => field(19, field(1, text));
const reply = text => field(20, Buffer.concat([field(1, 'bot-1a2b'), field(2, text)]));
const toolCall = (name, args) => field(45, Buffer.concat([field(1, 'call_118904630597'), field(2, name), field(3, JSON.stringify(args))]));

function conversationDb(file, steps) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, step_payload blob)');
  const put = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
  steps.forEach(([type, status, payload], i) => put.run(i, type, status, payload));
  db.close();
}

test('protobuf payloads: the strings, the tool and its arguments', () => {
  const p = toolCall('run_command', { CommandLine: 'npm test', toolSummary: 'Run the tests' });
  assert.deepEqual(protoStrings(p), ['call_118904630597', 'run_command', '{"CommandLine":"npm test","toolSummary":"Run the tests"}']);
  assert.deepEqual(toolOf(p), { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run the tests' } });
  assert.equal(timeOf('2026-11-11 04:43:01.184119+00:00'), Date.UTC(2026, 10, 11, 4, 43, 1, 184));
  assert.equal(timeOf('0001-01-01 00:00:00+00:00'), 0);
});

test('the Antigravity CLI: waiting for you, at work, a helper, idle; nothing left beside its files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-agy-fixture-'));
  const conv = path.join(home, 'conversations');
  fs.mkdirSync(conv);
  const id = n => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;
  conversationDb(path.join(conv, `${id(1)}.db`), [[14, 3, userInput('Convert the videos to mp4')], [15, 3, reply('Checking the folder first.')], [132, 9, toolCall('run_command', { CommandLine: 'ffmpeg -i a.webm a.mp4', toolSummary: 'Convert a.webm' })]]);
  conversationDb(path.join(conv, `${id(2)}.db`), [[14, 3, userInput('Read the notes')], [132, 2, toolCall('read_file', { Path: '/work/notes/todo.md' })]]);
  conversationDb(path.join(conv, `${id(3)}.db`), [[14, 3, userInput('Summarise the logs please')], [15, 3, reply('All done: three warnings, no errors.')]]);
  conversationDb(path.join(conv, `${id(4)}.db`), [[14, 3, userInput('Before anything else, use your ask-question tool to ask me whether I prefer red or blue, and wait for my answer.')], [132, 9, toolCall('ask_question', { questions: [{ question: 'Do you prefer red or blue?', options: ['Red', 'Blue'] }] })]]);
  const sum = new DatabaseSync(path.join(home, 'conversation_summaries.db'));
  sum.exec('PRAGMA journal_mode = WAL');
  sum.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', workspace_uris text NOT NULL, status text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false, not_fully_idle numeric NOT NULL DEFAULT false, last_modified_time datetime NOT NULL)");
  const row = sum.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const at = new Date().toISOString().replace('T', ' ').replace('Z', '000+00:00');
  row.run(id(1), '', 'Convert the videos to mp4', '["file:///work/video%20tools"]', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, at);
  row.run(id(2), '', 'Read the notes', '["file:///work/video%20tools"]', 'CASCADE_RUN_STATUS_RUNNING', id(1), 'researcher', 0, 1, at);
  row.run(id(4), '', '', '["file:///work/logs"]', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, at);
  row.run(id(3), 'Log summary', 'Summarise the logs please', '["file:///work/logs"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, at);
  sum.close();
  const before = fs.readdirSync(home).concat(fs.readdirSync(conv)).sort();
  const saved = CONFIG.gemini.antigravity;
  CONFIG.gemini.antigravity = home;
  try {
    const agents = await collectAntigravity(Date.now()), by = n => agents.find(a => a.id === `gemini:agy-${id(n)}`);
    assert.equal(agents.length, 4);
    assert.equal(by(4).asking, 'Question for you: Do you prefer red or blue?');
    assert.match(by(4).task, /^Before anything else, use your ask-question tool/, 'text that also reads as a nested record ("Be" = field 8, length 101) is kept whole');
    assert.equal(by(1).asking, 'Needs your OK: Running: Convert a.webm');
    assert.equal(by(1).status, 'working');
    assert.equal(by(1).project, 'video tools');
    assert.equal(by(1).host, 'Antigravity CLI');
    assert.equal(by(1).vendor, 'gemini');
    assert.equal(by(2).parentId, `gemini:agy-${id(1)}`);
    assert.equal(by(2).kind, 'subagent');
    assert.equal(by(2).nickname, 'researcher');
    assert.equal(by(2).task, 'Helper: Read the notes');
    assert.equal(by(2).status, 'working');
    assert.equal(by(2).thought.text, 'Reading todo.md');
    assert.equal(by(3).status, 'idle');
    assert.equal(by(3).task, 'Log summary');
    assert.equal(by(3).thought.text, 'All done: three warnings, no errors.');
    assert.deepEqual(fs.readdirSync(home).concat(fs.readdirSync(conv)).sort(), before, 'read from copies: no -wal or -shm left beside the CLI\'s files');
  } finally { CONFIG.gemini.antigravity = saved; }
});
