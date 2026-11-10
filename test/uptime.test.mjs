// When the office was running: spans that grow while it beats, and the stretches between them. Temp dir only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Uptime } from '../server/uptime.js';

const T0 = 1800000000000, MIN = 60000;
const fresh = () => new Uptime(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-up-')), 'uptime.json'), { saveEveryMs: Infinity });

test('steady beats make one span; a long silence starts another, and the silence is a gap', () => {
  const u = fresh();
  for (let t = 0; t <= 10 * MIN; t += 1500) u.beat(T0 + t);
  for (let t = 60 * MIN; t <= 70 * MIN; t += 1500) u.beat(T0 + t);
  assert.equal(u.spans.length, 2);
  assert.deepEqual(u.gaps(T0, T0 + 80 * MIN), [{ from: T0 + 10 * MIN, to: T0 + 60 * MIN }]);
});

test('a gap is cut to the span asked about, and short hiccups are not gaps', () => {
  const u = fresh();
  u.beat(T0); u.beat(T0 + 2 * MIN); u.beat(T0 + 3 * MIN + 30000); u.beat(T0 + 40 * MIN);
  assert.deepEqual(u.gaps(T0 + 20 * MIN, T0 + 30 * MIN), [{ from: T0 + 20 * MIN, to: T0 + 30 * MIN }]);
  assert.deepEqual(u.gaps(T0, T0 + 3 * MIN), [], 'a minute and a half between beats is not a gap');
  assert.deepEqual(u.gaps(T0 + 41 * MIN, T0 + 50 * MIN), []);
});

test('before the first record nothing is known, so nothing is called a gap', () => {
  const u = fresh();
  u.beat(T0 + 100 * MIN);
  assert.deepEqual(u.gaps(T0, T0 + 200 * MIN), []);
});

test('saved and read back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-up-')), file = path.join(dir, 'uptime.json');
  const u = new Uptime(file); u.beat(T0); u.beat(T0 + MIN); await u.save();
  assert.deepEqual(new Uptime(file).spans, [[T0, T0 + MIN]]);
});
