import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { garmentCorrectionLimits } from '../src/garmentMobility';

describe('contact travel from fabric attachment reach', () => {
  it('permits the hem to wrap a bent thigh without giving its waistband the same freedom', () => {
    const points = [0, .1, .2, .3].map(y => new THREE.Vector3(0, y, 0));
    const links = [0, 1, 2].map(a => ({ a, b: a + 1, rest: .1, stiffness: .68 }));
    const limits = garmentCorrectionLimits(points, [true, false, false, false], links, [0, 1, 2, 3], 1.65);
    expect(limits[0]).toBe(.012);
    expect(limits[1]).toBeCloseTo(.077);
    expect(limits[2]).toBeGreaterThan(.14);
    expect(limits[3]).toBeCloseTo(1.65 * .12);
  });

  it('uses the shortest sewn path and preserves a pinned UV seam across duplicate slots', () => {
    const points = [0, .1, .2, 0].map(y => new THREE.Vector3(0, y, 0));
    const links = [{ a: 0, b: 1, rest: .1, stiffness: .68 }, { a: 1, b: 2, rest: .1, stiffness: .68 },
      { a: 3, b: 2, rest: .12, stiffness: .68 }, { a: 0, b: 2, rest: .01, stiffness: .16 }];
    const limits = garmentCorrectionLimits(points, [false, false, false, true], links, [0, 1, 2, 0], 2);
    expect(limits[0]).toBe(.012); expect(limits[3]).toBe(.012);
    expect(limits[2]).toBeCloseTo(.012 + .12 * .65);
  });

  it('bounds disconnected pieces and scales the bound with the model rather than a character name', () => {
    const points = [new THREE.Vector3(), new THREE.Vector3(0, .2, 0)];
    expect(garmentCorrectionLimits(points, [true, false], [], [0, 1], 1)).toEqual([.012, .12]);
    expect(garmentCorrectionLimits(points, [true, false], [], [0, 1], .5)).toEqual([.012, .06]);
    expect(garmentCorrectionLimits(points, [true, false], [], [0, 1], Number.NaN)).toEqual([.012, .12]);
  });
});
