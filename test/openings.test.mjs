import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { shellGeometry, wallGeometry, windowPlan, wallPoint, wallNormal, outline } from '../web/openings.js';

const floor = { hx: 16, hz: 6 };
const shellOf = openings => { const m = new THREE.Mesh(shellGeometry(floor, openings, { height: 3.45 }), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); m.updateMatrixWorld(); return m; };
/** does a ray from outside, through this place on a wall, reach the room? */
const through = (shell, wall, u, v) => {
  const n = wallNormal(wall), p = wallPoint(wall, floor, u, v, 0.1);
  const from = new THREE.Vector3(p[0] + n[0] * 2, p[1], p[2] + n[2] * 2), to = new THREE.Vector3(p[0] - n[0] * 2, p[1], p[2] - n[2] * 2);
  return new THREE.Raycaster(from, to.clone().sub(from).normalize(), 0, 4).intersectObject(shell).length === 0;
};
const base = { w: 1.5, sill: 1.05, top: 2.45 };

test('light gets through an opening and nowhere else', () => {
  const shell = shellOf(windowPlan([-3, 4], base));
  assert.ok(through(shell, 'back', -3.4, 1.4), 'lower pane');
  assert.ok(!through(shell, 'back', 0, 1.7), 'the pier between windows');
  assert.ok(!through(shell, 'back', -3.4, 0.6), 'below the sill');
  assert.ok(!through(shell, 'back', -3.4, 3), 'above the head');
  for (const wall of ['front', 'west', 'east']) assert.ok(!through(shell, wall, 1, 1.7), `${wall} has no opening`);
});

test('the glazing bars stop the sun too', () => {
  const shell = shellOf(windowPlan([0], base));
  assert.ok(!through(shell, 'back', 0, 1.3), 'centre mullion');
  assert.ok(!through(shell, 'back', 0.4, 1.85), 'rail');
});

test('the roof stops the sun', () => {
  const shell = shellOf([]);
  const hits = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0), 0, 20).intersectObject(shell);
  assert.ok(hits.length > 0);
});

test('any other window works with no change: tall, wide, round, another wall', () => {
  const xs = [-3, 4], extent = { hx: 16, hz: 6, wallTop: 3.42 };
  const tall = shellOf(windowPlan(xs, base, 'tall', extent));
  assert.ok(through(tall, 'back', -3.4, 0.5) && through(tall, 'back', -3.4, 3), 'tall: low and high');
  const wide = shellOf(windowPlan(xs, base, 'wide', extent));
  assert.ok(through(wide, 'back', -3 + 1.2, 1.5) && !through(wide, 'back', -3 + 1.4, 1.5), 'wide: to its new edge');
  const round = shellOf(windowPlan(xs, base, 'round', extent));
  assert.ok(through(round, 'back', -3.3, 1.5), 'round: inside the circle');
  assert.ok(!through(round, 'back', -3.65, 1.05), 'round: outside the circle, inside the square it would have been');
  const walls = shellOf(windowPlan(xs, base, 'walls', extent));
  assert.ok(through(walls, 'west', -3.5 - 0.4, 1.4) && through(walls, 'front', -8 + 0.4, 1.4), 'west and front walls');
});

test('a hole for something solid does not let light in', () => {
  const shell = shellOf([{ wall: 'back', at: 0, w: 1, sill: 0, top: 2.1, light: false }]);
  assert.ok(!through(shell, 'back', 0.2, 1));
});

test('a wall is cut, its faces point outward on every wall', () => {
  for (const wall of ['back', 'front', 'west', 'east']) {
    const g = wallGeometry(wall, floor, { u0: -4, u1: 4, v1: 3 }, [{ wall, at: 0, w: 1, sill: 1, top: 2 }]);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld();
    const n = wallNormal(wall), p = wallPoint(wall, floor, 2, 1.5, 0.1);
    const hit = new THREE.Raycaster(new THREE.Vector3(p[0] + n[0] * 2, p[1], p[2] + n[2] * 2), new THREE.Vector3(-n[0], 0, -n[2]), 0, 4).intersectObject(m);
    assert.equal(hit.length > 0, true, `${wall}: an outside face is seen from outside`);
    const q = wallPoint(wall, floor, 0.2, 1.5, 0.1);
    assert.equal(new THREE.Raycaster(new THREE.Vector3(q[0] + n[0] * 2, q[1], q[2] + n[2] * 2), new THREE.Vector3(-n[0], 0, -n[2]), 0, 4).intersectObject(m).length, 0, `${wall}: hole`);
  }
});

test('the outline is the opening', () => {
  assert.deepEqual(outline({ at: 1, w: 2, sill: 1, top: 2 }), [[0, 1], [2, 1], [2, 2], [0, 2]]);
  assert.equal(outline({ at: 0, w: 1, sill: 1, top: 2, shape: 'round' }).length, 28);
});

test('the light shader is told about every opening that lets light in, and nothing else', async () => {
  const { setBuilding } = await import('../web/lightshader.js');
  const { windowAt, windowIn, indoorBox } = THREE.ShaderLib.toon.uniforms;
  setBuilding({ hx: 16, hz: 6, openings: [{ wall: 'back', at: 2, w: 1.6, sill: 1, top: 2 }, { wall: 'west', at: -3, w: 1, sill: 1, top: 3 }, { wall: 'back', at: 5, w: 1, sill: 0, top: 2, light: false }] });
  assert.deepEqual(indoorBox.value.toArray(), [16, 6]);
  assert.deepEqual(windowAt.value[0].toArray(), [2, 1.5, -6, 1.6]);
  assert.deepEqual(windowIn.value[0].toArray(), [0, 0, 1], 'a back window shines toward the front');
  assert.deepEqual(windowAt.value[1].toArray(), [-16, 2, -3, 2]);
  assert.deepEqual(windowIn.value[1].toArray(), [1, 0, 0], 'a west window shines east');
  assert.equal(windowAt.value[2].w, 0, 'the list ends here');
  assert.ok(THREE.ShaderChunk.lights_fragment_end.includes('directionalShadowMap[ 0 ]'), 'the bounce reads the sun map');
});
