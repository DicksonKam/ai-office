// Openings: the one list of where a wall has a hole in it. The wall you see is cut from this list, the window is fitted to
// it, and the invisible shell that keeps the sun out is cut from it too, so light gets in exactly where there is an opening,
// whatever its size, shape or wall. A new window is a new entry here; nothing about the lighting changes.
//
// An opening: { wall: 'back' | 'front' | 'west' | 'east', at, w, sill, top, shape: 'rect' | 'round' }. `at` is the centre along
// the wall (x on back and front, z on west and east). `light: false` is a hole for something solid, such as a door.
// Walls run from the outer face inward: `d` is the depth into the building.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const WALL_NAMES = ['back', 'front', 'west', 'east'];
const ALONG_X = { back: true, front: true, west: false, east: false };

/** a place on a wall (u along it, v up, d into the building) in floor space */
export function wallPoint(wall, { hx, hz }, u, v, d) {
  if (wall === 'back') return [u, v, -hz + d];
  if (wall === 'front') return [u, v, hz - d];
  if (wall === 'west') return [-hx + d, v, u];
  return [hx - d, v, u];
}
/** the direction a wall's outside faces */
export function wallNormal(wall) { return { back: [0, 0, -1], front: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }[wall]; }

/** an opening's edge as [u, v] points */
export function outline(o) {
  const cv = (o.sill + o.top) / 2;
  if (o.shape === 'round') {
    const r = Math.min(o.w, o.top - o.sill) / 2;
    return Array.from({ length: 28 }, (_, i) => { const a = i / 28 * Math.PI * 2; return [o.at + Math.cos(a) * r, cv + Math.sin(a) * r]; });
  }
  const l = o.at - o.w / 2, r = o.at + o.w / 2;
  return [[l, o.sill], [r, o.sill], [r, o.top], [l, o.top]];
}

/** the slim glazing bars of an opening, as { u0, u1, v0, v1 }: a centre mullion and a rail a little above the middle */
export function barsOf(o) {
  const cv = (o.sill + o.top) / 2, h = o.top - o.sill;
  if (o.shape === 'round') { const r = Math.min(o.w, h) / 2; return [{ u0: o.at - 0.025, u1: o.at + 0.025, v0: cv - r, v1: cv + r }, { u0: o.at - r, u1: o.at + r, v0: cv - 0.025, v1: cv + 0.025 }]; }
  return [{ u0: o.at - 0.025, u1: o.at + 0.025, v0: o.sill, v1: o.top }, { u0: o.at - o.w / 2, u1: o.at + o.w / 2, v0: cv + 0.075, v1: cv + 0.125 }];
}

function toWall(geo, wall, floor) {
  const o = wallPoint(wall, floor, 0, 0, 0), u = wallPoint(wall, floor, 1, 0, 0), d = wallPoint(wall, floor, 0, 0, 1);
  const axis = (a, b) => new THREE.Vector3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const m = new THREE.Matrix4().makeBasis(axis(u, o), new THREE.Vector3(0, 1, 0), axis(d, o)).setPosition(o[0], o[1], o[2]);
  geo.applyMatrix4(m);
  if (m.determinant() < 0) { // mirrored into place: turn the faces back outward
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i += 3) { const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1); p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, x, y, z); }
  }
  geo.computeVertexNormals();
  return geo;
}

/** a wall from u0 to u1, v0 up to v1 and d0 to d1 deep, with its holes cut out; `holes` are openings on this wall */
export function wallGeometry(wall, floor, { u0, u1, v0 = 0, v1, d0 = 0, d1 = 0.2 }, holes = []) {
  const shape = new THREE.Shape([new THREE.Vector2(u0, v0), new THREE.Vector2(u1, v0), new THREE.Vector2(u1, v1), new THREE.Vector2(u0, v1)]);
  for (const o of holes) shape.holes.push(new THREE.Path(outline(o).map(([u, v]) => new THREE.Vector2(u, v))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: d1 - d0, bevelEnabled: false });
  g.translate(0, 0, d0);
  return toWall(g.index ? g.toNonIndexed() : g, wall, floor);
}

/** What stops the sun: four thin walls and a roof, with a hole for every opening that lets light through and its bars left in. */
export function shellGeometry(floor, openings, { height, base = -0.3, thick = 0.04 } = {}) {
  const { hx, hz } = floor, parts = [], d0 = 0.08, d1 = d0 + thick;
  for (const wall of WALL_NAMES) {
    const half = ALONG_X[wall] ? hx : hz, on = openings.filter(o => o.wall === wall && o.light !== false);
    parts.push(wallGeometry(wall, floor, { u0: -half, u1: half, v0: base, v1: height, d0, d1 }, on));
    for (const o of on) for (const b of barsOf(o)) {
      const w = b.u1 - b.u0, h = b.v1 - b.v0, c = wallPoint(wall, floor, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2, (d0 + d1) / 2);
      const bar = ALONG_X[wall] ? new THREE.BoxGeometry(w, h, thick) : new THREE.BoxGeometry(thick, h, w);
      bar.translate(c[0], c[1], c[2]); parts.push(bar.toNonIndexed());
    }
  }
  const roof = new THREE.BoxGeometry(2 * hx, 0.1, 2 * hz); roof.translate(0, height + 0.05, 0); parts.push(roof.toNonIndexed());
  for (const g of parts) for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

/** Other windows to try the same light with (`?windows=` while checking; the office itself uses the plain list). */
export function windowPlan(xs, { w, sill, top }, variant, { hx, hz, wallTop } = {}) {
  const list = xs.map(at => ({ wall: 'back', at, w, sill, top, shape: 'rect' }));
  if (variant === 'tall') return list.map(o => ({ ...o, sill: 0.3, top: wallTop - 0.25 }));
  if (variant === 'wide') return list.map((o, i) => ({ ...o, w: Math.min(2.6, ...xs.filter((_, k) => k !== i).map(x => Math.abs(x - o.at) - w - 0.3)), sill: 0.9, top: wallTop - 0.25 }));
  if (variant === 'round') return list.map(o => ({ ...o, shape: 'round', w: 1.5, sill: 0.95, top: 2.45 }));
  if (variant === 'walls') return [...list, ...[-hz + 2.5, hz - 2.5].map(at => ({ wall: 'west', at, w: 1.5, sill, top, shape: 'rect' })), ...[-hx + 8, hx - 8].map(at => ({ wall: 'front', at, w: 1.5, sill, top, shape: 'rect' }))];
  return list;
}
