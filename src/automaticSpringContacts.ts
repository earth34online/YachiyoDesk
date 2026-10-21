import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, type VRM } from '@pixiv/three-vrm';
import { Vector3, Line3, Ray, type Object3D, type SkinnedMesh } from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';
import type { ContactConfiguration, MotionProfile } from './types';

const segments = [
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'],
] as const;
export interface AutomaticContactReport {
  status: 'not-requested' | 'native' | 'authored' | 'no-springs' | 'needs-body' | 'generated';
  candidates: Array<{ index: number; vertices: number }>;
  bodyMesh?: number;
  colliders: Array<{ bone: string; radius: number }>;
  joints: number;
}
const completed = new WeakMap<VRM, AutomaticContactReport>();

/** Only fill a genuinely missing spring contact configuration. Capsules are
 * inscribed in an unambiguous full-body skin; authored shapes, spring settings,
 * topology and materials remain authoritative. This is not a cloth rig maker.
 */
export function configureMissingSpringContacts(vrm: VRM, profile: MotionProfile, native: boolean,
  config?: ContactConfiguration): AutomaticContactReport {
  const old = completed.get(vrm); if (old) return old;
  const report: AutomaticContactReport = { status: 'no-springs', candidates: [], colliders: [], joints: 0 };
  const manager = vrm.springBoneManager;
  if (native || profile.profileId !== 'generic-vrm') { report.status = 'native'; return report; }
  if (!config || config.mode !== 'automatic') { report.status = 'not-requested'; return report; }
  if (!manager?.joints.size) return report;
  let authored = false;
  vrm.scene.traverse(node => { if (node instanceof VRMSpringBoneCollider) authored = true; });
  if (authored || manager?.colliders.length) { report.status = 'authored'; return report; }
  const human = vrm.humanoid, raw = human.rawHumanBones;
  const named = new Map<Object3D, string>(Object.entries(raw).flatMap(([name, item]) => item ? [[item.node, name] as const] : []));
  const dynamic = new Set([...manager.joints].map(joint => joint.bone));
  const meshes: SkinnedMesh[] = [];
  vrm.scene.updateWorldMatrix(true, true);
  vrm.scene.traverse(node => { if ((node as SkinnedMesh).isSkinnedMesh) meshes.push(node as SkinnedMesh); });
  const required = [['hips', 'spine', 'chest'], ['leftUpperArm', 'leftLowerArm', 'leftHand'],
    ['rightUpperArm', 'rightLowerArm', 'rightHand'], ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg']];
  const data = meshes.map((mesh, index) => {
    const g = mesh.geometry, owners: string[] = [], points: Vector3[] = [], coverage = new Set<string>();
    if (!g.attributes.skinIndex || !g.attributes.skinWeight) return { mesh, index, owners, points, movable: true, valid: false };
    let movable = false;
    for (let i = 0; i < g.attributes.position.count; i++) {
      let owner = '', best = 0;
      for (let k = 0; k < 4; k++) {
        const bone = mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i, k)], weight = g.attributes.skinWeight.getComponent(i, k);
        if (!bone || !(weight > 0)) continue;
        if (dynamic.has(bone) && !named.has(bone)) movable = true;
        if (named.has(bone) && weight > best) { best = weight; owner = named.get(bone)!; }
      }
      owners.push(best > .5 ? owner : '');
      if (best > .5) coverage.add(owner);
      points.push(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
    }
    // Do not infer the body from an isolated sleeve, skirt, hair or a merged
    // body/cloth skin containing dynamic weights. Ambiguity needs a source rig.
    return { mesh, index, owners, points, movable, valid: !movable && required.every(group => group.some(name => coverage.has(name))) };
  });
  const candidates = data.filter(item => item.valid);
  report.candidates = candidates.map(item => ({ index: item.index, vertices: item.points.length }));
  const selected = config.bodyMesh === undefined ? (candidates.length === 1 ? candidates[0] : undefined)
    : candidates.find(item => item.index === config.bodyMesh);
  if (!selected) { report.status = 'needs-body'; return report; }
  report.bodyMesh = selected.index;
  const allJoints = [...manager.joints].filter(joint => !named.has(joint.bone));
  const inserted: Array<{ bone: Object3D; collider: VRMSpringBoneCollider }> = [];
  for (const [name, endName] of segments) {
    if (config.disabledBones?.includes(name)) continue;
    const bone = human.getRawBoneNode(name), end = human.getRawBoneNode(endName);
    if (!bone || !end) continue;
    const inverse = bone.matrixWorld.clone().invert();
    const finish = end.getWorldPosition(new Vector3()).applyMatrix4(inverse), length = finish.length();
    if (!(length > 0) || !Number.isFinite(length)) continue;
    const direction = finish.clone().divideScalar(length);
    // Some sources omit skin hidden under rigidly skinned clothing. Where the
    // body has no samples, fit inside that visible, non-dynamic limb surface.
    // Dynamic sleeves/skirts never become a rigid body contact approximation.
    const surfaces = selected.owners.includes(name) ? [selected] : data.filter(item => !item.movable);
    let radius = length / 2, faces = 0;
    const segment = new Line3(new Vector3(), finish), triangle = new ExtendedTriangle();
    const ray = new Ray(new Vector3(), direction), crossing = new Vector3();
    for (const surface of surfaces) {
      const index = surface.mesh.geometry.index, count = index?.count ?? surface.points.length;
      for (let face = 0; face + 2 < count; face += 3) {
        const ids = [0, 1, 2].map(k => index ? index.getX(face + k) : face + k);
        if (!ids.every(i => surface.owners[i] === name)) continue;
        const points = ids.map(i => surface.points[i].clone().applyMatrix4(inverse));
        triangle.set(points[0], points[1], points[2]);
        if (triangle.getArea() === 0) continue;
        triangle.needsUpdate = true;
        const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, crossing);
        radius = Math.min(radius, hit && hit.length() <= length ? 0 : triangle.closestPointToSegment(segment)); faces++;
      }
    }
    // Distance to the actual triangle surface, not just its vertices: a
    // capsule fitted to a polygon's circumradius would protrude through faces.
    if (!faces || !Number.isFinite(radius)) continue;
    const shape = new VRMSpringBoneColliderShapeCapsule({ offset: new Vector3(), tail: finish.clone(), radius: 0 });
    // Keep every rest spring tip outside its new collider. A rest hair tuft
    // must never be pushed sideways merely by importing a missing config.
    for (const joint of allJoints) {
      if (joint.bone === bone || joint.bone === end) continue;
      const tip = joint.bone.localToWorld(joint.initialLocalChildPosition.clone()).applyMatrix4(inverse);
      const t = Math.max(0, Math.min(length, tip.dot(direction)));
      const distance = tip.addScaledVector(direction, -t).length();
      const scale = bone.getWorldScale(new Vector3());
      const minimumScale = Math.min(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
      radius = Math.min(radius, distance - joint.settings.hitRadius / minimumScale);
    }
    const multiplier = config.radiusScale?.[name] ?? 1;
    if (!Number.isFinite(multiplier) || multiplier < .25 || multiplier > 1) continue;
    radius *= multiplier;
    if (!(radius > length * 1e-5)) continue;
    shape.radius = radius;
    shape.offset.copy(direction).multiplyScalar(radius);
    shape.tail.copy(direction).multiplyScalar(length - radius);
    const collider = new VRMSpringBoneCollider(shape); collider.name = 'Generated body spring contact'; bone.add(collider);
    inserted.push({ bone, collider }); report.colliders.push({ bone: name, radius });
  }
  for (const joint of allJoints) {
    const colliders = inserted.filter(({ bone }) => {
      // A descendant collider would create an update dependency cycle.
      for (let n: Object3D | null = bone; n; n = n.parent) if (n === joint.bone) return false;
      return true;
    }).map(item => item.collider);
    if (!colliders.length) continue;
    joint.colliderGroups.push({ name: 'Generated body contacts', colliders }); manager.addJoint(joint); report.joints++;
  }
  report.status = report.joints ? 'generated' : 'needs-body';
  completed.set(vrm, report); return report;
}
