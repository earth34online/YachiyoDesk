/**
 * VRM normalized humanoid hand nodes share the same local wrist basis on both
 * sides. A palm-facing twist therefore uses the same signed X rotation for the
 * left and right hand; negating the left side mirrors the texture, not the
 * intended pose. Model/converter differences remain isolated in palmFacingSign.
 */
export function viewerFacingPalmTwists(
  palmFacingSign: -1 | 1,
  angleRadians: number,
): { left: number; right: number } {
  const safeAngle = Number.isFinite(angleRadians)
    ? Math.max(0, Math.min(Math.PI * 0.62, Math.abs(angleRadians)))
    : 0;
  const twist = safeAngle * palmFacingSign;
  return { left: twist, right: twist };
}
