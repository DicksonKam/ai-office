// The Link type: the one thing every reader produces and the resolver consumes (see index.js for the fields).
import { CONFIG } from '../config.js';

export const LINK_KINDS = new Set(['brief', 'reply', 'message', 'review', 'verdict', 'handoff', 'approval', 'launch', 'start']);
export const CONFIDENCES = new Set(['declared', 'structural', 'artifact', 'inferred']);
export const PARTY_RE = /^([a-z][a-z0-9_-]*):(.+)$/s; // any tool's name, plus pid: and name:

/** Split a party ref into its scheme and id, or null when it is not one. */
export function parseParty(ref) {
  if (typeof ref !== 'string') return null;
  const m = PARTY_RE.exec(ref);
  if (!m || !m[2].trim()) return null;
  if (m[1] === 'pid' && !/^\d+$/.test(m[2])) return null;
  return { scheme: m[1], id: m[2] };
}

/** A well-formed Link from loose fields (text capped, confidence defaulted). Returns null when a required field is bad. */
export function makeLink({ id, kind, from, to, at, text = null, channel = null, confidence = 'declared' }, textMax = CONFIG.links.textMax) {
  if (!id || !LINK_KINDS.has(kind) || !parseParty(from) || !parseParty(to) || from === to || !Number.isFinite(at)) return null;
  const t = text == null ? null : String(text).replace(/\s+/g, ' ').trim();
  return {
    id: String(id), kind, from, to, at,
    text: t ? (t.length > textMax ? t.slice(0, textMax) : t) : null,
    channel: channel ? String(channel) : null,
    confidence: CONFIDENCES.has(confidence) ? confidence : 'declared',
  };
}
