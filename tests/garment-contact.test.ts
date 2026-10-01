import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarmentContactSolver } from '../src/garmentContact';
const { sanitizeMotionProfile } = createRequire(import.meta.url)('../electron/motion-profile.cjs');
function skin(geometry: THREE.BufferGeometry, name: string, bone: THREE.Bone) {
  const count = geometry.attributes.position.count, weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  const material = new THREE.MeshBasicMaterial(); material.name = name;
  const mesh = new THREE.SkinnedMesh(geometry, material); mesh.bind(new THREE.Skeleton([bone])); return mesh;
}
function fixture(interior: boolean) {
  const scene = new THREE.Group(), bone = new THREE.Bone(); scene.add(bone);
  const bodyGeometry = new THREE.BoxGeometry(.12, .12, .12); bodyGeometry.translate(0, .32, 0);
  const garmentGeometry = new THREE.BufferGeometry();
  const points: number[] = [], indices: number[] = [];
  for (let i = 0; i < 9; i++) {
    // A large triangle passes through the body with all vertices well outside.
    points.push(-.4, .10, 0, .4, .10, 0, 0, .8, 0); indices.push(i * 3, i * 3 + 1, i * 3 + 2);
  }
  garmentGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3)); garmentGeometry.setIndex(indices);
  if (!interior) bodyGeometry.translate(10, 0, 0);
  const body = skin(bodyGeometry, 'BODY', bone), garment = skin(garmentGeometry, 'SKIRT', bone);
  scene.add(body, garment); scene.updateWorldMatrix(true, true);
  return GarmentContactSolver.create({ scene } as VRM, sanitizeMotionProfile({ capabilities: ['pmx-converted'] }))!;
}
afterEach(() => vi.restoreAllMocks());
describe('bounded garment surface coverage and recovery', () => {
  it('skins this frame after bone movement and desktop rotation instead of stale bone and bind matrices', () => {
    const solver = fixture(true);
    const source = solver.replacements[0].source;
    const root = source.parent!;
    source.skeleton.bones[0].position.y = .1;
    root.rotation.y = 1.1; root.scale.setScalar(.78); root.position.set(2, 3, -1);
    // Deliberately do not update the scene: the production solver owns this
    // refresh before sampling CPU skin, just as the renderer owns GPU updates.
    solver.update(1 / 60);
    const state = solver as unknown as { bodyPosition: THREE.BufferAttribute; body: THREE.SkinnedMesh };
    const input = state.body.geometry.attributes.position;
    for (let i = 0; i < input.count; i++) {
      expect(state.bodyPosition.getX(i)).toBeCloseTo(input.getX(i), 5);
      expect(state.bodyPosition.getY(i)).toBeCloseTo(input.getY(i) + .1, 5);
      expect(state.bodyPosition.getZ(i)).toBeCloseTo(input.getZ(i), 5);
    }
    solver.dispose();
  });
  it('detects triangle-interior contact that has no penetrating vertex and reports residuals honestly', () => {
    const solver = fixture(true); solver.update(1 / 60);
    expect(solver.diagnostics.surfaceIntersections).toBeGreaterThan(0);
    expect(solver.diagnostics.surfaceCheckComplete).toBe(true);
    expect(solver.diagnostics.unresolvedIntersections).toBeGreaterThan(0);
    const output = solver.replacements[0].display.geometry.attributes.position;
    for (let i = 0; i < output.count; i++) expect(Number.isFinite(output.getZ(i))).toBe(true);
    solver.dispose();
  });
  it('degrades before suspending, automatically retries, and permits explicit physics re-enabling', () => {
    const solver = fixture(false); let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time += 20);
    for (let i = 0; i < 20; i++) solver.update(1 / 60);
    expect(solver.diagnostics).toMatchObject({ enabled: true, reducedMeshes: 1, coolingMeshes: 0 });
    for (let i = 0; i < 20; i++) solver.update(1 / 60);
    expect(solver.diagnostics).toMatchObject({ enabled: false, coolingMeshes: 1, surfaceCheckComplete: false });
    expect(solver.replacements[0].source.visible).toBe(true);
    solver.update(6);
    expect(solver.diagnostics.enabled).toBe(true);
    expect(solver.replacements[0].display.visible).toBe(true);
    solver.setEnabled(false); solver.setEnabled(true);
    expect(solver.diagnostics).toMatchObject({ enabled: true, coolingMeshes: 0, reducedMeshes: 0, fallbackReason: '' });
    expect(solver.diagnostics.surfaceCheckComplete).toBe(false);
    expect(solver.diagnostics.shapeCheckComplete).toBe(false);
    solver.dispose();
  });
});
