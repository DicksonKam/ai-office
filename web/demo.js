// Demo mode (?demo): a scripted office with a team (lead, helpers, reviewer) and real-shaped events,
// so the choreography can be watched without live sessions.
// (Calls for help are not thoughts: a real spawn event carries them, with its own amber bubble.)
const HOST = { claude: 'Claude Desktop', codex: 'Codex Desktop', cursor: 'Cursor', gemini: 'Gemini CLI' };
const hostFor = vendor => HOST[vendor] || vendor;
// the demo's sessions are short: a finished task after 30 s of work (live: 2 min, from the server's config)
const DEMO_CONFIG = { finishedMinMs: 30000 };
const CLAUDE_THOUGHTS = [
  ['tool', 'Reading office.js'], ['think', 'The camera should fit the room bounds…'], ['tool', 'Editing character.js'],
  ['say', 'The chibi head needs to peek above the monitor.'], ['tool', 'Running: npm test'], ['error', 'Oops, that did not work. Trying again…'],
  ['tool', 'Searching for “seatY”'], ['say', 'Fixed. Shadows look softer now.'],
];
const CODEX_THOUGHTS = [
  ['tool', 'Running: pytest -q'], ['think', 'Checking the retry path'], ['tool', 'Editing parser.py, codec.py'],
  ['say', 'Implemented the validator. Import and --help pass.'], ['tool', 'Reading the review notes'], ['think', 'Comparing hashes'],
];

// Sample work going on outside the turn, so the demo shows every look a job can have. `idle`: their turn is over.
const demoSchedules = () => { const h = new Date(); h.setMinutes(0, 0, 0); h.setHours(h.getHours() + 1); return [{ id: 'demo:s1', kind: 'schedule', label: 'Check the inbox', state: 'waiting', nextAt: h.getTime(), owner: 'codex:demo-m2', startedAt: null, endedAt: null, evidence: 'reported' }, { id: 'demo:s2', kind: 'schedule', label: 'Weekly backup', state: 'waiting', nextAt: h.getTime() + 2 * 864e5, owner: null, startedAt: null, endedAt: null, evidence: 'reported' }]; };
const DEMO_JOBS = {
  'claude:demo-m1': { jobs: [['run', 'running', 'npm run build', 240]] },
  'claude:demo-m3': { idle: true, jobs: [['run', 'running', 'Long test suite', 600], ['run', 'running', 'Rendering the evening', 180]] },
  'codex:demo-m2': { idle: true, jobs: [['timer', 'waiting', 'Check the export again', 0, 12 * 60]] },
  'codex:demo-m4': { idle: true, jobs: [['run', 'done', 'Backup', 900], ['run', 'failed', 'Upload', 300]] },
  'claude:demo-lead3': { idle: true, jobs: [['run', 'running', 'Vault lint', 120], ['timer', 'waiting', 'Look at the lint report', 0, 20 * 60]] },
};
function addDemoJobs(agents, crowd) {
  const now = Date.now();
  for (const [i, a] of agents.entries()) {
    if (a.id === 'claude:demo-m3') a.startedBy = { id: 'claude:demo-m1', task: null }; // a chat another chat started
    const d = DEMO_JOBS[a.id] || (crowd && !a.parentId && i % 4 === 0 ? { idle: i % 8 === 0, jobs: [['run', 'running', 'Long test suite', 300]] } : null);
    if (!d) continue;
    if (d.idle) { a.status = 'idle'; a.thought = null; a.asking = null; a.idleSince = a.idleSince || now - 90000; }
    a.jobs = d.jobs.map(([kind, state, label, ago, inS], n) => ({ id: `${a.id}:job${n}`, kind, state, label, startedAt: now - ago * 1000, nextAt: inS ? now + inS * 1000 : null, endedAt: null, evidence: 'reported' }));
  }
}

/** ?demo&crowd=N : N top-level agents (leads with helpers, solo members, reviewers) arriving every couple of seconds.
 *  &reviewers: every lead gets a reviewer and reviews last longer (a busy review room: more reviewers than seats). */
