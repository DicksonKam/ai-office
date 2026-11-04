import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRequest } from '../server/origin.js';

const PORT = 4477, ok = h => isLocalRequest(h, PORT);

test('the office page and local tools are let in', () => {
  assert.ok(ok({ host: 'localhost:4477' }), 'no Origin: curl, a same-site GET');
  assert.ok(ok({ host: '127.0.0.1:4477' }));
  assert.ok(ok({ host: '[::1]:4477' }));
  assert.ok(ok({ host: 'localhost:4477', origin: 'http://localhost:4477' }));
  assert.ok(ok({ host: '127.0.0.1:4477', origin: 'http://127.0.0.1:4477' }));
});

test('another web site is refused', () => {
  assert.ok(!ok({ host: 'localhost:4477', origin: 'https://evil.example' }));
  assert.ok(!ok({ host: 'localhost:4477', origin: 'http://evil.example:4477' }));
  assert.ok(!ok({ host: 'localhost:4477', origin: 'null' }), 'a sandboxed frame or file:// page');
  assert.ok(!ok({ host: 'localhost:4477', origin: 'http://localhost:3000' }), 'another local dev server');
  assert.ok(!ok({ host: 'localhost:4477', origin: 'https://localhost:4477' }), 'not how the office is served');
  assert.ok(!ok({ host: 'localhost:4477', origin: 'http://localhost.evil.example:4477' }));
});

test('a domain pointed at this machine is refused (DNS rebinding)', () => {
  assert.ok(!ok({ host: 'evil.example:4477' }));
  assert.ok(!ok({ host: 'evil.example:4477', origin: 'http://evil.example:4477' }));
  assert.ok(!ok({ host: 'localhost.evil.example:4477' }));
  assert.ok(!ok({ host: 'localhost@evil.example:4477' }));
  assert.ok(!ok({ host: 'localhost:9999' }), 'wrong port');
  assert.ok(!ok({ host: 'localhost' }), 'no port means 80');
  assert.ok(!ok({}), 'no Host at all');
});
