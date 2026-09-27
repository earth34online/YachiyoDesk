import { clamp } from './math';

/**
 * Neutral arm angle for PMX skirts. Wider skirts need more lateral clearance;
 * narrow skirts let the arms hang nearer the body. Both measurements come from
 * the imported rig and are normalized by height, not from a character name.
 */
export function skirtRestArmAngle(radius: number, height: number): number {
  if (!Number.isFinite(radius) || !Number.isFinite(height) || height <= 0) return 1.16;
  return clamp(1.60 - 1.65 * (Math.max(0, radius) / height), 1.02, 1.43);
}

/**
 * Keep a gait inside a narrow imported skirt's sagittal envelope. VRM spring
 * colliders apply to an entire joint chain, not the contacting triangles: a
 * thigh capsule inflated both halves of a school skirt at rest. The smaller
 * of the measured front/back clearances is used so heel-strike and toe-off
 * remain symmetric; roomy skirts retain the ordinary gait.
 */
export function skirtGaitScale(frontDepth: number, backDepth: number, height: number): number {
  if (![frontDepth, backDepth, height].every(Number.isFinite) || height <= 0) return 1;
  const clearanceRatio = Math.max(0, Math.min(frontDepth, backDepth)) / height;
  return clamp((clearanceRatio - 0.05) / 0.12, 0.35, 1);
}

/** Side-to-side leg travel needs its own clearance measure. */
export function skirtLateralGaitScale(leftRadius: number, rightRadius: number, height: number): number {
  if (![leftRadius, rightRadius, height].every(Number.isFinite) || height <= 0) return 1;
  const clearanceRatio = Math.max(0, Math.min(leftRadius, rightRadius)) / height;
  return clamp((clearanceRatio - 0.12) / 0.10, 0.15, 1);
}
