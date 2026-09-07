import type * as THREE from 'three';
import { AvatarRuntime } from './AvatarRuntime';
import { clamp } from './math';
import type { AppSettings, HitZone, ReactionName } from './types';
import type { AppUI } from './AppUI';

interface DragState {
  pointerId: number;
  mode: 'move' | 'rotate';
  lastScreenX: number;
  lastScreenY: number;
  startClientX: number;
  startClientY: number;
  startedAt: number;
  distance: number;
  zone: HitZone;
}

export class InteractionController {
  private readonly canvas: HTMLCanvasElement;
  private readonly runtime: AvatarRuntime;
  private readonly ui: AppUI;
  private settings: AppSettings;
  private drag: DragState | null = null;
  private hoverHit: THREE.Intersection | null = null;
  private lastIgnoreState: boolean | null = null;
  private persistenceTimer = 0;
  private windowMoveTimer = 0;
  private pendingWindowPoint: { screenX: number; screenY: number } | null = null;
  private pokeTimes: number[] = [];
  private lastClickAt = 0;

  constructor(canvas: HTMLCanvasElement, runtime: AvatarRuntime, ui: AppUI, settings: AppSettings) {
    this.canvas = canvas;
    this.runtime = runtime;
    this.ui = ui;
    this.settings = settings;
    this.bindEvents();
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
    if (!settings.clickThrough) this.setIgnored(false);
  }

  reevaluateClickThrough(): void {
    this.setIgnored(this.settings.clickThrough
      && !this.hoverHit
      && !this.ui.isSettingsOpen()
      && !this.ui.isCompanionDockOpen());
  }

