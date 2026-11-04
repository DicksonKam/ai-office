// The shared-file reader (Milestone 12, E2): agent A writes a file, agent B reads the same file within
// CONFIG.links.artifactWindowMs -> a `message` link A -> B on channel `file`, confidence `artifact` (a dashed thread
// and a bubble; it never drives behaviour). The evidence is the agents' own transcripts: each collector reports the
// newest file touches it can see (`agent.touches: [{ path, op: 'write' | 'read', at }]`):
//   Claude   Write / Edit / MultiEdit / NotebookEdit -> write, Read -> read (Grep and Glob are searches, not reads)
//   Codex    apply_patch targets and FileChange items -> write; CommandExecution `parsed_cmd` reads and
//            cat / sed -n / head / tail / rg / grep <path> in exec commands -> read (absolute or project-relative paths)
//   Cursor   Read -> read, Write / StrReplace / MultiEdit / apply_patch -> write (CLI transcripts), the IDE's
//            read_file / edit_file / search_replace / write bubbles likewise
//   Gemini   read_file -> read, write_file / replace / edit -> write (current CLI session files)
// Two agents editing one repo is ordinary teamwork, not a handoff: when both share a project, paths inside either's
// working tree are ignored unless they sit in a conventional handoff place (collaboration/, handoff/, inbox/, mailbox/,
// STATUS.md, HANDOFF.md). Links are deduped by id and capped per ordered pair per hour.
import { createHash } from 'node:crypto';
import { CONFIG } from '../config.js';
import { basename } from '../tail.js';
import { makeLink } from './link.js';

const HOUR = 60 * 60 * 1000;
const HANDOFF_DIRS = new Set(['collaboration', 'handoff', 'handoffs', 'inbox', 'mailbox']);
const HANDOFF_FILES = /^(STATUS|HANDOFF)\.md$/i;

/** A path under a conventional handoff folder or named like a handoff note. */
export function isHandoffPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  if (HANDOFF_FILES.test(parts[parts.length - 1])) return true;
  return parts.slice(0, -1).some(seg => HANDOFF_DIRS.has(seg.toLowerCase()));
}

/** The repository root an agent works in: its cwd, or the repo above a Claude Code worktree. */
export function treeOf(agent) {
  const cwd = String(agent?.cwd || '');
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(cwd);
  return (m ? m[1] : cwd).replace(/[\\/]+$/, '');
}

const under = (p, root) => !!root && (p === root || p.startsWith(root + '/'));
export const hashPath = p => createHash('sha1').update(String(p)).digest('hex').slice(0, 12);

/**
 * Pure part: artifact links among `agents` from their touches. A write by A of P at tw, a read of P by B at tr with
 * tw <= tr <= tw + windowMs, A != B. The link's `at` is the read (when the message arrived); its id names the write.
 */
export function artifactLinks(agents, { now = Date.now(), windowMs = CONFIG.links.artifactWindowMs, perPairPerHour = CONFIG.links.artifactPerPairPerHour } = {}) {
  const list = (agents || []).filter(a => a && a.id && Array.isArray(a.touches) && a.touches.length);
  const reads = new Map(); // path -> [{ agent, at }]
  for (const b of list) for (const t of b.touches) {
    if (!t || t.op !== 'read' || !t.path || !Number.isFinite(t.at)) continue;
    const l = reads.get(t.path) || [];
    l.push({ agent: b, at: t.at }); reads.set(t.path, l);
  }
  const out = new Map(); // id -> link
  for (const a of list) {
    for (const w of a.touches) {
      if (!w || w.op !== 'write' || !w.path || !Number.isFinite(w.at) || w.at > now + 60 * 1000) continue;
      for (const r of reads.get(w.path) || []) {
        const b = r.agent;
        if (b.id === a.id || r.at < w.at || r.at - w.at > windowMs) continue;
        if (a.project && a.project === b.project && (under(w.path, treeOf(a)) || under(w.path, treeOf(b))) && !isHandoffPath(w.path)) continue;
        const id = `artifact:${a.id}:${b.id}:${hashPath(w.path)}:${w.at}`;
        if (out.has(id)) continue;
        const l = makeLink({ id, kind: 'message', from: a.id, to: b.id, at: r.at, text: basename(w.path), channel: 'file', confidence: 'artifact' });
        if (l) out.set(id, l);
      }
    }
  }
  // the cap: per ordered pair, per clock hour of the link's `at`, the earliest `perPairPerHour` links survive
  const sorted = [...out.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
  const count = new Map();
  const kept = [];
  for (const l of sorted) {
    const k = `${l.from}>${l.to}@${Math.floor(l.at / HOUR)}`;
    const n = (count.get(k) || 0) + 1;
    count.set(k, n);
    if (n <= perPairPerHour) kept.push(l);
  }
  return kept;
}

/** The reader: links from the present agents' touches (`ctx.agents`). Options are for tests. */
export function createArtifactReader({ windowMs = null, perPairPerHour = null } = {}) {
  let lastRead = 0, read = 0;
  return {
    name: 'artifact',
    async read(now = Date.now(), ctx = {}) {
      const links = artifactLinks(ctx.agents || [], { now, windowMs: windowMs ?? CONFIG.links.artifactWindowMs, perPairPerHour: perPairPerHour ?? CONFIG.links.artifactPerPairPerHour });
      lastRead = now; read = links.length;
      return links;
    },
    stats() { return { files: 0, malformed: 0, lastRead: lastRead || null, read }; },
  };
}
