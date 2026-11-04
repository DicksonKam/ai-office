// npm run synccheck [-- gapSeconds samples] : one office, two tabs. Runs the crowd demo from a server, opens a tab, opens
// a second one `gap` seconds later (default 90) and compares them every 15 s: who sits where, who is on which floor, who
// is doing what, and where they stand (walks to within 3.5 m, about 1.5 s). Exits 1, naming the differences, if the tabs
// disagree. `-- --live` compares two tabs on the running office server instead (the real agents).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { startCrowdServer } from './crowdserver.mjs';

const args = process.argv.slice(2), live = args.includes('--live'), nums = args.filter(a => /^\d+$/.test(a)).map(Number);
const GAP = nums[0] ?? 90, SAMPLES = nums[1] ?? 12, EVERY = 15000, WALK_TOL = 3.5, STILL_TOL = 1.2, MAX_BAD_SHARE = 0.03;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 4600 + Math.floor(Math.random() * 300);
const feed = live ? null : await startCrowdServer(port, 24);
const url = `http://localhost:${live ? CONFIG.port : port}/?hour=14`;
const CH = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-synccheck-'));
const dbg = 9300 + Math.floor(Math.random() * 500);
const ch = spawn(CH, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--window-size=640,400', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
const done = code => { try { ch.kill(); } catch { /* gone */ } feed?.close(); process.exit(code); };
let up = false;
for (let i = 0; i < 50 && !up; i++) { try { await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); up = true; } catch { await sleep(200); } }
if (!up) { console.error('synccheck: Chrome did not start'); done(2); }
async function openTab(u) {
  const t = await (await fetch(`http://127.0.0.1:${dbg}/json/new?${encodeURIComponent(u)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails.exception?.description?.split('\n')[0]); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  return async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
}
// (headless software rendering draws a frame every few seconds: bring the simulation to this moment before reading it)
const DIGEST = `(() => { const m = window.__office?.mgr; if (!m) return null; window.__office.stepNow(); return { t: Date.now(), floors: m.floors.length, list: m.list.filter(w => !w.done).map(w => ({ id: w.id, name: w.name, f: w.floor, seq: w.planSeq,
  seat: w.desk ? w.desk.floor + '/' + w.desk.id : w.slot ? w.slot.pod.floor + '/' + w.slot.pod.id + '#' + w.slot.index : null, st: w.state, next: w.next, k: w.ambientKind || null, x: w.pos.x, z: w.pos.z })) }; })()`;
const ready = `new Promise(r => { const t0 = performance.now(), iv = setInterval(() => { const m = window.__office?.mgr; if ((m && m.list.length) || performance.now() - t0 > 60000) { clearInterval(iv); const c = {}; if (m) for (const w of m.list) { const k = w.state === 'walk' ? 'walking' : 'placed'; c[k] = (c[k] || 0) + 1; } r(c); } }, 100); })`;

const A = await openTab(url);
console.log('tab A opened');
await sleep(GAP * 1000);
const B = await openTab(url);
const first = await B(ready);
console.log(`tab B opened ${GAP} s later; on its first frame: ${JSON.stringify(first)}`);
await sleep(EVERY);

let compared = 0, bad = 0, moving = 0; const skews = [], between = [];
const problems = new Map();
const note = (kind, w, text) => { bad++; const k = `${kind}:${w.id}`; if (!problems.has(k)) problems.set(k, `${kind}: ${w.name} ${text}`); };
for (let s = 0; s < SAMPLES; s++) {
  const [a, b] = await Promise.all([A(DIGEST), B(DIGEST)]);
  // a tab busy drawing a frame answers late: the two readings may be seconds apart, which walks must be allowed for
  const skew = Math.abs(a.t - b.t) / 1000; skews.push(skew);
  if (a.floors !== b.floors) { bad++; problems.set('floors', `floors: ${a.floors} vs ${b.floors}`); }
  const inB = new Map(b.list.map(w => [w.id, w]));
  for (const w of a.list) {
    const o = inB.get(w.id); inB.delete(w.id);
    if (!o) { if (w.st !== 'walk') note('only-in-A', w, `(${w.st})`); continue; }
    compared++;
    if (w.seq !== o.seq) { moving++; between.push({ w, need: Math.max(w.seq, o.seq) }); continue; } // caught between two ticks: rechecked below
    if (w.seat !== o.seat) note('seat', w, `${w.seat} vs ${o.seat}`);
    const walkA = w.st === 'walk', walkB = o.st === 'walk';
    const sameState = w.st === o.st || (walkA && w.next === o.st) || (walkB && o.next === w.st);
    if (!sameState && skew < 1) note('activity', w, `${w.st}→${w.next} vs ${o.st}→${o.next}`);
    if (w.k !== o.k) note('stop', w, `${w.k} vs ${o.k}`);
    const d = Math.hypot(w.x - o.x, w.z - o.z);
    if (w.f === o.f && d > (walkA || walkB ? WALK_TOL + 2.7 * skew : STILL_TOL)) note('position', w, `${d.toFixed(1)} m apart (${w.st}, ${o.st}, readings ${skew.toFixed(1)} s apart)`);
  }
  for (const o of inB.values()) if (o.st !== 'walk') note('only-in-B', o, `(${o.st})`);
  // tabs on different steps are fine for a moment; a tab still behind 3 s later is not getting the plan
  if (between.length) {
    await sleep(3000);
    const [a2, b2] = await Promise.all([A(DIGEST), B(DIGEST)]);
    for (const { w, need } of between.splice(0)) for (const [tab, d] of [['A', a2], ['B', b2]]) { const n = d.list.find(x => x.id === w.id); if (n && n.seq < need) note('behind', w, `tab ${tab} still on step ${n.seq} of ${need} after 3 s`); }
  }
  if (s < SAMPLES - 1) await sleep(EVERY);
}
console.log(`compared ${compared} worker readings across ${SAMPLES} samples (readings ${Math.max(...skews).toFixed(1)} s apart at most); ${moving} caught between ticks; ${bad} differences`);
for (const t of [...problems.values()].slice(0, 25)) console.log('  ' + t);
const share = compared ? bad / compared : 1;
if (!compared || share > MAX_BAD_SHARE) { console.error(`synccheck: tabs disagree (${(share * 100).toFixed(1)} % of readings)`); done(1); }
console.log(`synccheck: tabs agree (${(share * 100).toFixed(1)} % of readings differ, allowed ${MAX_BAD_SHARE * 100} %)`);
done(0);
