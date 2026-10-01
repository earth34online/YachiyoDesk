import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionController } from '../src/InteractionController';
import { AppUI } from '../src/AppUI';
import type { AvatarRuntime } from '../src/AvatarRuntime';
import type { AppSettings } from '../src/types';

const { DEFAULT_SETTINGS } = require('../electron/settings.cjs') as { DEFAULT_SETTINGS: AppSettings };

function harness() {
  const handlers = new Map<string, (event: any) => void>();
  const classes = new Set<string>();
  const classList = {
    add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
    contains: (name: string) => classes.has(name), toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name),
  };
  const api = { setClickThrough: vi.fn(), updateSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    flushInteractionSettings: vi.fn().mockReturnValue(true), noteUserActivity: vi.fn(),
    setInteractionPanelOpen: vi.fn() };
  vi.stubGlobal('window', { addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    setTimeout, clearTimeout, yachiyoDesk: api });
  vi.stubGlobal('document', { body: { classList } });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  // Use the real UI state transitions with inert visual elements. Rendering
  // and physical input are exercised separately by the Electron smoke test.
  const ui = Object.assign(Object.create(AppUI.prototype), {
    settingsOpen: false, blockingOverlayOpen: false, settingsShowFrame: 0, settingsHideTimer: 0,
    dockHideTimer: 0, loading: { hidden: false, classList }, fatal: { hidden: true },
    fatalMessage: { textContent: '' }, setupRequired: { hidden: true },
    companionDock: { matches: () => false }, settingsPanel: { hidden: true, classList },
    renderSettings: vi.fn(), refreshCharacters: vi.fn(), showToast: vi.fn(),
    isCompanionDockTarget: () => false,
  }) as AppUI;
  const runtime = { hitTest: vi.fn().mockReturnValue(null), setPointer: vi.fn(), resetPose: vi.fn(),
    setZoom: vi.fn(), setRotation: vi.fn(), noteActivity: vi.fn() };
  const controller = new InteractionController({} as HTMLCanvasElement, runtime as unknown as AvatarRuntime, ui, { ...DEFAULT_SETTINGS });
  Object.assign(ui, { callbacks: { onCloseSettings: () => controller.reevaluateClickThrough(),
    onInteractionStateChanged: () => controller.reevaluateClickThrough() } });
  const event = (extra = {}) => ({ clientX: 2, clientY: 2, screenX: 2, screenY: 2, preventDefault: vi.fn(), ...extra });
  return { api, ui, runtime, controller, handlers, event };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('desktop input ownership', () => {
  it('keeps first-run setup and fatal retry clickable after pointer movement and panel closure', () => {
    const h = harness();
    h.controller.reevaluateClickThrough();
    h.ui.showSetupRequired();
    h.handlers.get('pointermove')!(h.event());
    h.ui.showSettings(); h.ui.hideSettings();
    h.handlers.get('pointermove')!(h.event());
    expect(h.api.setClickThrough.mock.calls.map(([ignore]) => ignore)).toEqual([true, false]);
    h.ui.showFatal(new Error('bad model'));
    h.handlers.get('pointermove')!(h.event());
    expect(h.api.setClickThrough).toHaveBeenLastCalledWith(false);
  });

  it('restores transparent input after loading and an open/close panel cycle', () => {
    const h = harness();
    h.ui.showFatal(new Error('loading failed')); h.ui.finishLoading();
    h.ui.showSettings(); h.ui.hideSettings();
    expect(h.api.setClickThrough.mock.calls.map(([ignore]) => ignore)).toEqual([false, true, false, true]);
    vi.advanceTimersByTime(200);
    expect(h.ui.isSettingsOpen()).toBe(false);
  });

  it('reevaluates input when the delayed companion dock disappears', () => {
    const h = harness();
    h.ui.setCompanionHover(true); h.ui.setCompanionHover(false);
    expect(h.api.setClickThrough).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(360);
    expect(h.api.setClickThrough).toHaveBeenLastCalledWith(true);
  });
});

describe('interaction persistence', () => {
  it('previews rotation using the effective zoom and keeps unrelated pending persistence', () => {
    const h = harness();
    Object.assign(h.controller, { settings: { ...DEFAULT_SETTINGS, zoom: 1.2 }, pendingSettings: { zoom: 1.2 } });
    const preview = h.controller.previewSettings({ rotationY: .4 });
    expect(preview).toMatchObject({ zoom: 1.2, rotationY: .4 });
    expect(h.controller.previewSettings({ lookIntensity: .7 })).toMatchObject({ zoom: 1.2, rotationY: .4, lookIntensity: .7 });
    expect(h.controller.flushBeforeUnload()).toBe(true);
    expect(h.api.flushInteractionSettings).toHaveBeenCalledWith({ zoom: 1.2 }, DEFAULT_SETTINGS.activeCharacterId);
  });
  it('keeps unsaved interaction fields when an unrelated settings update arrives', () => {
    const h = harness();
    const schedule = h.controller as unknown as { schedulePersistence(patch: Partial<AppSettings>): void };
    schedule.schedulePersistence({ rotationY: 0.8, zoom: 0.6 });
    const merged = h.controller.setSettings({ ...DEFAULT_SETTINGS, speech: false });
    expect(merged).toMatchObject({ rotationY: 0.8, zoom: 0.6, speech: false });
  });
  it('merges rotation and zoom within the same debounce window', () => {
    const h = harness();
    const schedule = h.controller as unknown as { schedulePersistence(patch: Partial<AppSettings>): void };
    schedule.schedulePersistence({ rotationY: 0.7 });
    vi.advanceTimersByTime(100);
    schedule.schedulePersistence({ zoom: 0.6 });
    vi.advanceTimersByTime(280);
    expect(h.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ rotationY: 0.7, zoom: 0.6 });
  });

  it('does not let an old wheel save undo Ctrl+0', () => {
    const h = harness();
    h.runtime.hitTest.mockReturnValue({});
    h.handlers.get('wheel')!(h.event({ deltaY: -1200 }));
    h.handlers.get('keydown')!(h.event({ ctrlKey: true, key: '0' }));
    vi.advanceTimersByTime(500);
    expect(h.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ zoom: 0.35, rotationY: 0 });
  });

  it('cancels only fields replaced by a UI edit and flushes the rest once at unload', () => {
    const h = harness();
    const schedule = h.controller as unknown as { schedulePersistence(patch: Partial<AppSettings>): void };
    schedule.schedulePersistence({ rotationY: 0.8, zoom: 1.5 });
    h.controller.cancelPendingSettings({ zoom: 0.35 });
    h.controller.flushBeforeUnload(); h.controller.flushBeforeUnload();
    vi.advanceTimersByTime(500);
    expect(h.api.flushInteractionSettings).toHaveBeenCalledExactlyOnceWith({ rotationY: 0.8 }, 'yachiyo');
    expect(h.api.updateSettings).not.toHaveBeenCalled();
  });
});
