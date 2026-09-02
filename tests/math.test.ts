import { describe, expect, it } from 'vitest';
import { clamp, nextAdaptiveScale, normalizedPointer, reactionEnvelope, smoothstep01 } from '../src/math';

describe('animation math', () => {
  it('clamps values at both boundaries', () => {
    expect(clamp(-3, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(3, 0, 1)).toBe(1);
  });

  it('creates a continuous reaction envelope', () => {
    expect(reactionEnvelope(-0.1, 2)).toBe(0);
    expect(reactionEnvelope(0, 2)).toBe(0);
    expect(reactionEnvelope(0.18, 2)).toBeCloseTo(1);
    expect(reactionEnvelope(1, 2)).toBeCloseTo(1);
    expect(reactionEnvelope(2, 2)).toBe(0);
  });

  it('keeps smoothstep in the normalized interval', () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(0.5)).toBe(0.5);
    expect(smoothstep01(2)).toBe(1);
  });

  it('maps screen coordinates into WebGL normalized device coordinates', () => {
    expect(normalizedPointer(0, 0, 100, 200).toArray()).toEqual([-1, 1]);
    expect(normalizedPointer(50, 100, 100, 200).toArray()).toEqual([0, 0]);
    expect(normalizedPointer(100, 200, 100, 200).toArray()).toEqual([1, -1]);
  });

  it('reduces only the render scale after sustained frame pressure', () => {
    expect(nextAdaptiveScale({
      currentScale: 1,
      minimumScale: 0.7,
      targetFps: 60,
      averageFps: 43,
      p95FrameMs: 31,
      sampleCount: 180,
    })).toBeCloseTo(0.92);
  });

  it('recovers render scale gradually and never exceeds native quality', () => {
    expect(nextAdaptiveScale({
      currentScale: 0.9,
      minimumScale: 0.7,
      targetFps: 60,
      averageFps: 59,
      p95FrameMs: 18,
      sampleCount: 180,
    })).toBeCloseTo(0.935);
    expect(nextAdaptiveScale({
      currentScale: 0.99,
      minimumScale: 0.7,
      targetFps: 60,
      averageFps: 60,
      p95FrameMs: 17,
      sampleCount: 180,
    })).toBe(1);
  });

  it('does not react before enough telemetry has accumulated', () => {
    expect(nextAdaptiveScale({
      currentScale: 1,
      minimumScale: 0.7,
      targetFps: 60,
      averageFps: 10,
      p95FrameMs: 100,
      sampleCount: 20,
    })).toBe(1);
  });
});
