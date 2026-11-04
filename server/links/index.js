// Links: evidence that agent A communicated with agent B, whatever tool either runs on (Milestone 11, AGENT_COMMUNICATION.md).
//
//   Link { id, kind, from, to, at, text, channel, confidence }
//     kind        brief | reply | message | review | verdict | handoff | approval | launch
//     from / to   party refs: claude:<session-id>, codex:<thread-id>, cursor:<id>, gemini:<id>,
//                 pid:<n> (the process running an agent) or name:<label> (a party the office cannot know: a stub)
//     at          epoch ms;  text  ≤ 200 chars or null;  channel  how it travelled (a tool's name, 'process')
//     confidence  declared | structural | artifact | inferred
//
// Readers each read one trace type and return candidate links; the loader runs every reader each poll and the
// resolver (resolve.js) turns links into teams, events and stubs. A reader that throws costs its links this poll only
// (logged once, then only counted, like a failing collector).
import { logError, logRecovered } from '../tail.js';
import { createDeclaredReader } from './declared.js';
import { createProcessReader } from './process.js';
import { createArtifactReader } from './artifact.js';

export { LINK_KINDS, CONFIDENCES, PARTY_RE, parseParty, makeLink } from './link.js';

/**
 * The loader: `readLinks(now, ctx)` runs every reader in order and returns their links. `ctx` is shared with the
 * readers: `ctx.agents` (the present agents, with the `pid` and `touches` their collectors found), `ctx.links` (links
 * read so far this poll, so later readers can see the `pid:` refs declared by earlier ones), `ctx.pidMap` (pid -> party
 * ref, filled by readers that learn process ids) and `ctx.pidWeak` (the pids in it that are only a cwd/time guess).
 * `stats()` is what the snapshot shows the HUD: `{ files, malformed, lastRead, read }`.
 */
export function createLinkLoader({ readers = null, log = logError, recovered = logRecovered } = {}) {
  const list = readers || [createDeclaredReader(), createProcessReader(), createArtifactReader()];
  let lastRead = 0;
  return {
    readers: list,
    async readLinks(now = Date.now(), ctx = {}) {
      ctx.links = ctx.links || [];
      ctx.pidMap = ctx.pidMap || new Map();
      ctx.pidWeak = ctx.pidWeak || new Set();
      ctx.agents = ctx.agents || [];
      for (const r of list) {
        const tag = `[links:${r.name || 'reader'}]`;
        try {
          const out = await r.read(now, ctx);
          if (Array.isArray(out)) for (const l of out) if (l) ctx.links.push(l);
          recovered(tag);
        } catch (e) {
          log(tag, e, now);
        }
      }
      lastRead = now;
      return ctx.links;
    },
    stats() {
      const s = { files: 0, malformed: 0, lastRead: lastRead || null, read: 0 };
      for (const r of list) {
        const rs = r.stats?.();
        if (!rs) continue;
        s.files += rs.files || 0; s.malformed += rs.malformed || 0; s.read += rs.read || 0;
      }
      return s;
    },
  };
}
