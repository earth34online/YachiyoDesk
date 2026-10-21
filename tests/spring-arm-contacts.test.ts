import * as THREE from 'three';
import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapeSphere,
  VRMSpringBoneJoint, VRMSpringBoneManager, type VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { connectAuthoredArmContacts } from '../src/springArmContacts';
import type { MotionProfile } from '../src/types';

const profile = { profileId: 'generic-vrm', capabilities: ['pmx-converted'] } as MotionProfile;
function fixture() {
  const scene = new THREE.Group(), head = new THREE.Bone(), hair = new THREE.Bone(), tail = new THREE.Bone(), arm = new THREE.Bone();
  scene.add(head, arm); head.add(hair); hair.add(tail); tail.position.y = -.3;
  const collider = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({ radius: .08 }));
  arm.add(collider); arm.position.set(.03, -.28, 0); scene.updateMatrixWorld(true);
  const manager = new VRMSpringBoneManager(), joint = new VRMSpringBoneJoint(hair, tail, { stiffness: 1, gravityPower: 0, dragForce: .5 });
  manager.addJoint(joint); manager.setInitState();
  const nodes = { head, leftUpperArm: arm } as Record<string, THREE.Object3D>;
  const vrm = { scene, springBoneManager: manager, humanoid: {
    getRawBoneNode: (name: string) => nodes[name] ?? null,
    rawHumanBones: Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, { node }])),
  } } as unknown as VRM;
  return { vrm, scene, arm, hair, tail, joint, manager, collider, nodes };
}

describe('authored PMX arm contacts', () => {
  it('activates unused authored colliders and keeps a moving arm out of a head spring', () => {
    const { vrm, manager, joint, arm, collider } = fixture();
    expect(manager.colliders).toHaveLength(0);
    manager.update(1 / 60); // Prime ordering before references are added.
    collider.updateWorldMatrix(true, false);
    const originalTail = joint.bone.localToWorld(joint.initialLocalChildPosition.clone());
    expect(collider.shape.calculateCollision(collider.colliderMatrix, originalTail, 0, new THREE.Vector3())).toBeLessThan(-.02);
    const settings = { ...joint.settings };
    expect(connectAuthoredArmContacts(vrm, profile, false)).toEqual({ joints: 1, colliders: 1 });
    manager.setInitState();
    const point = new THREE.Vector3(), normal = new THREE.Vector3();
    for (const x of [.03, .04, -.03, -.04]) {
      arm.position.x = x;
      for (let frame = 0; frame < 30; frame++) manager.update(1 / 60);
      joint.bone.localToWorld(point.copy(joint.initialLocalChildPosition));
      // The library projects out of the surface and then restores bone length;
      // its settled residual must remain below the 1 mm visible-contact bound.
      expect(collider.shape.calculateCollision(collider.colliderMatrix, point, 0, normal)).toBeGreaterThan(-.001);
    }
    expect(joint.settings).toEqual(settings);
    expect(connectAuthoredArmContacts(vrm, profile, false)).toEqual({ joints: 0, colliders: 0 });
    expect(joint.colliderGroups).toHaveLength(1);
  });

  it('preserves existing groups, excludes self and body springs, and does not invent missing colliders', () => {
    const { vrm, joint, manager, arm, collider } = fixture();
    const authored = { name: 'authored', colliders: [collider] }; joint.colliderGroups.push(authored);
    const bodyJoint = new VRMSpringBoneJoint(arm, null); manager.addJoint(bodyJoint);
    expect(connectAuthoredArmContacts(vrm, profile, false).joints).toBe(0);
    expect(joint.colliderGroups).toEqual([authored]);
    expect(bodyJoint.colliderGroups).toEqual([]);
    collider.removeFromParent(); joint.colliderGroups.length = 0;
    expect(connectAuthoredArmContacts(vrm, profile, false)).toEqual({ joints: 0, colliders: 0 });
  });

  it('preserves original Ammo masks, Yachiyo and direct VRM configurations', () => {
    const { vrm, joint } = fixture();
    for (const [p, native] of [[profile, true], [{ ...profile, profileId: 'yachiyo-long-garment-v1' }, false],
      [{ ...profile, capabilities: [] }, false]] as [MotionProfile, boolean][]) {
      expect(connectAuthoredArmContacts(vrm, p, native).joints).toBe(0);
      expect(joint.colliderGroups).toHaveLength(0);
    }
  });

  it('does not apply an authored inward cage as an external arm surface', () => {
    const { vrm, collider, joint } = fixture();
    (collider.shape as VRMSpringBoneColliderShapeSphere).inside = true;
    expect(connectAuthoredArmContacts(vrm, profile, false).colliders).toBe(0);
    expect(joint.colliderGroups).toHaveLength(0);
  });

  it('repairs an unused proximal-centered capsule without changing its source shape or inflating it', () => {
    const f = fixture(); f.collider.removeFromParent();
    const lower = new THREE.Bone(); lower.position.y = -.3; f.arm.add(lower); f.nodes.leftLowerArm = lower;
    const shape = new VRMSpringBoneColliderShapeCapsule({
      offset: new THREE.Vector3(0, -.15, 0), tail: new THREE.Vector3(0, .15, 0), radius: .035,
    });
    const source = new VRMSpringBoneCollider(shape); f.arm.add(source);
    f.scene.rotation.set(.3, -.4, .2); f.scene.scale.setScalar(2); f.scene.updateMatrixWorld(true);
    connectAuthoredArmContacts(f.vrm, profile, false);
    const copy = f.joint.colliderGroups[0].colliders[0];
    expect(copy).not.toBe(source);
    const result = copy.shape as VRMSpringBoneColliderShapeCapsule;
    expect(result.offset.distanceTo(new THREE.Vector3(0, -.3, 0))).toBeLessThan(1e-8);
    expect(result.tail.length()).toBeLessThan(1e-8);
    expect(result.radius).toBe(shape.radius);
    expect(result.tail.distanceTo(result.offset)).toBeCloseTo(shape.tail.distanceTo(shape.offset), 12);
    expect(shape.offset.toArray()).toEqual([0, -.15, 0]);
    expect(shape.tail.toArray()).toEqual([0, .15, 0]);
    expect(connectAuthoredArmContacts(f.vrm, profile, false)).toEqual({ joints: 0, colliders: 0 });
    expect(f.arm.children.filter(node => node instanceof VRMSpringBoneCollider)).toHaveLength(2);
  });

  it.each(['referenced', 'centered', 'transverse'] as const)('keeps an authored %s capsule intact', mode => {
    const f = fixture(); f.collider.removeFromParent();
    const lower = new THREE.Bone(); lower.position.y = -.3; f.arm.add(lower); f.nodes.leftLowerArm = lower;
    const shape = new VRMSpringBoneColliderShapeCapsule({ radius: .035,
      offset: new THREE.Vector3(mode === 'transverse' ? -.15 : 0, mode === 'centered' ? -.3 : -.15, 0),
      tail: new THREE.Vector3(mode === 'transverse' ? .15 : 0, mode === 'centered' ? 0 : .15, 0),
    });
    const source = new VRMSpringBoneCollider(shape); f.arm.add(source);
    if (mode === 'referenced') {
      const body = new VRMSpringBoneJoint(f.arm, lower, {}, [{ colliders: [source] }]);
      f.manager.addJoint(body);
    }
    connectAuthoredArmContacts(f.vrm, profile, false);
    expect(f.joint.colliderGroups[0].colliders).toEqual([source]);
    expect(f.arm.children.filter(node => node instanceof VRMSpringBoneCollider)).toHaveLength(1);
  });
});
