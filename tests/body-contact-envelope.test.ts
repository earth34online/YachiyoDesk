import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { BodyContactEnvelope } from '../src/bodyContactEnvelope';

function fixture() {
  const scene = new THREE.Group(), hips = new THREE.Bone();
  const left = new THREE.Bone(), right = new THREE.Bone();
  scene.add(hips); hips.add(left, right);
  const geometry = new THREE.BoxGeometry(.1, .1, .1);
  const weights = new Float32Array(geometry.attributes.position.count * 4);
  for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(weights.length), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  scene.add(mesh); mesh.bind(new THREE.Skeleton([hips]));
  scene.updateMatrixWorld(true);
  const vrm = { scene, humanoid: { rawHumanBones: { hips: { node: hips },
    leftUpperLeg: { node: left }, rightUpperLeg: { node: right } } } } as unknown as VRM;
  return { scene, mesh, geometry, vrm, hips };
}

describe('posed body contact envelope', () => {
  it('covers triangle interiors even when all three garment corners are outside', () => {
    const { vrm, mesh, geometry } = fixture();
    const original = Array.from(geometry.attributes.position.array);
    const envelope = BodyContactEnvelope.create(vrm, mesh, geometry, new THREE.Matrix4())!;
    const a = new THREE.Vector3(-1, -1, 0), b = new THREE.Vector3(1, -1, 0), c = new THREE.Vector3(0, 1, 0);
    expect(envelope.projectPoint(a, new THREE.Vector3(0, 0, 1))).toBe(0);
    expect(envelope.projectTriangle(a, b, c, new THREE.Vector3(0, 0, 1))).toBeGreaterThan(0);
    expect(Math.min(a.z, b.z, c.z)).toBeGreaterThan(.05);
    expect(envelope.projectTriangle(a, b, c, new THREE.Vector3(0, 0, 1))).toBe(0);
    expect(Array.from(geometry.attributes.position.array)).toEqual(original);
  });

  it('uses the nearest local exit instead of stretching a cuff along its rest normal', () => {
    const { vrm, mesh, geometry } = fixture();
    const envelope = BodyContactEnvelope.create(vrm, mesh, geometry, new THREE.Matrix4())!;
    const point = new THREE.Vector3(.049, 0, 0), before = point.clone();
    expect(envelope.projectPoint(point, new THREE.Vector3(0, 0, 1))).toBe(1);
    expect(point.distanceTo(before)).toBeLessThan(.01);
    expect(point.x).toBeGreaterThan(.05);
  });

  it('resolves a face when its preferred normals cancel', () => {
    const { vrm, mesh, geometry } = fixture();
    const envelope = BodyContactEnvelope.create(vrm, mesh, geometry, new THREE.Matrix4())!;
    const corners = [new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, -1, 0), new THREE.Vector3(0, 1, 0)];
    expect(envelope.projectTriangle(corners[0], corners[1], corners[2], new THREE.Vector3())).toBeGreaterThan(0);
    expect(envelope.projectTriangle(corners[0], corners[1], corners[2], new THREE.Vector3())).toBe(0);
  });

  it('refits moved body surfaces in model space under desktop rotation and scaling', () => {
    const { vrm, mesh, geometry, scene } = fixture();
    scene.rotation.y = 1.1; scene.scale.setScalar(.78); scene.position.set(2, 3, -1);
    scene.updateMatrixWorld(true);
    const fromWorld = scene.matrixWorld.clone().invert();
    const envelope = BodyContactEnvelope.create(vrm, mesh, geometry, fromWorld)!;
    geometry.translate(.3, 0, 0); envelope.update();
    expect(envelope.projectPoint(new THREE.Vector3(), new THREE.Vector3())).toBe(0);
    const point = new THREE.Vector3(.3, 0, 0);
    expect(envelope.projectPoint(point, new THREE.Vector3(0, 0, 1))).toBe(1);
    expect(point.distanceTo(new THREE.Vector3(.3, 0, 0))).toBeGreaterThan(.05);
  });

  it('does not select the new solver for an incomplete humanoid', () => {
    const { vrm, mesh, geometry } = fixture();
    delete (vrm.humanoid.rawHumanBones as Partial<typeof vrm.humanoid.rawHumanBones>).leftUpperLeg;
    expect(BodyContactEnvelope.create(vrm, mesh, geometry, new THREE.Matrix4())).toBeNull();
  });
});
