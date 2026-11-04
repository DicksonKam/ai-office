// Print the current office snapshot once (debugging aid).
import { buildSnapshot } from './model.js';
const snap = await buildSnapshot();
for (const a of snap.agents) {
  const ind = '  '.repeat(a.depth || 0);
  console.log(`${a.status.padEnd(8)} ${(a.role || '').padEnd(8)} ${ind}${a.vendor}/${a.kind.padEnd(8)} ${(a.nickname || '-').padEnd(10)} ${(a.project || '').padEnd(20)} ${(a.task || '').slice(0, 36).padEnd(36)} ${a.waiting ? '⏳' : '  '} | ${a.thought ? `[${a.thought.kind}] ${a.thought.text}` : ''}`);
}
console.log(`\n${snap.agents.length} present, ${snap.teams.length} teams, ${snap.events.length} recent events`);
for (const e of snap.events.slice(-12)) console.log(`  ${new Date(e.at).toLocaleTimeString()} ${e.kind.padEnd(8)} ${e.from.slice(0, 28)} -> ${e.to.slice(0, 28)} ${e.text ? `“${e.text}”` : ''} ${e.verdict ? JSON.stringify(e.verdict) : ''}`);
