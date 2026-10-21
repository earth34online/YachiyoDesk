import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { repairPmxSkinSeams } from '../src/skinSeams';
import type { MotionProfile } from '../src/types';

const profile = { profileId: 'generic-vrm', capabilities: ['pmx-converted'] } as MotionProfile;

// Three pieces of a sewn fan, with duplicate UV corners. One corner follows
// the arm despite its coincident copies following the chest. Rest is closed;
// raising the arm exposes a crack. This contract is independent of the solver.
function fixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 0, .1, 0, -.1, .1, 0,
    0, 0, 0, .1, 0, 0, 0, .1, 0,
    0, 0, 0, .1, -.1, 0, .1, 0, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const indices = new Uint16Array(9 * 4), weights = new Float32Array(9 * 4);
  for (let index = 0; index < 9; index++) weights[index * 4] = 1;
  indices[6 * 4] = 1;
  weights[6 * 4] = .9; weights[6 * 4 + 1] = .1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const chest = new THREE.Bone(), arm = new THREE.Bone();
  chest.add(arm); arm.position.x = .1;
  const scene = new THREE.Group(), mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  scene.add(chest, mesh); scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([chest, arm]));
  const gap = () => {
    scene.updateMatrixWorld(true); mesh.skeleton.update();
    return mesh.getVertexPosition(0, new THREE.Vector3()).distanceTo(mesh.getVertexPosition(6, new THREE.Vector3()));
  };
  return { scene, mesh, arm, gap };
}

describe('PMX skin seams', () => {
  it('keeps a sewn seam closed throughout full arm rotation, preserving geometry and all other weights', () => {
    const { scene, mesh, arm, gap } = fixture();
    expect(gap()).toBeLessThan(1e-7);
    arm.rotation.z = Math.PI / 2;
    expect(gap()).toBeGreaterThan(.1);
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
    const original = Array.from(mesh.geometry.attributes.skinWeight.array);
    expect(repairPmxSkinSeams(scene, profile)).toEqual({ meshes: 1, seamGroups: 1, vertices: 1 });
    for (const angle of [0, .5, 1, 1.8, Math.PI, -.8, 0]) {
      arm.rotation.z = angle; expect(gap()).toBeLessThan(1e-7);
    }
    expect(mesh.geometry.attributes.position).toBe(position);
    expect(mesh.geometry.index).toBe(index);
    expect(Array.from(mesh.geometry.attributes.skinWeight.array).slice(0, 24)).toEqual(original.slice(0, 24));
    expect(repairPmxSkinSeams(scene, profile).vertices).toBe(0);
  });

  it('preserves coincident layers without a shared boundary edge', () => {
    const { scene, mesh } = fixture();
    mesh.geometry.attributes.position.setXYZ(8, .2, 0, 0);
    expect(repairPmxSkinSeams(scene, profile).vertices).toBe(0);
  });

  it('preserves distinct authored morphs and ambiguous bindings', () => {
    const { scene, mesh } = fixture();
    const morph = new THREE.Float32BufferAttribute(new Float32Array(27), 3);
    morph.setY(6, .01); mesh.geometry.morphAttributes.position = [morph];
    expect(repairPmxSkinSeams(scene, profile).vertices).toBe(0);
    delete mesh.geometry.morphAttributes.position;
    mesh.geometry.attributes.skinIndex.setX(3, 2);
    expect(repairPmxSkinSeams(scene, profile).vertices).toBe(0);
  });

  it('leaves Yachiyo and direct VRM binding untouched', () => {
    const { scene, mesh } = fixture(), before = mesh.geometry.attributes.skinWeight;
    for (const excluded of [{ ...profile, profileId: 'yachiyo' }, { ...profile, capabilities: [] }]) {
      expect(repairPmxSkinSeams(scene, excluded).vertices).toBe(0);
      expect(mesh.geometry.attributes.skinWeight).toBe(before);
    }
  });
});
