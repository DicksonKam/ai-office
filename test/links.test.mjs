// Links (Milestone 11): the declared-file reader (contract v1, incremental, rotation, age, text cap, malformed count),
// the process-ancestry reader against a synthetic process table, and the resolver (team adoption, vendor parent wins,
// stubs, pid: resolution, dedupe, kind mapping) through buildSnapshot with injected collectors. Everything runs in fresh
// temp folders; nothing under ~/.claude, ~/.codex or ~/.ai-office is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { createLinkLoader, makeLink, parseParty } from '../server/links/index.js';
import { createDeclaredReader, parseDeclaredLine, parseAt } from '../server/links/declared.js';
import { createProcessReader, linksFromTable, parsePs, labelOf, isExcluded, weakJoins } from '../server/links/process.js';
import { LinkResolver, verdictFromText } from '../server/links/resolve.js';
import { buildSnapshot, EVENT_TTL } from '../server/model.js';
import { Journal } from '../server/journal.js';

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
let n = 0;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `ai-office-${prefix}-`));
const iso = t => new Date(t).toISOString();
const line = o => JSON.stringify(o) + '\n';

const A = 'codex:01a1699f-a052-7ff3-a8d5-ed67be68fe12', B = 'claude:1b3900e6-6067-4fba-b690-1d17d96aa569', C = 'claude:cccccccc-0000-4000-8000-000000000003';

/** A present agent as a collector reports it. */
function agent(id, extra = {}) {
  const vendor = id.split(':')[0];
  return { id, vendor, kind: 'cli', host: vendor, task: id, cwd: '/tmp/x', project: 'x', model: null, branch: null, startedAt: null, alive: true,
    status: 'working', statusAt: Date.now(), lastActivityAt: Date.now(), thought: null, parentId: null, waiting: false, events: [], ...extra };
}
/** buildSnapshot with only these agents and links (no live collectors, no live readers). */
function snapshotWith(agents, links, { now = Date.now(), pidMap = new Map(), resolver = new LinkResolver(), events = new Map() } = {}) {
  const loader = createLinkLoader({ readers: [{ name: 'fake', read: (t, ctx) => { for (const [k, v] of pidMap) ctx.pidMap.set(k, v); return links; }, stats: () => ({ files: 1, malformed: 0, read: links.length }) }], log: () => {}, recovered: () => {} });
  const run = (nowAt = now, ag = agents, lk = links) => { links = lk; return buildSnapshot(nowAt, { collectors: [['[fake]', async () => ag.map(a => ({ ...a }))]], links: loader, resolver, events }); };
  return run;
}
const L = (kind, from, to, at, extra = {}) => makeLink({ id: `t:${kind}:${++n}`, kind, from, to, at, channel: 'test', ...extra });

// ---------------------------------------------------------------- the declared reader

test('declared: a valid contract line becomes a link; malformed lines are skipped and counted', async () => {
  const dir = tmp('links'), now = Date.now();
  const r = createDeclaredReader({ dir });
  fs.writeFileSync(path.join(dir, 'mytool.jsonl'), [
    line({ v: 1, id: 'mytool:run-42:brief', at: iso(now - 10 * SEC), kind: 'brief', from: A, to: B, text: 'Audit the native auth route', channel: 'mytool' }),
    'this is not json\n',
    line({ v: 1, kind: 'reply', from: B, to: A, at: now - 5 * SEC }),          // epoch ms, no id: derived
    line({ v: 1, kind: 'dance', from: A, to: B, at: now }),                    // unknown kind
    line({ v: 1, kind: 'message', from: A, to: 'nobody', at: now }),           // bad party
    line({ v: 1, kind: 'message', from: A, to: B }),                           // no at
    line({ v: 2, kind: 'message', from: A, to: B, at: now }),                  // wrong version
    line({ v: 1, kind: 'message', from: A, to: A, at: now }),                  // to itself
    line({ v: 1, kind: 'approval', from: 'name:Alex', to: B, at: now - SEC, extra: 'ignored' }),
  ].join(''));
  const links = await r.read(now);
  assert.deepEqual(links.map(l => l.kind), ['brief', 'reply', 'approval']);
  const brief = links[0];
  assert.deepEqual(brief, { id: 'mytool:run-42:brief', kind: 'brief', from: A, to: B, at: now - 10 * SEC, text: 'Audit the native auth route', channel: 'mytool', confidence: 'declared' });
  assert.match(links[1].id, /^declared:mytool\.jsonl:[0-9a-f]{16}$/);
  assert.equal(links[1].channel, 'mytool', 'channel defaults to the file name');
  assert.equal(links[2].from, 'name:Alex');
  assert.deepEqual(r.stats(), { files: 1, malformed: 6, lastRead: now, read: 3 });
});

