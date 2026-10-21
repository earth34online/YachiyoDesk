import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, type VRM, type VRMSpringBoneColliderGroup } from '@pixiv/three-vrm';
import { Vector3, type Object3D } from 'three';
import type { MotionProfile } from './types';

function under(node: Object3D | null, ancestor: Object3D): boolean {
  for (; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

const alignedCopies = new WeakMap<VRMSpringBoneCollider, VRMSpringBoneCollider>();
const runtimeCopies = new WeakSet<VRMSpringBoneCollider>();

/** A converted, unused limb capsule can be centered on the proximal joint
 * instead of the limb. Only correct that demonstrable coverage mismatch;
 * keep the authored object, radius, axis and length intact for its own groups.
 */
function limbContact(collider: VRMSpringBoneCollider, end: Object3D | null,
  referenced: Set<VRMSpringBoneCollider>): VRMSpringBoneCollider {
  const existing = alignedCopies.get(collider);
  if (existing) return existing;
  const shape = collider.shape;
  if (!end || !collider.parent || referenced.has(collider)
    || !(shape instanceof VRMSpringBoneColliderShapeCapsule) || shape.inside) return collider;
  collider.updateWorldMatrix(true, false);
  const start = collider.parent.getWorldPosition(new Vector3());
  const finish = end.getWorldPosition(new Vector3());
  const normal = new Vector3();
  if (shape.calculateCollision(collider.colliderMatrix, start, 0, normal) >= 0
    || shape.calculateCollision(collider.colliderMatrix, finish, 0, normal) <= 0) return collider;
  collider.worldToLocal(start); collider.worldToLocal(finish);
  const segment = finish.clone().sub(start), axis = shape.tail.clone().sub(shape.offset);
  const length = segment.length(), capsuleLength = axis.length();
  if (!Number.isFinite(length + capsuleLength + shape.radius) || length <= 0 || shape.radius <= 0
    || Math.abs(length - capsuleLength) > 2 * shape.radius) return collider;
  const center = shape.offset.clone().add(shape.tail).multiplyScalar(.5);
  // Require both capsule endpoints to lie within its radius of the limb axis.
  // A deliberately transverse joint collider is not a displaced limb capsule.
  const direction = segment.divideScalar(length);
  const radial = (point: Vector3) => point.clone().sub(start)
    .addScaledVector(direction, -point.clone().sub(start).dot(direction)).length();
  if (radial(shape.offset) > shape.radius || radial(shape.tail) > shape.radius
    || center.distanceTo(start) > shape.radius) return collider;
  const delta = start.add(finish).multiplyScalar(.5).sub(center);
  const copy = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeCapsule({
    offset: shape.offset.clone().add(delta), tail: shape.tail.clone().add(delta), radius: shape.radius,
  }));
  copy.name = 'Runtime aligned arm contact';
  copy.position.copy(collider.position); copy.quaternion.copy(collider.quaternion); copy.scale.copy(collider.scale);
  collider.parent.add(copy);
  alignedCopies.set(collider, copy); runtimeCopies.add(copy);
  return copy;
}

/** Reuse arm colliders omitted by PMX -> VRM spring group conversion.
 * No mesh or spring dynamics are changed. Original Ammo masks remain authoritative
 * when that backend is available; Yachiyo and direct VRM stay authored too.
 */
export function connectAuthoredArmContacts(vrm: VRM, profile: MotionProfile, originalPmxPhysics: boolean): {
  joints: number; colliders: number;
} {
  const report = { joints: 0, colliders: 0 };
  const manager = vrm.springBoneManager;
  if (originalPmxPhysics || !manager || profile.profileId !== 'generic-vrm'
    || !profile.capabilities.includes('pmx-converted')) return report;
  const head = vrm.humanoid.getRawBoneNode('head');
  if (!head) return report;
  const arms = (['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'] as const)
    .map(name => vrm.humanoid.getRawBoneNode(name)).filter((node): node is Object3D => !!node);
  const colliders: VRMSpringBoneCollider[] = [];
  const referenced = new Set(manager.colliders);
  const endpoints = new Map<Object3D, Object3D | null>();
  for (const side of ['left', 'right'] as const) {
    const upper = vrm.humanoid.getRawBoneNode(`${side}UpperArm`);
    const lower = vrm.humanoid.getRawBoneNode(`${side}LowerArm`);
    if (upper) endpoints.set(upper, lower);
    if (lower) endpoints.set(lower, vrm.humanoid.getRawBoneNode(`${side}Hand`));
  }
  // manager.colliders only includes currently referenced groups. Traverse the
  // scene to find the otherwise valid authored objects which were left unused.
  vrm.scene.traverse(node => {
    if (node instanceof VRMSpringBoneCollider && !runtimeCopies.has(node) && !('inside' in node.shape && node.shape.inside)
      && arms.some(arm => under(node.parent, arm))) colliders.push(node);
  });
  if (!colliders.length) return report;
  for (let i = 0; i < colliders.length; i++) colliders[i] = limbContact(colliders[i], endpoints.get(colliders[i].parent!) ?? null, referenced);
  const human = new Set(Object.values(vrm.humanoid.rawHumanBones).map(bone => bone!.node));
  const used = new Set<VRMSpringBoneCollider>();
  for (const joint of manager.joints) {
    if (joint.bone === head || human.has(joint.bone) || !under(joint.bone, head)) continue;
    const referenced = new Set(joint.colliderGroups.flatMap(group => group.colliders));
    const missing = colliders.filter(collider => !referenced.has(collider));
    if (!missing.length) continue;
    const group: VRMSpringBoneColliderGroup = { name: 'Runtime authored arm contacts', colliders: missing };
    joint.colliderGroups.push(group);
    // Collider ancestry participates in manager ordering. Adding references
    // alone leaves its dependency cache stale after an earlier update.
    manager.addJoint(joint);
    missing.forEach(collider => used.add(collider));
    report.joints++;
  }
  report.colliders = used.size;
  return report;
}
