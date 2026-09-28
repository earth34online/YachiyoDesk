import type { AvatarViewportBounds } from './types';

// The buffer is a transparent, avatar-only render, not a desktop screenshot.
// Map alpha coverage to logical canvas pixels, independent of monitor DPI.
export function alphaFootprint(
  pixels: Uint8Array, width: number, height: number, canvasWidth: number,
): AvatarViewportBounds | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width <= 0 || height <= 0 || !Number.isFinite(canvasWidth) || canvasWidth <= 0
    || pixels.length !== width * height * 4) return null;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] < 8) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (right < left) return null;
  const scale = canvasWidth / width;
  // Cover sub-pixel edges and the interval between low-resolution samples.
  const guard = scale + 1;
  return {
    left: Math.max(0, Math.floor(left * scale - guard)),
    right: Math.min(canvasWidth, Math.ceil((right + 1) * scale + guard)),
    canvasWidth,
  };
}