test('declared: text is cut at 200 chars, `at` accepts ISO or ms, ids are stable for the same line', () => {
  const long = 'x'.repeat(500);
  const l = parseDeclaredLine(JSON.stringify({ v: 1, kind: 'message', from: A, to: B, at: 1761458400000, text: long }), '/x/t.jsonl');
  assert.equal(l.text.length, 200);
  assert.equal(parseAt('2026-10-26T06:12:16Z'), Date.parse('2026-10-26T06:12:16Z'));
  assert.equal(parseAt(1761458400000), 1761458400000);
  assert.equal(parseAt('1761458400000'), 1761458400000);
  assert.equal(parseAt('yesterday'), null);
  const s = JSON.stringify({ v: 1, kind: 'message', from: A, to: B, at: 1761458400000 });
  assert.equal(parseDeclaredLine(s, 'a.jsonl').id, parseDeclaredLine(s, 'a.jsonl').id);
  assert.notEqual(parseDeclaredLine(s, 'a.jsonl').id, parseDeclaredLine(s, 'b.jsonl').id);
  assert.equal(parseDeclaredLine('{"v":1,"kind":"message","from":"pid:abc","to":"claude:x","at":1}', 'a.jsonl'), null, 'pid refs are numeric');
  assert.equal(parseParty('pid:4242')?.id, '4242');
});

test('declared: incremental offsets (only new bytes are parsed), a torn last line waits, rotation restarts', async () => {
  const dir = tmp('links'), now = Date.now(), file = path.join(dir, 'relay.jsonl');
  const r = createDeclaredReader({ dir });
  fs.writeFileSync(file, line({ v: 1, id: 'b:1', kind: 'brief', from: A, to: B, at: now - 30 * SEC }));
  assert.deepEqual((await r.read(now)).map(l => l.id), ['b:1']);
  const off1 = r._files().get(file).offset;
  assert.equal(off1, fs.statSync(file).size);

  // append a whole line and half of another
  const half = line({ v: 1, id: 'b:3', kind: 'message', from: A, to: B, at: now }).slice(0, 20);
  fs.appendFileSync(file, line({ v: 1, id: 'b:2', kind: 'reply', from: B, to: A, at: now - 10 * SEC }) + half);
  assert.deepEqual((await r.read(now + SEC)).map(l => l.id), ['b:1', 'b:2']);
  assert.equal(r.stats().malformed, 0, 'a torn line is not malformed yet');
  fs.appendFileSync(file, line({ v: 1, id: 'b:3', kind: 'message', from: A, to: B, at: now }).slice(20));
  assert.deepEqual((await r.read(now + 2 * SEC)).map(l => l.id), ['b:1', 'b:2', 'b:3']);
  assert.deepEqual((await r.read(now + 3 * SEC)).map(l => l.id), ['b:1', 'b:2', 'b:3'], 'nothing new: the same links again');

  // rotated: a shorter file replaces it (new content, read from the start)
  fs.writeFileSync(file, line({ v: 1, id: 'b:9', kind: 'brief', from: A, to: C, at: now }));
  assert.deepEqual((await r.read(now + 4 * SEC)).map(l => l.id), ['b:9']);

  // replaced by a different inode of the same size: restarts too
  const other = path.join(dir, 'tmp.jsonl.new');
  fs.writeFileSync(other, line({ v: 1, id: 'b:8', kind: 'brief', from: A, to: C, at: now }));
  fs.renameSync(other, file);
  const ids = (await r.read(now + 5 * SEC)).map(l => l.id);
  assert.deepEqual(ids, ['b:8']);

  // a removed file is forgotten; a missing folder is no error
  fs.renameSync(file, path.join(dir, 'gone.txt'));
  assert.deepEqual(await r.read(now + 6 * SEC), []);
  assert.equal(r.stats().files, 0);
  assert.deepEqual(await createDeclaredReader({ dir: path.join(dir, 'nope') }).read(now), []);
});

test('declared: links older than 24 h are ignored, the newest N per file are kept, duplicate ids once', async () => {
  const dir = tmp('links'), now = Date.now();
  const r = createDeclaredReader({ dir, maxPerFile: 3 });
  const rows = [];
  rows.push(line({ v: 1, id: 'old', kind: 'brief', from: A, to: B, at: now - 25 * HOUR }));
  for (let i = 0; i < 5; i++) rows.push(line({ v: 1, id: `m${i}`, kind: 'message', from: A, to: B, at: now - (10 - i) * MIN }));
  rows.push(line({ v: 1, id: 'm4', kind: 'message', from: A, to: B, at: now - MIN })); // same id again
  fs.writeFileSync(path.join(dir, 'x.jsonl'), rows.join(''));
  const links = await r.read(now);
  assert.deepEqual(links.map(l => l.id), ['m2', 'm3', 'm4']);
  assert.equal(r.stats().malformed, 0, 'old and duplicate lines are well-formed, just not kept');
  // time passes: the kept ones age out too
  assert.deepEqual((await r.read(now + 24 * HOUR)).map(l => l.id), []);
});

