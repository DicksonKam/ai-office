import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../web/sun.js';

const HOME = os.homedir();

/** The journal's day rolls over at local midnight: by default in this Mac's own zone (the browser showing the office
 *  normally runs on the same Mac, so "since midnight" agrees on both sides). AI_OFFICE_TIME_ZONE overrides it. */
function siteFromEnv() {
  const lat = Number(process.env.AI_OFFICE_LAT), lon = Number(process.env.AI_OFFICE_LON);
  const given = process.env.AI_OFFICE_LAT && process.env.AI_OFFICE_LON;
  if (given && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  if (given) console.error('[config] AI_OFFICE_LAT / AI_OFFICE_LON out of range, using the default place');
  return SITE;
}

function timeZone() {
  const tz = process.env.AI_OFFICE_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; }
  catch { console.error(`[config] unknown time zone "${tz}", using UTC`); return 'UTC'; }
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG = {
  port: Number(process.env.AI_OFFICE_PORT || 4477),
  dataDir: process.env.AI_OFFICE_DATA_DIR || path.join(ROOT, 'data'), // the office's own records
  site: siteFromEnv(),
  pollMs: 1500,

  claude: {
    sessionsDir: path.join(HOME, '.claude', 'sessions'),
    projectsDir: path.join(HOME, '.claude', 'projects'),
  },
  codex: {
    home: path.join(HOME, '.codex'),
    stateDb: path.join(HOME, '.codex', 'state_5.sqlite'),
    sessionsDir: path.join(HOME, '.codex', 'sessions'),
    showGuardian: true,
    askingWindowMs: 6 * 60 * 60 * 1000, // a thread blocked on you writes nothing while it waits: look this far back for it
    escalationQuietMs: 20 * 1000,       // an escalated command with no output and nothing else since, for this long => waiting on you
    scanBackBytes: 16 * 1024 * 1024,    // a rollout whose tail has no turn marker is searched backwards this far for one, once
    reviewHoldMs: 10 * 1000,            // a Guardian stays "working" this long after a review's task_complete (reviews take 1–5 s)
  },

  // Links between agents (Milestone 11): declared link files (contract v1) and process-ancestry evidence;
  // (Milestone 12) pids for every vendor and the shared-file reader
  jobs: {
    dir: process.env.AI_OFFICE_JOBS_DIR || path.join(HOME, '.ai-office', 'jobs'), // *.jsonl, one job update per line (server/jobdrop.js)
  },
  links: {
    dir: process.env.AI_OFFICE_LINKS_DIR || path.join(HOME, '.ai-office', 'links'), // *.jsonl, one link per line
    maxAgeMs: 24 * 60 * 60 * 1000,  // links older than this are ignored
    maxPerFile: 2000,               // newest links kept in memory per file
    textMax: 200,                   // a link's text is cut here (the contract's limit)
    psEveryMs: 10 * 1000,           // how often `ps` is run for process ancestry
    pidJoinSlackMs: 60 * 1000,      // weak pid join: a vendor CLI process in the agent's cwd started within this of the agent
    touchesMax: 40,                 // newest file touches a collector reports per agent (for the shared-file reader)
    artifactWindowMs: 30 * 60 * 1000, // A writes a file, B reads it within this => an `artifact` link
    artifactPerPairPerHour: 5,      // at most this many artifact links per ordered pair of agents per hour
  },

  // Lifecycle (ms)
  activeWindowMs: 10 * 60 * 1000,   // a session touched within this window is considered "in the building"
  idleAfterMs: 40 * 1000,           // no new log activity for this long => idle (when no explicit status)
  leaveAfterIdleMs: 6 * 60 * 1000,  // idle this long => the worker leaves the office
  askEscalateMs: 3 * 60 * 1000,     // an ask addressed to the agent that gave the work becomes yours once that agent has stopped working this long
  helperLeaveAfterIdleMs: 90 * 1000, // subagents / reviewers hang around less (a Codex helper thread only once closed or its lead's turn is over)
  admitMinMs: 30 * 1000,            // a worker first seen idle with less than this of its break left is not shown at all (no 1 s arrive / leave pair)
  tailBytes: 256 * 1024,            // how much of each log file to read from the end

  // Day journal (data/journal/YYYY-MM-DD.jsonl, append-only, local to this Mac)
  journal: {
    dir: process.env.AI_OFFICE_JOURNAL_DIR || path.join(process.env.AI_OFFICE_DATA_DIR || path.join(ROOT, 'data'), 'journal'),
    timeZone: timeZone(),           // the day rolls over at local midnight here (env AI_OFFICE_TIME_ZONE)
    finishedMinMs: 2 * 60 * 1000,   // a top-level session going working -> idle after this much work = a finished task
  },
};
