// The director: one plan, whoever watches it. Runs the crowd script's kind of input through it, with no 3D.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Director, LAYOUT, breakAnim, BREAK_CYCLES } from '../web/director.js';

const T0 = 1800000000000;
const agent = (id, extra = {}) => ({ id, vendor: 'claude', status: 'working', startedAt: T0 - 3600000, thought: null, parentId: null, ...extra });
const run = (d, script, from, to, stepS = 1) => { let plan; for (let t = from; t <= to; t += stepS) plan = d.update(script(t), script.events?.(t) || [], T0 + t * 1000, { finishedMinMs: 30000 }); return plan; };
const seatsOf = plan => Object.values(plan.workers).flatMap(w => [w.desk && `desk ${w.desk.f}/${w.desk.d}`, w.slot && `slot ${w.slot.f}/${w.slot.d}#${w.slot.i}`, w.seat && `seat ${w.seat.kind} ${w.seat.f}/${w.seat.i}`, w.qa && `qa ${w.qa.f}/${w.qa.i}`].filter(Boolean));

test('whoever is in when the director starts is already at their place; a later session walks in', () => {
  const d = new Director({ seed: 1 });
  const plan = d.update([agent('a'), agent('b', { startedAt: T0 - 5000 })], [], T0);
  assert.equal(plan.workers.a.step.k, 'desk');
  assert.equal(plan.workers.a.step.walk, 0);
  assert.equal(plan.workers.b.step.k, 'in', 'started seconds ago: really arriving');
  const later = d.update([agent('a'), agent('b', { startedAt: T0 - 5000 }), agent('c')], [], T0 + 2000);
  assert.equal(later.workers.c.step.k, 'in', 'appeared while the office was running');
});

test('the same inputs make the same plan, and a plan only changes when a decision is made', () => {
  const script = t => [agent('a', { status: t > 20 ? 'idle' : 'working', idleSince: T0 + 20000 }), agent('b')];
  const p1 = run(new Director({ seed: 5 }), script, 0, 200), p2 = run(new Director({ seed: 5 }), script, 0, 200);
  assert.deepEqual(p1, p2);
  const d = new Director({ seed: 5 });
  const a = d.update([agent('a'), agent('b')], [], T0), b = d.update([agent('a'), agent('b')], [], T0 + 1000);
  assert.deepEqual(a, b, 'nothing happened: nothing to send');
});

test('a restart resumes: saved and restored, the plan goes on as if nothing had happened', () => {
  const script = t => [agent('l', { role: 'lead' }), agent('h', { parentId: 'l', role: 'helper', depth: 1 }), agent('m', { status: t > 30 ? 'idle' : 'working', idleSince: T0 + 30000 })];
  const whole = new Director({ seed: 9 });
  const first = new Director({ seed: 9 });
  run(whole, script, 0, 100); run(first, script, 0, 100);
  const resumed = new Director({ state: JSON.parse(JSON.stringify(first)) });
  assert.deepEqual(run(resumed, script, 101, 300), run(whole, script, 101, 300));
});

test('nobody ever shares a seat, however crowded, and floors grow and go', () => {
  const crowd = t => Array.from({ length: 40 }, (_, i) => agent(`m${i}`, { status: (t + i * 7) % 300 > 120 ? 'idle' : 'working', idleSince: T0 + (t - 1) * 1000 }));
  const d = new Director({ seed: 3 });
  let plan;
  for (let t = 0; t < 900; t += 2) {
    plan = d.update(crowd(t), [], T0 + t * 1000, { finishedMinMs: 30000 });
    const seats = seatsOf(plan), held = Object.entries(plan.workers).map(([, w]) => w.step).filter(s => s.k === 'ambient' && s.a !== 'chat').map(s => `${s.a} ${s.f}/${s.i}`);
    assert.equal(new Set(seats).size, seats.length, `double-booked at ${t} s`);
    assert.equal(new Set(held).size, held.length, `one spot, two people at ${t} s`);
  }
  assert.ok(plan.floors >= Math.ceil(40 / LAYOUT.desks.length), 'six desks a floor');
  const quiet = d.update([], [], T0 + 900000);
  assert.equal(Object.values(quiet.workers).every(w => w.leaving || w.missingSince !== 0), true);
  for (let t = 910; t < 1700; t += 5) d.update([], [], T0 + t * 1000);
  assert.equal(d.update([], [], T0 + 1700000).floors, 1, 'an empty upper floor goes after a while');
});

