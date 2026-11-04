// Tests for the HUD fit plan (web/hudfit.js): which pills fold into ⋯, compact, clamp the card or stack.
// node scripts/test-hudfit.mjs
import assert from 'node:assert/strict';
import { planHud, rowWidth, hudStates, FOLD_ORDER, SECONDARY } from '../web/hudfit.js';

// widths close to the real pills (12 px M PLUS Rounded 1c, bold)
const PILLS = { key: 47, zoom: 86, teams: 62, log: 44, more: 34, today: 60, bell: 92, bellIcon: 52, conn: 58, connIcon: 28 };
const floors = n => (n < 2 ? { floors: 0, floorsCompact: 0 } : { floors: n * 63 + (n - 1) * 4, floorsCompact: n * 36 + (n - 1) * 4 });
const TITLE_BUSY = { natural: 430, min: 210 }; // "12:30 · 🙋 2 waiting on you ✓ 1 ready for you 5 working · 2 teams · 4 floors"
const TITLE_CALM = { natural: 250, min: 210 }; // "12:30 · 3 working · 1 team"
// the HUD at a window width: 18 px insets (12 px and tighter gaps at 760 px and below)
const at = (vw, n, title = TITLE_BUSY) => planHud({
  avail: vw - (vw <= 760 ? 24 : 36), gap: vw <= 760 ? 6 : 8, hudGap: vw <= 760 ? 8 : 10, title, w: { ...PILLS, ...floors(n) },
});
const desc = p => `${p.stack ? 'stack' : 'side'}${p.clamp ? '+clamp' : ''}${p.scroll ? '+scroll' : ''} fold=[${p.fold}]${p.compactFloors ? ' compactFloors' : ''}${p.bellIcon ? ' bellIcon' : ''}${p.connIcon ? ' connIcon' : ''} row=${p.row}`;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

t('wide (1280-1600): nothing folds or compacts, with 1 or 4 floors', () => {
  for (const vw of [1280, 1440, 1600]) for (const f of [1, 4]) {
    const p = at(vw, f);
    assert.deepEqual(p.fold, [], `${vw}/${f}F ${desc(p)}`);
    assert.ok(!p.compactFloors && !p.bellIcon && !p.connIcon && !p.stack && !p.clamp, `${vw}/${f}F ${desc(p)}`);
  }
});

t('1000 px with 4 floors: secondary pills fold, the always-visible ones stay full', () => {
  const p = at(1000, 4, TITLE_CALM);
  assert.ok(p.fold.length > 0 && !p.stack && !p.compactFloors && !p.bellIcon && !p.connIcon, desc(p));
  const busy = at(1000, 4); // a long status line keeps its full text; the floor counts turn into dots first
  assert.ok(!busy.stack && !busy.clamp && !busy.bellIcon, desc(busy));
});

t('800 px with 4 floors: everything secondary folds, floors compact, still one row beside the card', () => {
  const p = at(800, 4);
  assert.deepEqual(p.fold, SECONDARY, desc(p));
  assert.ok(p.compactFloors && !p.stack, desc(p));
});

t('600 px, one floor, calm status: side by side', () => {
  const p = at(600, 1, TITLE_CALM);
  assert.ok(!p.stack, desc(p));
});

t('390 px: the pills drop under the card (last resort) and fit the full width', () => {
  for (const f of [1, 2, 4]) {
    const p = at(390, f);
    assert.ok(p.stack, `${f}F ${desc(p)}`);
    assert.ok(p.row <= 390 - 24 || p.scroll, `${f}F ${desc(p)}`);
  }
  assert.ok(!at(390, 1).scroll && !at(390, 4).scroll, 'up to 4 floors fit a phone row');
});

t('320 px with 4 floors: never wraps, the row scrolls as the very last resort', () => {
  const p = at(320, 4);
  assert.ok(p.stack && p.scroll, desc(p));
});

t('invariants over every width 280..1800 and 1..4 floors', () => {
  for (const title of [TITLE_BUSY, TITLE_CALM]) for (let f = 1; f <= 4; f++) {
    let prevIdx = -1;
    for (let vw = 1800; vw >= 280; vw -= 2) {
      if (vw === 760) prevIdx = -1; // the 760 px breakpoint tightens insets and gaps: a little more room below it
      const p = at(vw, f, title), avail = vw - (vw <= 760 ? 24 : 36), hudGap = vw <= 760 ? 8 : 10, gap = vw <= 760 ? 6 : 8;
      // only secondary pills ever fold, least used first
      assert.deepEqual([...p.fold].sort(), FOLD_ORDER.slice(0, p.fold.length).sort(), `${vw}/${f}F ${desc(p)}`);
      assert.equal(p.row, rowWidth({ ...PILLS, ...floors(f) }, p, gap));
      // never wider than the HUD: beside the card at least its clamp minimum fits; stacked the row alone fits (or scrolls)
      if (!p.stack) assert.ok(p.row + hudGap + Math.min(title.min, title.natural) <= avail, `${vw}/${f}F ${desc(p)}`);
      else assert.ok(p.row <= avail || p.scroll, `${vw}/${f}F ${desc(p)}`);
      // a narrower window never un-degrades while side by side
      if (!p.stack) {
        const idx = hudStates({ ...PILLS, ...floors(f) }).findIndex(s => JSON.stringify(s) === JSON.stringify({ fold: p.fold, compactFloors: p.compactFloors, bellIcon: p.bellIcon, connIcon: p.connIcon }));
        assert.ok(idx >= 0 && idx >= prevIdx, `${vw}/${f}F ${desc(p)} (step ${idx} after ${prevIdx})`);
        prevIdx = idx;
      }
    }
  }
});

t('the Today pill not loaded yet (width 0) takes no room and no gap', () => {
  const w = { ...PILLS, ...floors(1), today: 0 };
  const s = hudStates(w)[0];
  assert.equal(rowWidth(w, s, 8), rowWidth({ ...w, today: 60 }, s, 8) - 60 - 8);
});

for (const vw of [1440, 1000, 800, 600, 390]) for (const f of [1, 4]) console.log(`# ${vw}px ${f}F: ${desc(at(vw, f))}`);
console.log(`all ${n} passed`);