test('loader: a reader that throws costs its links this poll only, logged once', async () => {
  const logged = [];
  let fail = true;
  const loader = createLinkLoader({
    readers: [
      { name: 'bad', read: () => { if (fail) throw new Error('boom'); return [L('message', A, B, 1)]; }, stats: () => ({ files: 0, malformed: 0, read: 0 }) },
      { name: 'good', read: () => [L('brief', A, B, 2)], stats: () => ({ files: 2, malformed: 1, read: 1 }) },
    ],
    log: (tag, e) => logged.push(`${tag} ${e.message}`), recovered: tag => logged.push(`${tag} ok`),
  });
  assert.equal((await loader.readLinks(5)).length, 1);
  assert.equal((await loader.readLinks(6)).length, 1);
  assert.deepEqual(logged, ['[links:bad] boom', '[links:good] ok', '[links:bad] boom', '[links:good] ok'].slice(0, 4));
  fail = false;
  assert.equal((await loader.readLinks(7)).length, 2);
  assert.deepEqual(loader.stats(), { files: 2, malformed: 1, lastRead: 7, read: 1 });
});

// ---------------------------------------------------------------- the process reader

const PS = `  PID  PPID COMMAND
    1     0 /sbin/launchd
  100     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  101   100 login -pfl me /bin/zsh -c exec -la zsh /bin/zsh
  102   101 -zsh
  200   102 node /Users/d/Projects/relay/relay.mjs --watch
  201   200 claude -p --resume abc
  202   200 codex exec --json
  300   102 claude
  301   300 node /opt/claude/helper.js
  302   301 claude --agent child
  400   101 -zsh
  401   400 claude
  500     1 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility
  501   500 claude
  502   500 claude
`;

test('process: parsing, labels and exclusions', () => {
  const t = parsePs(PS);
  assert.equal(t.size, 15);
  assert.deepEqual(t.get(201), { pid: 201, ppid: 200, startedAt: null, command: 'claude -p --resume abc' });
  // with lstart (the live format): the start time is parsed and the command keeps its own spaces
  const withStart = parsePs('  PID  PPID STARTED COMMAND\n 4242   102 Sun Oct 25 04:10:14 2026     /opt/homebrew/bin/codex exec --json\n 4243  4242 Mon Oct  6 04:10:14 2026 codex sandbox -c x\n');
  assert.deepEqual(withStart.get(4242), { pid: 4242, ppid: 102, startedAt: Date.parse('Sun Oct 25 04:10:14 2026'), command: '/opt/homebrew/bin/codex exec --json' });
  assert.equal(withStart.get(4243).startedAt, Date.parse('Mon Oct 6 04:10:14 2026'));
  assert.equal(labelOf('node /Users/d/Projects/relay/relay.mjs --watch'), 'relay.mjs');
  assert.equal(labelOf('/usr/bin/python3 -u /x/coordinator.py'), 'coordinator.py');
  assert.equal(labelOf('/opt/homebrew/bin/codex exec'), 'codex');
  assert.equal(isExcluded(t.get(1)), true);
  assert.equal(isExcluded(t.get(100)), true, 'Terminal (an app bundle)');
  assert.equal(isExcluded(t.get(101)), true, 'login');
  assert.equal(isExcluded(t.get(102)), true, 'a login shell shows as -zsh');
  assert.equal(isExcluded(t.get(500)), true, 'an Electron helper');
  assert.equal(isExcluded(t.get(200)), false, 'a plain node program is a launcher worth naming');
});

test('process: an agent whose process is an ancestor of another agent launched it (structural launch link)', () => {
  const agents = new Map([[300, 'claude:lead'], [302, 'claude:child'], [401, 'claude:other']]);
  const links = linksFromTable(parsePs(PS), agents, { now: 1000 });
  assert.deepEqual(links.map(l => [l.from, l.to, l.kind, l.channel, l.confidence, l.at]), [['claude:lead', 'claude:child', 'launch', 'process', 'structural', 1000]]);
  assert.equal(links[0].id, 'process:launch:300:302');
  // the `at` is when the link was first noticed, and stays put
  const firstSeen = new Map();
  linksFromTable(parsePs(PS), agents, { now: 1000, firstSeen });
  assert.equal(linksFromTable(parsePs(PS), agents, { now: 5000, firstSeen })[0].at, 1000);
});

