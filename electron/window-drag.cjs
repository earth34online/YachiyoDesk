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

function horizontalWindowRange(displayBounds, windowWidth, viewportBounds) {
  const values = [displayBounds?.x, displayBounds?.width, windowWidth].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [displayX, displayWidth, resolvedWindowWidth] = values;
  if (displayWidth <= 0 || resolvedWindowWidth <= 0) return null;

  let visibleLeft = 0;
  let visibleRight = resolvedWindowWidth;
  const sourceLeft = Number(viewportBounds?.left);
  const sourceRight = Number(viewportBounds?.right);
  const sourceWidth = Number(viewportBounds?.canvasWidth);
  if (
    Number.isFinite(sourceLeft)
    && Number.isFinite(sourceRight)
    && Number.isFinite(sourceWidth)
    && sourceWidth > 0
    && sourceLeft >= 0
    && sourceRight > sourceLeft
    && sourceRight <= sourceWidth
  ) {
    const scale = resolvedWindowWidth / sourceWidth;
    visibleLeft = sourceLeft * scale;
    visibleRight = sourceRight * scale;
  }

  let minimumX = displayX - visibleLeft;
  let maximumX = displayX + displayWidth - visibleRight;
  if (maximumX < minimumX) {
    // If the visible avatar itself is wider than this display, centring is the
    // only deterministic position that clips both sides equally.
    const centered = displayX + (displayWidth - (visibleRight - visibleLeft)) / 2 - visibleLeft;
    minimumX = centered;
    maximumX = centered;
  }
  return {
    minimumX: Math.round(minimumX),
    maximumX: Math.round(maximumX),
    visibleLeft,
    visibleRight,
  };
}

function clampDragPosition(position, displayBounds, windowSize, viewportBounds) {
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
  const horizontal = horizontalWindowRange(displayBounds, windowWidth, viewportBounds);
  if (!horizontal) return null;
  const maximumY = displayY + Math.max(0, displayHeight - windowHeight);
  return {
    x: Math.round(Math.min(horizontal.maximumX, Math.max(horizontal.minimumX, x))),
    y: Math.round(Math.min(maximumY, Math.max(displayY, y))),
  };
}

module.exports = { calculateDragPosition, clampDragPosition, horizontalWindowRange };
