import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeLink, claudeDesktopLink, codexThreadLink, resolveOpens, openLink } from '../server/open.js';

const CHAT = claudeDesktopLink('local_11111111-2222-4333-8444-555555555555');

test('only the known shape of link is allowed', () => {
  assert.ok(isSafeLink(CHAT));
  for (const bad of ['https://evil.example', 'file:///etc/passwd', 'claude://code/new?prompt=rm', `${CHAT}&prompt=hello`, 'claude://code/continue?session=last',
    'claude://code/continue?session=local_a b', 'claude://code/continue?session=local_a%0a', '', null, 42]) assert.ok(!isSafeLink(bad), String(bad));
});

test('a Codex thread link: a real thread id only', () => {
  assert.ok(isSafeLink(codexThreadLink('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')));
  for (const bad of ['new', 'abc', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?prompt=hello', '../settings']) assert.ok(!isSafeLink(codexThreadLink(bad)), bad);
});

test('an id that smuggles more into the link is refused', () => {
  assert.ok(!isSafeLink(claudeDesktopLink('local_abc&prompt=do-something')));
  assert.equal(claudeDesktopLink(undefined), null);
});

test('a helper opens the chat of the one it works for, and the page never sees the link', () => {
  const a = [{ id: 'L', openUrl: CHAT }, { id: 'H', parentId: 'L' }, { id: 'HH', parentId: 'H' }, { id: 'X' }];
  const t = resolveOpens(a);
  assert.equal(t.get('L').url, CHAT); assert.equal(t.get('L').label, 'Open this chat');
  assert.equal(t.get('HH').url, CHAT); assert.equal(t.get('HH').label, 'Open the lead’s chat');
  assert.ok(!t.has('X'));
  assert.ok(a.every(x => !('openUrl' in x)));
  assert.deepEqual(a[0].open, { label: 'Open this chat' });
  assert.equal(a[3].open, undefined);
});

test('a parent loop does not hang', () => {
  const a = [{ id: 'A', parentId: 'B' }, { id: 'B', parentId: 'A' }];
  assert.equal(resolveOpens(a).size, 0);
});

test('nothing unknown ever reaches the system', async () => {
  let ran = 0; await assert.rejects(openLink('https://evil.example', () => { ran++; })); assert.equal(ran, 0);
});
