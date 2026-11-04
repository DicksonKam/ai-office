import * as THREE from 'three';

let gradient;
export function gradientMap() {
  if (gradient) return gradient;
  const data = new Uint8Array([120, 120, 120, 255, 185, 185, 185, 255, 235, 235, 235, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter; gradient.needsUpdate = true;
  return gradient;
}

const cache = new Map();
export function toon(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (cache.has(key)) return cache.get(key);
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap(), ...opts });
  cache.set(key, m);
  return m;
}
export function matte(color, opts = {}) {
  const key = `std|${color}|${JSON.stringify(opts)}`;
  if (cache.has(key)) return cache.get(key);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...opts });
  cache.set(key, m);
  return m;
}

const OUTLINE = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { color: { value: new THREE.Color(0x4a3340) }, thickness: { value: 0.016 } },
  vertexShader: `uniform float thickness; void main(){ vec3 p = position + normalize(normal) * thickness; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
  fragmentShader: `uniform vec3 color; void main(){ gl_FragColor = vec4(color, 1.0); }`,
});
const outlineMats = new Map([[0.016, OUTLINE]]); // one material per thickness so static batching can merge ink hulls
function outlineMat(thickness) {
  let m = outlineMats.get(thickness);
  if (!m) { m = OUTLINE.clone(); m.uniforms.thickness.value = thickness; outlineMats.set(thickness, m); }
  return m;
}
export function outlined(mesh, thickness = 0.016) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat(thickness));
  o.castShadow = false; o.receiveShadow = false; o.renderOrder = -1;
  mesh.add(o);
  return mesh;
}

export function mesh(geo, mat, { x = 0, y = 0, z = 0, cast = true, receive = true, outline = false } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = receive && !mat.transparent; // glass and glows take no shade: with VSM, anything that takes shade also throws it
  if (outline) outlined(m, typeof outline === 'number' ? outline : 0.016);
  return m;
}
export const box = (w, h, d, mat, o) => mesh(new THREE.BoxGeometry(w, h, d), mat, o);
export const sphere = (r, mat, o, seg = 24) => mesh(new THREE.SphereGeometry(r, seg, seg * 0.75), mat, o);
export const cyl = (rt, rb, h, mat, o, seg = 24) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat, o);
export const capsule = (r, len, mat, o) => mesh(new THREE.CapsuleGeometry(r, len, 6, 16), mat, o);

/** Rounded box via extruded rounded rectangle – nice for desks and sofas. */
export function roundedBox(w, h, d, radius, mat, o = {}) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -d / 2, r = Math.min(radius, w / 2, d / 2);
  shape.moveTo(x + r, y); shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r); shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d); shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 });
  geo.rotateX(-Math.PI / 2); geo.translate(0, 0, 0);
  const m = mesh(geo, mat, o);
  // Extrude goes along +z then rotated: geometry now spans y in [0,h]. Center it vertically.
  m.geometry.translate(0, -h / 2, 0);
  return m;
}
