// Generates the app icons (SVG + PNG) from one list of shapes, so the vector and raster icons always match.
// Dev tool only (not loaded by the page). Run from the repo root:  node web/app/make-icons.mjs
// No dependencies: the PNGs are rasterised with signed distance fields and encoded with node:zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const C = {
  skyTop: '#cfe6ff', skyBottom: '#fbe9ef', cloud: '#ffffff', sun: '#ffdb94',
  ground: '#b3cda3', groundShade: '#98b98a', path: '#eedfc4',
  ink: '#3f3a4a', cream: '#faf5ee', wainscot: '#dfe6d6', roof: '#cf8466',
  glass: '#cfe1ec', glint: '#ffffff', warm: '#ffd27a', warmCore: '#ffe9b5', chibi: '#e8743b',
  door: '#d6b993', knob: '#e2b35d', awning: '#e2b35d', shrub: '#7fb173',
};

// layer 'bg' is drawn in canvas space (full bleed in the maskable icon); 'fg' is the building, scaled about the centre.
// fill is a colour or { grad: [top, bottom], y0, y1 } (null = clip helper only); clip names an earlier shape.
function shapes(variant) {
  const tile = variant === 'any';
  const s = [];
  const add = (o) => { s.push(o); return o; };
  if (tile) add({ id: 'tile', layer: 'bg', t: 'rrect', x: 24, y: 24, w: 464, h: 464, r: 104, fill: { grad: [C.skyTop, C.skyBottom], y0: 24, y1: 488 } });
  else add({ id: 'tile', layer: 'bg', t: 'rrect', x: 0, y: 0, w: 512, h: 512, r: 0, fill: { grad: [C.skyTop, C.skyBottom], y0: 0, y1: 512 } });
  const clip = tile ? 'tile' : null;
  // sky: a warm sun and one soft cloud
  add({ layer: 'bg', t: 'circle', cx: 384, cy: 100, r: 30, fill: C.sun, clip });
  for (const [cx, cy, r] of [[128, 104, 20], [156, 90, 29], [188, 106, 19]]) add({ layer: 'bg', t: 'circle', cx, cy, r, fill: C.cloud, alpha: 0.92, clip });
  add({ layer: 'bg', t: 'rrect', x: 102, y: 100, w: 106, h: 25, r: 12.5, fill: C.cloud, alpha: 0.92, clip });
  // ground and the path up to the door
  add({ layer: 'bg', t: 'rrect', x: -40, y: 380, w: 592, h: 200, r: 0, fill: C.ground, clip });
  add({ layer: 'bg', t: 'rrect', x: 234, y: 384, w: 44, h: 200, r: 0, fill: C.path, clip });
  // building
  add({ layer: 'fg', t: 'rrect', x: 116, y: 388, w: 280, h: 18, r: 9, fill: C.groundShade, alpha: 0.85 });
  add({ layer: 'fg', t: 'rrect', x: 124, y: 168, w: 264, h: 230, r: 22, fill: C.ink });
  add({ id: 'body', layer: 'fg', t: 'rrect', x: 133, y: 177, w: 246, h: 212, r: 14, fill: C.cream });
  add({ layer: 'fg', t: 'rrect', x: 120, y: 350, w: 272, h: 60, r: 0, fill: C.wainscot, clip: 'body' });
  add({ layer: 'fg', t: 'rrect', x: 106, y: 140, w: 300, h: 48, r: 18, fill: C.ink });
  add({ id: 'roof', layer: 'fg', t: 'rrect', x: 115, y: 149, w: 282, h: 30, r: 11, fill: C.roof });
  add({ layer: 'fg', t: 'rrect', x: 115, y: 149, w: 282, h: 9, r: 4.5, fill: '#ffffff', alpha: 0.22, clip: 'roof' });
  // upper windows: the left one lit warm, with a chibi at the desk
  const win = (x, y, w, h, lit, id) => {
    add({ layer: 'fg', t: 'rrect', x, y, w, h, r: 12, fill: C.ink });
    add({ id, layer: 'fg', t: 'rrect', x: x + 7, y: y + 7, w: w - 14, h: h - 14, r: 7, fill: lit ? C.warm : C.glass });
    if (lit) add({ layer: 'fg', t: 'circle', cx: x + w / 2, cy: y + h * 0.42, r: w * 0.42, fill: C.warmCore, alpha: 0.75, clip: id });
    else add({ layer: 'fg', t: 'rrect', x: x + 14, y: y + 13, w: 12, h: 12, r: 6, fill: C.glint, alpha: 0.85 });
  };
  win(156, 202, 88, 74, true, 'lit');
  add({ layer: 'fg', t: 'rrect', x: 176, y: 250, w: 48, h: 40, r: 18, fill: C.chibi, clip: 'lit' });
  add({ layer: 'fg', t: 'circle', cx: 200, cy: 238, r: 17, fill: C.chibi, clip: 'lit' });
  add({ layer: 'fg', t: 'circle', cx: 194, cy: 232, r: 4.5, fill: '#ffffff', alpha: 0.55, clip: 'lit' });
  win(268, 202, 88, 74, false, 'w2');
  // lower floor: two small windows, the door under a mustard awning
  win(156, 300, 56, 54, false, 'w3');
  win(300, 300, 56, 54, false, 'w4');
  add({ layer: 'fg', t: 'rrect', x: 228, y: 302, w: 56, h: 96, r: 12, fill: C.ink });
  add({ layer: 'fg', t: 'rrect', x: 236, y: 310, w: 40, h: 80, r: 7, fill: C.door });
  add({ layer: 'fg', t: 'circle', cx: 267, cy: 352, r: 5, fill: C.knob });
  add({ layer: 'fg', t: 'rrect', x: 214, y: 286, w: 84, h: 22, r: 11, fill: C.ink });
  add({ layer: 'fg', t: 'rrect', x: 221, y: 292, w: 70, h: 10, r: 5, fill: C.awning });
  // round shrubs at the corners, outlined like the building
  const shrubs = [[116, 380, 24], [146, 392, 17], [398, 382, 22], [370, 393, 15]];
  for (const [cx, cy, r] of shrubs) add({ layer: 'fg', t: 'circle', cx, cy, r: r + 8, fill: C.ink });
  for (const [cx, cy, r] of shrubs) add({ layer: 'fg', t: 'circle', cx, cy, r, fill: C.shrub });
  for (const [cx, cy, r] of shrubs) add({ layer: 'fg', t: 'circle', cx: cx - r * 0.3, cy: cy - r * 0.35, r: r * 0.38, fill: '#ffffff', alpha: 0.18 });
  return s;
}

