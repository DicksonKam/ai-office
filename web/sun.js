// The sun, from nothing but the date and the place. No 3D here, so the tests run without a browser, and every tab works
// out the same sun from the same clock. Everything the daylight looks like hangs off how high the sun is, so sunrise,
// sunset and when the lamps come on follow the real day and the real season rather than fixed hours.
//
// Compass: the back wall (the one facing away from the camera, with the windows) faces south, so in world space
// -z is south, +z north, -x east and +x west.

export const SITE = { lat: 22.3, lon: 114.17 }; // Hong Kong, unless the server is told otherwise (AI_OFFICE_LAT, AI_OFFICE_LON)

const RAD = Math.PI / 180;

/** Where the sun is at a moment: `el` degrees above the horizon, `az` degrees clockwise from north (NOAA's approximation). */
export function sunPosition(date, { lat, lon } = SITE) {
  const t = date.getTime(), start = Date.UTC(date.getUTCFullYear(), 0, 1), day = Math.floor((t - start) / 864e5);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const y = 2 * Math.PI / 365 * (day + (hours - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(y) - 0.032077 * Math.sin(y) - 0.014615 * Math.cos(2 * y) - 0.040849 * Math.sin(2 * y));
  const dec = 0.006918 - 0.399912 * Math.cos(y) + 0.070257 * Math.sin(y) - 0.006758 * Math.cos(2 * y) + 0.000907 * Math.sin(2 * y) - 0.002697 * Math.cos(3 * y) + 0.00148 * Math.sin(3 * y);
  const ha = ((hours * 60 + eqTime + 4 * lon) / 4 - 180) * RAD, phi = lat * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(ha));
  return { el: el / RAD, az: ((az / RAD) + 360) % 360, pm: Math.sin(ha) > 0 };
}

/** A unit vector pointing at a place in the sky, in world space. */
export function skyDir(el, az) {
  const e = el * RAD, a = az * RAD;
  return [-Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

// What the light looks like at each height of the sun. `sun` is what comes through the openings, measured on the ground
// (sunStrength turns it into the light's own intensity; below its cap the sky makes up what the sun no longer gives the ground), `room` the even light indoors, which also keeps the furniture's
// own shadows and does not move. The room light stops at the walls, so raising it never touches the garden, and the sun is
// free to be much stronger than the light in the room: that is what makes a patch on the floor read as sun.
const NIGHT = { el: -8, sky: ['#242848', '#4d4a7a'], hemi: [0x6a6f9a, 0x3b3552, 0.58], sun: [0x9fb0ff, 0.34], room: [0xb8c4e8, 0.1], fill: [0xb8c4e8, 0.15], glass: 0x1a2350, lamps: 1 };
const DAY = { el: 28, sky: ['#cfe6ff', '#fbe9ef'], hemi: [0xe8f1ff, 0xffe9d2, 0.72], sun: [0xffeccc, 1.65], room: [0xfff4e6, 0.88], fill: [0xfff0e2, 0.7], glass: 0xbfe0ff, lamps: 0 };
// Morning: the same idea as the evening below, in a paler, rosier light, so the two never read as the same picture.
const DAWN = [
  { ...NIGHT, el: -11 },
  { el: -4, sky: ['#7a86bc', '#d8a8b8'], hemi: [0x96a4dc, 0x6a6a90, 0.95], sun: [0x9fb0ff, 0.12], room: [0xffe2c4, 0.24], fill: [0xffe2c4, 0.24], glass: 0x6070a8, lamps: 0.9 },
  { el: -1, sky: ['#f6c0a8', '#c8b0dc'], hemi: [0xc8cce8, 0xb0a4c0, 0.86], sun: [0xffa878, 0], room: [0xffe6d2, 0.45], fill: [0xffe6d2, 0.35], glass: 0xecc0b0, lamps: 0.65 },
  { el: 9, sky: ['#ffe3c6', '#fbdcdc'], hemi: [0xe8e8ee, 0xd4c8cc, 1.05], sun: [0xffc48e, 1.35], room: [0xffeedd, 0.85], fill: [0xffe9d6, 0.6], glass: 0xffdcc0, lamps: 0 },
  DAY,
];
// Evening: the sky cools as the sun warms, so a low sun reads gold against cool shade and the lawn never turns olive; once
// the sun has gone the garden falls through a blue hour while the lamps take over the room. Night comes later than at dawn.
const DUSK = [
  { ...NIGHT, el: -11 },
  { el: -4, sky: ['#6d6aa8', '#c08fb0'], hemi: [0x8a98d8, 0x64608c, 0.98], sun: [0x9fb0ff, 0.12], room: [0xffd8b4, 0.22], fill: [0xffd8b4, 0.22], glass: 0x4f5f9c, lamps: 0.95 },
  { el: -1, sky: ['#f2a98f', '#b79ad0'], hemi: [0xc0c4e4, 0xa79bb8, 0.86], sun: [0xff9060, 0], room: [0xffdcc0, 0.42], fill: [0xffdcc0, 0.35], glass: 0xe8b4a8, lamps: 0.75 },
  { el: 9, sky: ['#ffd7b0', '#f3c4cf'], hemi: [0xe6e2e6, 0xcdbcc4, 1.05], sun: [0xffb47a, 1.35], room: [0xffe9d6, 0.85], fill: [0xffe8d8, 0.6], glass: 0xffcfae, lamps: 0 },
  DAY,
];

const smooth = t => t * t * (3 - 2 * t);

/** The two key frames around this height of the sun and how far between them it is (colours are mixed by the caller). */
export function lightAt(el, pm) {
  const keys = pm ? DUSK : DAWN;
  if (el <= keys[0].el) return { a: keys[0], b: keys[0], t: 0 };
  for (let i = 0; i < keys.length - 1; i++) if (el <= keys[i + 1].el) return { a: keys[i], b: keys[i + 1], t: smooth((el - keys[i].el) / (keys[i + 1].el - keys[i].el)) };
  const last = keys[keys.length - 1];
  return { a: last, b: last, t: 0 };
}

/** A low sun spreads thin over the ground, and a patch on the floor would fade well before the evening does. Holding its
 *  strength on the ground steady keeps the patches readable all day; the cap keeps faces turned to a low sun from burning out. */
export function sunStrength(el, onGround) { return el > -1 ? onGround / Math.max(Math.sin(el * RAD), 0.45) : onGround; }

/** The moon stands opposite the sun, never lower than a useful height: the one light plays both parts, off at the changeover. */
export function moonDir(el, az) { return skyDir(Math.max(35, -el), (az + 180) % 360); }
