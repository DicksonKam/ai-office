// A made-up day for the demo's Replay: yesterday, 09:00 to 19:00 in the viewer's own time, written as the day journal
// would write it, so it plays through the same film and player as a real one. The same cast and words as the live demo
// (web/demo.js); nothing here comes from anyone's real records. The same day every time.

const HOUR = 3600000, MIN = 60000;
const CAST = [
  // [id, vendor, kind, task, project, from h, to h, extra]
  ['codex:film-lead', 'codex', 'desktop', 'Compare open source video players', 'video-player', 9.2, 12.6, { role: 'lead', helpers: [['codex:film-h1', 'Helper: codec reader', 'Noether', 'Implemented validate_format.py. Import and --help pass.'], ['codex:film-h2', 'Helper: native auth route', 'Euler', 'Added safe failure diagnostics in the two owned source files.']], reviewer: 'codex:film-g1' }],
  ['claude:film-m1', 'claude', 'desktop', 'Polish the evening lights', 'ai-office', 9.5, 11.4, {}],
  ['claude:film-m3', 'claude', 'desktop', 'Fix the subtitle parser', 'subtitles', 10.1, 13.2, { asks: [[11.05, 'Question for you: Keep the old config or rebuild it?']] }],
  ['claude:film-lead2', 'claude', 'cli', 'Usage dashboard', 'usage-viewer', 11.0, 15.5, { role: 'lead', helpers: [['claude:film-h3', 'Helper: Research usage data sources', null, 'The status line JSON has no rate-limit fields; /usage shows 5h and 7d windows.']] }],
  ['codex:film-m2', 'codex', 'desktop', 'Export the manual as PDF', '手冊', 13.4, 14.9, {}],
  ['codex:film-m4', 'codex', 'desktop', 'Configure the build cache', 'city-sim', 14.0, 17.3, { asks: [[15.2, 'Needs your OK to run a command']] }],
  ['claude:film-lead3', 'claude', 'desktop', 'Check the wiki links', 'team-wiki', 15.1, 18.2, { role: 'lead', helpers: [['claude:film-h5', 'Helper: check broken links', null, '14 broken links, all in the changelog folder.']] }],
  ['cursor:film-c1', 'cursor', 'desktop', 'Refactor the settings page', 'settings-ui', 16.0, 18.6, {}],
  ['gemini:film-g2', 'gemini', 'cli', 'Summarise the lab notes', 'lab-notes', 17.0, 18.4, { asks: [[17.6, 'Needs your OK to run a command']] }],
];

/** the made-up day, ending at `now`'s previous midnight */
export function demoDay(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1);
  const day0 = d.getTime(), at = h => Math.round(day0 + h * HOUR);
  let s = 20261109; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; // same day every time
  const out = [];
  const info = (id, vendor, kind, task, project, extra = {}) => ({ id, vendor, agentKind: kind, project, task, parentId: extra.parentId || null, role: extra.role || null, ...(extra.nickname ? { nickname: extra.nickname } : {}) });
  let eid = 0;
  const event = (t, kind, from, to, text, more = {}) => out.push({ t, kind, eid: `film-e${++eid}`, ...from, to, at: t, ...(text ? { text } : {}), ...more });
  /** someone at work from `t0` to `t1`: stretches of work with short pauses; asks wait on you */
  const session = (base, t0, t1, asks = []) => {
    out.push({ t: t0, kind: 'arrived', ...base, status: 'working' });
    let t = t0;
    const askAt = asks.map(([h, text]) => [at(h), text]);
    while (t < t1 - 4 * MIN) {
      const work = (8 + rnd() * 22) * MIN, pause = (2 + rnd() * 10) * MIN;
      const ask = askAt.find(([a]) => a >= t && a < t + work);
      if (ask) {
        out.push({ t: ask[0], kind: 'idle', ...base, workedMs: ask[0] - t });
        out.push({ t: ask[0] + 1500, kind: 'asking-start', ...base, text: ask[1] });
        const back = ask[0] + (3 + rnd() * 5) * MIN;
        out.push({ t: back, kind: 'asking-end', ...base }, { t: back + 1500, kind: 'working', ...base });
        t = back + 1500; continue;
      }
      const stop = Math.min(t + work, t1 - 2 * MIN);
      out.push({ t: stop, kind: 'idle', ...base, workedMs: stop - t });
      t = stop + pause;
      if (t < t1 - 4 * MIN) out.push({ t, kind: 'working', ...base });
    }
    out.push({ t: t1, kind: 'left', ...base });
  };
  for (const [id, vendor, kind, task, project, h0, h1, extra] of CAST) {
    const base = info(id, vendor, kind, task, project, extra), t0 = at(h0), t1 = at(h1);
    session(base, t0, t1, extra.asks);
    (extra.helpers || []).forEach(([hid, htask, nick, report], k) => {
      const s0 = t0 + (12 + k * 9) * MIN, s1 = s0 + (18 + rnd() * 20) * MIN;
      const hb = info(hid, vendor, 'subagent', htask, project, { parentId: id, role: 'helper', nickname: nick });
      event(s0, 'spawn', base, hid, htask.replace(/^Helper:\s*/, ''));
      session(hb, s0 + 3000, s1);
      event(s1 - 20000, 'report', hb, id, report);
    });
    if (extra.reviewer) {
      const r0 = t0 + 75 * MIN, rb = info(extra.reviewer, vendor, 'guardian', 'Guardian review', project, { parentId: id, role: 'reviewer', nickname: 'Guardian' });
      out.push({ t: r0, kind: 'arrived', ...rb, status: 'working' });
      event(r0 + 3000, 'review', rb, id, null);
      event(r0 + 40000, 'verdict', rb, id, null, { outcome: 'allow', risk: 'low' });
      out.push({ t: r0 + 55000, kind: 'idle', ...rb, workedMs: 55000 }, { t: r0 + 70000, kind: 'left', ...rb });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return { day: 'demo', from: at(9) - MIN, to: at(19), dayStarts: [day0], entries: out, prev: null, next: null, gaps: [], madeUp: true };
}
