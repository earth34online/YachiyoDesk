import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { HeadContactSurface } from '../src/headContactSurface';

function fixture(scale: number, direction: number) {
  const scene = new THREE.Group(), root = new THREE.Group(); scene.add(root); root.scale.setScalar(scale);
  root.rotation.y = direction; root.position.set(.4, .3, -.2);
  const head = new THREE.Bone(), neck = new THREE.Bone(), hand = new THREE.Bone();
  head.position.y = 1.5; neck.position.y = 1.3; hand.position.set(.05, 1.52, .08); root.add(head, neck, hand);
  const skin = (bone: THREE.Bone, radius: number, point: THREE.Vector3) => {
    const geometry = new THREE.SphereGeometry(radius, 32, 24); geometry.translate(point.x, point.y, point.z);
    const indices = new Uint16Array(geometry.attributes.position.count * 4), weights = new Float32Array(indices.length);
    for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); root.add(mesh); scene.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton([bone])); return mesh;
  };
  const headMesh = skin(head, .12, head.position), handMesh = skin(hand, .015, hand.position);
  const bones: Record<string, THREE.Bone> = { head, neck, rightHand: hand };
  const vrm = { scene, humanoid: { normalizedHumanBonesRoot: root,
    getNormalizedBoneNode: (name: string) => bones[name] ?? null, getRawBoneNode: (name: string) => bones[name] ?? null } } as unknown as VRM;
  return { scene, root, head, hand, headMesh, handMesh, vrm };
}

describe('head contact surface', () => {
  for (const scale of [.5, 1, 2]) for (const rotation of [0, Math.PI, .7]) {
    it(`finds the actual outer surface with measured hand thickness, scale ${scale}, rotation ${rotation}`, () => {
      const f = fixture(scale, rotation), surface = new HeadContactSurface(f.vrm);
      const target = surface.resolve(f.hand.position, new THREE.Vector3(0, 0, 1));
      expect(target.y).toBeCloseTo(f.hand.position.y, 6);
      expect(target.clone().setY(0).length()).toBeGreaterThan(.131);
      expect(target.clone().setY(0).length()).toBeLessThan(.138);
      expect(target.x / target.z).toBeCloseTo(f.hand.position.x / f.hand.position.z, 5);
      f.hand.position.copy(target).multiply(new THREE.Vector3(1.2, 1, 1.2)); f.scene.updateMatrixWorld(true);
      expect(surface.resolve(f.hand.position, new THREE.Vector3(0, 0, 1)).distanceTo(f.hand.position)).toBeLessThan(1e-6);
    });
  }
  it('keeps unsupported geometry unchanged and follows a translated head', () => {
    const f = fixture(1, 0); f.root.remove(f.headMesh);
    expect(new HeadContactSurface(f.vrm).resolve(f.hand.position, new THREE.Vector3(0, 0, 1))).toBe(f.hand.position);
    f.root.add(f.headMesh); const surface = new HeadContactSurface(f.vrm);
    f.head.position.x += .2; f.hand.position.x += .2; f.scene.updateMatrixWorld(true);
    expect(surface.resolve(f.hand.position, new THREE.Vector3(0, 0, 1)).x).toBeGreaterThan(f.hand.position.x);
  });
});
