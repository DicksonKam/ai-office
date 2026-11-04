#!/usr/bin/env node
// Replay a day journal (data/journal/YYYY-MM-DD.jsonl) and report suspicious patterns:
//   flicker (left and back within 60 s, left while working and back within 10 min, or too many arrive/leave cycles
//   per hour), asking episodes that are too short
//   or too long (false "waiting on you"), orphan helpers, reports from agents that never arrived, status toggling,
//   double-logged arrivals / events, plus a daily summary.
//
//   npm run validate                      today's file
//   npm run validate -- path/to/day.jsonl  a specific file (or a date: 2026-10-26)
//   options: --json  --cycles=N (arrive/leave cycles per hour before flagging, default 4)  --limit=N (rows per section)
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../server/config.js';
import { localDate, journalFile, readEntries, digest } from '../server/journal.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : def; };
const asJson = args.includes('--json');
const CYCLES_PER_HOUR = opt('cycles', 4);
const LIMIT = opt('limit', 12);
const REARRIVE_MS = 60 * 1000;
const WORKING_REARRIVE_MS = 10 * 60 * 1000; // left straight from working and came back: the worker never really left
const ASK_MIN_MS = 3 * 1000;
const ASK_MAX_MS = 2 * 3600 * 1000;
const TOGGLE_MS = 10 * 1000;

const target = args.find(a => !a.startsWith('--'));
const file = !target ? journalFile(localDate())
  : /^\d{4}-\d{2}-\d{2}$/.test(target) ? journalFile(target)
  : path.resolve(target);
if (!fs.existsSync(file)) { console.error(`No journal at ${file}`); process.exit(2); }

const entries = readEntries(file);
const date = path.basename(file, '.jsonl');
const fmtT = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.journal.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hms = t => fmtT.format(new Date(t));
const dur = ms => ms < 60e3 ? `${(ms / 1000).toFixed(1)}s` : ms < 3600e3 ? `${(ms / 60e3).toFixed(1)}m` : `${(ms / 3600e3).toFixed(2)}h`;

// ---- replay -----------------------------------------------------------------------------------------------------
const who = new Map();        // id -> last known info
const arrivals = new Map();   // id -> [t]
const present = new Map();    // id -> arrived t
const lastLeft = new Map();   // id -> t
const leftWorking = new Map(); // id -> t it left while its last status was working
const status = new Map();     // id -> { s, t }
const askOpen = new Map();    // id -> { t, text }
const everArrived = new Set();
const seenEid = new Map();

const issues = { rearrived: [], workingRearrived: [], cycling: [], askShort: [], askLong: [], askOpenLong: [], orphanParent: [], helperAlone: [],
  reportNoArrival: [], reportToUnknown: [], toggles: [], doubleArrive: [], doubleEvent: [], leftUnknown: [], labelOnLeave: [] };
const toggleCount = new Map(); // id -> { n, minGap }

const name = id => { const w = who.get(id); return w ? `${w.nickname || w.task || id}`.slice(0, 48) + ` [${w.vendor}/${w.agentKind}${w.project ? ' · ' + w.project : ''}]` : id; };
let outOfOrder = 0, lastT = 0;

