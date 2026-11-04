// Which chat started which: a relationship of its own. A chat started by another is still the person's own chat, with its
// own desk, its own questions and its own break, so this says who it came from and changes nothing about its status.
// Remembered once seen, since a start call scrolls out of the end of a transcript. Knows no tool.
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export class StartedBy {
  constructor(state = null) {
    this.calls = new Map(state?.calls || []);   // the started chat's host id (what the start call returned) -> { parent, at }
    this.links = new Map(state?.links || []);   // child agent id -> { parent, at }
    this.dirty = false;
  }
  toJSON() { return { calls: [...this.calls], links: [...this.links] }; }

  /** `parent` made a start call that returned `hostId`. */
  noteCall(parent, hostId, at) {
    if (!hostId || this.calls.has(hostId)) return;
    this.calls.set(hostId, { parent, at: at || 0 }); this.dirty = true;
  }
  /** An agent that says which host id it is: matched exactly to the call that started it. */
  noteHost(id, hostId) {
    const c = hostId && this.calls.get(hostId);
    if (c && c.parent !== id && !this.links.has(id)) { this.links.set(id, c); this.dirty = true; }
  }
  /** A tool saying so directly. The newest word wins. */
  noteLink(parent, id, at) {
    const cur = this.links.get(id);
    if (parent === id || (cur && (cur.parent === parent || cur.at >= at))) return;
    this.links.set(id, { parent, at }); this.dirty = true;
  }
  of(id) { return this.links.get(id) || null; }
  prune(now = Date.now()) {
    for (const m of [this.calls, this.links]) for (const [k, v] of m) if (now - (v.at || 0) > KEEP_MS) { m.delete(k); this.dirty = true; }
  }
}
