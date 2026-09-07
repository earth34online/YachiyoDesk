import { describe, expect, it } from 'vitest';
import { viewerFacingPalmTwists } from '../src/handPose';

describe('viewerFacingPalmTwists', () => {
  it('uses the same normalized wrist direction on both sides', () => {
    expect(viewerFacingPalmTwists(1, 0.92)).toEqual({ left: 0.92, right: 0.92 });
  });

  it('inverts both wrists together for a converter-specific basis', () => {
    expect(viewerFacingPalmTwists(-1, 0.86)).toEqual({ left: -0.86, right: -0.86 });
  });

  it('clamps invalid and unsafe angles', () => {
    expect(viewerFacingPalmTwists(1, Number.NaN)).toEqual({ left: 0, right: 0 });
    const clamped = viewerFacingPalmTwists(1, 99);
    expect(clamped.left).toBeCloseTo(Math.PI * 0.62);
    expect(clamped.right).toBeCloseTo(Math.PI * 0.62);
  });
});
