// Static batching: merge every static mesh under a root into as few meshes as possible.
//  - Plain, opaque, untextured, non-emissive toon/matte materials are "baked": their colour goes into a vertex colour
//    and they share one white material per family, so a whole floor of differently coloured furniture is one draw.
//  - Every other material (screens, LEDs, lamp shades, canvases, ink outlines) is merged per material, so changing it
//    at runtime (colour, opacity, emissive) still works.
//  - Transparent meshes stay separate (they are sorted back to front), except where the material says
//    userData.mergeable: one flat tint at one opacity (glass panes, sun pools) blends the same in any order.
// Anything that moves, toggles visibility, scales or is rebuilt must sit under an object flagged userData.dynamic.
// The root itself may be dynamic (a chair that slides, a character's arm): only its descendants are checked.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const bakedMats = new Map();
function bakeKey(m) {
  if (m.userData.baked) return m.userData.bakeKey; // an earlier merge: same family, colours already in the vertices
  if (m.transparent || m.map || m.alphaMap || m.vertexColors || m.userData.live) return null;
  if (m.emissive && m.emissive.getHex() !== 0) return null;
  if (m.isMeshToonMaterial) return `toon|${m.side}|${m.gradientMap?.uuid}`;
  if (m.isMeshStandardMaterial) return `std|${m.side}|${m.roughness}|${m.metalness}`;
  return null;
}
function bakedMaterial(key, m) {
  let b = bakedMats.get(key);
  if (!b) {
    b = m.clone(); b.color.setRGB(1, 1, 1); b.vertexColors = true; b.userData = { baked: true, bakeKey: key };
    bakedMats.set(key, b);
  }
  return b;
}

// a mesh that carries something moving keeps its own transform space, so it is never merged away
function hasDynamicChild(o) { let d = false; o.traverse(c => { if (c !== o && c.userData.dynamic) d = true; }); return d; }

export function freezeStatic(root, { ignoreDynamic = false } = {}) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map(); // key -> { material, cast, receive, order, baked, items: [{ o, geo }] }
  const visit = (o, dynamic) => {
    if (!o.visible) return; // hidden subtrees are not drawn now and may appear later: never bake them
    const dyn = !ignoreDynamic && (dynamic || (o !== root && !!o.userData.dynamic));
    // a mesh on a dimmed / ghosted floor wears a display variant (ghost.js): merge by its real material and shadow
    // flags, so a dimmed colour is never baked in; the caller re-applies the floor's mode to the result
    const mat = o.isMesh ? (o.userData.origMat || o.material) : null;
    if (o.isMesh && !dyn && o.visible && !Array.isArray(mat) && (!mat.transparent || mat.userData.mergeable) && !o.userData.slab && !o.userData.noMerge && !hasDynamicChild(o)) {
      const bk = bakeKey(mat), cast = o.userData.origCast ?? o.castShadow, receive = o.userData.origReceive ?? o.receiveShadow, arch = !!o.userData.arch;
      const key = `${bk ? 'bake:' + bk : mat.uuid}|${cast ? 1 : 0}|${receive ? 1 : 0}|${o.renderOrder}|${arch ? 'a' : ''}`;
      let g = groups.get(key);
      if (!g) { g = { material: bk ? bakedMaterial(bk, mat) : mat, cast, receive, order: o.renderOrder, baked: !!bk, arch, items: [] }; groups.set(key, g); }
      g.items.push({ o, color: bk && !mat.userData.baked ? mat.color : null, keepColor: !!mat.userData.baked });
    }
    for (const c of [...o.children]) visit(c, dyn);
  };
  visit(root, false);

  const prep = ({ o, color, keepColor }) => {
    let geo = o.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (geo.index) geo = geo.toNonIndexed();
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', ...(keepColor ? ['color'] : [])].includes(name)) geo.deleteAttribute(name);
    const n = geo.attributes.position.count;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (color) { const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = color.r; a[i * 3 + 1] = color.g; a[i * 3 + 2] = color.b; } geo.setAttribute('color', new THREE.Float32BufferAttribute(a, 3)); }
    geo.morphAttributes = {}; geo.clearGroups();
    return geo;
  };

  let merged = 0, removed = 0;
  const victims = [];
  for (const g of groups.values()) {
    if (g.items.length < 2) continue; // nothing to gain: keep the original mesh and material
    const geos = g.items.map(prep);
    const geo = mergeGeometries(geos, false);
    for (const x of geos) x.dispose();
    if (!geo) continue;
    const m = new THREE.Mesh(geo, g.material);
    m.castShadow = g.cast; m.receiveShadow = g.receive; m.renderOrder = g.order; m.userData.merged = true; if (g.arch) m.userData.arch = true;
    root.add(m); merged++;
    for (const it of g.items) victims.push(it.o);
  }
  // remove the originals (keep their children: they were visited separately and may be dynamic or unmerged)
  for (const o of victims) {
    const parent = o.parent; if (!parent) continue;
    for (const c of [...o.children]) { c.applyMatrix4(o.matrix); parent.add(c); }
    parent.remove(o); removed++;
    if (o.userData.merged) o.geometry.dispose(); // an earlier merge result owns its geometry: free it (re-merged props)
  }
  return { merged, removed };
}
