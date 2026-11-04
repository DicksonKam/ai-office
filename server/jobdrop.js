// Jobs from any tool: one JSON line per update in a *.jsonl file under CONFIG.jobs.dir, the same idea as the link contract.
//   {"v":1,"id":"mytool:build-42","owner":"mytool:chat-7","kind":"run","state":"running","label":"Nightly build","at":"2026-11-03T06:12:16Z","pid":1234}
//   later: {"v":1,"id":"mytool:build-42","state":"done","at":"..."}
// kind: run | timer (with nextAt). state: running | waiting | done | failed | stopped. A tool the office has no reader for
// may name itself with "agent":{"name":"Chat","project":"x","status":"idle"}: it then gets a worker while it has a job.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';
import { readTail, parseJsonl, snippet, projectOf } from './tail.js';
import { parseAt } from './links/declared.js';

const ID = /^[^\s:]+:\S+$/, KINDS = new Set(['run', 'timer']), STATES = new Set(['running', 'waiting', 'done', 'failed', 'stopped']);
const STUB_MS = 10 * 60 * 1000;

/** One line -> an observation, or null when it does not follow the contract. */
export function parseDropLine(j) {
  if (!j || j.v !== 1 || typeof j.id !== 'string' || !ID.test(j.id) || !STATES.has(j.state)) return null;
  const at = parseAt(j.at);
  if (at == null) return null;
  const ended = !['running', 'waiting'].includes(j.state), nextAt = parseAt(j.nextAt);
  const base = { id: j.id, state: j.state, at, endedAt: ended ? at : null, nextAt };
  if (typeof j.owner !== 'string' || !ID.test(j.owner)) return base; // an end note, for a job already reported
  if (!KINDS.has(j.kind)) return null;
  return { ...base, owner: j.owner, kind: j.kind, label: snippet(String(j.label || ''), 60) || null, startedAt: parseAt(j.startedAt) ?? at, pid: Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null, evidence: 'reported', agent: j.agent && typeof j.agent === 'object' ? j.agent : null };
}

export function createJobDrop({ dir = () => CONFIG.jobs.dir, maxBytes = 256 * 1024 } = {}) {
  const files = new Map(); // path -> { mtimeMs, size, obs }
  return {
    /** `{ jobs, stubs }`: the newest line per job across the folder, and an agent for each owner naming itself. */
    async read(now = Date.now()) {
      const root = dir();
      let names = [];
      try { names = (await readdir(root)).filter(n => n.endsWith('.jsonl') && !n.startsWith('.')); } catch { names = []; }
      const seen = new Set();
      for (const n of names) {
        const p = path.join(root, n);
        seen.add(p);
        let st; try { st = await stat(p); } catch { continue; }
        const hit = files.get(p);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
        try { const { text } = await readTail(p, maxBytes); files.set(p, { mtimeMs: st.mtimeMs, size: st.size, obs: parseJsonl(text).map(parseDropLine).filter(Boolean) }); } catch { /* being written: next poll */ }
      }
      for (const p of files.keys()) if (!seen.has(p)) files.delete(p);
      const jobs = new Map(), stubs = new Map();
      for (const { obs } of files.values()) for (const o of obs) {
        const prev = jobs.get(o.id);
        if (!prev || o.at >= prev.at) jobs.set(o.id, prev ? { ...prev, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)), endedAt: o.endedAt } : o);
        if (o.agent && o.owner) {
          const was = stubs.get(o.owner);
          if (!was || o.at >= was.at) stubs.set(o.owner, { at: o.at, startedAt: was?.startedAt ?? o.at, ...o.agent, id: o.owner, label: o.label });
        }
      }
      const live = new Set([...jobs.values()].filter(j => ['running', 'waiting'].includes(j.state)).map(j => j.owner));
      return { jobs: [...jobs.values()], stubs: [...stubs.values()].filter(s => live.has(s.id) || now - s.at < STUB_MS).map(agentFrom) };
    },
  };
}

function agentFrom(s) {
  const tool = s.id.slice(0, s.id.indexOf(':')), cwd = typeof s.cwd === 'string' ? s.cwd : null;
  return {
    id: s.id, vendor: tool, kind: 'cli', host: snippet(String(s.host || tool), 30), task: snippet(String(s.name || s.label || tool), 60), taskRank: 1,
    cwd, project: snippet(String(s.project || (cwd ? projectOf(cwd) : tool)), 40), model: null, branch: null, startedAt: s.startedAt, alive: true,
    status: s.status === 'working' ? 'working' : 'idle', statusAt: s.at, lastActivityAt: s.at, thought: null, parentId: null, waiting: false, asking: null, events: [], pid: null, touches: [],
  };
}