test('helpers join their lead; a spawn with a free room is a kickoff; three helpers use the meeting room', () => {
  const d = new Director({ seed: 2 });
  const lead = agent('l', { role: 'lead' });
  let t = 0; const at = () => T0 + (t += 1) * 1000;
  d.update([lead], [], at());
  const helpers = ['h1', 'h2', 'h3'].map(id => agent(id, { parentId: 'l', role: 'helper', depth: 1, startedAt: T0 }));
  const events = helpers.map(h => ({ id: `s-${h.id}`, kind: 'spawn', from: 'l', to: h.id, at: T0 + 2000, text: 'part' }));
  let plan = d.update([lead, ...helpers], events, at());
  assert.equal(plan.workers.l.step.k, 'meet');
  assert.ok(plan.rooms['0:huddle'] || plan.rooms['0:meeting']);
  let sawSession = false;
  for (let i = 0; i < 120; i++) { plan = d.update([lead, ...helpers], events, at()); if (Object.values(plan.rooms).some(r => r.session)) sawSession = true; }
  assert.ok(sawSession, 'the kickoff took place');
  assert.equal(plan.workers.l.step.k, 'desk', 'the lead is back at the desk');
  for (const h of helpers) { assert.equal(plan.workers[h.id].step.k, 'slot'); assert.deepEqual([plan.workers[h.id].slot.f, plan.workers[h.id].slot.d], [plan.workers.l.desk.f, plan.workers.l.desk.d]); }
});

test('a report is a trip: the printer, then the lead, then a sheet on the pile; old reports just count', () => {
  const d = new Director({ seed: 2 });
  const lead = agent('l', { role: 'lead' }), helper = agent('h', { parentId: 'l', role: 'helper', depth: 1 });
  let t = 0; const at = () => T0 + (t += 1) * 1000;
  d.update([lead, helper], [{ id: 'old', kind: 'report', from: 'h', to: 'l', at: T0 - 300000 }], at());
  assert.equal(d.update([lead, helper], [], at()).workers.l.reports, 1, 'a report from before: on the pile, nobody walks');
  const ev = [{ id: 'r1', kind: 'report', from: 'h', to: 'l', at: T0 + 3000, text: 'done' }];
  const kinds = new Set(); let plan;
  for (let i = 0; i < 60; i++) { plan = d.update([lead, helper], ev, at()); kinds.add(plan.workers.h.step.k); }
  assert.ok(kinds.has('collect') && kinds.has('present'), [...kinds].join());
  assert.equal(plan.workers.h.step.k, 'slot');
  assert.equal(plan.workers.l.reports, 2);
});

test('a review is collected, stamped and delivered', () => {
  const d = new Director({ seed: 2 });
  const lead = agent('l', { role: 'lead' }), g = agent('g', { parentId: 'l', role: 'reviewer', kind: 'guardian' });
  let t = 0; const at = () => T0 + (t += 1) * 1000;
  d.update([lead, g], [], at());
  const kinds = []; let plan;
  const ev = [{ id: 'rv', kind: 'review', from: 'g', to: 'l', at: T0 + 2000 }];
  for (let i = 0; i < 40; i++) { plan = d.update([lead, g], ev, at()); const k = plan.workers.g.step.k; if (kinds.at(-1) !== k) kinds.push(k); }
  const ev2 = [...ev, { id: 'vd', kind: 'verdict', from: 'g', to: 'l', at: T0 + t * 1000, verdict: { outcome: 'allow', risk: 'low' } }];
  for (let i = 0; i < 60; i++) { plan = d.update([lead, g], ev2, at()); const k = plan.workers.g.step.k; if (kinds.at(-1) !== k) kinds.push(k); }
  assert.deepEqual(kinds, ['review', 'qa', 'handover', 'qa']);
  assert.equal(plan.qaOut[plan.workers.g.step.f], 1);
  assert.equal(plan.workers.g.review, null);
});