  private bindEvents(): void {
    window.addEventListener('pointermove', (event) => this.onPointerMove(event), { passive: false });
    window.addEventListener('pointerdown', (event) => this.onPointerDown(event), { passive: false });
    window.addEventListener('pointerup', (event) => this.onPointerUp(event), { passive: false });
    window.addEventListener('pointercancel', () => this.endDrag());
    window.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    window.addEventListener('contextmenu', (event) => this.onContextMenu(event));
    window.addEventListener('blur', () => {
      this.endDrag();
      // Pointer events cannot cross a BrowserWindow boundary. Closing on blur
      // covers clicks on another app/desktop as well as clicks inside our own
      // transparent surface, so the panel never depends on one event path.
      if (this.ui.isSettingsOpen()) this.ui.hideSettings();
    });
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  private onPointerMove(event: PointerEvent): void {
    this.runtime.setPointer(event.clientX, event.clientY, true);
    if (this.ui.isCompanionDockTarget(event.target)) {
      this.ui.setCompanionHover(true);
      this.setIgnored(false);
      return;
    }
    if (this.drag) {
      const deltaX = event.screenX - this.drag.lastScreenX;
      const deltaY = event.screenY - this.drag.lastScreenY;
      this.drag.lastScreenX = event.screenX;
      this.drag.lastScreenY = event.screenY;
      this.drag.distance += Math.hypot(deltaX, deltaY);
      if (this.drag.mode === 'rotate') {
        const rotation = clamp(this.settings.rotationY + deltaX * 0.009, -Math.PI, Math.PI);
        this.settings = { ...this.settings, rotationY: rotation };
        this.runtime.setRotation(rotation);
        this.schedulePersistence({ rotationY: rotation });
      } else if (!this.settings.lockPosition) {
        this.queueWindowDrag(event.screenX, event.screenY);
      }
      event.preventDefault();
      return;
    }

    if (this.ui.isSettingsOpen()) {
      this.ui.setCompanionHover(false);
      this.setIgnored(false);
      return;
    }
    this.hoverHit = this.runtime.hitTest(event.clientX, event.clientY);
    // Hovering reveals the compact status dock but does not interrupt a walk.
    // An actual press/wheel/context action below is the intentional stop signal.
    document.body.classList.toggle('over-avatar', Boolean(this.hoverHit));
    this.ui.setCompanionHover(Boolean(this.hoverHit));
    this.setIgnored(this.settings.clickThrough && !this.hoverHit && !this.ui.isCompanionDockOpen());
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.ui.isCompanionDockTarget(event.target)) return;
    if (this.ui.isSettingsOpen()) return;
    const hit = this.runtime.hitTest(event.clientX, event.clientY);
    if (!hit) return;
    if (event.button === 2) {
      window.yachiyoDesk.noteUserActivity();
      this.runtime.noteActivity();
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    const zone = this.runtime.hitZone(hit);
    window.yachiyoDesk.noteUserActivity();
    this.runtime.noteActivity();
    this.drag = {
      pointerId: event.pointerId,
      mode: event.button === 1 || event.shiftKey ? 'rotate' : 'move',
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startedAt: performance.now(),
      distance: 0,
      zone,
    };
    this.canvas.setPointerCapture?.(event.pointerId);
    document.body.classList.add('dragging-avatar');
    this.setIgnored(false);
    if (this.drag.mode === 'move' && !this.settings.lockPosition) {
      this.runtime.setDragging(true);
      window.yachiyoDesk.beginWindowDrag(event.screenX, event.screenY);
    }
    event.preventDefault();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const drag = this.drag;
    const click = drag.distance < 7 && performance.now() - drag.startedAt < 550 && drag.mode === 'move';
    this.endDrag(event.screenX, event.screenY);
    if (click) this.reactToClick(drag.zone);
    event.preventDefault();
  }

  private endDrag(screenX?: number, screenY?: number): void {
    if (!this.drag) return;
    if (this.drag.mode === 'move') {
      this.runtime.setDragging(false);
      if (this.windowMoveTimer) window.clearTimeout(this.windowMoveTimer);
      this.windowMoveTimer = 0;
      this.pendingWindowPoint = null;
      if (!this.settings.lockPosition) {
        window.yachiyoDesk.endWindowDrag(
          screenX ?? this.drag.lastScreenX,
          screenY ?? this.drag.lastScreenY,
        );
      }
    }
    try { this.canvas.releasePointerCapture?.(this.drag.pointerId); } catch { /* already released */ }
    this.drag = null;
    document.body.classList.remove('dragging-avatar');
    this.reevaluateClickThrough();
  }

  private reactToClick(zone: HitZone): void {
    if (!this.settings.reactions) return;
    const now = performance.now();
    this.pokeTimes = this.pokeTimes.filter((time) => now - time < 6500);
    this.pokeTimes.push(now);

    let reaction: ReactionName;
    let speechKey: string;
    if (this.pokeTimes.length >= 5) {
      reaction = 'angry';
      speechKey = 'angry';
      this.pokeTimes = [];
    } else if (now - this.lastClickAt < 340) {
      reaction = 'joy';
      speechKey = 'joy';
    } else if (zone === 'head') {
      reaction = 'joy';
      speechKey = 'head';
    } else if (zone === 'body') {
      reaction = 'surprised';
      speechKey = 'body';
    } else {
      reaction = 'poke';
      speechKey = 'lower';
    }
    this.lastClickAt = now;
    this.runtime.triggerReaction(reaction);
    this.ui.showSpeech(speechKey);
  }

  private onWheel(event: WheelEvent): void {
    if (this.ui.isSettingsOpen() || !this.runtime.hitTest(event.clientX, event.clientY)) return;
    const factor = Math.exp(-event.deltaY * 0.0012);
    window.yachiyoDesk.noteUserActivity();
    const zoom = clamp(this.settings.zoom * factor, 0.10, 2.4);
    this.settings = { ...this.settings, zoom };
    this.runtime.setZoom(zoom);
    this.runtime.noteActivity();
    this.ui.showToast(`缩放 ${Math.round(zoom * 100)}%`);
    this.schedulePersistence({ zoom });
    event.preventDefault();
  }

  private onContextMenu(event: MouseEvent): void {
    if (this.ui.isSettingsOpen()) return;
    if (!this.runtime.hitTest(event.clientX, event.clientY)) return;
    event.preventDefault();
    window.yachiyoDesk.noteUserActivity();
    window.yachiyoDesk.showContextMenu({ x: event.clientX, y: event.clientY });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.ui.isSettingsOpen()) {
      this.ui.hideSettings();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '0') {
      this.runtime.resetPose();
      this.settings = { ...this.settings, zoom: 0.35, rotationY: 0 };
      this.runtime.setZoom(0.35);
      this.runtime.setRotation(0);
      void window.yachiyoDesk.updateSettings({ zoom: 0.35, rotationY: 0 });
      this.ui.showToast('已恢复默认姿态');
      event.preventDefault();
    }
  }

  private setIgnored(ignore: boolean): void {
    if (this.lastIgnoreState === ignore) return;
    this.lastIgnoreState = ignore;
    window.yachiyoDesk.setClickThrough(ignore);
  }

  private schedulePersistence(patch: Partial<AppSettings>): void {
    window.clearTimeout(this.persistenceTimer);
    this.persistenceTimer = window.setTimeout(() => {
      void window.yachiyoDesk.updateSettings(patch);
    }, 280);
  }

  private queueWindowDrag(screenX: number, screenY: number): void {
    this.pendingWindowPoint = { screenX, screenY };
    if (this.windowMoveTimer) return;
    // A 240 Hz requestAnimationFrame stream overwhelms Windows' transparent
    // surface compositor without improving pointer feel. Submit only the most
    // recent absolute point at a stable 60 Hz, then flush the exact endpoint
    // synchronously on pointer-up.
    this.windowMoveTimer = window.setTimeout(() => {
      this.windowMoveTimer = 0;
      const point = this.pendingWindowPoint;
      this.pendingWindowPoint = null;
      if (point && this.drag?.mode === 'move') {
        window.yachiyoDesk.updateWindowDrag(point.screenX, point.screenY);
      }
    }, 16);
  }
}
