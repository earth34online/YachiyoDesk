'use strict';

// Surfaces arrive front-to-back. Subtract occluders at the top edge, rather
// than treating every visible HWND rectangle as an exposed platform.
function exposedPlatforms(windows, area) {
  const result = [];
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index];
    if (!window || !['x','y','width','height'].every(key => Number.isFinite(window[key]))
      || window.width <= 0 || window.height <= 0) continue;
    if (window.y < area.y || window.y >= area.y + area.height) continue;
    let segments = [[Math.max(window.x, area.x), Math.min(window.x + window.width, area.x + area.width)]];
    for (const front of windows.slice(0, index)) {
      if (front.y > window.y || front.y + front.height <= window.y) continue;
      segments = segments.flatMap(([left, right]) => {
        if (front.x >= right || front.x + front.width <= left) return [[left, right]];
        return [[left, Math.min(right, front.x)], [Math.max(left, front.x + front.width), right]].filter(([a,b]) => b > a);
      });
    }
    for (const [left,right] of segments) if (right > left) result.push({ id: window.id, left, right, y: window.y });
  }
  return result;
}

function contactGeometry(bounds, viewport) {
  const scale = bounds.width / (viewport?.canvasWidth || bounds.width);
  const verticalScale = bounds.height / (viewport?.canvasHeight || bounds.height);
  return {
    left: (viewport?.left ?? bounds.width * .4) * scale,
    right: (viewport?.right ?? bounds.width * .6) * scale,
    footLeft: (viewport?.footLeft ?? bounds.width * .48) * scale,
    footRight: (viewport?.footRight ?? bounds.width * .52) * scale,
    footY: (viewport?.footY ?? bounds.height - 2) * verticalScale,
    height: Math.max(1, (viewport?.avatarHeight ?? bounds.height * .35) * verticalScale),
  };
}

function selectSupport(platforms, bounds, geometry, fromY, toY) {
  const left = bounds.x + geometry.footLeft, right = bounds.x + geometry.footRight;
  return platforms.filter(surface => left >= surface.left && right <= surface.right
    && surface.y >= fromY - .5 && surface.y <= toY + .5).sort((a,b) => a.y - b.y)[0] || null;
}

class DesktopContacts {
  constructor(host) { this.host = host; this.windows = []; this.support = null; this.fall = null; this.timer = null; this.reactionUntil = 0; this.last = 0; }
  geometry() { return contactGeometry(this.host.bounds(), this.host.viewport()); }
  platforms() {
    const area = this.host.area();
    return [...(this.host.settings().windowContacts ? exposedPlatforms(this.windows, area) : []),
      { id: 'screen', left: area.x, right: area.x + area.width, y: area.y + area.height }];
  }
  enabled() { return this.host.settings().desktopContacts && !this.host.settings().lockPosition && this.host.active(); }
  command(phase, extra = {}) { this.host.command({ phase, ...extra }); }
  updateWindows(windows) {
    this.windows = windows;
    if (!this.enabled() || this.fall || !this.support || this.support.id === 'screen') return;
    const bounds = this.host.bounds(), geometry = this.geometry();
    const previous = this.support;
    const candidates = this.platforms().filter(surface => surface.id === previous.id);
    const source = windows.find(window => window.id === previous.id);
    // Follow translation only while both feet remain on an exposed segment.
    const dx = source ? source.x - previous.windowX : 0;
    const moved = { ...bounds, x: bounds.x + dx };
    const next = candidates.find(surface => moved.x + geometry.footLeft >= surface.left
      && moved.x + geometry.footRight <= surface.right);
    if (!next) { this.support = null; this.drop(0); return; }
    const area = this.host.area();
    if (moved.x + geometry.left < area.x || moved.x + geometry.right > area.x + area.width
      || next.y-geometry.height < area.y) {
      this.support = null; this.drop(0); return;
    }
    if (Math.abs(moved.x-bounds.x) >= .5 || Math.abs(next.y-geometry.footY-bounds.y) >= .5) {
      this.host.supportMoved?.();
      this.host.move(moved.x, next.y - geometry.footY);
    }
    this.support = { ...next, windowX: source.x };
  }
  drop(velocity = 0) {
    this.cancel(false);
    if (!this.enabled()) return false;
    const bounds = this.host.bounds(), geometry = this.geometry();
    this.fall = { y: bounds.y, velocity: Math.max(0, Math.min(velocity, geometry.height * 5)) };
    this.support = null; this.last = this.host.now();
    this.command('fall');
    this.timer = setInterval(() => this.step(), 16);
    return true;
  }
  step() {
    if (!this.fall || !this.host.settings().desktopContacts || this.host.settings().lockPosition) { this.cancel(); return; }
    // A modal panel pauses an in-progress fall; hiding/reloading explicitly
    // cancels it at the host lifecycle boundary. Resume without wall-time debt.
    if (!this.host.active()) { this.last = this.host.now(); return; }
    const now = this.host.now(), delta = Math.max(0, (now - this.last) / 1000); this.last = now;
    const bounds = this.host.bounds(), geometry = this.geometry(), area = this.host.area();
    const gravity = 9.81 * geometry.height / 1.65;
    const previousFoot = this.fall.y + geometry.footY;
    const nextY = this.fall.y + this.fall.velocity * delta + gravity * delta * delta / 2;
    this.fall.velocity += gravity * delta;
    const platforms = this.platforms();
    const floor = platforms.at(-1);
    const surface = selectSupport(platforms, bounds, geometry, previousFoot, nextY + geometry.footY)
      || (previousFoot >= floor.y ? floor : null);
    const x = Math.min(area.x + area.width - geometry.right, Math.max(area.x - geometry.left, bounds.x));
    if (surface) {
      this.host.move(x, surface.y - geometry.footY);
      const source = this.windows.find(window => window.id === surface.id);
      this.support = { ...surface, windowX: source?.x };
      const impact = Math.min(1, this.fall.velocity / Math.max(1, geometry.height * 3));
      clearInterval(this.timer); this.timer = null; this.fall = null;
      this.reactionUntil = now + 1000;
      this.command('land', { impact }); this.host.settled?.(surface.id);
    } else {
      this.fall.y = nextY; this.host.move(x, nextY);
    }
  }
  range() {
    if (!this.enabled() || !this.support || this.support.id === 'screen') return null;
    const geometry = this.geometry();
    return { minimumX: Math.ceil(this.support.left - geometry.footLeft), maximumX: Math.floor(this.support.right - geometry.footRight) };
  }
  floorY() { return this.support && this.enabled() ? this.support.y - this.geometry().footY : null; }
  busy() { return Boolean(this.fall) || this.host.now() < this.reactionUntil; }
  edge(direction) {
    if (!this.enabled()) return;
    this.reactionUntil = this.host.now() + 1300;
    this.command('edge', { direction, wall: this.support?.id === 'screen' || !this.support });
  }
  interruptReaction() {
    this.reactionUntil = 0;
    if (!this.fall) this.command('idle');
  }
  cancel(clearSupport = true) {
    clearInterval(this.timer); this.timer = null; this.fall = null; this.reactionUntil = 0;
    if (clearSupport) this.support = null;
    this.command('idle');
  }
}
module.exports = { exposedPlatforms, contactGeometry, selectSupport, DesktopContacts };
