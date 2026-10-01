import { describe, expect, it } from 'vitest';
import { skirtGaitScale, skirtLateralGaitScale, skirtRestArmAngle, skirtHandClearanceAngle } from '../src/garmentPose';

describe('imported skirt neutral arm pose', () => {
  it('measures enough radial room for the hand and retains an already wider pose', () => {
    const angle = skirtHandClearanceAngle(1.4, .08, .5, .18, .03);
    expect(.08 + .5 * Math.cos(angle)).toBeCloseTo(.21, 6);
    expect(skirtHandClearanceAngle(1.1, .08, .5, .18, .03)).toBe(1.1);
    expect(skirtHandClearanceAngle(1.4, .08, 0, .18, .03)).toBe(1.4);
  });
  it('lets narrow garments hang closer to the body than bell skirts', () => {
    const narrow = skirtRestArmAngle(0.18, 1.55);
    const wide = skirtRestArmAngle(0.47, 1.55);
    expect(narrow).toBeGreaterThan(1.35);
    expect(wide).toBeGreaterThan(1.02);
    expect(wide).toBeLessThan(1.15);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('stays bounded for unusual but valid imported dimensions', () => {
    expect(skirtRestArmAngle(0, 1.5)).toBe(1.43);
    expect(skirtRestArmAngle(2, 1.5)).toBe(1.02);
    expect(skirtRestArmAngle(Number.NaN, 1.5)).toBe(1.16);
  });
});

describe('imported skirt walking clearance', () => {
  it('reduces leg travel for a narrow school skirt without changing a roomy skirt', () => {
    expect(skirtGaitScale(0.179, 0.088, 1.344)).toBe(0.35);
    expect(skirtGaitScale(0.366, 0.339, 1.334)).toBe(1);
  });

  it('keeps unmeasurable imports on the ordinary gait', () => {
    expect(skirtGaitScale(Number.NaN, 0.1, 1.5)).toBe(1);
    expect(skirtGaitScale(0.1, 0.1, 0)).toBe(1);
  });

  it('uses side clearance for lateral leg travel rather than front depth', () => {
    expect(skirtLateralGaitScale(0.158, 0.160, 1.344)).toBe(0.15);
    expect(skirtLateralGaitScale(0.385, 0.388, 1.334)).toBe(1);
  });
});