test('process: two agents under a plain program get "launched by <program>" stub links; shells and apps never do', () => {
  const t = parsePs(PS);
  // under the relay (node relay.mjs): one stub per agent, named after the script
  let links = linksFromTable(t, new Map([[201, 'claude:worker'], [202, 'codex:coordinator']]), { now: 1 });
  assert.deepEqual(links.map(l => [l.from, l.to]).sort(), [['name:relay.mjs', 'claude:worker'], ['name:relay.mjs', 'codex:coordinator']]);
  // two sessions started from the same shell / terminal: nothing
  assert.deepEqual(linksFromTable(t, new Map([[300, 'claude:a'], [401, 'claude:b']]), { now: 1 }), []);
  // two sessions under the Claude desktop helper: nothing
  assert.deepEqual(linksFromTable(t, new Map([[501, 'claude:a'], [502, 'claude:b']]), { now: 1 }), []);
  // the common ancestor is itself an agent: only the ancestor links, no stub
  links = linksFromTable(t, new Map([[300, 'claude:lead'], [302, 'claude:child'], [301, 'pid:301']]), { now: 1 });
  assert.deepEqual(links.map(l => l.id).sort(), ['process:launch:300:301', 'process:launch:300:302', 'process:launch:301:302']);
  // a pid that is not in the table produces nothing
  assert.deepEqual(linksFromTable(t, new Map([[9999, 'claude:ghost'], [300, 'claude:lead']]), { now: 1 }), []);
});

test('process reader: registry pids and declared pid: refs, ps at most every 10 s, graceful when ps fails', async () => {
  const reg = tmp('registry');
  fs.writeFileSync(path.join(reg, '300.json'), JSON.stringify({ pid: 300, sessionId: 'lead-session', cwd: '/x' }));
  fs.writeFileSync(path.join(reg, '302.json'), JSON.stringify({ pid: 302, sessionId: 'child-session' }));
  fs.writeFileSync(path.join(reg, 'junk.json'), '{ torn');
  let calls = 0, failing = false;
  const ps = async () => { calls++; if (failing) throw new Error('ps: no such tool'); return PS; };
  const r = createProcessReader({ ps, everyMs: 10 * SEC, registryDir: reg });
  const ctx = { links: [L('brief', 'pid:202', 'pid:201', 1), L('reply', 'pid:201', 'pid:202', 2)], pidMap: new Map() };
  const t0 = 100 * SEC;
  let links = await r.read(t0, ctx);
  assert.equal(calls, 1);
  assert.deepEqual(links.map(l => [l.from, l.to]).sort(), [['claude:lead-session', 'claude:child-session'], ['name:relay.mjs', 'pid:201'], ['name:relay.mjs', 'pid:202']]);
  assert.deepEqual([...ctx.pidMap], [[300, 'claude:lead-session'], [302, 'claude:child-session']], 'registry pids resolve to claude ids; a bare pid: ref stays a pid');
  await r.read(t0 + 3 * SEC, ctx); await r.read(t0 + 9 * SEC, ctx);
  assert.equal(calls, 1, 'ps not run again within 10 s');
  await r.read(t0 + 10 * SEC, ctx);
  assert.equal(calls, 2);
  failing = true;
  links = await r.read(t0 + 20 * SEC, ctx);
  assert.equal(calls, 3);
  assert.equal(links.length, 3, 'the last table is kept when ps fails');
  assert.equal(r.stats().psFailures, 1);
  // only pid refs in the links and the registry count; the stub named a pid not in the registry
  assert.ok(links.some(l => l.to === 'pid:201' && l.from === 'name:relay.mjs'));
  // ps failing from the very start: no links, no throw
  const r2 = createProcessReader({ ps: async () => { throw new Error('nope'); }, everyMs: 10 * SEC, registryDir: reg });
  assert.deepEqual(await r2.read(t0, { links: [], pidMap: new Map() }), []);
});

// ---------------------------------------------------------------- the resolver, through buildSnapshot

test('resolver: a brief adopts a parentless helper (teamSource link), stable across polls, until it leaves', async () => {
  const now = Date.now();
  const run = snapshotWith([agent(A), agent(B)], [L('brief', A, B, now - 20 * SEC, { text: 'Audit the native auth route' })], { now });
  let snap = await run();
  const a = snap.agents.find(x => x.id === A), b = snap.agents.find(x => x.id === B);
  assert.equal(b.parentId, A); assert.equal(b.role, 'helper'); assert.equal(b.teamSource, 'link'); assert.equal(b.depth, 1); assert.equal(b.teamId, A);
  assert.equal(a.role, 'lead'); assert.equal(a.helpers, 1); assert.equal(a.teamSource, null);
  assert.deepEqual(snap.teams, [{ id: A, lead: A, members: [B], reviewers: [] }]);
  // the brief as an event the client already knows how to act out
  const ev = snap.events.find(e => e.linkKind === 'brief');
  assert.equal(ev.kind, 'spawn'); assert.equal(ev.text, 'Audit the native auth route'); assert.equal(ev.channel, 'test'); assert.equal(ev.confidence, 'declared');
  assert.equal(ev.from, A); assert.equal(ev.to, B); assert.equal(ev.stub, undefined);
  assert.deepEqual(snap.links, { files: 1, malformed: 0, lastRead: now, read: 1 });

  // later polls: the brief is older than the event TTL but the team holds
  snap = await run(now + EVENT_TTL + MIN);
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  assert.equal(snap.events.length, 0);
  // even when the link file no longer returns it (the adoption is remembered)
  snap = await run(now + EVENT_TTL + 2 * MIN, undefined, []);
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  // the lead leaves: the helper stands alone; the lead returns: the team is back
  snap = await run(now + EVENT_TTL + 3 * MIN, [agent(B)], []);
  assert.equal(snap.agents.find(x => x.id === B).parentId, null); assert.equal(snap.agents.find(x => x.id === B).teamSource, null);
  snap = await run(now + EVENT_TTL + 4 * MIN, [agent(A), agent(B)], []);
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  // the helper leaves and comes back: forgotten
  await run(now + EVENT_TTL + 5 * MIN, [agent(A)], []);
  snap = await run(now + EVENT_TTL + 6 * MIN, [agent(A), agent(B)], []);
  assert.equal(snap.agents.find(x => x.id === B).parentId, null);
});

