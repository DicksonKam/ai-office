import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualityStepper } from '../web/autoquality.js';

const run = (q, dt, ms) => { for (let t = 0; t < ms; t += dt) q.tick(dt); };

test('a fast machine loses nothing', () => {
  let n = 0; const q = createQualityStepper({ steps: [() => n++, () => n++] });
  run(q, 16, 20000); assert.equal(n, 0);
});
test('a slow machine steps down in order, one at a time, and stops at the end', () => {
  const log = []; const q = createQualityStepper({ steps: [() => log.push('a'), () => log.push('b')] });
  run(q, 80, 4200); assert.deepEqual(log, ['a'], 'one step after the first window');
  run(q, 80, 30000); assert.deepEqual(log, ['a', 'b']); assert.equal(q.level, 2);
});
test('it stops stepping once the machine copes', () => {
  let n = 0; const q = createQualityStepper({ steps: [() => n++, () => n++] });
  run(q, 80, 4200); assert.equal(n, 1); run(q, 20, 30000); assert.equal(n, 1);
});
test('a long stall is not a slow machine', () => {
  let n = 0; const q = createQualityStepper({ steps: [() => n++] });
  for (let i = 0; i < 40; i++) q.tick(9000); assert.equal(n, 0);
});

test('even a machine drawing a frame every two seconds steps down', () => {
  let n = 0; const q = createQualityStepper({ steps: [() => n++] });
  run(q, 2000, 20000); assert.equal(n, 1);
});
