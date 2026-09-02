import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { commitTemporaryFile, DEFAULT_SETTINGS, SettingsStore, sanitizeSettings, sanitizeWindow } = require('../electron/settings.cjs') as {
  DEFAULT_SETTINGS: Record<string, unknown>;
  SettingsStore: new (filePath: string) => { get: () => Record<string, unknown> };
  commitTemporaryFile: (
    temporaryPath: string,
    destinationPath: string,
    fileSystem: {
      renameSync: (source: string, destination: string) => void;
      copyFileSync: (source: string, destination: string) => void;
      unlinkSync: (path: string) => void;
    },
  ) => void;
  sanitizeSettings: (input?: Record<string, unknown>) => Record<string, unknown>;
  sanitizeWindow: (input?: Record<string, unknown>) => Record<string, number> | null;
};

describe('main-process settings validation', () => {
  it('rejects invalid values and preserves safe defaults', () => {
    const result = sanitizeSettings({
      quality: 'impossible',
      zoom: 99,
      rotationY: Number.NaN,
      sleepMinutes: -100,
      clickThrough: 'yes',
    });
    expect(result.quality).toBe('ultra');
    expect(result.zoom).toBe(2.4);
    expect(result.rotationY).toBe(0);
    expect(result.sleepMinutes).toBe(1);
    expect(result.clickThrough).toBe(true);
  });

  it('uses the requested 35% character size for new profiles', () => {
    expect(DEFAULT_SETTINGS.zoom).toBe(0.35);
    expect(sanitizeSettings().zoom).toBe(0.35);
    expect(sanitizeSettings({ zoom: 0.01 }).zoom).toBe(0.10);
  });

  it('migrates existing profiles to the requested 35% launch size', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-settings-'));
    try {
      const legacyPath = path.join(directory, 'legacy.json');
      fs.writeFileSync(legacyPath, JSON.stringify({
        schemaVersion: 1,
        zoom: 1,
        window: { x: 100, y: 100, width: 1610, height: 1800 },
      }), 'utf8');
      const migrated = new SettingsStore(legacyPath).get();
      expect(migrated.zoom).toBe(0.35);
      expect(migrated.window).toBeNull();
      expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).schemaVersion).toBe(15);

      const previousDefaultPath = path.join(directory, 'v3-default.json');
      fs.writeFileSync(previousDefaultPath, JSON.stringify({ schemaVersion: 3, zoom: 0.82 }), 'utf8');
      expect(new SettingsStore(previousDefaultPath).get().zoom).toBe(0.35);

      const customPath = path.join(directory, 'custom.json');
      fs.writeFileSync(customPath, JSON.stringify({ schemaVersion: 1, zoom: 1.25 }), 'utf8');
      expect(new SettingsStore(customPath).get().zoom).toBe(0.35);

      const oversizedCompactPath = path.join(directory, 'v4-oversized-compact.json');
      fs.writeFileSync(oversizedCompactPath, JSON.stringify({
        schemaVersion: 4,
        zoom: 0.15,
        window: { x: 304, y: -137, width: 1800, height: 1800 },
      }), 'utf8');
      expect(new SettingsStore(oversizedCompactPath).get().window).toBeNull();

      const accidentalResizePath = path.join(directory, 'v5-accidental-resize.json');
      fs.writeFileSync(accidentalResizePath, JSON.stringify({
        schemaVersion: 5,
        zoom: 0.33,
        window: { x: 1117, y: 360, width: 806, height: 1108 },
      }), 'utf8');
      const fixedHost = new SettingsStore(accidentalResizePath).get();
      expect(fixedHost.zoom).toBe(0.35);
      expect(fixedHost.window).toBeNull();

      const dpiDriftPath = path.join(directory, 'v6-dpi-drift.json');
      fs.writeFileSync(dpiDriftPath, JSON.stringify({
        schemaVersion: 6,
        zoom: 0.2733178200585764,
        window: { x: 804, y: 219, width: 670, height: 990 },
      }), 'utf8');
      const repairedDpiProfile = new SettingsStore(dpiDriftPath).get();
      expect(repairedDpiProfile.zoom).toBe(0.35);
      expect(repairedDpiProfile.window).toBeNull();

      const previousWalkSpeedPath = path.join(directory, 'v7-walk-speed.json');
      fs.writeFileSync(previousWalkSpeedPath, JSON.stringify({
        schemaVersion: 7,
        wanderSpeed: 62,
        autoStart: true,
      }), 'utf8');
      const slowedWalk = new SettingsStore(previousWalkSpeedPath).get();
      expect(slowedWalk.wanderSpeed).toBe(52);
      expect(slowedWalk.autoStart).toBe(true);

      const customWalkSpeedPath = path.join(directory, 'v7-custom-walk-speed.json');
      fs.writeFileSync(customWalkSpeedPath, JSON.stringify({ schemaVersion: 7, wanderSpeed: 55 }), 'utf8');
      expect(new SettingsStore(customWalkSpeedPath).get().wanderSpeed).toBe(55);

      const conservativeDefaultPath = path.join(directory, 'v10-default-speed.json');
      fs.writeFileSync(conservativeDefaultPath, JSON.stringify({ schemaVersion: 10, wanderSpeed: 42 }), 'utf8');
      expect(new SettingsStore(conservativeDefaultPath).get().wanderSpeed).toBe(52);

      const disabledLegacyAutostartPath = path.join(directory, 'v12-autostart.json');
      fs.writeFileSync(disabledLegacyAutostartPath, JSON.stringify({ schemaVersion: 12, autoStart: false }), 'utf8');
      expect(new SettingsStore(disabledLegacyAutostartPath).get().autoStart).toBe(true);

      const disabledPreviousProfilePath = path.join(directory, 'v14-autostart.json');
      fs.writeFileSync(disabledPreviousProfilePath, JSON.stringify({ schemaVersion: 14, autoStart: false }), 'utf8');
      const restoredProfile = new SettingsStore(disabledPreviousProfilePath).get();
      expect(restoredProfile.schemaVersion).toBe(15);
      expect(restoredProfile.autoStart).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enables autonomous bottom wandering and clamps its speed', () => {
    expect(DEFAULT_SETTINGS.autonomousBehavior).toBe(true);
    expect(DEFAULT_SETTINGS.autoStart).toBe(true);
    expect(DEFAULT_SETTINGS.wanderSpeed).toBe(52);
    expect(sanitizeSettings({ wanderSpeed: 999 }).wanderSpeed).toBe(90);
    expect(sanitizeSettings({ wanderSpeed: 1 }).wanderSpeed).toBe(18);
    expect(sanitizeSettings({ activityFrequency: 99 }).activityFrequency).toBe(2);
    expect(DEFAULT_SETTINGS.wanderMode).toBe('patrol');
    expect(sanitizeSettings({ wanderMode: 'random' }).wanderMode).toBe('random');
    expect(sanitizeSettings({ wanderMode: 'diagonal' }).wanderMode).toBe('patrol');
  });

  it('clamps corrupted window bounds', () => {
    expect(sanitizeWindow({ x: 999999, y: -999999, width: 2, height: 9000 })).toEqual({
      x: 32000,
      y: -32000,
      width: 300,
      height: 1800,
    });
  });

  it('falls back to copy-and-unlink when a redirected profile rejects rename', () => {
    const calls: string[] = [];
    commitTemporaryFile('settings.json.tmp', 'settings.json', {
      renameSync: () => {
        const error = new Error('cross-device link') as Error & { code: string };
        error.code = 'EXDEV';
        throw error;
      },
      copyFileSync: (source, destination) => calls.push(`copy:${source}->${destination}`),
      unlinkSync: (path) => calls.push(`unlink:${path}`),
    });
    expect(calls).toEqual([
      'copy:settings.json.tmp->settings.json',
      'unlink:settings.json.tmp',
    ]);
  });
});