test('resolver: a vendor parent always wins; a handoff moves the adopted helpers; the newest brief wins', async () => {
  const now = Date.now();
  // B has a vendor parent C (present): the brief from A does not move it
  let run = snapshotWith([agent(A), agent(C), agent(B, { parentId: C, kind: 'subagent' })], [L('brief', A, B, now - 10 * SEC)], { now });
  let snap = await run();
  let b = snap.agents.find(x => x.id === B);
  assert.equal(b.parentId, C); assert.equal(b.teamSource, 'vendor');
  // the vendor parent is away: the helper stands alone, and the brief may adopt it
  snap = await run(now + SEC, [agent(A), agent(B, { parentId: C, kind: 'subagent' })]);
  b = snap.agents.find(x => x.id === B);
  assert.equal(b.parentId, A); assert.equal(b.teamSource, 'link');

  // handoff: A hands its team to C
  run = snapshotWith([agent(A), agent(B), agent(C)], [L('brief', A, B, now - 10 * SEC)], { now });
  snap = await run();
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  snap = await run(now + SEC, undefined, [L('brief', A, B, now - 10 * SEC), L('handoff', A, C, now - 5 * SEC)]);
  b = snap.agents.find(x => x.id === B);
  assert.equal(b.parentId, C); assert.equal(b.teamSource, 'link');
  assert.equal(snap.events.find(e => e.kind === 'handoff')?.linkKind, 'handoff', 'handoff passes through as its own kind');
  snap = await run(now + 2 * SEC);
  assert.equal(snap.agents.find(x => x.id === B).parentId, C, 'stable: the older brief does not pull it back');
  // a newer brief from A wins again
  snap = await run(now + 3 * SEC, undefined, [L('brief', A, B, now - 10 * SEC), L('handoff', A, C, now - 5 * SEC), L('brief', A, B, now - SEC)]);
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  // a brief beats a launch whatever their times
  run = snapshotWith([agent(A), agent(B), agent(C)], [L('launch', C, B, now, { confidence: 'structural', channel: 'process' }), L('brief', A, B, now - HOUR)], { now });
  snap = await run();
  assert.equal(snap.agents.find(x => x.id === B).parentId, A);
  // a brief to oneself or a loop never makes a cycle
  run = snapshotWith([agent(A), agent(B)], [L('brief', A, B, now - 2 * SEC), L('brief', B, A, now - SEC)], { now });
  snap = await run();
  const parents = snap.agents.map(x => x.parentId);
  assert.equal(parents.filter(Boolean).length, 1, 'one of them leads, never both');
});

