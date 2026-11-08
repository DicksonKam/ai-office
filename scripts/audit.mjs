#!/usr/bin/env node
// npm run audit [-- --from=YYYY-MM-DD --to=YYYY-MM-DD --by-day --json]: was the office right? Compares its day journal with what
// the agents' own records say happened, for Claude Code and Codex. Reads times and record types only: no chat text is
// reported, and it runs no AI. Agents' helpers in Claude live in other files and are left out.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { CONFIG } from '../server/config.js';
import { claudeTruth, codexTruth, officeTimeline, coverageOf, compareChat, summarize } from './audit-lib.mjs';

const opt = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = k => process.argv.includes(`--${k}`);
const dir = CONFIG.journal.dir, from = opt('from') || '0000', to = opt('to') || '9999';
async function lines(file, want = () => true) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) { if (!l || l.length > 8e6 || !want(l)) continue; try { out.push(JSON.parse(l)); } catch { /* a partial line */ } }
  return out;
}
const days = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 10)).filter(d => d >= from && d <= to).sort();
const byId = new Map(), allTimes = [], rowsByDay = new Map();
for (const d of days) {
  for (const r of await lines(path.join(dir, `${d}.jsonl`))) {
    if (!r.t) continue; allTimes.push(r.t);
    if (!r.id || (r.vendor !== 'claude' && r.vendor !== 'codex')) continue;
    if (r.vendor === 'claude' && r.id.includes('/')) continue; // a Claude helper: its record is in another file
    (byId.get(r.id) || byId.set(r.id, []).get(r.id)).push({ ...r, day: d });
  }
}
const claudeFiles = new Map();
for (const p of fs.readdirSync(CONFIG.claude.projectsDir)) {
  let names; try { names = fs.readdirSync(path.join(CONFIG.claude.projectsDir, p)); } catch { continue; }
  for (const n of names) if (n.endsWith('.jsonl') && !n.startsWith('._')) claudeFiles.set(n.slice(0, -6), path.join(CONFIG.claude.projectsDir, p, n));
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const db = new DatabaseSync(CONFIG.codex.stateDb, { readOnly: true });
const rollouts = new Map(db.prepare('SELECT id, rollout_path FROM threads').all().map(r => [r.id, r.rollout_path]));
db.close();

const coverage = coverageOf(allTimes), end = allTimes.length ? Math.max(...allTimes) : 0;
const results = [];
for (const [id, rows] of byId) {
  const [vendor, raw] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  let truth = null;
  try {
    if (vendor === 'claude' && claudeFiles.has(raw)) truth = claudeTruth(await lines(claudeFiles.get(raw), l => l.includes('"timestamp"')), raw, fs.statSync(claudeFiles.get(raw)).birthtimeMs - 60000);
    if (vendor === 'codex' && rollouts.get(raw) && fs.existsSync(rollouts.get(raw))) truth = codexTruth(await lines(rollouts.get(raw), l => /task_started|task_complete|turn_aborted|request_user_input|function_call_output/.test(l.slice(0, 2000))));
  } catch { truth = null; }
  const first = rows[0], r = compareChat(truth, officeTimeline(rows, end), coverage);
  results.push({ ...r, id, vendor, kind: first.agentKind, day: first.day, automated: /^ccscope-/.test(first.task || '') });
}
const group = (name, rs) => ({ group: name, ...summarize(rs) });
const real = results.filter(r => !r.automated);
const out = [group('all', results), group('CCScope usage checks', results.filter(r => r.automated)), group('everything else', real), group('claude', real.filter(r => r.vendor === 'claude')), group('codex', real.filter(r => r.vendor === 'codex')), group('codex reviewers', real.filter(r => r.kind === 'guardian'))];
if (flag('by-day')) for (const d of days) out.push(group(d, real.filter(r => r.day === d)));
if (flag('json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`journal days ${days[0]} to ${days[days.length - 1]}, office running ${(coverage.reduce((n, c) => n + c[1] - c[0], 0) / 3600000).toFixed(0)} h in ${coverage.length} stretches`);
  console.table(Object.fromEntries(out.map(({ group: g, ...v }) => [g, v])));
  const stamp = t => new Date(t).toISOString().slice(5, 16);
  const worst = (title, pick, n = 6) => { const rows = real.flatMap(r => (r[pick] || []).map(s => ({ id: r.id.slice(0, 20), kind: r.kind, at: stamp(s[0]), mins: +((s[1] - s[0]) / 60000).toFixed(1) }))).sort((a, b) => b.mins - a.mins).slice(0, n); if (rows.length) { console.log(`\n${title}`); console.table(rows); } };
  worst('longest false workers', 'falseWorkers'); worst('longest missed work', 'missedWork'); worst('longest false "waiting on you"', 'falseAsks'); worst('longest missed "waiting on you"', 'missedAsks');
}
