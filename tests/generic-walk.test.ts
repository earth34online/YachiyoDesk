import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { planGenericWalk } = createRequire(import.meta.url)('../electron/window-drag.cjs');

describe('generic walking to measured screen edges', () => {
  const range = { minimumX: -210, maximumX: 1401 };
  it('does not reverse 80 pixels before the visible edge', () => {
    expect(planGenericWalk(1375, range, 1, 350)).toEqual({ startX: 1375, targetX: 1401, direction: 1, distance: 26 });
    expect(planGenericWalk(-199, range, -1, 350)).toEqual({ startX: -199, targetX: -210, direction: -1, distance: 11 });
  });
  it('reverses only once the available movement is exhausted', () => {
    expect(planGenericWalk(1401, range, 1, 350)).toEqual({ startX: 1401, targetX: 1051, direction: -1, distance: 350 });
  });
  it('supports negative-origin displays and clamps a pose-expanded start', () => {
    expect(planGenericWalk(-3000, { minimumX: -2001, maximumX: -303 }, -1, 400))
      .toEqual({ startX: -2001, targetX: -1601, direction: 1, distance: 400 });
  });
  it('rejects impossible geometry instead of leaving walking legs on a stationary window', () => {
    expect(planGenericWalk(0, { minimumX: 0, maximumX: 0 }, 1, 350)).toBeNull();
    expect(planGenericWalk(0, range, 1, NaN)).toBeNull();
  });
});