test('resolver: kind mapping, channel/confidence on every event, verdict heuristics, dedupe by id', async () => {
  const now = Date.now();
  const links = [
    L('reply', B, A, now - 9 * SEC, { text: 'Done: 3 files' }),
    L('message', A, B, now - 8 * SEC, { text: 'ping' }),
    L('review', A, B, now - 7 * SEC),
    L('verdict', A, B, now - 6 * SEC, { text: 'Flagged: high risk change to auth' }),
    L('verdict', A, B, now - 5 * SEC, { text: 'LGTM, low risk' }),
    L('approval', 'name:Alex', B, now - 4 * SEC, { text: 'go ahead' }),
    L('launch', A, B, now - 3 * SEC, { confidence: 'structural', channel: 'process' }),
    L('message', A, B, now - EVENT_TTL - SEC, { text: 'too old for an event' }),
  ];
  const vendorEvents = [{ id: 'codex-spawn:1', kind: 'spawn', from: A, to: B, text: 'helper', at: now - 2 * SEC }, { id: 'codex-report:1', kind: 'report', from: B, to: A, text: 'rep', at: now - SEC }];
  const run = snapshotWith([agent(A, { events: vendorEvents }), agent(B)], links, { now });
  const snap = await run();
  const byLink = Object.fromEntries(snap.events.filter(e => e.channel === 'test' || e.channel === 'process').map(e => [e.id, e]));
  const kinds = snap.events.map(e => `${e.linkKind}>${e.kind}`);
  assert.deepEqual(kinds, ['reply>report', 'message>message', 'review>review', 'verdict>verdict', 'verdict>verdict', 'approval>approval', 'launch>launch', 'brief>spawn', 'reply>report']);
  for (const e of snap.events) { assert.ok(e.channel, `${e.id} has a channel`); assert.ok(e.confidence, `${e.id} has a confidence`); }
  const [flag, ok] = snap.events.filter(e => e.kind === 'verdict').map(e => e.verdict);
  assert.deepEqual(flag, { outcome: 'flag', risk: 'high' });
  assert.deepEqual(ok, { outcome: 'allow', risk: 'low' });
  assert.deepEqual(verdictFromText(null), { outcome: 'allow', risk: null });
  // vendor-native events: direct channel, declared (the spawn: structural), and a linkKind
  const vs = snap.events.find(e => e.id === 'codex-spawn:1'), vr = snap.events.find(e => e.id === 'codex-report:1');
  assert.deepEqual([vs.channel, vs.confidence, vs.linkKind], ['direct', 'structural', 'brief']);
  assert.deepEqual([vr.channel, vr.confidence, vr.linkKind], ['direct', 'declared', 'reply']);
  // the approval from a human outside the office: a stub on the from side, kept
  const ap = snap.events.find(e => e.kind === 'approval');
  assert.deepEqual(ap.stub, { side: 'from', label: 'Alex' }); assert.equal(ap.from, 'name:Alex'); assert.equal(ap.to, B);
  assert.equal(Object.keys(byLink).length, 7);
  // dedupe: the same ids again next poll stay one event each; expired ones go
  const again = await run(now + SEC);
  assert.equal(again.events.length, snap.events.length);
  assert.equal(new Set(again.events.map(e => e.id)).size, again.events.length);
  const later = await run(now + EVENT_TTL + 10 * SEC);
  assert.equal(later.events.length, 0);
});

test('resolver: pid: ends resolve through the pid map; two unresolved ends drop the link; a name: end is a stub', async () => {
  const now = Date.now();
  const links = [
    L('brief', 'pid:300', B, now - 5 * SEC, { text: 'via pid' }),
    L('message', 'pid:999', 'name:someone', now - 4 * SEC),     // neither end known
    L('message', A, 'name:the relay', now - 3 * SEC, { text: 'to a stranger' }),
    L('message', A, 'claude:not-here', now - 2 * SEC),           // a known scheme, absent agent: a stub too
    L('message', 'pid:777', B, now - SEC),                       // a pid nobody maps: a stub
  ];
  const run = snapshotWith([agent(A), agent(B)], links, { now, pidMap: new Map([[300, A]]) });
  const snap = await run();
  const b = snap.agents.find(x => x.id === B);
  assert.equal(b.parentId, A, 'pid:300 is A: the brief adopts B');
  const evs = snap.events;
  assert.deepEqual(evs.map(e => [e.from, e.to, e.stub?.side, e.stub?.label]), [
    [A, B, undefined, undefined],
    [A, 'name:the relay', 'to', 'the relay'],
    [A, 'claude:not-here', 'to', 'claude:not-here'],
    ['pid:777', B, 'from', 'pid 777'],
  ]);
  assert.equal(evs[0].kind, 'spawn'); assert.equal(evs[0].text, 'via pid');
});

test('journal: event lines carry channel, confidence, linkKind and stub; new kinds are journaled', () => {
  const dir = tmp('journal'), now = Date.now();
  const j = new Journal({ dir, log: { error() {} } }).load(now);
  const agents = [{ ...agent(A), role: 'lead' }, { ...agent(B), parentId: A, role: 'helper' }];
  j.record({ now, agents, events: [
    { id: 'l1', kind: 'spawn', linkKind: 'brief', from: A, to: B, text: 'go', at: now - SEC, channel: 'mytool', confidence: 'declared' },
    { id: 'l2', kind: 'launch', linkKind: 'launch', from: 'name:relay.mjs', to: B, at: now - SEC, channel: 'process', confidence: 'structural', stub: { side: 'from', label: 'relay.mjs' } },
    { id: 'l3', kind: 'handoff', linkKind: 'handoff', from: A, to: B, at: now, channel: 'mytool', confidence: 'declared' },
    { id: 'v1', kind: 'report', linkKind: 'reply', from: B, to: A, text: 'done', at: now, channel: 'direct', confidence: 'declared' },
  ] });
  const file = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'));
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.eid);
  const byEid = Object.fromEntries(lines.map(e => [e.eid, e]));
  assert.deepEqual(Object.keys(byEid).sort(), ['l1', 'l2', 'l3', 'v1']);
  assert.equal(byEid.l1.channel, 'mytool'); assert.equal(byEid.l1.confidence, 'declared'); assert.equal(byEid.l1.linkKind, 'brief'); assert.equal(byEid.l1.kind, 'spawn');
  assert.deepEqual(byEid.l2.stub, { side: 'from', label: 'relay.mjs' }); assert.equal(byEid.l2.id, 'name:relay.mjs'); assert.equal(byEid.l2.linkKind, undefined, 'same as kind: not repeated');
  assert.equal(byEid.l3.kind, 'handoff');
  assert.equal(byEid.v1.linkKind, 'reply'); assert.equal(byEid.v1.channel, 'direct');
  const today = j.today();
  assert.equal(today.stats.reports, 1);
});

