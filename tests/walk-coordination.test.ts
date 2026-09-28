import { createRequire } from 'node:module';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { ProceduralAnimator } from '../src/ProceduralAnimator';
import { legGait } from '../src/gait';
import type { AppSettings, MotionProfile } from '../src/types';

const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS } = require('../electron/settings.cjs');
const { sanitizeMotionProfile, PMX_CONVERTED_MOTION_PROFILE } = require('../electron/motion-profile.cjs');
type Pose = Record<string, { rotation: number[] }>;

function sample(profile: MotionProfile, phase: number, weight = 1): Record<string, THREE.Euler> {
  const vrm = { humanoid: { setNormalizedPose: () => {} } } as unknown as VRM;
  const animator = new ProceduralAnimator(vrm, { ...DEFAULT_SETTINGS, idleMotion: false } as AppSettings, profile);
  const state = animator as unknown as {
    elapsed: number; autonomousStartedAt: number; walkWeight: number; motionWeight: number;
    pose: Pose; updatePose: (sleeping: boolean, reaction: null, weight: number, elapsed: number, duration: number) => void;
  };
  state.elapsed = phase / profile.walk.cadence;
  state.autonomousStartedAt = 0;
  state.walkWeight = weight;
  state.motionWeight = 0;
  state.updatePose(false, null, 0, 0, 1);
  return Object.fromEntries(Object.entries(state.pose).map(([bone, pose]) =>
    [bone, new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(pose.rotation), 'YXZ')]));
}

describe('walking limb coordination without changing idle/legacy poses', () => {
  for (const sign of [-1, 1]) {
    it(`PMX arms follow contact gait with forward axis ${sign}`, () => {
      const profile: MotionProfile = sanitizeMotionProfile({ ...PMX_CONVERTED_MOTION_PROFILE,
        handPose: { ...PMX_CONVERTED_MOTION_PROFILE.handPose, legForwardAxisSign: sign } });
      for (let i = 0; i < 120; i += 1) {
        const phase = i * Math.PI * 2 / 120;
        const pose = sample(profile, phase);
        const stride = legGait(phase).thigh * sign;
        expect(pose.leftUpperArm.x - .025).toBeCloseTo(-stride * .29 * profile.walk.armSwingScale, 8);
        expect(pose.rightUpperArm.x - .025).toBeCloseTo(stride * .29 * profile.walk.armSwingScale, 8);
        // No procedural outward abduction on the PMX walking chain.
        expect(pose.leftUpperLeg.z).toBeCloseTo(0, 8);
        expect(pose.rightUpperLeg.z).toBeCloseTo(0, 8);
        expect(pose.leftUpperLeg.x + pose.rightUpperLeg.x).toBeCloseTo(0, 8);
      }
    });
  }
  it('does not add toe yaw or abduction when PMX walking is disabled', () => {
    const profile = sanitizeMotionProfile(PMX_CONVERTED_MOTION_PROFILE);
    const pose = sample(profile, Math.PI / 3, 0);
    for (const bone of ['leftUpperLeg', 'rightUpperLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
      expect(pose[bone].y).toBeCloseTo(0, 8);
      expect(pose[bone].z).toBeCloseTo(0, 8);
    }
  });
  for (const capabilities of [[], ['long-garment']]) {
    it(`preserves legacy VRM/Yachiyo sine gait (${capabilities.join(',') || 'VRM'})`, () => {
      const profile = sanitizeMotionProfile({ capabilities });
      for (const phase of [0, .5, Math.PI / 2, Math.PI, 4.5]) {
        const pose = sample(profile, phase);
        const stride = Math.sin(phase);
        expect(pose.leftUpperArm.x - .025).toBeCloseTo(-stride * .18 * profile.walk.armSwingScale, 8);
        expect(pose.leftUpperLeg.x).toBeCloseTo(stride * .56 * profile.walk.strideScale, 8);
        expect(pose.leftUpperLeg.z).toBeCloseTo(.09 * profile.walk.strideScale, 8);
      }
    });
  }
});