export function startCrowdDemo(onSnapshot, n = 24, { reviewers = false } = {}) {
  const t0 = Date.now();
  const projects = ['ai-office', 'video-player', 'usage-viewer', 'city-sim', 'subtitles', '手冊', 'settings-ui', 'relay', 'chart-kit', 'team-wiki'];
  const tasks = ['Fix flaky tests', 'Refactor the collector', 'Write release notes', 'Port the renderer', 'Review the PR', 'Migrate the schema', 'Tune the palette', 'Export PDFs', 'Lint the docs', 'Profile the server'];
  const helperNames = ['Noether', 'Euler', 'Hypatia', 'Lagrange', 'Galileo', 'Linnaeus', 'Franklin', 'Huygens', 'McClintock', 'Jason', 'Curie', 'Turing', 'Lovelace', 'Darwin', 'Kepler', 'Bohr'];
  const roster = [], events = [];
  let hi = 0, spawnAt = 0;
  const mk = (id, vendor, kind, task, project, extra = {}) => ({
    id, vendor, kind, host: hostFor(vendor), task, project, cwd: `/Users/you/Projects/${project}`,
    model: vendor === 'claude' ? 'claude-fable-5-1' : 'gpt-6.1', status: 'working', startedAt: t0, lastActivityAt: t0, thought: null, parentId: null, waiting: false, ...extra,
  });
  for (let i = 0; i < n; i++) {
    const vendor = i % 3 === 0 ? 'claude' : 'codex', project = projects[i % projects.length], task = tasks[i % tasks.length];
    const isLead = i % 2 === 0;
    const id = `${vendor}:crowd-${i}`;
    spawnAt += 2.5;
    roster.push({ at: spawnAt, a: mk(id, vendor, 'desktop', task, project, isLead ? { role: 'lead' } : {}) });
    if (isLead) {
      const helpers = 1 + (i % 3);
      for (let h = 0; h < helpers; h++) {
        const late = i % 4 === 0; // every other lead calls its helpers once seated, all at once: a kickoff (1–2 → huddle room, 3 → meeting room)
        const hid = `${vendor}:crowd-${i}-h${h}`; const at = spawnAt + (late ? 45 + h * 0.5 : 4 + h * 3);
        roster.push({ at, a: mk(hid, vendor, 'subagent', `Helper: ${task.toLowerCase()} part ${h + 1}`, project, { nickname: vendor === 'codex' ? helperNames[hi++ % helperNames.length] : null, parentId: id, role: 'helper', depth: 1 }) });
        events.push({ at, id: `c-spawn-${i}-${h}`, kind: 'spawn', from: id, to: hid, text: `${task.toLowerCase()} part ${h + 1}` });
        events.push({ at: at + 30 + h * 7, id: `c-msg-${i}-${h}`, kind: 'message', from: hid, to: id, text: null });
        events.push({ at: at + 70 + h * 9, id: `c-rep-${i}-${h}`, kind: 'report', from: hid, to: id, text: `Part ${h + 1} done: tests pass.` });
      }
      if (reviewers || (vendor === 'codex' && i % 4 === 0)) {
        const gid = `codex:crowd-${i}-g`; const at = spawnAt + 20;
        roster.push({ at, a: mk(gid, 'codex', 'guardian', 'Guardian review', project, { nickname: 'Guardian', parentId: id, role: 'reviewer', reviewFor: reviewers ? 150 : 30 }) });
        events.push({ at, id: `c-rev-${i}`, kind: 'review', from: gid, to: id });
        events.push({ at: at + 25, id: `c-ver-${i}`, kind: 'verdict', from: gid, to: id, verdict: { outcome: 'allow', risk: 'low' } });
      }
    }
  }
  function tick() {
    const s = (Date.now() - t0) / 1000;
    const agents = [];
    for (const r of roster) {
      if (s < r.at) continue;
      const a = { ...r.a };
      const pool = a.vendor === 'claude' ? CLAUDE_THOUGHTS : CODEX_THOUGHTS;
      const idx = Math.floor((s - r.at) / 6) + r.at | 0;
      const [kind, text] = pool[idx % pool.length];
      const idleAt = a.role === 'helper' ? r.at + 95 : a.role === 'reviewer' ? r.at + (a.reviewFor || 30) : 1e9;
      if (s > idleAt + 60) continue; // gone
      a.status = s >= idleAt ? 'idle' : 'working';
      const solo = !a.parentId && a.role !== 'lead';
      // solo members finish a prompt now and then and stay idle: half of them for ~1¾ minutes every 3⅓ minutes (a
      // finished hand-back keeps them at the desk), the other half for 4 minutes every 5½ (long enough to rest, then
      // get up for coffee, the café or the lounge, and a trip to the WC: every break room gets used in a demo)
      const longBreak = (r.at * 2 | 0) % 2 === 0, cyc = longBreak ? 330 : 200, idle0 = longBreak ? 60 : 75, idle1 = longBreak ? 300 : 180;
      const ph = (s - r.at) % cyc;
      if (solo && ph > idle0 && ph < idle1) a.status = 'idle';
      a.asking = solo && a.status === 'working' && ((s - r.at) % 90) > 40 && ((s - r.at) % 90) < 62 && (r.at | 0) % 4 === 1 ? 'Question for you: Which branch should I merge into?' : null;
      a.thought = { kind, text, at: t0 + (Math.floor((s - r.at) / 6) * 6 + r.at) * 1000 };
      // some solo members run one long command now and then (the kind of stretch taken to the focus pod)
      const lc = (s - r.at) % 150;
      if (solo && (r.at | 0) % 3 === 0 && a.status === 'working' && !a.asking && lc > 20 && lc < 120) a.thought = { kind: 'tool', text: 'Running: npm test -- --runInBand', at: t0 + (s - lc + 20) * 1000 };
      a.idleSince = a.status === 'idle' ? (s >= idleAt ? t0 + idleAt * 1000 : Date.now() - (ph - idle0) * 1000) : null;
      a.teamId = a.parentId || a.id;
      agents.push(a);
    }
    for (const a of agents) a.helpers = agents.filter(x => x.parentId === a.id && x.role === 'helper').length;
    const ev = events.filter(e => s >= e.at && s < e.at + 170).map(e => ({ ...e, at: t0 + e.at * 1000 }));
    const teamIds = [...new Set(agents.map(a => a.teamId))];
    const teams = teamIds.map(tid => ({ id: tid, lead: tid, members: agents.filter(a => a.teamId === tid && a.id !== tid && a.role !== 'reviewer').map(a => a.id), reviewers: agents.filter(a => a.teamId === tid && a.role === 'reviewer').map(a => a.id) }));
    addDemoJobs(agents, true);
    onSnapshot({ type: 'snapshot', now: Date.now(), agents, events: ev, teams, config: DEMO_CONFIG, schedules: demoSchedules() });
  }
  tick();
  return setInterval(tick, 1000);
}

