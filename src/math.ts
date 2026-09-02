import * as THREE from 'three';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function damp(current: number, target: number, smoothing: number, delta: number): number {
  return THREE.MathUtils.damp(current, target, smoothing, delta);
}

export function smoothstep01(value: number): number {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

export function reactionEnvelope(elapsed: number, duration: number, fadeIn = 0.18, fadeOut = 0.35): number {
  if (elapsed < 0 || elapsed >= duration) return 0;
  const attack = smoothstep01(elapsed / Math.max(0.001, fadeIn));
  const release = smoothstep01((duration - elapsed) / Math.max(0.001, fadeOut));
  return Math.min(attack, release);
}

export function eulerQuaternion(x: number, y: number, z: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
}

export function normalizedPointer(clientX: number, clientY: number, width: number, height: number): THREE.Vector2 {
  return new THREE.Vector2(
    (clientX / Math.max(1, width)) * 2 - 1,
    -(clientY / Math.max(1, height)) * 2 + 1,
  );
}

export function randomBetween(min: number, max: number, random = Math.random): number {
  return min + (max - min) * random();
}

export interface AdaptiveScaleInput {
  currentScale: number;
  minimumScale: number;
  targetFps: number;
  averageFps: number;
  p95FrameMs: number;
  sampleCount: number;
}

export function nextAdaptiveScale(input: AdaptiveScaleInput): number {
  const {
    currentScale,
    minimumScale,
    targetFps,
    averageFps,
    p95FrameMs,
    sampleCount,
  } = input;
  if (sampleCount < Math.max(45, targetFps * 1.5)) return clamp(currentScale, minimumScale, 1);
  const frameBudget = 1000 / targetFps;
  const underSustainedLoad = averageFps < targetFps * 0.84 || p95FrameMs > frameBudget * 1.65;
  if (underSustainedLoad) return clamp(currentScale - 0.08, minimumScale, 1);
  const hasRecoveryHeadroom = averageFps >= targetFps * 0.955 && p95FrameMs < frameBudget * 1.30;
  if (hasRecoveryHeadroom) return clamp(currentScale + 0.035, minimumScale, 1);
  return clamp(currentScale, minimumScale, 1);
}