test('config: the links folder comes from AI_OFFICE_LINKS_DIR or ~/.ai-office/links', () => {
  assert.ok(CONFIG.links.dir.endsWith(process.env.AI_OFFICE_LINKS_DIR ? path.basename(process.env.AI_OFFICE_LINKS_DIR) : path.join('.ai-office', 'links')));
  assert.equal(CONFIG.links.textMax, 200);
  assert.equal(CONFIG.links.maxAgeMs, 24 * HOUR);
});

// ---------------------------------------------------------------- pids for every vendor (Milestone 12, E1)

// the live `ps -axo pid,ppid,lstart,command` shape: a CLI codex per thread, a sandbox helper under it, a claude it launched
const PS2 = `  PID  PPID STARTED                  COMMAND
    1     0 Sun Oct 25 04:00:00 2026 /sbin/launchd
  102     1 Sun Oct 25 04:00:01 2026 -zsh
  700   102 Sun Oct 25 04:10:14 2026 /opt/homebrew/bin/codex exec --json
  701   700 Sun Oct 25 04:10:14 2026 codex sandbox -c shell_environment_policy.inherit="all"
  702   700 Sun Oct 25 04:10:20 2026 claude -p
  800   102 Sun Oct 25 04:10:14 2026 /opt/homebrew/bin/codex
  900   102 Sun Oct 25 05:00:00 2026 node /usr/local/bin/gemini
`;
const T = s => Date.parse(`Sun Oct 25 ${s} 2026`);
const CWDS = { 700: '/w/one', 701: '/w/one', 702: '/w/one', 800: '/w/two', 900: '/g' };

test('process: the weak join needs the vendor CLI, a start within a minute, the same cwd, one candidate and one claimant', async () => {
  const table = parsePs(PS2);
  const asked = [];
  const cwdOf = async pid => { asked.push(pid); return CWDS[pid] || null; };
  const codex1 = agent('codex:t1', { cwd: '/w/one', startedAt: T('04:10:20'), pid: null });
  const gem = agent('gemini:g1', { cwd: '/g', startedAt: T('05:00:30'), pid: null });
  const cur = agent('cursor:c1', { cwd: '/w/one', startedAt: null, pid: null });          // no start time: never joined
  const late = agent('codex:t9', { cwd: '/w/two', startedAt: T('04:20:00'), pid: null }); // ten minutes off: never joined
  let joins = await weakJoins(table, [codex1, gem, cur, late], cwdOf, { slackMs: 60 * SEC });
  assert.deepEqual([...joins], [[700, 'codex:t1'], [900, 'gemini:g1']]);
  assert.ok(!asked.includes(701), 'a `codex sandbox` helper is never a candidate');
  assert.ok(!asked.includes(702), 'a claude process is not a candidate for a codex thread');
  // two threads in the same cwd started together: the one process cannot be told apart, nobody gets it
  const codex2 = agent('codex:t2', { cwd: '/w/one', startedAt: T('04:10:30'), pid: null });
  joins = await weakJoins(table, [codex1, codex2], cwdOf, { slackMs: 60 * SEC });
  assert.deepEqual([...joins], []);
  // a pid already explicit elsewhere is not up for grabs
  joins = await weakJoins(table, [codex1], cwdOf, { taken: new Set([700]), slackMs: 60 * SEC });
  assert.deepEqual([...joins], []);
  // an explicit pid on the agent itself skips the join
  joins = await weakJoins(table, [agent('codex:t3', { cwd: '/w/one', startedAt: T('04:10:20'), pid: 4242 })], cwdOf, { slackMs: 60 * SEC });
  assert.deepEqual([...joins], []);
});

test('process: a launch link through a weak pid is `artifact`, through explicit pids `structural`', () => {
  const table = parsePs(PS2);
  const agents = new Map([[700, 'codex:t1'], [702, 'claude:c1']]);
  let links = linksFromTable(table, agents, { now: 1, weak: new Set([700]) });
  assert.deepEqual(links.map(l => [l.from, l.to, l.confidence]), [['codex:t1', 'claude:c1', 'artifact']]);
  links = linksFromTable(table, agents, { now: 1 });
  assert.deepEqual(links.map(l => [l.from, l.to, l.confidence]), [['codex:t1', 'claude:c1', 'structural']]);
});

