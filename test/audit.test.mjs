// The yardstick itself, on chats whose right answers are known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeTruth, codexTruth, officeTimeline, coverageOf, compareChat, summarize } from '../scripts/audit-lib.mjs';

const T0 = Date.parse('2026-11-01T10:00:00Z'), sec = n => T0 + n * 1000, iso = n => new Date(sec(n)).toISOString();
const u = (n, extra = {}) => ({ type: 'user', timestamp: iso(n), sessionId: 's', message: { content: 'hi' }, ...extra });
const a = (n, content = 'ok') => ({ type: 'assistant', timestamp: iso(n), sessionId: 's', message: { content } });
const use = (n, id, name) => a(n, [{ type: 'tool_use', id, name }]);
const result = (n, id) => ({ type: 'user', timestamp: iso(n), sessionId: 's', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const cov = [[sec(-3600), sec(36000)]];

test('claude: one stretch of work, and a long tool call does not break it', () => {
  const t = claudeTruth([u(0), a(30), use(40, 't1', 'Bash'), result(1000, 't1'), a(1010)], 's');
  assert.deepEqual(t.working, [[sec(0), sec(1010)]]);
});
test('claude: two turns far apart are two stretches', () => {
  assert.equal(claudeTruth([u(0), a(10), u(1000), a(1010)], 's').working.length, 2);
});
test('claude: lines copied from an earlier session do not count', () => {
  assert.equal(claudeTruth([{ ...u(0), sessionId: 'older' }, a(5000)], 's').working[0][0], sec(5000));
});
test('claude: waiting for an answer is not work', () => {
  const t = claudeTruth([u(0), a(5), use(10, 'q', 'AskUserQuestion'), result(900, 'q'), a(905)], 's');
  assert.deepEqual(t.asks, [[sec(10), sec(900)]]);
  assert.deepEqual(t.working, [[sec(0), sec(10)], [sec(900), sec(905)]]);
});
const ev = (n, type) => ({ timestamp: iso(n), type: 'event_msg', payload: { type } });
test('codex: a turn, and a chat only opened has none', () => {
  assert.deepEqual(codexTruth([ev(0, 'task_started'), ev(60, 'task_complete')]).working, [[sec(0), sec(60)]]);
  assert.deepEqual(codexTruth([ev(0, 'thread_settings_applied')]).working, []);
});
test('codex: a question asked and answered', () => {
  const l = (n, p) => ({ timestamp: iso(n), type: 'response_item', payload: p });
  assert.deepEqual(codexTruth([ev(0, 'task_started'), l(5, { type: 'function_call', name: 'request_user_input', call_id: 'c' }), l(50, { type: 'function_call_output', call_id: 'c' })]).asks, [[sec(5), sec(50)]]);
});
const row = (n, kind, extra = {}) => ({ t: sec(n), kind, ...extra });
test('office timeline from journal rows', () => {
  const o = officeTimeline([row(2, 'arrived', { status: 'working' }), row(40, 'idle'), row(50, 'working'), row(60, 'idle'), row(100, 'left')], sec(200));
  assert.deepEqual(o.shown, [[sec(2), sec(100)]]);
  assert.deepEqual(o.working, [[sec(2), sec(40)], [sec(50), sec(60)]]);
});
test('a worker with no activity near it is false', () => {
  const r = compareChat({ working: [], asks: [] }, officeTimeline([row(0, 'arrived', { status: 'working' }), row(5, 'left')], sec(9)), cov);
  assert.equal(r.falseWorkers.length, 1);
});
test('a worker for real work is not false, and a late start is measured', () => {
  const r = compareChat({ working: [[sec(0), sec(100)]], asks: [] }, officeTimeline([row(3, 'arrived', { status: 'working' }), row(104, 'idle'), row(200, 'left')], sec(300)), cov);
  assert.equal(r.falseWorkers.length, 0); assert.deepEqual(r.lateStarts, [3000]); assert.deepEqual(r.lateEnds, [4000]);
  assert.equal(r.missedWork.length, 0);
});
test('real work the office never showed is missed; a blink is not counted', () => {
  assert.equal(compareChat({ working: [[sec(0), sec(100)]], asks: [] }, officeTimeline([], sec(300)), cov).missedWork.length, 1);
  assert.equal(compareChat({ working: [[sec(0), sec(5)]], asks: [] }, officeTimeline([], sec(300)), cov).missedWork.length, 0);
});
test('while the office was not running, nothing counts as missed', () => {
  assert.equal(compareChat({ working: [[sec(0), sec(100)]], asks: [] }, officeTimeline([], sec(300)), [[sec(1000), sec(2000)]]).missedWork.length, 0);
});
test('a record that no longer exists proves nothing', () => {
  const r = compareChat(null, officeTimeline([row(0, 'arrived'), row(5, 'left')], sec(9)), cov);
  assert.equal(r.noRecord, 1); assert.equal(r.falseWorkers.length, 0);
});
test('asks: false and missed', () => {
  const none = { working: [], asks: [] };
  assert.equal(compareChat(none, officeTimeline([row(0, 'arrived'), row(1, 'asking-start'), row(60, 'asking-end')], sec(90)), cov).falseAsks.length, 1);
  assert.equal(compareChat({ working: [], asks: [[sec(0), sec(60)]] }, officeTimeline([], sec(90)), cov).missedAsks.length, 1);
});
test('coverage breaks at a long silence', () => {
  assert.equal(coverageOf([sec(0), sec(60), sec(10000)]).length, 2);
});
test('summary adds up', () => {
  const r = compareChat({ working: [[sec(0), sec(100)]], asks: [] }, officeTimeline([row(0, 'arrived', { status: 'working' }), row(50, 'idle'), row(90, 'left')], sec(300)), cov);
  const s = summarize([r]); assert.equal(s.shownWorkingPct, 50); assert.equal(s.officeWorkTruePct, 100);
});

test('claude: history carried into a continued chat is not new work', () => {
  const t = claudeTruth([u(0), a(10), u(5000), a(5010)], 's', sec(4000));
  assert.deepEqual(t.working, [[sec(5000), sec(5010)]]);
});

test('claude: a quick reply after the end of a turn is a new stretch', () => {
  const end = { ...a(30), message: { content: 'done', stop_reason: 'end_turn' } };
  assert.deepEqual(claudeTruth([u(0), end, u(90), a(120)], 's').working, [[sec(0), sec(30)], [sec(90), sec(120)]]);
});
test('an ask with a tool call open beside it is not proven false', () => {
  const r = compareChat({ working: [], asks: [], tools: [[sec(0), sec(100)]] }, officeTimeline([row(0, 'arrived'), row(10, 'asking-start'), row(60, 'asking-end')], sec(90)), cov);
  assert.equal(r.falseAsks.length, 0); assert.equal(r.inferredAsks.length, 1);
});
