import * as THREE from 'three';
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm';
import type { MotionProfile, ReactionName } from './types';

type Pose = Record<string, { rotation?: number[]; position?: number[] }>;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** Analytic two-link IK: preserve lengths and choose the joint on the pole side. */
export function solveTwoLink(start: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3,
  upperLength: number, lowerLength: number, maximumFlexion = Math.PI - 0.001):
  { joint: THREE.Vector3; end: THREE.Vector3 } {
  const direction = target.clone().sub(start);
  const minimum = Math.sqrt(Math.max(0, upperLength ** 2 + lowerLength ** 2
    + 2 * upperLength * lowerLength * Math.cos(maximumFlexion)));
  const distance = THREE.MathUtils.clamp(direction.length(), Math.max(minimum, 1e-6),
    (upperLength + lowerLength) * (1 - 1e-7));
  if (direction.lengthSq() < 1e-12) direction.copy(DOWN);
  direction.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const perpendicular = pole.clone().addScaledVector(direction, -pole.dot(direction));
  if (perpendicular.lengthSq() < 1e-10) {
    perpendicular.copy(Math.abs(direction.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : UP);
    perpendicular.addScaledVector(direction, -perpendicular.dot(direction));
  }
  perpendicular.normalize();
  return {
    joint: start.clone().addScaledVector(direction, along)
      .addScaledVector(perpendicular, Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))),
    end: start.clone().addScaledVector(direction, distance),
  };
}

/** Geometry belongs to the normalized rest rig, independent of garment names or Euler sign profiles. */
export class GenericPoseConstraints {
  private readonly rest = new Map<string, THREE.Vector3>();
  private readonly fingerAxes = new Map<string, THREE.Vector3>();
  private readonly root: THREE.Object3D;
  private readonly forward = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();
  private readonly hipsRest: THREE.Vector3;
  private readonly legLength: number;
  private readonly footRest = new Map<string, THREE.Quaternion>();
  readonly diagnostics = { calibrated: true, forward: [] as number[], footAnchorError: 0,
    maximumElbowFlexion: 0, handToFaceDistance: 0 };

  static create(vrm: VRM, profile: MotionProfile): GenericPoseConstraints | null {
    // The author's Yachiyo poses have a separate contract; keep that path intact.
    if (profile.profileId !== 'generic-vrm' || !profile.capabilities.includes('pmx-converted')
      || !vrm.humanoid.getNormalizedBoneNode || !vrm.humanoid.normalizedHumanBonesRoot) return null;
    const required = ['hips', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
    if (required.some(name => !vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName))) return null;
    for (const [start, end] of [['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
      ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot']]) {
      const a = vrm.humanoid.getNormalizedBoneNode(start as VRMHumanBoneName)!.getWorldPosition(new THREE.Vector3());
      const b = vrm.humanoid.getNormalizedBoneNode(end as VRMHumanBoneName)!.getWorldPosition(new THREE.Vector3());
      const length = a.distanceTo(b);
      if (!Number.isFinite(length) || length < 1e-5) return null;
    }
    return new GenericPoseConstraints(vrm);
  }

  private constructor(private readonly vrm: VRM) {
    this.root = vrm.humanoid.normalizedHumanBonesRoot;
    this.root.updateWorldMatrix(true, true);
    for (const [name, bone] of Object.entries(vrm.humanoid.normalizedHumanBones)) {
      this.rest.set(name, this.point(bone.node));
    }
    this.hipsRest = this.rest.get('hips')!.clone();
    this.legLength = (this.length('leftUpperLeg', 'leftLowerLeg') + this.length('leftLowerLeg', 'leftFoot')
      + this.length('rightUpperLeg', 'rightLowerLeg') + this.length('rightLowerLeg', 'rightFoot')) / 2;
    for (const side of ['left', 'right']) {
      const toe = this.rest.get(`${side}Toes`);
      if (toe) this.forward.add(toe.clone().sub(this.rest.get(`${side}Foot`)!));
      this.footRest.set(`${side}Foot`, this.orientation(this.node(`${side}Foot`)!));
      if (toe) this.footRest.set(`${side}Toes`, this.orientation(this.node(`${side}Toes`)!));
    }
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, 1);
    this.forward.normalize();
    this.lateral.crossVectors(UP, this.forward).normalize();
    this.diagnostics.forward = this.forward.toArray();
    this.calibrateFingers();
  }

  private node(name: string): THREE.Object3D | null {
    return this.vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
  }
  private point(node: THREE.Object3D): THREE.Vector3 {
    return this.root.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
  }
  private orientation(node: THREE.Object3D): THREE.Quaternion {
    return this.root.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(node.getWorldQuaternion(new THREE.Quaternion()));
  }
  private length(a: string, b: string): number { return this.rest.get(a)!.distanceTo(this.rest.get(b)!); }

  get idleArmPitch(): number {
    // A small forward rest tilt, calibrated in the normalized rig rather than
    // copied from the author's separate arm convention. Retain side clearance.
    return -0.06 * this.forward.z;
  }

  private calibrateFingers(): void {
    for (const side of ['left', 'right']) {
      const index = this.rest.get(`${side}IndexProximal`), little = this.rest.get(`${side}LittleProximal`);
      const middle = this.rest.get(`${side}MiddleProximal`), next = this.rest.get(`${side}MiddleIntermediate`);
      if (!index || !little || !middle || !next) continue;
      const palm = new THREE.Vector3().crossVectors(next.clone().sub(middle), little.clone().sub(index)).normalize();
      // A normalized T-pose presents the palms downward. Infer the palm plane
      // from this rig's finger spread, then choose its inward hemisphere.
      if (palm.dot(DOWN) < 0) palm.negate();
      if (palm.lengthSq() < .5) palm.copy(DOWN);
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
        const parts = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
        let previousDirection: THREE.Vector3 | null = null;
        for (let i = 0; i < parts.length; i++) {
          const name = `${side}${finger}${parts[i]}`, start = this.rest.get(name);
          const end = this.rest.get(`${side}${finger}${parts[i + 1]}`);
          const direction: THREE.Vector3 | null = start && end ? end.clone().sub(start).normalize() : previousDirection;
          if (!start || !direction) continue;
          previousDirection = direction;
          const intoPalm = finger === 'Thumb' && i === 0
            ? middle.clone().sub(start).normalize().add(palm).normalize() : palm;
          const axis = new THREE.Vector3().crossVectors(direction, intoPalm).normalize();
          if (axis.lengthSq() > .5) this.fingerAxes.set(name, axis);
        }
      }
    }
  }

