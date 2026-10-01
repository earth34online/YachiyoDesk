import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { validateAnatomy, validateFingerFlexion, garmentSurfaceIssues } = createRequire(import.meta.url)('../electron/motion-quality.cjs');
describe('motion test acceptance', () => {
  const idle = { leftToeRise: -.04, rightToeRise: -.04 };
  const anatomy = { calibrated: true, legLength: .85, leftKneeForward: .23, rightKneeForward: .23,
    leftFootSupportError: .0005, rightFootSupportError: .0005, leftToeSupportError: .0005, rightToeSupportError: .0005,
    leftToeRise: -.08, rightToeRise: -.08, rightElbowFlexion: 2.4 };
  it('rejects an uncalibrated PMX path, backward squat, raised toes and excessive elbow flexion', () => {
    expect(() => validateAnatomy('crouch', null, idle)).toThrow('校准');
    expect(() => validateAnatomy('crouch', { ...anatomy, leftKneeForward: -.225 }, idle)).toThrow('蹲姿');
    expect(() => validateAnatomy('tiptoe', { ...anatomy, leftToeRise: .0095 }, idle)).toThrow('踮脚');
    expect(() => validateAnatomy('think', { ...anatomy, rightElbowFlexion: 2.99 }, idle)).toThrow('肘部');
    for (const motion of ['crouch', 'tiptoe', 'think']) expect(() => validateAnatomy(motion, anatomy, idle)).not.toThrow();
  });
  it('rejects finger twisting with no change in chain angle', () => {
    const samples = [0, .8, 1.2].map(curl => ({ curl, fingerFlexion: { leftIndex: 0, rightIndex: 0 } }));
    expect(() => validateFingerFlexion(samples)).toThrow('屈曲');
    for (const sample of samples) sample.fingerFlexion = { leftIndex: sample.curl * 1.22, rightIndex: sample.curl * 1.22 };
    expect(validateFingerFlexion(samples)).toMatchObject({ chains: ['leftIndex', 'rightIndex'], missingOptionalChains: 6 });
  });
  it('does not equate enabled contact with a collision-free surface', () => {
    expect(garmentSurfaceIssues('dance', { enabled: true, garmentMeshes: 2, surfaceCheckComplete: true,
      shapeCheckComplete: true, shapePreservationPassed: true,
      unresolvedIntersections: 52 })).toMatchObject([{ reason: 'unresolved-surface-intersections', pairs: 52 }]);
    expect(garmentSurfaceIssues('crouch', { enabled: true, garmentMeshes: 2, surfaceCheckComplete: false,
      shapeCheckComplete: true, shapePreservationPassed: true,
      coolingMeshes: 1, unresolvedIntersections: 0 }).map((item: any) => item.reason))
      .toEqual(['garment-contact-incomplete-coverage', 'surface-verification-incomplete']);
  });
  it('rejects a collision-free result that stretches or reverses the garment', () => {
    expect(garmentSurfaceIssues('idle', { enabled: true, garmentMeshes: 2, surfaceCheckComplete: true,
      unresolvedIntersections: 0, shapeCheckComplete: true, shapePreservationPassed: false,
      maximumStretchExcess: .1, collapsedFaces: 2 })).toMatchObject([{ reason: 'garment-shape-verification-failed' }]);
  });
  it('permits bounded submillimeter contact while rejecting unmeasured or larger intersections', () => {
    const state = { enabled: true, garmentMeshes: 2, surfaceCheckComplete: true, shapeCheckComplete: true,
      shapePreservationPassed: true, coolingMeshes: 0, unresolvedIntersections: 10,
      maximumResidualDepthBound: .0002, maximumResidualSpan: .002 };
    expect(garmentSurfaceIssues('dance', state)).toEqual([]);
    for (const patch of [{ maximumResidualDepthBound: .007 }, { maximumResidualSpan: .02 },
      { maximumResidualDepthBound: Number.NaN }]) {
      expect(garmentSurfaceIssues('dance', { ...state, ...patch })).toMatchObject([{ reason: 'unresolved-surface-intersections' }]);
    }
    expect(garmentSurfaceIssues('dance', { ...state, surfaceCheckComplete: false })).toMatchObject([{ reason: 'surface-verification-incomplete' }]);
  });
});
