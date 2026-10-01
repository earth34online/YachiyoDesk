import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ContactSkinning } from '../src/contactSkinning';

function fixture(relative: boolean) {
  const root = new THREE.Group(), bones = Array.from({ length: 4 }, () => new THREE.Bone());
  root.add(bones[0]); for (let i = 1; i < 4; i++) { bones[i - 1].add(bones[i]); bones[i].position.set(.1, .07, -.03); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([.1, .3, -.2, -.2, .15, .05], 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 2, 3, 3, 0, 1, 2], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([.1, .2, .3, .4, 1, 0, 0, 0], 4));
  g.morphTargetsRelative = relative;
  g.morphAttributes.position = [new THREE.Float32BufferAttribute([.02, -.01, .03, -.01, .05, .02], 3)];
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh);
  mesh.position.set(.03, -.02, .01); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
  mesh.morphTargetInfluences![0] = .6;
  bones[1].rotation.set(.2, -.3, .4); bones[2].scale.set(1.1, .9, 1.2);
  root.rotation.y = 1.1; root.scale.setScalar(.78); root.position.set(2, 3, -1); root.updateMatrixWorld(true);
  return { mesh, root, bones };
}

describe('cached contact skinning', () => {
  it.each([false, true])('matches Three.js with four weights, zero slots, transforms and relative morphs=%s', relative => {
    const { mesh, root, bones } = fixture(relative), cache = new ContactSkinning();
    const expected = new THREE.Vector3(), actual = new THREE.Vector3();
    for (let frame = 0; frame < 3; frame++) {
      bones[1].rotation.y += .1; root.updateMatrixWorld(true); cache.beginFrame();
      for (let index = 0; index < 2; index++) {
        mesh.getVertexPosition(index, expected); cache.sample(mesh, index, actual);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-10);
      }
    }
  });

  it('supports meshes sharing bones with distinct bind transforms', () => {
    const { mesh, root } = fixture(true), other = mesh.clone(); root.add(other);
    other.position.x += .2; root.updateMatrixWorld(true);
    other.bindMatrix.makeTranslation(.2, .1, -.05); other.bindMatrixInverse.copy(other.bindMatrix).invert();
    const cache = new ContactSkinning(); cache.beginFrame();
    for (const m of [mesh, other]) expect(cache.sample(m, 0, new THREE.Vector3()).distanceTo(
      m.getVertexPosition(0, new THREE.Vector3()))).toBeLessThan(1e-10);
  });
});