  setFinger(pose: Pose, name: string, angle: number): boolean {
    const axis = this.fingerAxes.get(name), rotation = pose[name]?.rotation;
    if (!axis || !rotation) return false;
    new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.clamp(angle, 0, 1.45)).toArray(rotation);
    return true;
  }

  measure(): Record<string, unknown> {
    this.root.updateWorldMatrix(true, true);
    const point = (name: string): THREE.Vector3 | null => {
      const bone = this.vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      return bone ? this.point(bone) : null;
    };
    const result: Record<string, unknown> = { calibrated: true, legLength: this.legLength,
      forward: this.forward.toArray(), fingerFlexion: {} as Record<string, number> };
    for (const side of ['left', 'right']) {
      const hip = point(`${side}UpperLeg`)!, knee = point(`${side}LowerLeg`)!, foot = point(`${side}Foot`)!;
      const toe = point(`${side}Toes`);
      const shoulder = point(`${side}UpperArm`), hand = point(`${side}Hand`);
      if (shoulder && hand) result[`${side}HandForward`] = hand.clone().sub(shoulder).dot(this.forward);
      result[`${side}KneeForward`] = knee.clone().sub(hip).dot(this.forward);
      result[`${side}FootSupportError`] = foot.distanceTo(this.rest.get(`${side}Foot`)!);
      if (toe) {
        result[`${side}ToeSupportError`] = toe.distanceTo(this.rest.get(`${side}Toes`)!);
        result[`${side}ToeRise`] = toe.y - foot.y;
      }
      for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
        const a = point(`${side}${finger}Proximal`), b = point(`${side}${finger}Intermediate`), c = point(`${side}${finger}Distal`);
        if (a && b && c) (result.fingerFlexion as Record<string, number>)[`${side}${finger}`]
          = b.clone().sub(a).angleTo(c.clone().sub(b));
      }
    }
    const shoulder = point('rightUpperArm'), elbow = point('rightLowerArm'), hand = point('rightHand');
    if (shoulder && elbow && hand) result.rightElbowFlexion = elbow.clone().sub(shoulder).angleTo(hand.clone().sub(elbow));
    return result;
  }

  private orient(pose: Pose, name: string, orientation: THREE.Quaternion): void {
    const node = this.node(name);
    if (!node || !pose[name]?.rotation || !node.parent) return;
    const world = this.root.getWorldQuaternion(new THREE.Quaternion()).multiply(orientation);
    node.quaternion.copy(node.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
    const restRotation = this.vrm.humanoid.normalizedRestPose[name as VRMHumanBoneName]?.rotation;
    const delta = node.quaternion.clone();
    if (restRotation) delta.multiply(new THREE.Quaternion().fromArray(restRotation).invert());
    delta.toArray(pose[name].rotation!);
    node.updateWorldMatrix(false, true);
  }

  private aim(pose: Pose, name: string, child: string, target: THREE.Vector3): void {
    const node = this.node(name)!, start = this.point(node);
    const from = this.point(this.node(child)!).sub(start).normalize();
    const to = target.clone().sub(start).normalize();
    const orientation = new THREE.Quaternion().setFromUnitVectors(from, to).multiply(this.orientation(node));
    this.orient(pose, name, orientation);
  }

  private solve(pose: Pose, upper: string, lower: string, end: string, target: THREE.Vector3,
    pole: THREE.Vector3, maximumFlexion?: number): void {
    const result = solveTwoLink(this.point(this.node(upper)!), target, pole,
      this.length(upper, lower), this.length(lower, end), maximumFlexion);
    this.aim(pose, upper, lower, result.joint);
    this.aim(pose, lower, end, result.end);
  }

  apply(pose: Pose, reaction: ReactionName | null, active: number, transitionBlend = 1): void {
    const names = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes', 'rightUpperArm', 'rightLowerArm'];
    const before = transitionBlend < 1 ? names.map(name => ({ name, rotation: pose[name]?.rotation?.slice(),
      position: pose[name]?.position?.slice() })) : null;
    this.solvePose(pose, reaction, active);
    // A new constraint must respect the animator's existing reaction crossfade.
    // In particular, interrupting a squat must not snap the pelvis upright.
    for (const entry of before ?? []) {
      const target = pose[entry.name];
      if (entry.rotation && target?.rotation) new THREE.Quaternion().fromArray(entry.rotation)
        .slerp(new THREE.Quaternion().fromArray(target.rotation), transitionBlend).toArray(target.rotation);
      if (entry.position && target?.position) for (let i = 0; i < 3; i++) {
        target.position[i] = THREE.MathUtils.lerp(entry.position[i], target.position[i], transitionBlend);
      }
    }
  }

  private solvePose(pose: Pose, reaction: ReactionName | null, active: number): void {
    this.diagnostics.footAnchorError = 0;
    if (active <= 0 || !['crouch', 'tiptoe', 'think'].includes(reaction ?? '')) return;
    this.vrm.humanoid.setNormalizedPose(pose);
    this.root.updateWorldMatrix(true, true);
    if (reaction === 'think') {
      if (!this.node('rightUpperArm') || !this.node('rightLowerArm') || !this.node('rightHand')) return;
      if (Math.min(this.length('rightUpperArm', 'rightLowerArm'), this.length('rightLowerArm', 'rightHand')) < 1e-5) return;
      const head = this.point(this.node('head')!);
      const shoulder = this.point(this.node('rightUpperArm')!);
      const armLength = this.length('rightUpperArm', 'rightLowerArm') + this.length('rightLowerArm', 'rightHand');
      const face = head.clone().addScaledVector(this.lateral, Math.sign(shoulder.clone().sub(head).dot(this.lateral)) * armLength * .18)
        .addScaledVector(UP, -armLength * .02).addScaledVector(this.forward, armLength * .12);
      const target = this.point(this.node('rightHand')!).lerp(face, active);
      const pole = shoulder.clone().sub(head).setY(-armLength).addScaledVector(this.forward, armLength * .4);
      this.solve(pose, 'rightUpperArm', 'rightLowerArm', 'rightHand', target, pole, THREE.MathUtils.degToRad(140));
      const elbow = this.point(this.node('rightLowerArm')!), hand = this.point(this.node('rightHand')!);
      this.diagnostics.maximumElbowFlexion = shoulder.clone().sub(elbow).negate().angleTo(hand.clone().sub(elbow));
      this.diagnostics.handToFaceDistance = hand.distanceTo(face);
      return;
    }
    const hips = this.node('hips')!;
    const targets = new Map<string, THREE.Vector3>();
    const tilt = new THREE.Quaternion().setFromAxisAngle(this.lateral, .30 * active);
    const hipDelta = new THREE.Vector3();
    for (const side of ['left', 'right']) {
      const foot = `${side}Foot`, rest = this.rest.get(foot)!;
      const toe = this.rest.get(`${side}Toes`);
      const target = reaction === 'tiptoe' && toe
        ? toe.clone().sub(toe.clone().sub(rest).applyQuaternion(tilt)) : rest.clone();
      targets.set(side, target);
      hipDelta.add(target.clone().sub(rest).multiplyScalar(.5));
    }
    if (reaction === 'crouch') hipDelta.set(0, -this.legLength * .22 * active, 0)
      .addScaledVector(this.forward, -this.legLength * .10 * active);
    hips.position.copy(this.hipsRest).add(hipDelta);
    const restHips = this.vrm.humanoid.normalizedRestPose.hips!.position!;
    hips.position.clone().sub(new THREE.Vector3().fromArray(restHips)).toArray(pose.hips.position!);
    hips.updateWorldMatrix(false, true);
    for (const side of ['left', 'right']) {
      const foot = `${side}Foot`, toe = `${side}Toes`;
      this.solve(pose, `${side}UpperLeg`, `${side}LowerLeg`, foot, targets.get(side)!, this.forward);
      this.orient(pose, foot, reaction === 'tiptoe' ? tilt.clone().multiply(this.footRest.get(foot)!) : this.footRest.get(foot)!);
      if (this.footRest.has(toe)) this.orient(pose, toe, this.footRest.get(toe)!);
      const anchor = reaction === 'tiptoe' && this.rest.has(toe) ? toe : foot;
      this.diagnostics.footAnchorError = Math.max(this.diagnostics.footAnchorError,
        this.point(this.node(anchor)!).distanceTo(this.rest.get(anchor)!));
    }
  }
}
