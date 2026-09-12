import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { calculateDragPosition, clampDragPosition, horizontalWindowRange } = require('../electron/window-drag.cjs') as {
  calculateDragPosition: (session: Record<string, number>) => { x: number; y: number } | null;
  clampDragPosition: (
    position: { x: number; y: number },
    display: { x: number; y: number; width: number; height: number },
    windowSize: { width: number; height: number },
    viewportBounds?: { left: number; right: number; canvasWidth: number },
  ) => { x: number; y: number } | null;
  horizontalWindowRange: (
    display: { x: number; width: number },
    windowWidth: number,
    viewportBounds?: { left: number; right: number; canvasWidth: number },
  ) => { minimumX: number; maximumX: number; visibleLeft: number; visibleRight: number } | null;
};

describe('coalesced desktop-window dragging', () => {
  it('always derives the target from the fixed origin and never accumulates frame error', () => {
    const session = {
      originScreenX: 100,
      originScreenY: 200,
      screenX: 230.6,
      screenY: 161.4,
      windowX: 1200,
      windowY: 300,
    };
    expect(calculateDragPosition(session)).toEqual({ x: 1331, y: 261 });

    session.screenX = 101;
    session.screenY = 201;
    expect(calculateDragPosition(session)).toEqual({ x: 1201, y: 301 });
  });

  it('rejects malformed pointer sessions instead of moving the window', () => {
    expect(calculateDragPosition({ originScreenX: 1 } as Record<string, number>)).toBeNull();
  });

  it('slides along every physical screen edge without letting the companion surface escape', () => {
    const display = { x: -1920, y: 0, width: 1920, height: 1080 };
    const size = { width: 560, height: 840 };
    expect(clampDragPosition({ x: -2500, y: 125 }, display, size)).toEqual({ x: -1920, y: 125 });
    expect(clampDragPosition({ x: -900, y: -400 }, display, size)).toEqual({ x: -900, y: 0 });
    expect(clampDragPosition({ x: 500, y: 900 }, display, size)).toEqual({ x: -560, y: 240 });
  });

  it('lets transparent host margins leave the display while keeping the avatar itself inside', () => {
    const display = { x: -1707, y: 143, width: 1707, height: 1068 };
    const size = { width: 560, height: 840 };
    const avatar = { left: 184, right: 376, canvasWidth: 560 };
    expect(horizontalWindowRange(display, size.width, avatar)).toEqual({
      minimumX: -1891,
      maximumX: -376,
      visibleLeft: 184,
      visibleRight: 376,
    });
    expect(clampDragPosition({ x: -2600, y: 370 }, display, size, avatar)).toEqual({ x: -1891, y: 370 });
    expect(clampDragPosition({ x: 300, y: 370 }, display, size, avatar)).toEqual({ x: -376, y: 370 });
  });

  it('rescales renderer viewport bounds to the actual native window width', () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const size = { width: 560, height: 840 };
    const highDpiCanvas = { left: 276, right: 564, canvasWidth: 840 };
    expect(horizontalWindowRange(display, size.width, highDpiCanvas)).toEqual({
      minimumX: -184,
      maximumX: 1544,
      visibleLeft: 184,
      visibleRight: 376,
    });
  });

  it('falls back to strict host clamping for malformed avatar bounds', () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const size = { width: 560, height: 840 };
    expect(clampDragPosition(
      { x: 1800, y: 0 },
      display,
      size,
      { left: 400, right: 200, canvasWidth: 560 },
    )).toEqual({ x: 1360, y: 0 });
  });

  it('rejects invalid display/window geometry', () => {
    expect(clampDragPosition({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 10 }, { width: 1, height: 1 })).toBeNull();
  });
});
