// The resolver: links -> the office. Each link end is resolved to a present agent (`vendor:id` directly, `pid:n` through
// the pid map, `name:x` never: a stub). A link with both ends unresolved is dropped; with one end unresolved it becomes
// an event with a `stub` ("a message to someone outside the office"). A `brief` (or `launch`) from A to B adopts B
// into A's team while both are in and B has no parent from its own vendor; the adoption is remembered until B leaves
// or a `handoff` moves it. Link kinds map onto the event kinds the office already acts out (brief -> spawn, reply ->
// report) and keep their own name in `linkKind`.
import { parseParty } from './link.js';

export const KIND_TO_EVENT = { brief: 'spawn', reply: 'report', message: 'message', review: 'review', verdict: 'verdict', handoff: 'handoff', approval: 'approval', launch: 'launch' };
export const EVENT_TO_LINK = { spawn: 'brief', report: 'reply', message: 'message', review: 'review', verdict: 'verdict', handoff: 'handoff', approval: 'approval', launch: 'launch' };
const ADOPTING = new Set(['brief', 'launch']);
const DRIVES = new Set(['declared', 'structural']); // artifact / inferred links are drawn, never move anyone or re-team

/** A verdict from free text: flagged when it reads like a refusal, else allowed; risk when a level is named. */
export function verdictFromText(text) {
  const s = String(text || '');
  const flagged = /\b(flag(?:ged)?|reject(?:ed)?|block(?:ed)?|den(?:y|ied)|fail(?:ed)?|unsafe|risky|changes requested|needs work|not approved)\b/i.test(s)
    && !/\b(no (?:issues|problems|risks?) found|nothing flagged|not flagged)\b/i.test(s);
  const risk = /\b(high|medium|low)\b/i.exec(s);
  return { outcome: flagged ? 'flag' : 'allow', risk: risk ? risk[1].toLowerCase() : null };
}

export class LinkResolver {
  constructor() {
    this.adopted = new Map(); // helper id -> { parentId, at, linkId, score }
  }

  /** `{ id }` for a present agent, else `{ id: null, label }` for a stub. */
  resolveRef(ref, byId, pidMap, depth = 0) {
    const p = parseParty(ref);
    if (!p) return { id: null, label: String(ref ?? '?') };
    if (p.scheme === 'name') return { id: null, label: p.id };
    if (p.scheme === 'pid') {
      const mapped = pidMap?.get(Number(p.id));
      if (mapped && mapped !== ref && depth < 2) return this.resolveRef(mapped, byId, pidMap, depth + 1);
      return { id: null, label: `pid ${p.id}` };
    }
    return byId.has(ref) ? { id: ref } : { id: null, label: ref };
  }

  /**
   * Team adoption. `present` agents already have vendor parents that are absent set to null. Sets `parentId` and
   * `teamSource` ('vendor' | 'link' | null) on each agent; a vendor parent always wins.
   */
  adopt(present, byId, links, pidMap, now = Date.now()) {
    const sorted = [...links].filter(l => (ADOPTING.has(l.kind) || l.kind === 'handoff') && DRIVES.has(l.confidence || 'declared')).sort((a, b) => a.at - b.at);
    for (const l of sorted) {
      if (l.at > now + 60 * 1000) continue; // a clock from the future decides nothing yet
      const from = this.resolveRef(l.from, byId, pidMap), to = this.resolveRef(l.to, byId, pidMap);
      if (!from.id || !to.id || from.id === to.id) continue;
      if (l.kind === 'handoff') { // A hands its team to B: every helper adopted by A moves over
        for (const ad of this.adopted.values()) if (ad.parentId === from.id && ad.at < l.at) { ad.parentId = to.id; ad.at = l.at; ad.linkId = l.id; }
        continue;
      }
      const score = l.kind === 'brief' ? 1 : 0; // a declared brief beats a launch seen in the process table
      const cur = this.adopted.get(to.id);
      if (!cur || score > cur.score || (score === cur.score && l.at > cur.at)) this.adopted.set(to.id, { parentId: from.id, at: l.at, linkId: l.id, score });
    }
    for (const id of this.adopted.keys()) if (!byId.has(id)) this.adopted.delete(id); // B left: forgotten
    const descends = (id, ancestor) => { // would making `ancestor` the parent of `id` close a loop?
      let cur = byId.get(ancestor), guard = 0;
      while (cur && guard++ < 16) { if (cur.id === id) return true; cur = cur.parentId ? byId.get(cur.parentId) : null; }
      return false;
    };
    for (const a of present) {
      if (a.parentId) { a.teamSource = 'vendor'; continue; }
      const ad = this.adopted.get(a.id);
      if (ad && byId.has(ad.parentId) && ad.parentId !== a.id && !descends(a.id, ad.parentId)) { a.parentId = ad.parentId; a.teamSource = 'link'; }
      else a.teamSource = null;
    }
    return present;
  }

  /** Events for the links within `ttl`, ends resolved; one unresolved end becomes a stub, two drop the link. */
  events(links, byId, pidMap, now = Date.now(), ttl = Infinity) {
    const out = [];
    for (const l of links) {
      if (!l || !(now - l.at <= ttl) || l.kind === 'start') continue; // a lasting relationship (server/startedby.js), not something acted out
      const from = this.resolveRef(l.from, byId, pidMap), to = this.resolveRef(l.to, byId, pidMap);
      if (!from.id && !to.id) continue;
      if (from.id && to.id && from.id === to.id) continue;
      const ev = {
        id: l.id, kind: KIND_TO_EVENT[l.kind] || l.kind, linkKind: l.kind,
        from: from.id || l.from, to: to.id || l.to,
        text: l.text || null, verdict: l.kind === 'verdict' ? verdictFromText(l.text) : null, at: l.at,
        channel: l.channel || null, confidence: l.confidence || 'declared',
      };
      if (!from.id) ev.stub = { side: 'from', label: from.label };
      else if (!to.id) ev.stub = { side: 'to', label: to.label };
      out.push(ev);
    }
    return out;
  }
}
