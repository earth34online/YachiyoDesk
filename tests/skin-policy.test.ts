import { describe, expect, it } from 'vitest';
import { shouldCombineSkeletons } from '../src/skin-policy';

describe('skeleton optimization policy', () => {
  it('preserves separate PMX bind chains to avoid asymmetric sleeve deformation', () => {
    expect(shouldCombineSkeletons({ capabilities: ['pmx-converted'] })).toBe(false);
    expect(shouldCombineSkeletons({ capabilities: ['pmx-converted', 'long-garment'] })).toBe(false);
  });

  it('keeps the existing optimization for Yachiyo and direct VRM imports', () => {
    expect(shouldCombineSkeletons({ capabilities: ['long-garment'] })).toBe(true);
    expect(shouldCombineSkeletons({ capabilities: [] })).toBe(true);
  });
});
