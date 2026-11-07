import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it, vi } from 'vitest';
import { SeatedHandContact } from '../src/seatedHandContact';

function fixture() {
  const scene = new THREE.Group(), root = new THREE.Group(); scene.add(root);
  const leg = new THREE.Bone(), hand = new THREE.Bone(); root.add(leg, hand);
  leg.position.set(0, .5, .2); hand.position.set(0, .54, .2);
  const skin = (bone: THREE.Bone, geometry: THREE.BufferGeometry) => {
    geometry.translate(bone.position.x, bone.position.y, bone.position.z);
    const count = geometry.getAttribute('position').count, weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); root.add(mesh);
    scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([bone]));
  };
  skin(leg, new THREE.BoxGeometry(.2, .1, .3)); skin(hand, new THREE.SphereGeometry(.015, 16, 12));
  const bones: Record<string, THREE.Bone> = { leftUpperLeg: leg, leftHand: hand };
  const vrm = { scene, humanoid: { normalizedHumanBonesRoot: root, update: vi.fn(),
    getNormalizedBoneNode: (name: string) => bones[name] ?? null,
    getRawBoneNode: (name: string) => bones[name] ?? null } } as unknown as VRM;
  return { vrm, scene, root, leg, hand };
}

describe('posed lap contact', () => {
  it('places measured hand skin on the actual thigh and refits after the thigh moves', () => {
    const f = fixture(), surface = new SeatedHandContact(f.vrm);
    const first = surface.resolve('left', f.hand.position);
    expect(first.y).toBeCloseTo(.565, 4); expect(first.x).toBe(0); expect(first.z).toBe(.2);
    f.leg.position.y += .1; surface.update();
    expect(surface.resolve('left', f.hand.position).y).toBeCloseTo(.665, 4);
    f.hand.position.set(0, .8, .2); f.scene.updateMatrixWorld(true);
    expect(surface.resolve('left', f.hand.position).distanceTo(f.hand.position)).toBeLessThan(1e-6);
    f.hand.position.set(.5, .54, .2); f.scene.updateMatrixWorld(true);
    expect(surface.resolve('left', f.hand.position).distanceTo(f.hand.position)).toBeLessThan(1e-6);
  });
  it('ignores alpha-cutout cloth above the thigh while retaining solid pixels of the same material', () => {
    const f = fixture(), base = f.root.children.find(object => (object as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    const cloth = base.clone() as THREE.SkinnedMesh; cloth.geometry = base.geometry.clone();
    cloth.geometry.translate(0, .1, 0);
    const pixels = new Uint8Array([255,255,255,0]);
    const texture = new THREE.DataTexture(pixels, 1, 1); texture.needsUpdate = true;
    cloth.material = new THREE.MeshBasicMaterial({ map:texture, alphaTest:.5 });
    f.root.add(cloth); f.scene.updateMatrixWorld(true);
    const surface = new SeatedHandContact(f.vrm);
    expect(surface.resolve('left', f.hand.position).y).toBeCloseTo(.565, 4);
    pixels[3] = 255; texture.needsUpdate = true;
    expect(surface.resolve('left', f.hand.position).y).toBeCloseTo(.665, 4);
    f.hand.position.y = .9; f.scene.updateMatrixWorld(true);
    expect(surface.resolve('left', f.hand.position, true).y).toBeCloseTo(.665, 4);
    expect(surface.resolve('left', f.hand.position).y).toBeCloseTo(.9, 4);
  });
});
