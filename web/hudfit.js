// HUD fit: which pills fold into the "⋯" menu, so the pill row never wraps. Pure (no DOM): main.js measures the natural
// widths and applies the plan; scripts/test-hudfit.mjs tests it in Node.
//
// Always visible: floor buttons, Today, Alerts, connection. Secondary pills fold one by one, least used first; then the
// floor buttons compact ("1F 13" -> "1F" with a badge dot), the bell drops its label and the connection pill shrinks to
// its dot. The status card keeps its natural width while anything can still give; then it clamps (ellipsis, or wraps
// under 520 px) down to its minimum; only below that do the pills drop to a second row under the card.

export const SECONDARY = ['key', 'zoom', 'teams', 'log']; // order in the row and in the menu
export const FOLD_ORDER = ['key', 'zoom', 'log', 'teams']; // least used folds first

/** Degradation steps, mildest first. */
export function hudStates(w) {
  const out = [];
  for (let k = 0; k <= FOLD_ORDER.length; k++) {
    const folded = new Set(FOLD_ORDER.slice(0, k));
    out.push({ fold: SECONDARY.filter(id => folded.has(id)), compactFloors: false, bellIcon: false, connIcon: false });
  }
  const all = out[out.length - 1];
  if (w.floors > 0) out.push({ ...all, compactFloors: true });
  out.push({ ...out[out.length - 1], bellIcon: true });
  out.push({ ...out[out.length - 1], connIcon: true });
  return out;
}

/** Width of the pill row in a given state (pills of width 0 are not shown and take no gap). */
export function rowWidth(w, s, gap) {
  const items = [
    s.compactFloors ? w.floorsCompact || w.floors : w.floors,
    ...SECONDARY.filter(id => !s.fold.includes(id)).map(id => w[id]),
    s.fold.length ? w.more : 0,
    w.today,
    s.bellIcon ? w.bellIcon || w.bell : w.bell,
    s.connIcon ? w.connIcon || w.conn : w.conn,
  ].filter(x => x > 0);
  return items.reduce((a, b) => a + b, 0) + gap * Math.max(0, items.length - 1);
}

/**
 * @param {object} m
 * @param {number} m.avail   width of the HUD (px)
 * @param {number} m.gap     gap between pills
 * @param {number} m.hudGap  gap between the status card and the pills
 * @param {{natural:number,min:number}} m.title  status card width: natural (one line) and the least it may clamp to
 * @param {object} m.w  natural widths: floors, floorsCompact, key, zoom, teams, log, more, today, bell, bellIcon, conn, connIcon
 * @returns {{fold:string[], compactFloors:boolean, bellIcon:boolean, connIcon:boolean, stack:boolean, clamp:boolean, scroll:boolean, row:number}}
 */
export function planHud({ avail, gap = 8, hudGap = 10, title = { natural: 0, min: 0 }, w }) {
  const states = hudStates(w);
  const slack = 1; // sub-pixel rounding
  const done = (s, extra) => ({ ...s, stack: false, clamp: false, scroll: false, row: rowWidth(w, s, gap), ...extra });
  // 1. side by side, the card at its natural width: the mildest state that fits
  for (const s of states) if (rowWidth(w, s, gap) + hudGap + title.natural <= avail - slack) return done(s);
  // 2. side by side, the card clamped: the most compact pills, the card takes what is left (at least its minimum)
  const last = states[states.length - 1];
  const room = avail - hudGap - rowWidth(w, last, gap);
  if (room >= Math.min(title.min, title.natural) - slack) return done(last, { clamp: room < title.natural });
  // 3. last resort: the card on its own line, the pills on a row of their own below it
  const clamp = title.natural > avail;
  for (const s of states) if (rowWidth(w, s, gap) <= avail - slack) return done(s, { stack: true, clamp });
  return done(last, { stack: true, clamp, scroll: true }); // still too wide (tiny screen, many floors): the row scrolls
}