export function startDemo(onSnapshot, { scene = null } = {}) {
  const t0 = Date.now();
  // ?demo=deleg: only the delegation scene (a Codex chat, the Claude reviewer its tool starts, one person's own chat),
  // started 40 s in so the reviewer arrives after a few seconds
  const ONLY = scene === 'deleg' ? new Set(['codex:demo-m4', 'claude:demo-m5', 'claude:demo-m3']) : null;
  const SKIP = ONLY ? 40 : 0;
  const mk = (id, vendor, kind, task, project, extra = {}) => ({
    id, vendor, kind, host: hostFor(vendor), task, project, cwd: `/Users/you/Projects/${project}`,
    model: vendor === 'claude' ? 'claude-fable-5-1' : vendor === 'codex' ? 'gpt-6.1' : vendor, status: 'working', startedAt: t0, lastActivityAt: t0, thought: null, parentId: null, waiting: false, ...extra,
  });
  const L1 = 'codex:demo-lead', L2 = 'claude:demo-lead2';
  // links (Milestone 11): a Codex coordinator with a Claude worker adopted by a `brief` link over 'demo-relay' (a cross-
  // vendor pod: teal lead, orange helper with a "↳ lead" chip), a hand-over to a second coordinator, an approval relayed
  // from outside, a `launch` stub, a message to someone outside, and one artifact and one inferred link (dashed and
  // dotted threads, grey bubbles) into the wiki lead's pod
  const B1 = 'codex:demo-coord', B2 = 'codex:demo-coord2', BW = 'claude:demo-relay-w1', L3 = 'claude:demo-lead3';
  const roster = [
    { at: 30, a: mk(B1, 'codex', 'cli', 'Coordinate the auth audit', 'relay', { role: 'lead', host: 'Codex CLI', teamSource: 'vendor' }) },
    { at: 36, a: mk(BW, 'claude', 'cli', 'Audit the native auth route', 'relay', { parentId: B1, role: 'helper', depth: 1, host: 'Claude Code CLI', teamSource: 'link' }) },
    { at: 110, a: mk(B2, 'codex', 'cli', 'Coordinate the auth audit · round 2', 'relay', { role: 'lead', host: 'Codex CLI', teamSource: 'vendor' }) },
    { at: 0, a: mk(L1, 'codex', 'desktop', 'Compare open source video players', 'video-player', { role: 'lead' }) },
    { at: 5, a: mk('claude:demo-m1', 'claude', 'desktop', 'Polish the evening lights', 'ai-office') },
    { at: 14, a: mk('codex:demo-h1', 'codex', 'subagent', 'Helper: codec reader', 'video-player', { nickname: 'Noether', parentId: L1, role: 'helper', depth: 1 }) },
    { at: 26, a: mk('codex:demo-h2', 'codex', 'subagent', 'Helper: native auth route', 'video-player', { nickname: 'Euler', parentId: L1, role: 'helper', depth: 1 }) },
    { at: 40, a: mk('codex:demo-g1', 'codex', 'guardian', 'Guardian review', 'video-player', { nickname: 'Guardian', parentId: L1, role: 'reviewer' }) },
    { at: 48, a: mk(L2, 'claude', 'cli', 'Usage dashboard', 'usage-viewer', { role: 'lead' }) },
    { at: 56, a: mk('claude:demo-h3', 'claude', 'subagent', 'Helper: Research usage data sources', 'usage-viewer', { parentId: L2, role: 'helper', depth: 1 }) },
    { at: 70, a: mk('codex:demo-m2', 'codex', 'desktop', 'Export the manual as PDF', '手冊') },
    { at: 95, a: mk('codex:demo-h4', 'codex', 'subagent', 'Helper: publication check', 'video-player', { nickname: 'Jason', parentId: 'codex:demo-h2', role: 'helper', depth: 2 }) },
    { at: 36, a: mk('claude:demo-m3', 'claude', 'desktop', 'Fix the subtitle parser', 'subtitles') },
    { at: 44, a: mk('codex:demo-m4', 'codex', 'desktop', 'Configure the build cache', 'city-sim') },
    { at: 60, a: mk('claude:demo-m5', 'claude', 'cli', 'Review the test plan', 'city-sim') },
    { at: 66, a: mk('claude:demo-lead3', 'claude', 'desktop', 'Check the wiki links', 'team-wiki', { role: 'lead' }) },
    { at: 78, a: mk('claude:demo-h5', 'claude', 'subagent', 'Helper: check broken links', 'team-wiki', { parentId: 'claude:demo-lead3', role: 'helper', depth: 1 }) },
    { at: 22, a: mk('cursor:demo-c1', 'cursor', 'desktop', 'Refactor the settings page', 'settings-ui') },
    { at: 52, a: mk('gemini:demo-g2', 'gemini', 'cli', 'Summarise the lab notes', 'lab-notes') },
  ];
  const life = { 'codex:demo-h1': [62, 80], 'codex:demo-g1': [60, 90], 'claude:demo-m1': [50, 130], 'claude:demo-h3': [100, 125], 'codex:demo-h2': [140, 160], 'codex:demo-h4': [130, 145], 'claude:demo-h5': [125, 150], 'claude:demo-m3': [150, 200],
    [B1]: [124, 150], [BW]: [168, 205], [B2]: [170, 215], 'claude:demo-m5': [158, 190] };
  // the relayed worker works in two rounds (a brief each): idle in between, as a headless worker would be
  const busy = { [BW]: [[36, 88], [125, 168]], 'claude:demo-m5': [[60, 102], [120, 158]], 'codex:demo-m4': [[44, 144], [160, 400]] };
  // work handed over by another agent's tool (what the server infers from the process tree): the city-sim Codex
  // chat starts a headless Claude reviewer twice (one session, resumed), and that reviewer's asks and finish are the
  // chat's, not yours; during the second job the chat stops (its turn over) without answering, so that ask becomes yours
  const delegated = { 'claude:demo-m5': { id: 'codex:demo-m4', certain: false } };
  // link adoptions and the hand-over: [from s, parentId, teamSource] (the server would set these from the links)
  const reparent = {
    [BW]: [[122, B2, 'link']],                 // after the hand-over the worker looks to the second coordinator
    'gemini:demo-g2': [[100, L3, 'link']],     // an artifact link (both edited STATUS.md): a dashed thread
    'cursor:demo-c1': [[140, L3, 'link']],     // an inferred link (a content echo): a dotted thread, a grey "?" bubble
  };
  const waiting = { [L1]: [[30, 60], [100, 140]], [L2]: [[60, 100]], [B1]: [[40, 85]], [B2]: [[128, 165]] };
  const asking = { // blocked on the user (real-shaped: an open question, a permission prompt, a plan to approve)
    'claude:demo-m3': [[60, 92, 'Question for you: Keep the old config or rebuild it?']],
    'codex:demo-m4': [[112, 138, 'Needs your OK to run a command']],
    'claude:demo-m5': [[70, 92, 'Needs your OK: Running: Scan the logs for failed runs', 'giver'], [140, 156, 'Needs your OK: Writing report_view.py', 'giver', 149]],
  };
  const events = [
    { at: 14, id: 'e-spawn1', kind: 'spawn', from: L1, to: 'codex:demo-h1', text: 'codec reader' },
    { at: 26, id: 'e-spawn2', kind: 'spawn', from: L1, to: 'codex:demo-h2', text: 'native auth route' },
    { at: 34, id: 'e-msg1', kind: 'message', from: 'codex:demo-h1', to: L1, text: null },
    { at: 38, id: 'e-msg2', kind: 'message', from: L1, to: 'codex:demo-h2', text: 'follow-up task' },
    { at: 40, id: 'e-rev1', kind: 'review', from: 'codex:demo-g1', to: L1, text: null },
    { at: 55, id: 'e-ver1', kind: 'verdict', from: 'codex:demo-g1', to: L1, verdict: { outcome: 'allow', risk: 'low' } },
    { at: 56, id: 'e-spawn3', kind: 'spawn', from: L2, to: 'claude:demo-h3', text: 'Research Claude Code usage data sources' },
    { at: 62, id: 'e-rep1', kind: 'report', from: 'codex:demo-h1', to: L1, text: 'Implemented validate_format.py. Import and --help pass.' },
    { at: 95, id: 'e-spawn4', kind: 'spawn', from: 'codex:demo-h2', to: 'codex:demo-h4', text: 'publication check' },
    { at: 100, id: 'e-rep2', kind: 'report', from: 'claude:demo-h3', to: L2, text: 'The status line JSON has no rate-limit fields; /usage shows 5h and 7d windows.' },
    { at: 78, id: 'e-spawn5', kind: 'spawn', from: 'claude:demo-lead3', to: 'claude:demo-h5', text: 'check broken links' },
    { at: 125, id: 'e-rep5', kind: 'report', from: 'claude:demo-h5', to: 'claude:demo-lead3', text: '14 broken links, all in the changelog folder.' },
    { at: 112, id: 'e-msg3', kind: 'message', from: 'codex:demo-h4', to: 'codex:demo-h2', text: null },
    { at: 130, id: 'e-rep3', kind: 'report', from: 'codex:demo-h4', to: 'codex:demo-h2', text: 'Publication check passed, no secrets in the diff.' },
    { at: 140, id: 'e-rep4', kind: 'report', from: 'codex:demo-h2', to: L1, text: 'Added safe failure diagnostics in the two owned source files.' },
    // links: the relayed team (declared, over 'demo-relay')
    { at: 36, id: 'l-brief1', kind: 'spawn', linkKind: 'brief', channel: 'demo-relay', confidence: 'declared', from: B1, to: BW, text: 'Audit the native auth route' },
    { at: 60, id: 'l-msg1', kind: 'message', channel: 'demo-relay', confidence: 'declared', from: BW, to: B1, text: 'Two findings so far' },
    { at: 72, id: 'l-stub1', kind: 'message', channel: 'demo-relay', confidence: 'declared', from: B1, stub: { side: 'to', label: 'name:ops-channel' }, text: 'status posted' },
    { at: 86, id: 'l-reply1', kind: 'report', linkKind: 'reply', channel: 'demo-relay', confidence: 'declared', from: BW, to: B1, text: 'Auth route audited: one unchecked redirect, patch attached.' },
    { at: 96, id: 'l-appr1', kind: 'approval', channel: 'demo-relay', confidence: 'declared', to: BW, stub: { side: 'from', label: 'name:collaboration panel' }, text: 'patch accepted' },
    { at: 120, id: 'l-hand1', kind: 'handoff', channel: 'demo-relay', confidence: 'declared', from: B1, to: B2, text: 'round 2 of the audit' },
    { at: 126, id: 'l-brief2', kind: 'spawn', linkKind: 'brief', channel: 'demo-relay', confidence: 'declared', from: B2, to: BW, text: 'Re-check the redirect fix' },
    { at: 166, id: 'l-reply2', kind: 'report', linkKind: 'reply', channel: 'demo-relay', confidence: 'declared', from: BW, to: B2, text: 'Redirect fix verified, no regressions.' },
    // a launch seen in process ancestry: panel.py started the AI-Office session (the launcher is outside the office)
    { at: 8, id: 'l-launch1', kind: 'launch', channel: 'process', confidence: 'structural', to: 'claude:demo-m1', stub: { side: 'from', label: 'name:panel.py' } },
    // weaker evidence into the wiki lead's pod: an artifact link (dashed thread) and an inferred one (dotted, "?")
    { at: 100, id: 'l-art1', kind: 'spawn', linkKind: 'brief', channel: 'STATUS.md', confidence: 'artifact', from: L3, to: 'gemini:demo-g2', text: 'lint the lab notes folder' },
    { at: 136, id: 'l-art2', kind: 'report', linkKind: 'reply', channel: 'STATUS.md', confidence: 'artifact', from: 'gemini:demo-g2', to: L3, text: 'Lab notes linted, 3 fixes.' },
    { at: 140, id: 'l-inf1', kind: 'message', channel: 'echo', confidence: 'inferred', from: L3, to: 'cursor:demo-c1', text: null },
    // the process tree: a Codex chat's tool started the reviewer (inferred: the one Codex chat at work in that project)
    { at: 60, id: 'l-host1', kind: 'launch', channel: 'process', confidence: 'inferred', from: 'codex:demo-m4', to: 'claude:demo-m5' },
    { at: 120, id: 'l-host2', kind: 'launch', channel: 'process', confidence: 'inferred', from: 'codex:demo-m4', to: 'claude:demo-m5' },
  ];
  /** the team root of an agent in this tick's list (a helper under a helper belongs to the top lead) */
  const rootOf = (a, byId) => { let x = a, guard = 0; while (x.parentId && byId.has(x.parentId) && guard++ < 6) x = byId.get(x.parentId); return x.id; };

  function tick() {
    const s = (Date.now() - t0) / 1000 + SKIP;
    const agents = [];
    for (const r of roster) {
      if (s < r.at || (ONLY && !ONLY.has(r.a.id))) continue;
      const [idleAt = 1e9, leaveAt = 1e9] = life[r.a.id] || [];
      if (s >= leaveAt) continue;
      const a = { ...r.a };
      const pool = a.vendor === 'claude' ? CLAUDE_THOUGHTS : CODEX_THOUGHTS;
      const idx = Math.floor((s - r.at) / 5) + r.at;
      const [kind, text] = pool[idx % pool.length];
      a.status = s >= idleAt ? 'idle' : 'working';
      let idleFrom = idleAt;
      const rounds = busy[a.id];
      if (rounds) { // works in rounds: idle between them, from the end of the last round
        const cur = rounds.find(([x, y]) => s >= x && s < y);
        a.status = cur ? 'working' : 'idle';
        if (!cur) { const done = rounds.filter(([, y]) => s >= y); idleFrom = done.length ? done[done.length - 1][1] : r.at; }
      }
      const sw = (reparent[a.id] || []).filter(([x]) => s >= x).pop(); // adopted by a link, or handed to another lead
      if (sw) { a.parentId = sw[1]; a.role = 'helper'; a.depth = 1; a.teamSource = sw[2]; }
      a.waiting = (waiting[a.id] || []).some(([x, y]) => s >= x && s < y);
      const ask = a.status === 'working' ? (asking[a.id] || []).find(([x, y]) => s >= x && s < y) : null;
      a.asking = ask?.[2] || null;
      a.delegator = delegated[a.id] || null;
      a.askTo = ask?.[3] === 'giver' && (ask[4] == null || s < ask[4]) ? a.delegator?.id ?? null : null; // past [4]: escalated to you
      a.thought = a.status === 'working' ? { kind, text, at: t0 + Math.floor((s - r.at) / 5) * 5000 } : { kind: 'say', text: 'All done here.', at: t0 + (idleFrom - SKIP) * 1000 };
      a.idleSince = a.status === 'idle' ? t0 + (idleFrom - SKIP) * 1000 : null;
      agents.push(a);
    }
    const byId = new Map(agents.map(a => [a.id, a]));
    for (const a of agents) if (a.delegator && !byId.has(a.delegator.id)) { a.delegator = null; a.askTo = null; } // the giver left
    for (const a of agents) if (a.askTo && byId.get(a.askTo)?.asking) a.askTo = null; // the giver is waiting on you: so is this ask
    for (const a of agents) { a.teamId = rootOf(a, byId); a.helpers = agents.filter(x => x.parentId === a.id && x.role === 'helper').length; } // after everyone is in
    const ev = events.filter(e => s >= e.at && s < e.at + 170 && (!ONLY || [e.from, e.to].every(x => !x || ONLY.has(x)))).map(e => ({ ...e, at: t0 + (e.at - SKIP) * 1000 }));
    const teamIds = [...new Set(agents.map(a => a.teamId))];
    const teams = teamIds.map(tid => ({ id: tid, lead: tid, members: agents.filter(a => a.teamId === tid && a.id !== tid && a.role !== 'reviewer').map(a => a.id), reviewers: agents.filter(a => a.teamId === tid && a.role === 'reviewer').map(a => a.id) }));
    addDemoJobs(agents, false);
    onSnapshot({ type: 'snapshot', now: Date.now(), agents, events: ev, teams, config: DEMO_CONFIG, schedules: demoSchedules() });
  }
  tick();
  return setInterval(tick, 1000);
}
