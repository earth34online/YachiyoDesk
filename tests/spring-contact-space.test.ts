import * as THREE from 'three';
import { VRMSpringBoneJoint, VRMSpringBoneManager, type VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { prepareGenericPmxSpringSpace } from '../src/springContactSpace';
const { sanitizeMotionProfile } = createRequire(import.meta.url)('../electron/motion-profile.cjs');

function fixture() {
  const scene = new THREE.Group(), bone = new THREE.Bone(), tail = new THREE.Bone();
  scene.add(bone); bone.add(tail); bone.position.set(.12, .8, .02); tail.position.set(0, -.3, .05);
  scene.updateMatrixWorld(true);
  const joint = new VRMSpringBoneJoint(bone, tail, { gravityPower: 0, dragForce: .6, stiffness: 1 });
  const manager = new VRMSpringBoneManager(); manager.addJoint(joint);
  return { scene, bone, tail, joint, manager, vrm: { scene, springBoneManager: manager } as VRM };
}

describe('generic PMX spring reference space', () => {
  it('keeps a settled spring steady when the desktop view rotates, scales and moves', () => {
    const { scene, bone, joint, manager, vrm } = fixture();
    expect(prepareGenericPmxSpringSpace(vrm, sanitizeMotionProfile({ capabilities: ['pmx-converted'] }))).toBe(1);
    manager.setInitState();
    for (let i = 0; i < 10; i++) { manager.update(1 / 60); scene.updateMatrixWorld(true); }
    const rest = bone.quaternion.clone();
    scene.rotation.y = 1.1; scene.scale.setScalar(.78); scene.position.set(2, 3, -1);
    scene.updateMatrixWorld(true);
    for (let i = 0; i < 30; i++) { manager.update(1 / 60); scene.updateMatrixWorld(true); }
    expect(bone.quaternion.angleTo(rest)).toBeLessThan(1e-6);
    expect(joint.center?.parent).toBe(scene);
    expect(joint.center?.position.toArray()).toEqual([0, 0, 0]);
    const count = scene.children.length;
    expect(prepareGenericPmxSpringSpace(vrm, sanitizeMotionProfile({ capabilities: ['pmx-converted'] }))).toBe(0);
    expect(scene.children.length).toBe(count);
  });

  it('retains an explicitly authored center and leaves native Yachiyo and direct VRM untouched', () => {
    const { vrm, joint, scene } = fixture(); const authored = new THREE.Group(); scene.add(authored);
    joint.center = authored;
    expect(prepareGenericPmxSpringSpace(vrm, sanitizeMotionProfile({ capabilities: ['pmx-converted'] }))).toBe(0);
    expect(joint.center).toBe(authored);
    joint.center = null;
    for (const profile of [{ ...sanitizeMotionProfile({ capabilities: ['pmx-converted'] }), profileId: 'yachiyo-author-vrm-v1' }, sanitizeMotionProfile({})]) {
      expect(prepareGenericPmxSpringSpace(vrm, profile)).toBe(0);
      expect(joint.center).toBeNull();
    }
  });
});
