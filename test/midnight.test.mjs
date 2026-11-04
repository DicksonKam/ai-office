// The midnight rollover (Milestone 12 S2, checked without a 24-hour soak): snapshots recorded either side of a local
// midnight go to two day files; everyone still in is carried into the new day as an arrival (with an open ask), the
// new day's digest counts them as in, and an event re-sent across midnight is not logged twice. Temp dir only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, dayStart, readEntries, journalFile } from '../server/journal.js';

const TZ = 'Asia/Hong_Kong';
const agent = (id, extra = {}) => ({ id, vendor: 'claude', kind: 'cli', project: '/p/alpha', task: 'do it', status: 'working', ...extra });

test('journal: a snapshot after local midnight starts a new day file and carries everyone still in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-midnight-'));
  const j = new Journal({ dir, timeZone: TZ, log: { log() {}, warn() {}, error() {} } });
  const mid = dayStart('2026-03-11', TZ);
  const ev = { id: 'e1', kind: 'message', from: 'a', to: 'b', at: mid - 30000, text: 'hello' };
  j.record({ now: mid - 60000, agents: [agent('a'), agent('b', { asking: 'Which branch?' })], events: [ev] });
  j.record({ now: mid - 20000, agents: [agent('a', { status: 'idle', idleSince: mid - 25000 }), agent('b', { asking: 'Which branch?' })], events: [ev] });
  j.record({ now: mid + 20000, agents: [agent('a', { status: 'idle' }), agent('b', { asking: 'Which branch?' })], events: [ev] }); // the event re-sent
  const before = readEntries(journalFile('2026-03-10', dir)), after = readEntries(journalFile('2026-03-11', dir));
  assert.deepEqual(before.map(e => e.kind).sort(), ['arrived', 'arrived', 'asking-start', 'idle', 'message']);
  assert.ok(after.every(e => e.t >= mid), 'nothing from before midnight in the new day');
  const carried = after.filter(e => e.carried);
  assert.deepEqual(carried.map(e => `${e.kind}:${e.id}`).sort(), ['arrived:a', 'arrived:b', 'asking-start:b']);
  assert.equal(carried.find(e => e.id === 'a').status, 'idle');
  assert.equal(after.filter(e => e.kind === 'message').length, 0, 'the event re-sent across midnight is not logged again');
  const today = j.today('2026-03-11');
  assert.equal(today.date, '2026-03-11');
  assert.equal(today.stats.sessions, 2, 'both carried in count as in today');
  assert.equal(today.stats.askedYou, 0, 'an ask carried over from yesterday is not a new ask today');
});
