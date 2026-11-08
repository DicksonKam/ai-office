// The audit's yardstick, with no file access so it can be tested on known answers: what really happened in a chat (from the
// agent's own records: times and record types only, never text), what the office said (from its day journal), and the
// difference. An interval is [startMs, endMs].

export const GAP_MS = 180 * 1000;     // records this close belong to the same stretch of work
export const MIN_WORK_MS = 20 * 1000; // shorter than this, the office polling every 1.5 s could fairly miss it or not
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function merge(spans, gap = 0) {
  const s = spans.filter(x => x[1] >= x[0]).sort((a, b) => a[0] - b[0]), out = [];
  for (const [a, b] of s) { const l = out[out.length - 1]; if (l && a - l[1] <= gap) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}
const overlaps = (a, list) => list.some(b => a[0] <= b[1] && b[0] <= a[1]);
const overlapMs = (a, list) => list.reduce((n, b) => n + Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])), 0);
const median = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Claude Code transcript lines -> { working, asks }. Lines copied from an earlier session carry its id, and are not this one's. */
export function claudeTruth(lines, sessionId, since = 0) {
  const points = [], open = new Map(), tools = [], asks = [], ends = [];
  for (const l of lines) {
    if (!l || (l.type !== 'user' && l.type !== 'assistant') || l.isSidechain || (l.sessionId && l.sessionId !== sessionId)) continue;
    const t = Date.parse(l.timestamp); if (!t || t < since) continue; // older than its own file: history carried into a continued chat
    const content = l.message?.content;
    points.push([t, t]);
    if (l.type === 'assistant' && l.message?.stop_reason === 'end_turn') ends.push(t); // the turn is over: a quick reply starts a new one
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') open.set(b.id, { t, ask: ASK_TOOLS.has(b.name) });
      else if (b?.type === 'tool_result' && open.has(b.tool_use_id)) { const o = open.get(b.tool_use_id); open.delete(b.tool_use_id); (o.ask ? asks : tools).push([o.t, t]); }
    }
  }
  const waited = merge(asks), work = mergeTurns([...points, ...tools], ends);
  return { working: work.flatMap(w => carve(w, waited)), asks: waited, tools: merge(tools) };
}
function mergeTurns(spans, ends) {
  const s = spans.filter(x => x[1] >= x[0]).sort((a, b) => a[0] - b[0]), out = [];
  for (const [a, b] of s) {
    const l = out[out.length - 1];
    if (l && a - l[1] <= GAP_MS && !ends.some(e => e >= l[1] && e < a)) l[1] = Math.max(l[1], b); else out.push([a, b]);
  }
  return out;
}
/** a stretch of work without the time it spent waiting for an answer */
function carve([a, b], holes) {
  const out = []; let at = a;
  for (const [x, y] of holes) { if (y < a || x > b) continue; if (x > at) out.push([at, x]); at = Math.max(at, y); }
  if (at < b || !out.length) out.push([at, b]);
  return out.filter(s => s[1] >= s[0]);
}

/** Codex rollout lines -> { working, asks }. A turn runs from task_started to task_complete or turn_aborted. */
export function codexTruth(lines) {
  const working = [], asks = [], open = new Map(); let start = null, last = 0;
  for (const l of lines) {
    const t = Date.parse(l?.timestamp); if (!t) continue; last = Math.max(last, t);
    const p = l.payload || {};
    if (l.type === 'event_msg') {
      if (p.type === 'task_started') { if (start !== null) working.push([start, t]); start = t; }
      else if ((p.type === 'task_complete' || p.type === 'turn_aborted') && start !== null) { working.push([start, t]); start = null; }
    } else if (l.type === 'response_item') {
      if (p.type === 'function_call' && p.name === 'request_user_input') open.set(p.call_id, t);
      else if (p.type === 'function_call_output' && open.has(p.call_id)) { asks.push([open.get(p.call_id), t]); open.delete(p.call_id); }
    }
  }
  if (start !== null) working.push([start, last]);
  return { working: merge(working), asks: merge(asks) };
}

