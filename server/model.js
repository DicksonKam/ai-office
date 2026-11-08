// Merge collectors into one office snapshot: teams, roles, interaction events and the lifecycle rules:
//   working  -> at the desk        idle -> coffee break (for a while), then leaves        gone -> walks out
// Links (server/links): evidence from any tool that two agents talked. A brief / launch link adopts a parentless agent
// into the sender's team (teamSource 'link'; a vendor parent always wins), and every link within EVENT_TTL is an event
// alongside the vendor-native ones; all events carry channel, confidence and linkKind, a stub when one end is unknown.
// Collectors also report what they can read about each agent's process (`pid`, explicit) and its newest file touches
// (`touches`); the process reader adds weak cwd/time pid joins (`pidWeak`), the shared-file reader turns a write by A
// and a read by B of one file into an `artifact` link. The snapshot keeps `pid` / `pidWeak` per agent, not the touches.
import { CONFIG } from './config.js';
import { resolveOpens } from './open.js';
import { collectClaude } from './collectors/claude.js';
import { collectCodex, codexSchedules } from './collectors/codex.js';
import { collectCursor, cursorJobs } from './collectors/cursor.js';
import { collectGemini } from './collectors/gemini.js';
import { logError, logRecovered, FORGET_AFTER_MS } from './tail.js';
import { createLinkLoader } from './links/index.js';
import { LinkResolver, EVENT_TO_LINK } from './links/resolve.js';
import { shellsUnder } from './links/process.js';
import { isPidAlive } from './tail.js';
import { JobBook } from './jobbook.js';
import { StartedBy } from './startedby.js';
import { createJobDrop } from './jobdrop.js';
import { waitingOnJob } from '../web/jobs.js';

/** who can be opened right now, and how (server/open.js); the page only ever names an agent */
export const openBook = { targets: new Map() };

const idleSince = new Map();   // id -> ms when it became idle
const lastStatus = new Map();  // id -> status at the previous poll
const everLead = new Set();    // ids that have had helpers (stay "lead" after the helpers leave)
const lastSeen = new Map();    // id -> ms it was last reported by a collector (state for ids unseen for an hour is dropped)
const lastTask = new Map();    // id -> { task, rank }: the strongest label seen (a session keeps its title as it leaves)
const LAST_TASK_MAX = 2000;
const delegatorOf = new Map(); // id -> { id, certain } from the last snapshot: who gave this agent its work (leave timer)
const askSince = new Map();    // id -> ms its open ask started (an ask to a delegator becomes the person's after a while)
const stillSince = new Map();  // id -> ms it stopped working (a delegator that stopped no longer answers asks for long)
const recentEvents = new Map(); // event id -> event (recent interaction events, deduped)
export const EVENT_TTL = 3 * 60 * 1000;
const DEFAULT_COLLECTORS = [['[claude]', collectClaude], ['[codex]', collectCodex], ['[cursor]', collectCursor], ['[gemini]', collectGemini]];
let linkLoader = null;               // created on first use (readers open nothing until they run)
const linkResolver = new LinkResolver();
export const jobBook = new JobBook();
export const startedBy = new StartedBy();
const jobDrop = createJobDrop();
// a reader per tool whose jobs do not come with its agents, and one per tool that keeps schedules: add a tool here
const DEFAULT_JOB_READERS = [['[cursor jobs]', cursorJobs]], DEFAULT_SCHEDULE_READERS = [['[codex schedules]', codexSchedules]];
let psTable = () => null; // the newest process table, from the process reader

function rootOf(id, byId) {
  let cur = byId.get(id), depth = 0, guard = 0;
  while (cur?.parentId && byId.has(cur.parentId) && guard++ < 10) { cur = byId.get(cur.parentId); depth++; }
  return { root: cur?.id || id, depth };
}

/** When `a` went idle. A worker seen working at the previous poll went idle now: its statusAt is its last activity,
 *  which can be minutes old (a helper whose long model reply ran out its grace), and starting the break there would
 *  send it home on the very poll it stopped working (a fake left / arrived pair in the journal). A worker first seen
 *  idle has been idle since its statusAt. Returns the idle start (null while working). */
export function trackIdle(a, now) {
  const prev = lastStatus.get(a.id);
  lastStatus.set(a.id, a.status);
  if (a.status === 'working') { idleSince.delete(a.id); return null; }
  if (a.status === 'idle' && !idleSince.has(a.id)) idleSince.set(a.id, prev === 'working' ? now : Math.min(a.statusAt || now, now));
  return idleSince.get(a.id) ?? null;
}