const SCALE = { any: 1, maskable: 0.9 };

// ---- SVG ----------------------------------------------------------------------------
function svg(variant) {
  const sc = SCALE[variant], list = shapes(variant);
  const defs = [], body = { bg: [], fg: [] };
  let gid = 0;
  const geom = o => o.t === 'circle' ? `<circle cx="${o.cx}" cy="${o.cy}" r="${o.r}"` : `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}"${o.r ? ` rx="${o.r}"` : ''}`;
  for (const o of list) {
    if (o.id && list.some(p => p.clip === o.id)) defs.push(`<clipPath id="c-${o.id}">${geom(o)}/></clipPath>`);
    if (!o.fill) continue;
    let fill = o.fill;
    if (typeof fill === 'object') { const id = `g${gid++}`; defs.push(`<linearGradient id="${id}" x1="0" y1="${fill.y0}" x2="0" y2="${fill.y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${fill.grad[0]}"/><stop offset="1" stop-color="${fill.grad[1]}"/></linearGradient>`); fill = `url(#${id})`; }
    body[o.layer].push(`${geom(o)} fill="${fill}"${o.alpha != null ? ` fill-opacity="${o.alpha}"` : ''}${o.clip ? ` clip-path="url(#c-${o.clip})"` : ''}/>`);
  }
  const tf = sc === 1 ? '' : ` transform="translate(${256 * (1 - sc)} ${256 * (1 - sc)}) scale(${sc})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n<title>AI Office</title>\n<defs>${defs.join('')}</defs>\n${body.bg.join('\n')}\n<g${tf}>\n${body.fg.join('\n')}\n</g>\n</svg>\n`;
}

// ---- PNG ----------------------------------------------------------------------------
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
function sdf(o, x, y) {
  if (o.t === 'circle') return Math.hypot(x - o.cx, y - o.cy) - o.r;
  const r = Math.min(o.r, o.w / 2, o.h / 2), cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const qx = Math.abs(x - cx) - o.w / 2 + r, qy = Math.abs(y - cy) - o.h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function png(variant, size) {
  const sc = SCALE[variant], list = shapes(variant), byId = Object.fromEntries(list.filter(o => o.id).map(o => [o.id, o]));
  const k = 512 / size, row = size * 4 + 1, data = Buffer.alloc(row * size);
  const local = (o, X, Y) => o.layer === 'fg' ? [(X - 256) / sc + 256, (Y - 256) / sc + 256] : [X, Y];
  const cov = (o, X, Y) => { // antialiased coverage of shape o at canvas point (X, Y), measured in output pixels
    const [x, y] = local(o, X, Y);
    const d = sdf(o, x, y) * (o.layer === 'fg' ? sc : 1) / k;
    return Math.max(0, Math.min(1, 0.5 - d));
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const X = (px + 0.5) * k, Y = (py + 0.5) * k;
      let r = 0, g = 0, b = 0, a = 0; // premultiplied
      for (const o of list) {
        if (!o.fill) continue;
        let c = cov(o, X, Y);
        if (c && o.clip) c *= cov(byId[o.clip], X, Y);
        if (!c) continue;
        c *= o.alpha ?? 1;
        let col;
        if (typeof o.fill === 'object') {
          const t = Math.max(0, Math.min(1, (local(o, X, Y)[1] - o.fill.y0) / (o.fill.y1 - o.fill.y0)));
          const A = hex(o.fill.grad[0]), B = hex(o.fill.grad[1]); col = A.map((v, i) => v + (B[i] - v) * t);
        } else col = hex(o.fill);
        r = col[0] * c + r * (1 - c); g = col[1] * c + g * (1 - c); b = col[2] * c + b * (1 - c); a = c + a * (1 - c);
      }
      const i = py * row + 1 + px * 4;
      data[i] = a ? Math.round(r / a * 255) : 0; data[i + 1] = a ? Math.round(g / a * 255) : 0; data[i + 2] = a ? Math.round(b / a * 255) : 0; data[i + 3] = Math.round(a * 255);
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const v of buf) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4); len.writeUInt32BE(body.length); cr.writeUInt32BE(crc(Buffer.concat([t, body]))); return Buffer.concat([len, t, body, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(data, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(path.join(OUT, 'icon.svg'), svg('any'));
writeFileSync(path.join(OUT, 'icon-maskable.svg'), svg('maskable'));
for (const [file, variant, size] of [['icon-192.png', 'any', 192], ['icon-512.png', 'any', 512], ['icon-maskable-512.png', 'maskable', 512], ['apple-touch-icon.png', 'maskable', 180]]) writeFileSync(path.join(OUT, file), png(variant, size));
console.log('icons written to', OUT);