test('process reader: collector pids are structural, weak joins fill ctx.pidWeak, cwd is asked once per process', async () => {
  const reg = tmp('registry');
  fs.writeFileSync(path.join(reg, '702.json'), JSON.stringify({ pid: 702, sessionId: 'c1', cwd: '/w/one' }));
  const asked = [];
  const r = createProcessReader({ ps: async () => PS2, everyMs: 10 * SEC, registryDir: reg, cwdOf: async pid => { asked.push(pid); return CWDS[pid] || null; } });
  const agents = [agent('codex:t1', { cwd: '/w/one', startedAt: T('04:10:20'), pid: null }), agent('claude:c1', { cwd: '/w/one', pid: 702 }), agent('gemini:g1', { cwd: '/g', startedAt: T('05:00:30'), pid: null })];
  const ctx = { agents, links: [], pidMap: new Map(), pidWeak: new Set() };
  const t0 = 100 * SEC;
  const links = await r.read(t0, ctx);
  assert.deepEqual([...ctx.pidMap].sort((a, b) => a[0] - b[0]), [[700, 'codex:t1'], [702, 'claude:c1'], [900, 'gemini:g1']]);
  assert.deepEqual([...ctx.pidWeak].sort(), [700, 900]);
  assert.deepEqual(links.map(l => [l.from, l.to, l.confidence]), [['codex:t1', 'claude:c1', 'artifact']]);
  assert.equal(r.stats().weakPids, 2);
  const askedOnce = asked.length;
  // next polls: the cwd cache answers, the join holds
  const ctx2 = { agents, links: [], pidMap: new Map(), pidWeak: new Set() };
  await r.read(t0 + 2 * SEC, ctx2); await r.read(t0 + 11 * SEC, ctx2);
  assert.equal(asked.length, askedOnce, 'lsof is not run again for a process already asked');
  assert.deepEqual([...ctx2.pidWeak].sort(), [700, 900]);
  // the codex thread leaves: its weak pid goes with it
  const ctx3 = { agents: agents.slice(1), links: [], pidMap: new Map(), pidWeak: new Set() };
  await r.read(t0 + 12 * SEC, ctx3);
  assert.deepEqual([...ctx3.pidMap].sort((a, b) => a[0] - b[0]), [[702, 'claude:c1'], [900, 'gemini:g1']]);

  // through buildSnapshot: pid / pidWeak on each agent, the dashed launch as an event, no touches in the snapshot
  const loader = createLinkLoader({ readers: [r], log: () => {}, recovered: () => {} });
  const snap = await buildSnapshot(t0 + 13 * SEC, { collectors: [['[fake]', async () => agents.map(a => ({ ...a, touches: [{ path: '/x', op: 'read', at: t0 }] }))]], links: loader, resolver: new LinkResolver(), events: new Map() });
  const by = Object.fromEntries(snap.agents.map(a => [a.id, a]));
  assert.deepEqual([by['codex:t1'].pid, by['codex:t1'].pidWeak], [700, true]);
  assert.deepEqual([by['claude:c1'].pid, by['claude:c1'].pidWeak], [702, false]);
  assert.deepEqual([by['gemini:g1'].pid, by['gemini:g1'].pidWeak], [900, true]);
  for (const a of snap.agents) assert.equal(a.touches, undefined);
  const ev = snap.events.find(e => e.kind === 'launch');
  assert.deepEqual([ev.from, ev.to, ev.confidence, ev.channel], ['codex:t1', 'claude:c1', 'artifact', 'process']);
  assert.equal(by['claude:c1'].parentId, null, 'a launch guessed from a weak pid adopts nobody: artifact never drives behaviour');
  // the same chain with both pids explicit: structural, and the launched desk sits in the launcher pod
  fs.writeFileSync(path.join(reg, '700.json'), JSON.stringify({ pid: 700, sessionId: 't1-as-claude', cwd: '/w/one' }));
  const r2 = createProcessReader({ ps: async () => PS2, everyMs: 10 * SEC, registryDir: reg, cwdOf: async () => null });
  const loader2 = createLinkLoader({ readers: [r2], log: () => {}, recovered: () => {} });
  const both = [agent('claude:t1-as-claude', { cwd: '/w/one', pid: 700 }), agent('claude:c1', { cwd: '/w/one', pid: 702 })];
  const snap2 = await buildSnapshot(t0 + 14 * SEC, { collectors: [['[fake]', async () => both.map(a => ({ ...a }))]], links: loader2, resolver: new LinkResolver(), events: new Map() });
  assert.equal(snap2.agents.find(a => a.id === 'claude:c1').parentId, 'claude:t1-as-claude');
  assert.equal(snap2.events.find(e => e.kind === 'launch').confidence, 'structural');
});
