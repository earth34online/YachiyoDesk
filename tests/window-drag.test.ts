import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { calculateDragPosition, clampDragPosition } = require('../electron/window-drag.cjs') as {
  calculateDragPosition: (session: Record<string, number>) => { x: number; y: number } | null;
  clampDragPosition: (
    position: { x: number; y: number },
    display: { x: number; y: number; width: number; height: number },
    windowSize: { width: number; height: number },
  ) => { x: number; y: number } | null;
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

  it('rejects invalid display/window geometry', () => {
    expect(clampDragPosition({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 10 }, { width: 1, height: 1 })).toBeNull();
  });
});