for (const e of entries) {
  if (e.t < lastT) outOfOrder++;
  lastT = Math.max(lastT, e.t);
  const taskBefore = e.id ? who.get(e.id)?.task : undefined; // the label it carried before this line
  if (e.id && !e.eid) who.set(e.id, { ...who.get(e.id), ...e });
  switch (e.kind) {
    case 'arrived': {
      if (present.has(e.id)) issues.doubleArrive.push({ id: e.id, t: e.t, since: present.get(e.id) });
      present.set(e.id, e.t);
      everArrived.add(e.id);
      const left = lastLeft.get(e.id);
      if (left != null && e.t - left <= REARRIVE_MS) issues.rearrived.push({ id: e.id, t: e.t, gap: e.t - left });
      const lw = leftWorking.get(e.id);
      if (lw != null && e.t - lw <= WORKING_REARRIVE_MS) issues.workingRearrived.push({ id: e.id, t: e.t, gap: e.t - lw });
      leftWorking.delete(e.id);
      if (!e.carried) {
        const list = arrivals.get(e.id) || []; list.push(e.t); arrivals.set(e.id, list);
      }
      if ((e.agentKind === 'subagent') && !e.parentId) issues.helperAlone.push({ id: e.id, t: e.t });
      status.set(e.id, { s: e.status || null, t: e.t, arrival: true });
      break;
    }
    case 'left': {
      if (!present.has(e.id)) issues.leftUnknown.push({ id: e.id, t: e.t });
      if (taskBefore != null && e.task != null && e.task !== taskBefore) issues.labelOnLeave.push({ id: e.id, t: e.t, from: taskBefore, to: e.task });
      present.delete(e.id);
      lastLeft.set(e.id, e.t);
      if (status.get(e.id)?.s === 'working' || e.workedMs != null) leftWorking.set(e.id, e.t); else leftWorking.delete(e.id);
      const a = askOpen.get(e.id);
      if (a) { closeAsk(e.id, a, e.t); askOpen.delete(e.id); }
      status.delete(e.id);
      break;
    }
    case 'working': case 'idle': {
      const prev = status.get(e.id);
      if (prev?.s && prev.s !== e.kind && !prev.arrival) { // a back-and-forth, not the first change after arriving
        const gap = e.t - prev.t;
        if (gap < TOGGLE_MS) {
          const c = toggleCount.get(e.id) || { n: 0, minGap: Infinity, first: e.t };
          c.n++; c.minGap = Math.min(c.minGap, gap); c.last = e.t; toggleCount.set(e.id, c);
        }
      }
      status.set(e.id, { s: e.kind, t: e.t });
      break;
    }
    case 'asking-start':
      if (!askOpen.has(e.id)) askOpen.set(e.id, { t: e.t, text: e.text, carried: e.carried });
      break;
    case 'asking-end': {
      const a = askOpen.get(e.id);
      if (a) { closeAsk(e.id, a, e.t); askOpen.delete(e.id); }
      break;
    }
  }
  if (e.eid) {
    if (seenEid.has(e.eid)) issues.doubleEvent.push({ eid: e.eid, t: e.t, first: seenEid.get(e.eid) });
    else seenEid.set(e.eid, e.t);
    if (e.kind === 'report') {
      if (!everArrived.has(e.id)) issues.reportNoArrival.push({ id: e.id, t: e.at || e.t, text: e.text });
      if (e.to && !everArrived.has(e.to)) issues.reportToUnknown.push({ id: e.id, to: e.to, t: e.at || e.t });
    }
  }
}

function closeAsk(id, a, t) {
  const d = t - a.t;
  if (d < ASK_MIN_MS && !a.carried) issues.askShort.push({ id, t: a.t, d, text: a.text });
  if (d > ASK_MAX_MS) issues.askLong.push({ id, t: a.t, d, text: a.text });
}
for (const [id, a] of askOpen) if (lastT - a.t > ASK_MAX_MS) issues.askOpenLong.push({ id, t: a.t, d: lastT - a.t, text: a.text });

// parents that never showed up
const parents = new Map();
for (const e of entries) if (e.parentId && !e.eid) { if (!parents.has(e.parentId)) parents.set(e.parentId, new Set()); parents.get(e.parentId).add(e.id); }
for (const [pid, kids] of parents) if (!everArrived.has(pid)) issues.orphanParent.push({ parentId: pid, helpers: [...kids] });

// arrive/leave cycles in any 1-hour window
for (const [id, ts] of arrivals) {
  let best = 0, at = 0;
  for (let i = 0, j = 0; i < ts.length; i++) { while (ts[i] - ts[j] > 3600e3) j++; if (i - j + 1 > best) { best = i - j + 1; at = ts[j]; } }
  if (best > CYCLES_PER_HOUR) issues.cycling.push({ id, cycles: best, from: at });
}
for (const [id, c] of toggleCount) issues.toggles.push({ id, n: c.n, minGap: c.minGap, first: c.first, last: c.last });
issues.toggles.sort((a, b) => b.n - a.n);
issues.cycling.sort((a, b) => b.cycles - a.cycles);

// ---- summary ----------------------------------------------------------------------------------------------------
const day = digest(date, entries);
const byKind = {};
for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
const byVendor = {};
for (const [, w] of who) { const k = `${w.vendor}/${w.agentKind}`; byVendor[k] = (byVendor[k] || 0) + 1; }
const asks = entries.filter(e => e.kind === 'asking-start' && !e.carried).length;
const summary = {
  file, date, entries: entries.length, bytes: fs.statSync(file).size,
  span: entries.length ? `${hms(entries[0].t)} – ${hms(lastT)}` : null,
  outOfOrder, byKind, agents: who.size, byVendor, stillPresent: present.size, stillAsking: askOpen.size,
  stats: day.stats, askingEpisodes: asks,
};

