import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { PMX_CONVERTED_MOTION_PROFILE, sanitizeMotionProfile } = require('../electron/motion-profile.cjs') as {
  PMX_CONVERTED_MOTION_PROFILE: Record<string, any>;
  sanitizeMotionProfile: (
    value: Record<string, unknown> | undefined,
    context: { id: string; builtIn: boolean },
  ) => Record<string, any>;
};

describe('character-scoped motion profiles', () => {
  it('gives imported characters the safe generic VRM standard', () => {
    const profile = sanitizeMotionProfile(undefined, { id: 'local-character', builtIn: false });
    expect(profile.profileId).toBe('generic-vrm');
    expect(profile.baseStandard).toBe('generic-vrm');
    expect(profile.capabilities).toEqual([]);
    expect(profile.springBone.enabled).toBe(false);
    expect(profile.walk.cadence).toBe(4.8);
    expect(profile.handPose.palmFacingSign).toBe(1);
    expect(profile.handPose.armAxisSign).toBe(1);
    expect(profile.handPose.bodyForwardAxisSign).toBe(1);
    expect(profile.handPose.legForwardAxisSign).toBe(1);
    expect(profile.handPose.rootDepthAxisSign).toBe(1);
    expect(profile.handPose.wristAmplitudeScale).toBe(1);
    expect(profile.handPose.elbowBendScale).toBe(1);
    expect(profile.handPose.fingerCurlScale).toBe(1);
    expect(profile.legPose.kneeBendSign).toBe(-1);
  });

  it('isolates PMX arm-axis correction from direct VRM and built-in profiles', () => {
    const converted = sanitizeMotionProfile(PMX_CONVERTED_MOTION_PROFILE, { id: 'converted-pmx', builtIn: false });
    expect(converted.profileId).toBe('generic-vrm');
    expect(converted.capabilities).toContain('pmx-converted');
    expect(converted.handPose.armAxisSign).toBe(-1);
    expect(converted.handPose.bodyForwardAxisSign).toBe(-1);
    expect(converted.handPose.legForwardAxisSign).toBe(-1);
    expect(converted.handPose.rootDepthAxisSign).toBe(-1);
    expect(converted.handPose.wristAmplitudeScale).toBe(0.90);
    expect(converted.handPose.elbowBendScale).toBe(1.16);
    expect(converted.handPose.fingerCurlScale).toBe(1);

    const directVrm = sanitizeMotionProfile(undefined, { id: 'direct-vrm', builtIn: false });
    expect(directVrm.handPose.armAxisSign).toBe(1);
    expect(directVrm.handPose.bodyForwardAxisSign).toBe(1);
    expect(directVrm.handPose.legForwardAxisSign).toBe(1);
    expect(directVrm.handPose.rootDepthAxisSign).toBe(1);
    expect(directVrm.handPose.wristAmplitudeScale).toBe(1);
    expect(directVrm.handPose.elbowBendScale).toBe(1);
  });

  it('does not let an imported model impersonate the built-in Yachiyo profile', () => {
    const profile = sanitizeMotionProfile({
      profileId: 'yachiyo-long-garment-v1',
      capabilities: ['long-garment'],
      springBone: { enabled: true, jointNamePatterns: ['MySkirt'] },
    }, { id: 'local-character', builtIn: false });
    expect(profile.profileId).toBe('generic-vrm');
    expect(profile.springBone.enabled).toBe(true);
    expect(profile.springBone.jointNamePatterns).toEqual(['myskirt']);
  });

  it('keeps Yachiyo tuning scoped and clamps unsafe values', () => {
    const profile = sanitizeMotionProfile({
      profileId: 'yachiyo-long-garment-v1',
      capabilities: ['long-garment'],
      walk: { cadence: 999, strideScale: -3 },
      handPose: { palmFacingSign: -1 },
      springBone: { enabled: true, stiffnessScale: 0, hitRadiusScale: 99 },
    }, { id: 'yachiyo', builtIn: true });
    expect(profile.profileId).toBe('yachiyo-long-garment-v1');
    expect(profile.walk.cadence).toBe(7.2);
    expect(profile.walk.strideScale).toBe(0.35);
    expect(profile.springBone.stiffnessScale).toBe(0.35);
    expect(profile.springBone.hitRadiusScale).toBe(1.35);
    expect(profile.handPose.palmFacingSign).toBe(-1);
  });
});