/** One chat's rows from the journal -> what the office showed. `end` closes anything still open. */
export function officeTimeline(rows, end) {
  const shown = [], working = [], asks = []; let inAt = null, workAt = null, askAt = null;
  const stopWork = t => { if (workAt !== null) { working.push([workAt, t]); workAt = null; } };
  const stopAsk = t => { if (askAt !== null) { asks.push([askAt, t]); askAt = null; } };
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (r.kind === 'arrived') { inAt ??= r.t; if (r.status === 'working') workAt ??= r.t; }
    else if (r.kind === 'working') workAt ??= r.t;
    else if (r.kind === 'idle') stopWork(r.t);
    else if (r.kind === 'asking-start') askAt ??= r.t;
    else if (r.kind === 'asking-end') stopAsk(r.t);
    else if (r.kind === 'left') { stopWork(r.t); stopAsk(r.t); if (inAt !== null) { shown.push([inAt, r.t]); inAt = null; } }
  }
  stopWork(end); stopAsk(end); if (inAt !== null) shown.push([inAt, end]);
  return { shown, working, asks };
}

/** When the office was running: any stretch of its journal with no silence over `gap`. */
export const coverageOf = (times, gap = 30 * 60 * 1000) => merge(times.map(t => [t, t]), gap);

/** One chat. `truth` null means its record no longer exists: nothing can be proved either way. */
export function compareChat(truth, office, coverage) {
  const r = { falseWorkers: [], missedWork: [], lateStarts: [], lateEnds: [], falseAsks: [], missedAsks: [], inferredAsks: [], workMs: 0, shownWorkingMs: 0, officeWorkMs: 0, officeTrueMs: 0, shownCount: office.shown.length };
  if (!truth) return { ...r, noRecord: office.shown.length };
  const inCover = s => coverage.some(c => s[0] >= c[0] && s[1] <= c[1]);
  const near = 10 * 60 * 1000;
  for (const s of office.shown) if (!overlaps([s[0] - near, s[1]], truth.working) && !overlaps([s[0] - near, s[1]], truth.asks)) r.falseWorkers.push(s);
  for (const w of truth.working) {
    if (!inCover(w)) continue;
    r.workMs += w[1] - w[0]; r.shownWorkingMs += overlapMs(w, office.working);
    if (w[1] - w[0] < MIN_WORK_MS) continue;
    const hit = office.working.filter(o => w[0] <= o[1] && o[0] <= w[1]).sort((a, b) => a[0] - b[0]);
    if (!hit.length) { r.missedWork.push(w); continue; }
    const first = hit[0], last = hit[hit.length - 1];
    if (first[0] >= w[0] - 5000) r.lateStarts.push(first[0] - w[0]);   // already at work when this began: not a start
    r.lateEnds.push(last[1] - w[1]);
  }
  for (const o of office.working) if (inCover(o)) { r.officeWorkMs += o[1] - o[0]; r.officeTrueMs += overlapMs(o, truth.working); }
  // a permission prompt leaves no record of its own: an ask with a tool call open beside it may well be one, so it is not proven false
  for (const a of office.asks) if (!overlaps([a[0] - 30000, a[1] + 30000], truth.asks)) (overlaps([a[0] - 5000, a[1] + 5000], truth.tools || []) ? r.inferredAsks : r.falseAsks).push(a);
  for (const a of truth.asks) if (inCover(a) && a[1] - a[0] >= 10000 && !overlaps([a[0] - 30000, a[1] + 30000], office.asks)) r.missedAsks.push(a);
  return r;
}
export const summarize = (results) => {
  const all = k => results.flatMap(x => x[k] || []), sum = k => results.reduce((n, x) => n + (x[k] || 0), 0);
  const late = all('lateStarts'), end = all('lateEnds');
  return { chats: results.length, shown: sum('shownCount'), noRecord: sum('noRecord'), falseWorkers: all('falseWorkers').length, missedWork: all('missedWork').length, workHours: +(sum('workMs') / 3600000).toFixed(1),
    shownWorkingPct: sum('workMs') ? +(100 * sum('shownWorkingMs') / sum('workMs')).toFixed(1) : null, officeWorkTruePct: sum('officeWorkMs') ? +(100 * sum('officeTrueMs') / sum('officeWorkMs')).toFixed(1) : null,
    lateStartMedianS: late.length ? +(median(late) / 1000).toFixed(1) : null, lateStartWorstS: late.length ? +(Math.max(...late) / 1000).toFixed(0) : null, starts: late.length,
    lateEndMedianS: end.length ? +(median(end) / 1000).toFixed(1) : null, lateEndWorstS: end.length ? +(Math.max(...end) / 1000).toFixed(0) : null, falseAsks: all('falseAsks').length, inferredAsks: all('inferredAsks').length, missedAsks: all('missedAsks').length };
};
