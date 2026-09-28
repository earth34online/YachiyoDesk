import { describe, expect, it } from 'vitest';
import { alphaFootprint } from '../src/avatar-footprint';

describe('actual rendered avatar footprint', () => {
  it('measures asymmetric alpha, not a neutral/T-pose bounding box', () => {
    const pixels = new Uint8Array(100 * 20 * 4);
    pixels[(3 * 100 + 45) * 4 + 3] = 255;
    pixels[(8 * 100 + 61) * 4 + 3] = 128;
    pixels[(0 * 100 + 1) * 4 + 3] = 1;
    expect(alphaFootprint(pixels, 100, 20, 500)).toEqual({ left: 219, right: 316, canvasWidth: 500 });
  });
  it('keeps fallback on a blank or invalid render', () => {
    expect(alphaFootprint(new Uint8Array(80), 5, 4, 560)).toBeNull();
    expect(alphaFootprint(new Uint8Array(0), 5, 4, 560)).toBeNull();
    expect(alphaFootprint(new Uint8Array(80), 5, 4, NaN)).toBeNull();
  });
  it('clips guards to the canvas, preserving valid IPC geometry', () => {
    const pixels = new Uint8Array(4 * 2 * 4).fill(255);
    expect(alphaFootprint(pixels, 4, 2, 560)).toEqual({ left: 0, right: 560, canvasWidth: 560 });
  });
});