if (asJson) {
  console.log(JSON.stringify({ summary, thresholds: { CYCLES_PER_HOUR, REARRIVE_MS, WORKING_REARRIVE_MS, ASK_MIN_MS, ASK_MAX_MS, TOGGLE_MS }, issues }, null, 2));
  process.exit(0);
}

const out = [];
const section = (title, rows, fmt) => {
  out.push(`${rows.length ? '!!' : 'ok'}  ${title}: ${rows.length}`);
  for (const r of rows.slice(0, LIMIT)) out.push('      ' + fmt(r));
  if (rows.length > LIMIT) out.push(`      … ${rows.length - LIMIT} more`);
};
out.push(`Journal ${summary.file}`);
out.push(`  ${summary.entries} entries, ${(summary.bytes / 1024).toFixed(1)} KB, ${summary.span || 'empty'}${outOfOrder ? `, ${outOfOrder} out of order` : ''}`);
out.push(`  kinds: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
out.push(`  agents: ${who.size} (${Object.entries(byVendor).map(([k, n]) => `${k} ${n}`).join(', ')}); still in at the end: ${present.size}, still asking: ${askOpen.size}`);
const s = day.stats;
out.push(`  day: ${s.sessions} sessions, ${s.helpers} helpers, ${s.finished} finished, ${s.reports} reports, ${s.reviews} reviews, ${s.verdicts} verdicts, asked you ${s.askedYou}×`);
if (s.projects.length) out.push(`  projects: ${s.projects.slice(0, 8).map(p => `${p.project} ${p.count}`).join(', ')}`);
out.push('');

section(`Left and came back within ${REARRIVE_MS / 1000}s (flicker)`, issues.rearrived, r => `${hms(r.t)}  back after ${dur(r.gap)}  ${name(r.id)}`);
section(`Left while working and came back within ${WORKING_REARRIVE_MS / 60000} min (dropped mid-task)`, issues.workingRearrived, r => `${hms(r.t)}  back after ${dur(r.gap)}  ${name(r.id)}`);
section(`More than ${CYCLES_PER_HOUR} arrivals in an hour`, issues.cycling, r => `${r.cycles}× from ${hms(r.from)}  ${name(r.id)}`);
section(`Status toggling faster than every ${TOGGLE_MS / 1000}s`, issues.toggles, r => `${r.n}× (fastest ${dur(r.minGap)}) ${hms(r.first)}–${hms(r.last)}  ${name(r.id)}`);
section(`Asking episodes shorter than ${ASK_MIN_MS / 1000}s (false "waiting on you"?)`, issues.askShort, r => `${hms(r.t)}  ${dur(r.d)}  ${name(r.id)}  “${r.text || ''}”`);
section(`Asking episodes longer than ${dur(ASK_MAX_MS)}`, issues.askLong, r => `${hms(r.t)}  ${dur(r.d)}  ${name(r.id)}  “${r.text || ''}”`);
section(`Still asking after ${dur(ASK_MAX_MS)} at end of file`, issues.askOpenLong, r => `${hms(r.t)}  ${dur(r.d)}  ${name(r.id)}  “${r.text || ''}”`);
section('Helpers whose parent never appeared', issues.orphanParent, r => `parent ${r.parentId}  ← ${r.helpers.map(name).join('; ')}`);
section('Helpers (subagents) that arrived without a parent', issues.helperAlone, r => `${hms(r.t)}  ${name(r.id)}`);
section('Reports from agents that never arrived', issues.reportNoArrival, r => `${hms(r.t)}  ${name(r.id)}  “${r.text || ''}”`);
section('Reports to agents that never arrived', issues.reportToUnknown, r => `${hms(r.t)}  ${name(r.id)} → ${r.to}`);
section('Arrived while already in (double count)', issues.doubleArrive, r => `${hms(r.t)}  (in since ${hms(r.since)})  ${name(r.id)}`);
section('Left without having arrived today', issues.leftUnknown, r => `${hms(r.t)}  ${name(r.id)}`);
section('Task label changed as the worker left (weaker label from the leaving path)', issues.labelOnLeave, r => `${hms(r.t)}  ${name(r.id)}  “${r.from}” → “${r.to}”`);
section('Event ids logged twice (double count)', issues.doubleEvent, r => `${hms(r.t)}  ${r.eid} (first ${hms(r.first)})`);
console.log(out.join('\n'));
