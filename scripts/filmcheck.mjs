// Does a film agree with what was recorded? For every journal day: at many moments, who was in, working and waiting, read
// from the lines by a plain reader of its own, against the film. Prints times and counts only, never task text.
// npm run filmcheck
import fs from 'node:fs';
import path from 'node:path';
import { makeFilm } from '../web/film.js';
import { withoutBlips, parseEntries } from '../server/journal.js';
import { CONFIG } from '../server/config.js';

const dir = CONFIG.journal.dir, MOMENTS = 400;
const days = fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort();

/** straight from the lines: the last word on each person at or before `t` */
function fromLines(lines, t) {
  const out = new Map();
  for (const e of lines) {
    if (e.t > t) break;
    if (e.kind === 'arrived') out.set(e.id, { working: e.status === 'working', asking: out.get(e.id)?.asking || false });
    else if (e.kind === 'left') out.delete(e.id);
    else if (e.kind === 'working' && out.has(e.id)) out.get(e.id).working = true;
    else if (e.kind === 'idle' && out.has(e.id)) out.get(e.id).working = false;
    else if (e.kind === 'asking-start' && out.has(e.id)) out.get(e.id).asking = true;
    else if (e.kind === 'asking-end' && out.has(e.id)) out.get(e.id).asking = false;
  }
  return out;
}

let bad = 0, moments = 0, seats = 0, unplanned = 0;
console.log('day         lines  frames   ms   MB  moments  disagree  shared-seat  no-plan');
for (const f of days) {
  const lines = withoutBlips(parseEntries(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => a.t - b.t);
  if (!lines.length) continue;
  const from = lines[0].t, to = lines[lines.length - 1].t + 60000;
  const t0 = performance.now();
  const film = makeFilm(lines, { from, to });
  const ms = Math.round(performance.now() - t0);
  const mb = film.frames.reduce((n, x) => n + x.plan.length, 0) / 1048576;
  let dis = 0, seat = 0, none = 0, n = 0;
  const near = t => lines.some(e => Math.abs(e.t - t) < 3100);
  for (let i = 0; i < MOMENTS; i++) {
    const t = from + (to - from) * (i + 0.5) / MOMENTS;
    if (near(t)) continue;
    n++;
    const want = fromLines(lines, t), got = film.at(t);
    const have = new Map(got.agents.map(a => [a.id, a]));
    let same = want.size === have.size;
    for (const [id, w] of want) { const a = have.get(id); if (!a || (a.status === 'working') !== w.working || !!a.asking !== w.asking) same = false; }
    if (!same) dis++;
    const taken = new Set();
    for (const a of got.agents) {
      const p = got.plan.workers[a.id];
      if (!p) { none++; continue; }
      if (p.desk) { const k = `${p.desk.f}/${p.desk.d}`; if (taken.has(k)) seat++; taken.add(k); }
    }
  }
  bad += dis; moments += n; seats += seat; unplanned += none;
  console.log(f.slice(0, 10), String(lines.length).padStart(6), String(film.frames.length).padStart(6), String(ms).padStart(5), mb.toFixed(1).padStart(5), String(n).padStart(7), String(dis).padStart(8), String(seat).padStart(11), String(none).padStart(8));
}
console.log(`\n${moments} moments checked: ${bad} disagree, ${seats} shared desks, ${unplanned} people with no plan`);
if (bad || seats || unplanned) process.exitCode = 1;