/** The label `a` keeps. Collectors rank what their label rests on (`taskRank`: 2 a title the tool itself gave the
 *  session, 1 its first prompt, 0 the working folder; absent = 1). A weaker label never replaces a stronger one already
 *  seen for the id: a Claude session's registry file goes when it ends, and the transcript-only path that then reports
 *  it as it leaves knows only the first prompt. Bounded: ids forgotten with lastSeen, and the oldest past LAST_TASK_MAX. */
export function rememberTask(a) {
  const rank = a.task ? (Number.isFinite(a.taskRank) ? a.taskRank : 1) : -1;
  delete a.taskRank;
  const prev = lastTask.get(a.id);
  if (prev && rank < prev.rank) { a.task = prev.task; return a.task; }
  lastTask.delete(a.id); // re-insert: most recently updated last
  lastTask.set(a.id, { task: a.task, rank });
  while (lastTask.size > LAST_TASK_MAX) lastTask.delete(lastTask.keys().next().value);
  return a.task;
}

/** How long `a` stays after going idle. Claude helpers hang around briefly (their run is over when they hand back). A
 *  Codex helper or Guardian thread persists between its turns until its lead closes it (`turn_aborted`) or the lead's
 *  turn is over, so it gets the full break meanwhile and the short one after that; a parent no collector reports counts
 *  as a turn that is over. */
function leaveLimit(a, allById) {
  // a worker another agent gave its work to has handed it back once idle: it goes like a helper, not like your own chat
  if (a.kind !== 'subagent' && a.kind !== 'guardian') return delegatorOf.get(a.id) ? CONFIG.helperLeaveAfterIdleMs : CONFIG.leaveAfterIdleMs;
  if (a.vendor !== 'codex') return CONFIG.helperLeaveAfterIdleMs;
  // a Codex helper or Guardian thread lives until it is closed: between its own turns, and between its lead's short
  // turns (a Guardian reviews each escalation of a lead that works in bursts), it stays while the lead is in
  const parent = a.parentId ? allById.get(a.parentId) : null;
  const parentIn = !!(parent && parent.status !== 'gone');
  return a.closed || !parentIn ? CONFIG.helperLeaveAfterIdleMs : CONFIG.leaveAfterIdleMs;
}

/** Who each agent's asks and hand-backs are for (AGENT_COMMUNICATION.md, "Who is the question for?"). `delegator`
 *  `{ id, certain }`: the agent that gave this one its work across processes: a declared / structural brief or launch
 *  (the adopting parent, certain) or a launch inferred from the process tree (`delegations`, not certain). A vendor's
 *  own helpers have none here: their prompts appear in the person's own chat, so they stay the person's. `askTo`: the
 *  delegator an open ask is addressed to, while that delegator is in and not itself waiting on the person, and is
 *  still working or stopped less than CONFIG.askEscalateMs ago (counted from the later of its stop and the ask);
 *  otherwise null (the ask is the person's). A delegator at work answers in its own time (seen live: asks open 6 min
 *  while the delegator worked, all answered by it). Mutates `present`. */
export function addressAsks(present, byId, delegations = new Map(), now = Date.now()) {
  for (const a of present) {
    let d = null;
    if (a.parentId && a.teamSource === 'link') d = { id: a.parentId, certain: true };
    else if (!a.parentId) {
      const x = delegations?.get(a.id);
      if (x && byId.has(x.from) && x.from !== a.id) d = { id: x.from, certain: x.confidence === 'declared' || x.confidence === 'structural' };
    }
    a.delegator = d;
    if (d) delegatorOf.set(a.id, d); else delegatorOf.delete(a.id);
  }
  for (const a of present) {
    if (a.status === 'working') stillSince.delete(a.id); else if (!stillSince.has(a.id)) stillSince.set(a.id, now);
  }
  for (const a of present) {
    if (!a.asking) { askSince.delete(a.id); a.askTo = null; continue; }
    if (!askSince.has(a.id)) askSince.set(a.id, now);
    const d = a.delegator ? byId.get(a.delegator.id) : null;
    const answering = d && (d.status === 'working' || now - Math.max(askSince.get(a.id), stillSince.get(d.id) ?? now) < CONFIG.askEscalateMs);
    a.askTo = answering && !d.asking ? d.id : null;
  }
  return present;
}

/** One collector; a failure costs that vendor this poll only, and a failure that repeats every poll is logged once. */
async function run(tag, collect, now) {
  try {
    const out = await collect(now);
    logRecovered(tag);
    return out;
  } catch (e) {
    logError(tag, e, now);
    return [];
  }
}

/** Vendor-native events already name both parties: a direct channel, declared confidence (the structural spawn link
 *  aside), and the link kind they correspond to. */
function vendorEvent(ev, from, to) {
  return {
    id: ev.id, kind: ev.kind, linkKind: EVENT_TO_LINK[ev.kind] || ev.kind, from, to,
    text: ev.text || null, verdict: ev.verdict || null, at: ev.at,
    channel: 'direct', confidence: ev.kind === 'spawn' ? 'structural' : 'declared',
  };
}