test('a finished session rests at the desk, goes for coffee, sits down and comes back when work starts', () => {
  const d = new Director({ seed: 4 });
  let idle = false, idleAt = null; const m = () => agent('m', { status: idle ? 'idle' : 'working', idleSince: idle ? idleAt : null });
  let t = 0; const at = () => T0 + (t += 1) * 1000;
  for (let i = 0; i < 40; i++) d.update([m()], [], at(), { finishedMinMs: 30000 });
  idle = true; idleAt = T0 + t * 1000;
  const seen = new Set(); let plan;
  for (let i = 0; i < 300; i++) { plan = d.update([m()], [], at()); seen.add(plan.workers.m.step.k); }
  assert.ok(plan.workers.m.readyAt > 0, 'worked long enough: finished, your turn');
  for (const k of ['stretch', 'brew', 'break']) assert.ok(seen.has(k), `${k} in ${[...seen].join()}`);
  idle = false;
  plan = d.update([m()], [], at());
  assert.equal(plan.workers.m.step.k, 'desk');
});

test('someone gone says goodbye and leaves; back in time, they turn around; a leaver still has a record to draw', () => {
  const d = new Director({ seed: 4 });
  const m = agent('m');
  let t = 0; const at = () => T0 + (t += 1) * 1000;
  d.update([m], [], at());
  let plan;
  for (let i = 0; i < 8; i++) plan = d.update([], [], at());
  assert.equal(plan.workers.m.step.k, 'exit'); assert.ok(plan.workers.m.agent, 'a late tab can still draw them');
  assert.equal(plan.workers.m.desk, null, 'the desk is free at once');
  plan = d.update([m], [], at());
  assert.equal(plan.workers.m.step.k, 'desk'); assert.equal(plan.workers.m.leaving, false);
  for (let i = 0; i < 40; i++) plan = d.update([], [], at());
  assert.equal(plan.workers.m, undefined, 'out of the door');
  plan = d.update([m], [], at());
  assert.equal(plan.workers.m.step.k, 'in', 'back later: a fresh arrival');
});

test('a break pose follows the clock alone, so every tab agrees', () => {
  assert.equal(breakAnim('cafe', 0, 0), 'sip');
  assert.equal(breakAnim('cafe', 0, 6.5), 'chat');
  const total = BREAK_CYCLES.cafe.reduce((n, [, s]) => n + s, 0);
  assert.equal(breakAnim('cafe', 0, total + 6.5), 'chat');
});

test('the way in: walking times follow the real route, and several arriving together leave the lobby one after another', async () => {
  const { ENTRY_M } = await import('../web/director.js');
  const d = new Director({ seed: 3 });
  d.update([agent('lead')], [], T0);
  const kids = ['h1', 'h2', 'h3', 'h4'].map(id => agent(id, { parentId: 'lead', role: 'helper', startedAt: T0 + 1000 }));
  const plan = d.update([agent('lead'), ...kids], [], T0 + 1000);
  const starts = kids.map(k => plan.workers[k.id].step.since - (T0 + 1000));
  assert.deepEqual(starts, [0, 450, 900, 1350]);
  for (const k of kids) assert.ok(Math.abs(plan.workers[k.id].step.walk - ENTRY_M * 5.5 / 10.9) < 1e-9, 'the old pace over the real length');
  const later = d.update([agent('lead'), ...kids, agent('solo', { startedAt: T0 + 20000 })], [], T0 + 20000);
  assert.equal(later.workers.solo.step.since, T0 + 20000, 'someone alone does not wait for anyone');
});
