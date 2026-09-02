'use strict';

function calculateDragPosition(session) {
  if (!session || typeof session !== 'object') return null;
  const values = [
    session.originScreenX,
    session.originScreenY,
    session.screenX,
    session.screenY,
    session.windowX,
    session.windowY,
  ].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [originScreenX, originScreenY, screenX, screenY, windowX, windowY] = values;
  return {
    x: Math.round(windowX + screenX - originScreenX),
    y: Math.round(windowY + screenY - originScreenY),
  };
}

function clampDragPosition(position, displayBounds, windowSize) {
  const values = [
    position?.x,
    position?.y,
    displayBounds?.x,
    displayBounds?.y,
    displayBounds?.width,
    displayBounds?.height,
    windowSize?.width,
    windowSize?.height,
  ].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x, y, displayX, displayY, displayWidth, displayHeight, windowWidth, windowHeight] = values;
  if (displayWidth <= 0 || displayHeight <= 0 || windowWidth <= 0 || windowHeight <= 0) return null;
  const maximumX = displayX + Math.max(0, displayWidth - windowWidth);
  const maximumY = displayY + Math.max(0, displayHeight - windowHeight);
  return {
    x: Math.round(Math.min(maximumX, Math.max(displayX, x))),
    y: Math.round(Math.min(maximumY, Math.max(displayY, y))),
  };
}

module.exports = { calculateDragPosition, clampDragPosition };
