import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import type { MotionProfile } from '../src/types';
import { repairPmxSkinGradients } from '../src/skinGradients';

const profile = { profileId: 'generic-vrm', capabilities: ['pmx-converted'] } as MotionProfile;

function fixture(values = [0, .8, .2, .8, 1]) {
  const scene = new THREE.Group(), chest = new THREE.Bone(), arm = new THREE.Bone(), elbow = new THREE.Bone();
  scene.add(chest); chest.add(arm); arm.add(elbow); arm.position.x = .5; elbow.position.x = .5;
  const right = new THREE.Bone(), rightElbow = new THREE.Bone(); chest.add(right); right.add(rightElbow);
  const leg = new THREE.Bone(), dynamic = new THREE.Bone(); chest.add(leg, dynamic);
  const positions: number[] = [], indices: number[] = [], weights: number[] = [], skin: number[] = [];
  for (let row = 0; row < 2; row++) for (let x = 0; x < values.length; x++) {
    positions.push(x / (values.length - 1), row * .02, .005 * Math.sin(x));
    skin.push(0, 1, 0, 0); weights.push(1 - values[x], values[x], 0, 0);
  }
  for (let x = 0; x + 1 < values.length; x++) {
    const a = x, b = x + 1, c = x + values.length, d = c + 1;
    // Symmetric triangulation avoids imposing a preferred direction on the strip.
    indices.push(a, b, c, c, b, d, a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4)); g.setIndex(indices); g.computeVertexNormals();
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); scene.add(mesh); scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([chest, arm, elbow, leg, dynamic]));
  const bones: Record<string, THREE.Bone> = { spine: chest, chest, leftUpperArm: arm, leftLowerArm: elbow,
    rightUpperArm: right, rightLowerArm: rightElbow, leftUpperLeg: leg, rightUpperLeg: leg };
  const vrm = { scene, humanoid: { getRawBoneNode: (name: string) => bones[name] ?? null } } as unknown as VRM;
  return { scene, vrm, mesh, g, arm, leg, dynamic };
}

describe('upper-body skin gradients', () => {
  it('repairs an alternating weight strip without changing rigid anchors or mesh structure', () => {
    const { vrm, mesh, g, arm } = fixture();
    const position = g.attributes.position, normal = g.attributes.normal, index = g.index, skin = g.attributes.skinIndex;
    const result = repairPmxSkinGradients(vrm, profile, new Set([mesh]));
    expect(result.vertices).toBe(6); expect(result.residual).toBeLessThanOrEqual(1e-7);
    const w = g.attributes.skinWeight;
    for (let row = 0; row < 2; row++) for (let x = 0; x < 5; x++) {
      expect(w.getY(row * 5 + x)).toBeCloseTo(x / 4, 5);
      expect(w.getX(row * 5 + x) + w.getY(row * 5 + x)).toBeCloseTo(1, 6);
      expect(w.getZ(row * 5 + x)).toBe(0); expect(w.getW(row * 5 + x)).toBe(0);
    }
    expect(g.attributes.position).toBe(position); expect(g.attributes.normal).toBe(normal);
    expect(g.index).toBe(index); expect(g.attributes.skinIndex).toBe(skin);
    for (const angle of [0, Math.PI / 2, Math.PI, -.5]) {
      arm.rotation.z = angle; vrm.scene.updateMatrixWorld(true); mesh.skeleton.update();
      for (let i = 0; i < position.count; i++) expect(mesh.getVertexPosition(i, new THREE.Vector3()).toArray().every(Number.isFinite)).toBe(true);
    }
    expect(repairPmxSkinGradients(vrm, profile, new Set([mesh])).vertices).toBe(0);
  });

  it('preserves a harmonic field, direct VRM and Yachiyo', () => {
    const { vrm, g, mesh } = fixture([0, .25, .5, .75, 1]), before = g.attributes.skinWeight;
    expect(repairPmxSkinGradients(vrm, profile, new Set([mesh])).vertices).toBe(0); expect(g.attributes.skinWeight).toBe(before);
    for (const excluded of [{ ...profile, profileId: 'yachiyo' }, { ...profile, capabilities: [] }]) {
      const f = fixture(); expect(repairPmxSkinGradients(f.vrm, excluded, new Set([f.mesh])).vertices).toBe(0);
    }
  });

  it('preserves whole-body skins and unanchored blends', () => {
    const f = fixture(), before = f.g.attributes.skinWeight;
    f.g.attributes.skinIndex.setZ(0, 3); f.g.attributes.skinWeight.setXYZW(0, .8, 0, .2, 0);
    expect(repairPmxSkinGradients(f.vrm, profile, new Set([f.mesh])).vertices).toBe(0); expect(f.g.attributes.skinWeight).toBe(before);
    const floating = fixture([.2, .8, .2, .8, .2]);
    expect(repairPmxSkinGradients(floating.vrm, profile, new Set([floating.mesh])).vertices).toBe(0);
  });

  it('preserves dynamic influences, inactive slots and duplicate bone indices', () => {
    const f = fixture(); f.g.attributes.skinIndex.setZ(2, 4); f.g.attributes.skinWeight.setXYZW(2, .4, .2, .4, 0);
    f.g.attributes.skinIndex.setZ(1, 1); f.g.attributes.skinWeight.setXYZW(1, .2, .4, .4, 0);
    repairPmxSkinGradients(f.vrm, profile, new Set([f.mesh]));
    const w = f.g.attributes.skinWeight;
    expect([w.getX(2), w.getY(2), w.getZ(2), w.getW(2)]).toEqual([Math.fround(.4), Math.fround(.2), Math.fround(.4), 0]);
    expect(w.getX(1) + w.getY(1) + w.getZ(1)).toBeCloseTo(1, 6);
    expect(w.getY(1)).toBeCloseTo(w.getZ(1), 6); expect(w.getW(1)).toBe(0);
  });

  it('does not mutate shared geometries or invalid weights', () => {
    const f = fixture(), before = f.g.attributes.skinWeight;
    const copy = new THREE.SkinnedMesh(f.g, f.mesh.material); copy.bind(f.mesh.skeleton); f.scene.add(copy);
    expect(repairPmxSkinGradients(f.vrm, profile, new Set([f.mesh])).vertices).toBe(0); expect(f.g.attributes.skinWeight).toBe(before);
    const invalid = fixture(); invalid.g.attributes.skinWeight.setX(1, NaN);
    expect(repairPmxSkinGradients(invalid.vrm, profile, new Set([invalid.mesh])).vertices).toBe(0);
  });

  it('leaves healthy disconnected clothing unchanged even when its weights admit a smoother field', () => {
    const f = fixture();
    const healthy = new THREE.SkinnedMesh(f.g.clone(), f.mesh.material);
    healthy.geometry.translate(0, 0, .1); f.scene.add(healthy); f.scene.updateMatrixWorld(true);
    healthy.bind(f.mesh.skeleton);
    const original = healthy.geometry.attributes.skinWeight;
    expect(repairPmxSkinGradients(f.vrm, profile, new Set()).vertices).toBe(0);
    expect(repairPmxSkinGradients(f.vrm, profile, new Set([f.mesh])).vertices).toBeGreaterThan(0);
    expect(healthy.geometry.attributes.skinWeight).toBe(original);
  });
});
