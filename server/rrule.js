// The next time a recurrence rule fires (RFC 5545's common shapes: MINUTELY, HOURLY, DAILY, WEEKLY, with INTERVAL, BYMINUTE,
// BYHOUR, BYSECOND, BYDAY, UNTIL and COUNT), counted from when the rule was made, in the server's own time zone. Null when
// it will not fire again, or for a rule it cannot read: a schedule shown with no time is better than a wrong one.
const UNIT_MS = { MINUTELY: 60000, HOURLY: 3600000, DAILY: 86400000, WEEKLY: 604800000 };
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_STEPS = 20000;

export function parseRule(text) {
  const out = {};
  for (const part of String(text || '').replace(/^RRULE:/i, '').split(';')) { const [k, v] = part.split('='); if (k && v) out[k.toUpperCase()] = v; }
  return out;
}
const untilMs = v => { const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)Z?)?$/.exec(v || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 23), +(m[5] || 59), +(m[6] || 59)) : null; };
const list = v => (v == null ? null : String(v).split(',').map(Number).filter(Number.isFinite));

export function nextOccurrence(rule, anchorMs, now = Date.now()) {
  const r = parseRule(rule), unit = UNIT_MS[r.FREQ], every = Math.max(1, Number(r.INTERVAL) || 1);
  if (!unit || !Number.isFinite(anchorMs)) return null;
  const until = r.UNTIL ? untilMs(r.UNTIL) : null, count = r.COUNT ? Number(r.COUNT) : null;
  const byMin = list(r.BYMINUTE), byHour = list(r.BYHOUR), bySec = list(r.BYSECOND), byDay = r.BYDAY ? r.BYDAY.split(',').map(d => DAYS.indexOf(d.slice(-2))) : null;
  const sec = bySec?.[0] ?? new Date(anchorMs).getSeconds(), min = byMin?.[0] ?? new Date(anchorMs).getMinutes();
  // the periods this rule fires in, from the one holding the anchor; a date walk, so a clock change does not shift a daily rule
  const at = new Date(anchorMs); let fired = 0;
  const hours = byHour || [at.getHours()];
  for (let i = 0; i < MAX_STEPS; i++) {
    const candidates = [];
    if (r.FREQ === 'MINUTELY') candidates.push(new Date(anchorMs + i * every * 60000).setSeconds(sec, 0));
    else if (r.FREQ === 'HOURLY') { const d = new Date(anchorMs + i * every * 3600000); d.setMinutes(min, sec, 0); candidates.push(d.getTime()); }
    else {
      const stepDays = r.FREQ === 'DAILY' ? i * every : null;
      const days = stepDays != null ? [stepDays] : (byDay || [at.getDay()]).map(w => i * every * 7 + w - at.getDay());
      for (const dd of days) for (const h of hours) candidates.push(new Date(at.getFullYear(), at.getMonth(), at.getDate() + dd, h, min, sec, 0).getTime());
    }
    for (const t of candidates.sort((a, b) => a - b)) {
      if (t < anchorMs) continue;
      if (r.FREQ === 'WEEKLY' ? false : byDay && !byDay.includes(new Date(t).getDay())) continue;
      if (until != null && t > until) return null;
      fired++;
      if (count != null && fired > count) return null;
      if (t > now) return t;
    }
  }
  return null;
}
