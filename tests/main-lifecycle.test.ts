import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mainPath = path.resolve('electron/main.cjs');
const localRequire = createRequire(mainPath);
const { DEFAULT_SETTINGS } = localRequire('./settings.cjs');
const directories: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function harness(activeId = 'alpha') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-main-')); directories.push(directory);
  const character = path.join(directory, 'characters', 'alpha'); fs.mkdirSync(character, { recursive: true });
  fs.writeFileSync(path.join(character, 'model.vrm'), 'test');
  fs.writeFileSync(path.join(character, 'character.json'), JSON.stringify({ id: 'alpha', displayName: 'Alpha', model: 'model.vrm', messages: {} }));
  let settings = { ...DEFAULT_SETTINGS, activeCharacterId: activeId, zoom: 1.4, characterZooms: { yachiyo: 0.35 } };
  const store = { get: () => structuredClone(settings), patch: (patch: any) => { settings = { ...settings, ...patch }; return store.get(); } };
  let bounds = { x: 800, y: 240, width: 560, height: 840 };
  const handles = new Map<string, (...args: any[]) => any>(), listeners = new Map<string, (...args: any[]) => any>();
  const window = { isDestroyed: () => false, getBounds: () => ({ ...bounds }), getPosition: () => [bounds.x, bounds.y],
    setBounds: vi.fn((next: typeof bounds) => { bounds = next; }), setIgnoreMouseEvents: vi.fn(),
    setAlwaysOnTop: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    webContents: { send: vi.fn((channel: string, message: any) => {
      if (channel === 'app:command' && message.command === 'flush-interaction-settings') {
        listeners.get('settings:interaction-flushed')!({ sender: window.webContents }, { token: message.payload, ok: true });
      }
    }), reloadIgnoringCache: vi.fn() } };
  const electron = { app: { isPackaged: false, getPath: () => directory, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn() },
    ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handles.set(name, fn), on: (name: string, fn: (...args: any[]) => any) => listeners.set(name, fn),
      removeListener: (name: string) => listeners.delete(name) },
    dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
    screen: { getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) } };
  const context = vm.createContext({ require: (name: string) => name === 'electron' ? electron : localRequire(name),
    __dirname: path.dirname(mainPath), Buffer, URL, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { argv: [], env: {}, platform: 'win32', on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } } });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + `\n globalThis.h = {
    setup(store, window) { settingsStore = store; mainWindow = window; runtimeIsReady = true; },
    startAutonomousWalk, switchCharacter, resetRuntimeState, activeCharacterRecord, bindIpc,
    state() { return { runtimeIsReady, moving: Boolean(autonomyMove), timer: autonomyMoveTimer, scheduler: autonomyTimer }; }
  };`, context);
  const h = context.h; h.setup(store, window); h.bindIpc();
  return { h, window, store, handles, listeners, directory };
}

describe('actual main-process character lifecycle', () => {
  it('clears the old movement timer on tray switch and prevents a second walk', async () => {
    const { h, window } = harness();
    expect(h.startAutonomousWalk()).toBe(true);
    expect(h.startAutonomousWalk()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect((await h.switchCharacter('yachiyo')).ok).toBe(true);
    expect(h.state()).toMatchObject({ runtimeIsReady: false, moving: false, timer: null, scheduler: null });
    expect(vi.getTimerCount()).toBe(0);
    window.setBounds.mockClear(); vi.advanceTimersByTime(10000);
    expect(window.setBounds).not.toHaveBeenCalled();
    expect(window.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
  });
  it('deleting the active character restores the fallback scale and stops movement', async () => {
    const { h, store, handles, directory } = harness(); h.startAutonomousWalk();
    expect(await handles.get('characters:remove')!({}, 'alpha')).toEqual({ ok: true });
    expect(store.get()).toMatchObject({ activeCharacterId: 'yachiyo', zoom: 0.35 });
    expect(fs.existsSync(path.join(directory, 'characters', 'alpha'))).toBe(false);
    expect(h.state().moving).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('invalid active-character fallback restores its remembered scale', () => {
    const { h, store } = harness('missing'); h.activeCharacterRecord();
    expect(store.get()).toMatchObject({ activeCharacterId: 'yachiyo', zoom: 0.35 });
  });
  it('an unloading old character saves its own scale without changing the new one', async () => {
    const { h, store, listeners } = harness(); await h.switchCharacter('yachiyo');
    const event: { returnValue?: boolean } = {};
    listeners.get('settings:flush-interaction')!(event, { characterId: 'alpha', patch: { zoom: 0.8, rotationY: 1.2 } });
    expect(event.returnValue).toBe(true);
    expect(store.get()).toMatchObject({ activeCharacterId: 'yachiyo', zoom: 0.35, rotationY: 0,
      characterZooms: { alpha: 0.8, yachiyo: 0.35 } });
  });
  it('leaves the active character intact when the renderer cannot save settings', async () => {
    const { h, store, window } = harness(); window.webContents.send.mockImplementation(() => {});
    const switching = h.switchCharacter('yachiyo');
    vi.advanceTimersByTime(2000);
    expect((await switching).ok).toBe(false);
    expect(store.get().activeCharacterId).toBe('alpha');
    expect(window.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });
});
