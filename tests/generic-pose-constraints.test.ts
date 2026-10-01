import * as THREE from 'three';
import { VRMHumanoid, type VRM, type VRMHumanBones } from '@pixiv/three-vrm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { GenericPoseConstraints, solveTwoLink } from '../src/genericPoseConstraints';
import { ProceduralAnimator } from '../src/ProceduralAnimator';
import type { ReactionName } from '../src/types';
const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS } = require('../electron/settings.cjs');
const { sanitizeMotionProfile, PMX_CONVERTED_MOTION_PROFILE } = require('../electron/motion-profile.cjs');

function rig(front: number, scale: number, generic = true) {
  const scene = new THREE.Group(), bones: Record<string, THREE.Object3D> = {};
  const bone = (name: string, parent: string | null, x: number, y: number, z: number) => {
    const node = new THREE.Bone(); node.position.set(x * scale, y * scale, z * scale);
    (parent ? bones[parent] : scene).add(node); bones[name] = node; return node;
  };
  bone('hips', null, 0, 1, 0); bone('spine', 'hips', 0, .1, 0); bone('chest', 'spine', 0, .2, 0);
  bone('neck', 'chest', 0, .15, 0); bone('head', 'neck', 0, .10, 0);
  for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
    bone(side + 'UpperLeg', 'hips', sign * .085, -.025, 0);
    bone(side + 'LowerLeg', side + 'UpperLeg', 0, -.40, 0);
    bone(side + 'Foot', side + 'LowerLeg', 0, -.45, 0);
    bone(side + 'Toes', side + 'Foot', 0, -.04, front * .13);
    bone(side + 'Shoulder', 'chest', sign * .025, .10, 0);
    bone(side + 'UpperArm', side + 'Shoulder', sign * .075, 0, 0);
    bone(side + 'LowerArm', side + 'UpperArm', sign * .24, 0, 0);
    bone(side + 'Hand', side + 'LowerArm', sign * .21, 0, 0);
    for (const [finger, spread] of [['Index', .025], ['Middle', 0], ['Ring', -.025], ['Little', -.05]] as const) {
      bone(side + finger + 'Proximal', side + 'Hand', sign * .07, 0, spread);
      bone(side + finger + 'Intermediate', side + finger + 'Proximal', sign * .035, 0, 0);
      bone(side + finger + 'Distal', side + finger + 'Intermediate', sign * .02, 0, 0);
    }
    bone(side + 'ThumbMetacarpal', side + 'Hand', sign * .01, -.015, .015);
    bone(side + 'ThumbProximal', side + 'ThumbMetacarpal', sign * .035, 0, .035);
    bone(side + 'ThumbDistal', side + 'ThumbProximal', sign * .02, 0, .02);
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(Object.fromEntries(Object.entries(bones).map(([name, node]) => [name, { node }])) as VRMHumanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const vrm = { scene, humanoid } as VRM;
  const profile = sanitizeMotionProfile(PMX_CONVERTED_MOTION_PROFILE);
  const animator = new ProceduralAnimator(vrm, { ...DEFAULT_SETTINGS, idleMotion: false, mouseLook: false, lookIntensity: 0 },
    generic ? profile : { ...profile, capabilities: [] });
  const point = (name: string) => bones[name].getWorldPosition(new THREE.Vector3());
  const rest = Object.fromEntries(Object.keys(bones).map(name => [name, point(name)]));
  const step = (n: number) => { for (let i = 0; i < n; i++) { animator.update(1 / 60); humanoid.update(); scene.updateWorldMatrix(true, true); } };
  return { animator, humanoid, vrm, profile, point, rest, step };
}

describe('generic geometry constraints', () => {
  for (const front of [-1, 1]) {
    it(`moves both resting hands slightly forward using the rig's front direction ${front}`, () => {
      const adjusted = rig(front, 1), original = rig(front, 1, false);
      adjusted.step(1); original.step(1);
      for (const side of ['left', 'right']) {
        const delta = adjusted.point(side + 'Hand').sub(original.point(side + 'Hand'));
        expect(delta.z * front).toBeGreaterThan(.01);
        expect(delta.length()).toBeLessThan(.06);
        expect(Math.abs(delta.x)).toBeLessThan(.002);
      }
    });
  }
  for (const front of [-1, 1]) for (const scale of [.65, 1.4]) {
    it(`plants both squat feet and bends knees forward, front ${front}, scale ${scale}`, () => {
      const r = rig(front, scale); r.animator.trigger('crouch');
      r.step(108);
      for (const side of ['left', 'right']) {
        const hip = r.point(side + 'UpperLeg'), knee = r.point(side + 'LowerLeg');
        expect((knee.z - hip.z) * front).toBeGreaterThan(.10 * scale);
        expect(r.point(side + 'Foot').distanceTo(r.rest[side + 'Foot'])).toBeLessThan(1e-5);
        expect(r.point(side + 'Toes').distanceTo(r.rest[side + 'Toes'])).toBeLessThan(1e-5);
      }
      expect(r.point('hips').y).toBeLessThan(r.rest.hips.y - .15 * scale);
    });
    it(`raises heels around toe support, front ${front}, scale ${scale}`, () => {
      const r = rig(front, scale); r.animator.trigger('tiptoe'); r.step(93);
      for (const side of ['left', 'right']) {
        expect(r.point(side + 'Foot').y).toBeGreaterThan(r.rest[side + 'Foot'].y + .025 * scale);
        expect(r.point(side + 'Toes').distanceTo(r.rest[side + 'Toes'])).toBeLessThan(.002 * scale);
      }
    });
  }
  it('limits the actual elbow chain while reaching toward the face', () => {
    const r = rig(1, 1); r.animator.trigger('think'); r.step(126);
    const upper = r.point('rightLowerArm').sub(r.point('rightUpperArm'));
    const lower = r.point('rightHand').sub(r.point('rightLowerArm'));
    expect(upper.angleTo(lower)).toBeLessThanOrEqual(THREE.MathUtils.degToRad(140) + 1e-6);
    expect(r.point('rightHand').distanceTo(r.point('head'))).toBeLessThan(.15);
  });
  it('bends mirrored finger chains into the palm and moves the distal joint', () => {
    const r = rig(1, 1), constraints = GenericPoseConstraints.create(r.vrm, r.profile)!;
    const pose = r.humanoid.getNormalizedPose();
    for (const side of ['left', 'right']) {
      for (const [part, amount] of [['Proximal', .8], ['Intermediate', .976], ['Distal', .656]] as const) {
        expect(constraints.setFinger(pose, side + 'Index' + part, amount)).toBe(true);
      }
    }
    r.humanoid.setNormalizedPose(pose); r.humanoid.update(); r.vrm.scene.updateWorldMatrix(true, true);
    for (const side of ['left', 'right']) {
      const a = r.point(side + 'IndexIntermediate').sub(r.point(side + 'IndexProximal'));
      const b = r.point(side + 'IndexDistal').sub(r.point(side + 'IndexIntermediate'));
      expect(a.angleTo(b)).toBeCloseTo(.976, 5);
      expect(r.point(side + 'IndexDistal').y).toBeLessThan(r.rest[side + 'IndexDistal'].y - .03);
    }
  });
  it('leaves native VRM and the Yachiyo profile outside the new constraint path', () => {
    const r = rig(1, 1);
    expect(GenericPoseConstraints.create(r.vrm, { ...r.profile, capabilities: [] })).toBeNull();
    expect(GenericPoseConstraints.create(r.vrm, { ...r.profile, profileId: 'yachiyo' })).toBeNull();
  });
  it('opposes and flexes both thumbs toward the palm instead of twisting their length axes', () => {
    const r = rig(1, 1), constraints = GenericPoseConstraints.create(r.vrm, r.profile)!;
    const pose = r.humanoid.getNormalizedPose();
    for (const side of ['left', 'right']) for (const part of ['Metacarpal', 'Proximal', 'Distal']) {
      expect(constraints.setFinger(pose, side + 'Thumb' + part, .8)).toBe(true);
    }
    r.humanoid.setNormalizedPose(pose); r.humanoid.update(); r.vrm.scene.updateWorldMatrix(true, true);
    for (const side of ['left', 'right']) {
      const first = r.point(side + 'ThumbProximal').sub(r.point(side + 'ThumbMetacarpal'));
      const second = r.point(side + 'ThumbDistal').sub(r.point(side + 'ThumbProximal'));
      expect(first.angleTo(second)).toBeCloseTo(.8, 5);
      expect(r.point(side + 'ThumbDistal').y).toBeLessThan(r.rest[side + 'ThumbDistal'].y - .025);
    }
  });
  it('rejects a degenerate leg chain instead of generating NaN rotations', () => {
    const r = rig(1, 1);
    r.humanoid.getNormalizedBoneNode('leftLowerLeg')!.position.set(0, 0, 0);
    expect(GenericPoseConstraints.create(r.vrm, r.profile)).toBeNull();
  });
  it('clamps unreachable targets without changing segment lengths or flipping the pole', () => {
    for (const target of [new THREE.Vector3(0, -4, 0), new THREE.Vector3(0, -.001, 0)]) {
      const result = solveTwoLink(new THREE.Vector3(), target, new THREE.Vector3(0, 0, 1), .4, .5, 2.4);
      expect(result.joint.length()).toBeCloseTo(.4, 8);
      expect(result.joint.distanceTo(result.end)).toBeCloseTo(.5, 8);
      expect(result.joint.z).toBeGreaterThan(0);
    }
  });
  it('returns every corrected action continuously to the same idle pose', () => {
    for (const action of ['think', 'crouch', 'tiptoe'] as ReactionName[]) {
      const r = rig(1, 1); r.animator.trigger(action); r.step(450);
      const result = r.humanoid.getNormalizedPose(); r.animator.reset(); r.step(1);
      const idle = r.humanoid.getNormalizedPose();
      for (const name of ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperArm', 'rightLowerArm']) {
        expect(new THREE.Quaternion().fromArray(result[name as keyof typeof result]!.rotation!).angleTo(
          new THREE.Quaternion().fromArray(idle[name as keyof typeof idle]!.rotation!))).toBeLessThan(.002);
      }
    }
  });
  it('keeps the existing crossfade when a supported action interrupts a squat', () => {
    const r = rig(1, 1); r.animator.trigger('crouch'); r.step(108);
    const hips = r.point('hips'), foot = r.point('leftFoot');
    r.animator.trigger('tiptoe'); r.step(1);
    expect(r.point('hips').distanceTo(hips)).toBeLessThan(.003);
    expect(r.point('leftFoot').distanceTo(foot)).toBeLessThan(.005);
  });
});
