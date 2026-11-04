import test from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, skyDir, lightAt, moonDir, sunStrength } from '../web/sun.js';

const hk = (y, m, d, h, min = 0) => new Date(Date.UTC(y, m - 1, d, h - 8, min));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);

test('the sun at solar noon stands where Hong Kong astronomy says', () => {
  const nov = sunPosition(hk(2026, 11, 2, 12, 7));
  near(nov.el, 52.8, 1, 'November noon height');
  near(nov.az, 180, 4, 'November noon bearing');
  near(sunPosition(hk(2026, 12, 21, 12, 25)).el, 44.3, 1, 'midwinter noon height');
  assert.ok(sunPosition(hk(2026, 6, 21, 12, 20)).el > 87, 'midsummer noon: almost overhead');
});

test('sunrise and sunset fall at the real times, and move with the season', () => {
  // almanac times, which count the sun as up when its centre is 0.83 degrees below the horizon (the air bends the light)
  const crossing = (y, m, d, from, to) => { for (let t = from; t < to; t++) { const a = sunPosition(hk(y, m, d, 0, t)).el + 0.83, b = sunPosition(hk(y, m, d, 0, t + 1)).el + 0.83; if (a * b <= 0) return t; } return null; };
  near(crossing(2026, 11, 2, 300, 480), 6 * 60 + 26, 5, 'November sunrise');
  near(crossing(2026, 11, 2, 960, 1200), 17 * 60 + 49, 5, 'November sunset');
  near(crossing(2026, 6, 21, 240, 480), 5 * 60 + 39, 5, 'June sunrise');
  near(crossing(2026, 6, 21, 960, 1320), 19 * 60 + 11, 5, 'June sunset');
});

test('morning sun comes from the east, afternoon sun from the west, noon from the windows side', () => {
  const am = sunPosition(hk(2026, 11, 2, 9)), pm = sunPosition(hk(2026, 11, 2, 15)), noon = sunPosition(hk(2026, 11, 2, 12, 7));
  assert.ok(!am.pm && pm.pm);
  for (const h of [5, 6, 7, 8, 11]) assert.ok(!sunPosition(hk(2026, 11, 2, h)).pm, `${h}:00 is morning`); // before 08:00 here the UTC clock is on the day before
  for (const h of [13, 17, 20, 23]) assert.ok(sunPosition(hk(2026, 11, 2, h)).pm, `${h}:00 is not morning`);
  const [ax] = skyDir(am.el, am.az), [px] = skyDir(pm.el, pm.az), [, ny, nz] = skyDir(noon.el, noon.az);
  assert.ok(ax < 0, '-x is east'); assert.ok(px > 0, '+x is west');
  assert.ok(nz < 0 && ny > 0, 'the noon sun is above the south-facing back wall');
});

test('sky directions are unit length', () => {
  for (const [e, a] of [[0, 0], [45, 90], [88, 200], [12, 300]]) near(Math.hypot(...skyDir(e, a)), 1, 1e-9, 'length');
});

test('the light has no jumps: sun off at the horizon, lamps fade as the sun climbs', () => {
  for (const pm of [false, true]) {
    let lastSun = -1, lastLamps = 2;
    for (let el = -1; el <= 40; el += 0.5) {
      const { a, b, t } = lightAt(el, pm), sun = a.sun[1] + (b.sun[1] - a.sun[1]) * t, lamps = a.lamps + (b.lamps - a.lamps) * t;
      assert.ok(lamps <= lastLamps + 1e-9, 'lamps only go down as the sun climbs');
      if (el === -1) assert.equal(sun, 0, 'the light changes from moon to sun at nothing');
      lastSun = sun; lastLamps = lamps;
    }
    assert.ok(lastSun >= 0.9);
    assert.equal(lastLamps, 0);
    const n = lightAt(-30, pm); assert.equal(n.a.lamps, 1);
  }
});

test('the moon is always high enough to light something', () => {
  const pos = sunPosition(hk(2026, 11, 2, 23));
  const [, y] = moonDir(pos.el, pos.az);
  assert.ok(y >= Math.sin(35 * Math.PI / 180) - 1e-9);
});

test('the sun holds its strength on the ground as it sinks, up to a limit', () => {
  const onGround = el => sunStrength(el, 1) * Math.sin(el * Math.PI / 180);
  assert.ok(Math.abs(onGround(60) - 1) < 1e-9 && Math.abs(onGround(30) - 1) < 1e-9);
  assert.ok(sunStrength(5, 1) <= 1 / 0.45 + 1e-9, 'capped low down');
  assert.equal(sunStrength(-20, 0.34), 0.34, 'the moon is taken as it is');
});