/** One office snapshot. `opts` is for tests: `collectors` ([tag, collect] pairs), `links` (a link loader), `resolver`
 *  (a LinkResolver) and `events` (the Map of recent events) replace the live ones. */
export async function buildSnapshot(now = Date.now(), opts = {}) {
  const collectors = opts.collectors || DEFAULT_COLLECTORS;
  const links = opts.links || (linkLoader ||= createLinkLoader());
  const resolver = opts.resolver || linkResolver;
  const events = opts.events || recentEvents;
  const lists = await Promise.all(collectors.map(([tag, collect]) => run(tag, collect, now)));
  const all = lists.flat();

  // work going on outside the turn: everything the readers can see goes into the book, which decides what is still going
  const book = opts.jobBook || jobBook;
  const drop = await (opts.jobDrop || jobDrop).read(now);
  for (const s of drop.stubs) if (!all.some(a => a.id === s.id)) all.push(s); // a tool the office has no reader for, naming itself
  const starts = opts.startedBy || startedBy;
  for (const a of all) for (const c of a.startCalls || []) starts.noteCall(c.by || a.id, c.hostId, c.at);
  for (const a of all) { starts.noteHost(a.id, a.hostId); delete a.startCalls; delete a.hostId; }
  starts.prune(now);
  for (const a of all) { if (a.jobObs) book.observe(a.jobObs.map(o => ({ ...o, id: `${a.id}:${o.key}`, owner: a.id })), now); delete a.jobObs; }
  book.observe(drop.jobs, now);
  for (const list of await Promise.all((opts.jobReaders || DEFAULT_JOB_READERS).map(([tag, read]) => run(tag, read, now)))) book.observe(list, now);
  book.setSchedules((await Promise.all((opts.scheduleReaders || DEFAULT_SCHEDULE_READERS).map(([tag, read]) => run(tag, read, now)))).flat());
  book.sweep(now, new Map(all.map(a => [a.id, a])), { shellsUnder: pid => shellsUnder(psTable(), pid), pidAlive: isPidAlive });

  // 1. lifecycle
  const present = [];
  const allById = new Map(all.map(a => [a.id, a]));
  for (const a of all) {
    lastSeen.set(a.id, now);
    const firstSeen = !lastStatus.has(a.id);
    trackIdle(a, now);
    rememberTask(a);
    const jobs = book.listFor(a.id);
    if (jobs.length) a.jobs = jobs;
    // waiting on its own job, a worker stays, and its break starts counting only when the job is over
    const held = a.status === 'idle' && waitingOnJob(a, now);
    if (held) idleSince.set(a.id, now);
    let visible;
    if (a.status === 'gone') visible = false;
    else if (a.status === 'working' || held) visible = true;
    else {
      const since = idleSince.get(a.id) ?? now;
      const left = leaveLimit(a, allById) - (now - since);
      // first seen already deep into its break (a registry entry idle for minutes): with seconds left it would walk in
      // and straight out again, so it is not shown at all
      visible = left > 0 && !(firstSeen && left < CONFIG.admitMinMs);
    }
    if (!visible) continue;
    present.push({ ...a, idleSince: a.status === 'idle' ? idleSince.get(a.id) : null });
  }

  // 2. hierarchy: parents must be present, otherwise the helper stands on its own
  const byId = new Map(present.map(a => [a.id, a]));
  for (const a of present) if (a.parentId && !byId.has(a.parentId)) a.parentId = null;
  // links from any tool (declared files, process ancestry); a brief / launch adopts a parentless helper into a team
  const ctx = { agents: present, links: [], pidMap: new Map(), pidWeak: new Set() };
  const linkList = await links.readLinks(now, ctx);
  if (ctx.psTable) psTable = ctx.psTable;
  // the process each agent runs in: explicit from its collector, else what the process reader joined (weak: a guess)
  const pidOf = new Map();
  for (const [pid, ref] of ctx.pidMap) if (byId.has(ref) && !pidOf.has(ref)) pidOf.set(ref, pid);
  for (const a of present) {
    const explicit = Number.isInteger(a.pid) && a.pid > 0 ? a.pid : null;
    const joined = explicit ?? pidOf.get(a.id) ?? null;
    a.pid = joined; a.pidWeak = joined != null && explicit == null && ctx.pidWeak.has(joined);
    delete a.touches; // the shared-file reader has had them; file paths stay out of the snapshot
  }
  resolver.adopt(present, byId, linkList, ctx.pidMap, now);
  // who started whom: from any tool's link, and from what the readers matched above. Nothing but the desk, label and card follows
  for (const l of linkList) {
    if (l.kind !== 'start' || !['declared', 'structural'].includes(l.confidence || 'declared')) continue;
    const from = resolver.resolveRef(l.from, byId, ctx.pidMap), to = resolver.resolveRef(l.to, byId, ctx.pidMap);
    if (from.id && to.id) starts.noteLink(from.id, to.id, l.at);
  }
  for (const a of present) {
    const s = starts.of(a.id);
    if (s && !a.parentId) a.startedBy = { id: s.parent, task: byId.get(s.parent)?.task || lastTask.get(s.parent)?.task || null };
  }
  addressAsks(present, byId, ctx.delegations, now);
  const childCount = new Map();
  for (const a of present) if (a.parentId && a.kind !== 'guardian') childCount.set(a.parentId, (childCount.get(a.parentId) || 0) + 1);
  for (const [id] of childCount) everLead.add(id);
  const helpersWorking = new Map();
  for (const a of present) if (a.parentId && a.kind !== 'guardian' && a.status === 'working') helpersWorking.set(a.parentId, (helpersWorking.get(a.parentId) || 0) + 1);
  for (const a of present) {
    const { root, depth } = rootOf(a.id, byId);
    a.teamId = root; a.depth = depth;
    a.role = a.kind === 'guardian' ? 'reviewer' : depth > 0 ? 'helper' : everLead.has(a.id) ? 'lead' : 'member';
    a.helpers = childCount.get(a.id) || 0;
    // a lead whose turn is open, with nothing of its own running and helpers at work, is waiting on them (Codex reports
    // turnOpen / callOpen; the Claude collector applies the same rule itself at the end of a turn)
    if (a.status === 'working' && !a.waiting && !a.asking && a.turnOpen && !a.callOpen && helpersWorking.get(a.id)) a.waiting = true;
    delete a.turnOpen; delete a.callOpen; delete a.closed; // lifecycle inputs, not snapshot fields
  }

  // 3. events: resolve Codex agent paths to ids within each team, dedupe, keep recent
  const pathIndex = new Map(); // teamId -> Map(path -> id)
  for (const a of present) {
    if (!a.agentPath) continue;
    if (!pathIndex.has(a.teamId)) pathIndex.set(a.teamId, new Map());
    pathIndex.get(a.teamId).set(a.agentPath, a.id);
  }
  const resolve = (teamId, path) => path ? pathIndex.get(teamId)?.get(path) || null : null;
  for (const a of present) {
    for (const ev of a.events || []) {
      if (!ev.at || now - ev.at > EVENT_TTL || events.has(ev.id)) continue;
      const from = ev.from || resolve(a.teamId, ev.fromPath);
      const to = ev.to || resolve(a.teamId, ev.toPath);
      if (!from || !to || from === to) continue;
      events.set(ev.id, vendorEvent(ev, from, to));
    }
    delete a.events;
  }
  for (const ev of resolver.events(linkList, byId, ctx.pidMap, now, EVENT_TTL)) if (!events.has(ev.id)) events.set(ev.id, ev);
  for (const [id, ev] of events) if (now - ev.at > EVENT_TTL) events.delete(id);
  // forget workers no collector has reported for an hour (days of uptime would otherwise keep every id ever seen)
  for (const [id, t] of lastSeen) {
    if (now - t <= FORGET_AFTER_MS) continue;
    lastSeen.delete(id); idleSince.delete(id); lastStatus.delete(id); everLead.delete(id); lastTask.delete(id); delegatorOf.delete(id); askSince.delete(id); stillSince.delete(id);
  }

  const teams = [...new Set(present.map(a => a.teamId))].map(tid => ({
    id: tid,
    lead: tid,
    members: present.filter(a => a.teamId === tid && a.id !== tid && a.role !== 'reviewer').map(a => a.id),
    reviewers: present.filter(a => a.teamId === tid && a.role === 'reviewer').map(a => a.id),
  }));

  openBook.targets = resolveOpens(present);

  return {
    type: 'snapshot',
    now,
    config: {
      site: CONFIG.site,
      leaveAfterIdleMs: CONFIG.leaveAfterIdleMs, idleAfterMs: CONFIG.idleAfterMs,
      finishedMinMs: CONFIG.journal.finishedMinMs, // same "finished a task" threshold as the day journal
      timeZone: CONFIG.journal.timeZone,           // the zone the journal's day rolls over in
    },
    agents: present.sort((a, b) => (a.depth - b.depth) || ((a.startedAt || a.lastActivityAt) - (b.startedAt || b.lastActivityAt))),
    events: [...events.values()].sort((x, y) => x.at - y.at),
    teams,
    schedules: book.upcoming(), // the wall board: what runs next, whoever it belongs to
    links: links.stats(), // { files, malformed, lastRead, read } for the HUD / card
  };
}
