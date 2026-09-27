import { describe, expect, it } from 'vitest';
import { legGait } from '../src/gait';

describe('PMX walk contact phases', () => {
  it('alternates heel strike and toe-off between left and right feet', () => {
    for (let frame = 0; frame < 240; frame += 1) {
      const phase = frame * Math.PI * 2 / 240;
      const left = legGait(phase);
      const right = legGait(phase + Math.PI);
      expect(left.heelContact * right.heelContact).toBeLessThan(0.01);
      expect(left.toeOff * right.toeOff).toBeLessThan(0.01);
      expect(left.thigh + right.thigh).toBeCloseTo(0, 8);
    }
    expect(legGait(0).heelContact).toBe(1);
    expect(legGait(Math.PI).toeOff).toBe(1);
    expect(legGait(0).knee).toBe(0);
  });
});
