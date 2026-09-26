'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 15,
  alwaysOnTop: true,
  clickThrough: true,
  lockPosition: false,
  mouseLook: true,
  physics: true,
  idleMotion: true,
  autonomousBehavior: true,
  reactions: true,
  speech: true,
  contactShadow: true,
  autoStart: true,
  quality: 'ultra',
  adaptivePerformance: true,
  zoom: 0.35,
  rotationY: 0,
  motionIntensity: 1,
  wanderSpeed: 52,
  wanderMode: 'patrol',
  activityFrequency: 1,
  lookIntensity: 1,
  activeCharacterId: 'yachiyo',
  characterZooms: Object.freeze({}),
  sleepMinutes: 3,
  window: null,
});

const BOOLEAN_KEYS = new Set([
  'alwaysOnTop',
  'clickThrough',
  'lockPosition',
  'mouseLook',
  'physics',
  'idleMotion',
  'autonomousBehavior',
  'reactions',
  'speech',
  'contactShadow',
  'autoStart',
  'adaptivePerformance',
]);

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sanitizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const width = Math.round(clampNumber(value.width, 560, 300, 1800));
  const height = Math.round(clampNumber(value.height, 840, 460, 1800));
  const x = Math.round(clampNumber(value.x, 0, -32000, 32000));
  const y = Math.round(clampNumber(value.y, 0, -32000, 32000));
  return { x, y, width, height };
}

function sanitizeSettings(value = {}) {
  const output = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object') return output;

  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] === 'boolean') output[key] = value[key];
  }

  output.quality = ['ultra', 'high', 'balanced'].includes(value.quality)
    ? value.quality
    : DEFAULT_SETTINGS.quality;
  output.zoom = clampNumber(value.zoom, DEFAULT_SETTINGS.zoom, 0.10, 2.4);
  output.rotationY = clampNumber(value.rotationY, DEFAULT_SETTINGS.rotationY, -Math.PI, Math.PI);
  output.motionIntensity = clampNumber(value.motionIntensity, DEFAULT_SETTINGS.motionIntensity, 0, 1.5);
  output.wanderSpeed = clampNumber(value.wanderSpeed, DEFAULT_SETTINGS.wanderSpeed, 18, 90);
  output.wanderMode = ['patrol', 'random'].includes(value.wanderMode)
    ? value.wanderMode
    : DEFAULT_SETTINGS.wanderMode;
  output.activityFrequency = clampNumber(value.activityFrequency, DEFAULT_SETTINGS.activityFrequency, 0.5, 2);
  output.lookIntensity = clampNumber(value.lookIntensity, DEFAULT_SETTINGS.lookIntensity, 0, 1.5);
  output.sleepMinutes = clampNumber(value.sleepMinutes, DEFAULT_SETTINGS.sleepMinutes, 1, 30);
  output.activeCharacterId = typeof value.activeCharacterId === 'string'
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.activeCharacterId)
    ? value.activeCharacterId
    : DEFAULT_SETTINGS.activeCharacterId;
  output.characterZooms = {};
  if (value.characterZooms && typeof value.characterZooms === 'object' && !Array.isArray(value.characterZooms)) {
    for (const [id, zoom] of Object.entries(value.characterZooms).slice(0, 128)) {
      if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && typeof zoom === 'number' && Number.isFinite(zoom)) {
        output.characterZooms[id] = clampNumber(zoom, DEFAULT_SETTINGS.zoom, 0.10, 2.4);
      }
    }
  }
  output.window = sanitizeWindow(value.window);
  return output;
}

function commitTemporaryFile(temporaryPath, destinationPath, fileSystem = fs) {
  try {
    fileSystem.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    // Redirected/synchronised Windows profile folders can report EXDEV even
    // when both paths appear to share a directory. Copying the completed temp
    // file still prevents a partially-written JSON file from being observed.
    if (!['EXDEV', 'EEXIST', 'EPERM'].includes(error?.code)) throw error;
    fileSystem.copyFileSync(temporaryPath, destinationPath);
    fileSystem.unlinkSync(temporaryPath);
  }
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.needsWrite = false;
    this.data = this.#read();
    if (this.needsWrite) this.#write();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // Version 1 used 100% as its implicit starting size. Version 2 deliberately
      // starts smaller so the companion does not dominate the desktop on first run.
      const isLegacyProfile = !Number.isFinite(parsed.schemaVersion) || parsed.schemaVersion < 2;
      if (isLegacyProfile) {
        this.needsWrite = true;
        if (parsed.zoom === 1) parsed.zoom = DEFAULT_SETTINGS.zoom;
        // An early resize path could persist a near-full-screen companion window.
        // Reset only those legacy outliers; ordinary saved positions stay intact.
        if (parsed.window && (Number(parsed.window.width) > 900 || Number(parsed.window.height) > 1200)) {
          parsed.window = null;
        }
      }
      // Version 4 intentionally makes the companion desktop-sized rather than
      // filling most of the transparent host. Migrate only the old default;
      // an explicit user-selected zoom is preserved.
      if (Number(parsed.schemaVersion) < 4 && Math.abs(Number(parsed.zoom) - 0.82) < 0.0001) {
        parsed.zoom = DEFAULT_SETTINGS.zoom;
        this.needsWrite = true;
      }
      // Version 5 repairs a large transparent host window that older resize
      // handling could persist. At the new compact zoom this wastes millions
      // of composited pixels and may restore partly off-screen. Only migrate
      // that exact legacy combination; deliberate larger/custom profiles stay.
      if (Number(parsed.schemaVersion) < 5
        && Number(parsed.zoom) <= 0.20
        && parsed.window
        && (Number(parsed.window.width) > 900 || Number(parsed.window.height) > 1200)) {
        parsed.window = null;
        this.needsWrite = true;
      }
      // Version 6 makes the transparent host a fixed compositor surface.
      // Frameless edge-resizing was easy to trigger accidentally and Windows
      // transparent windows visibly flash while their native bounds change.
      // A non-standard saved size also breaks floor-walk detection because the
      // invisible host no longer matches the character the user sees.
      if (Number(parsed.schemaVersion) < 6
        && parsed.window
        && (Math.abs(Number(parsed.window.width) - 560) > 8
          || Math.abs(Number(parsed.window.height) - 840) > 8)) {
        parsed.window = null;
        this.needsWrite = true;
      }
      // Version 7 repeats the fixed-surface repair for profiles that were
      // already opened by version 6 while the per-monitor DPI bug was under
      // investigation. That build could persist a compositor-converted size
      // such as 670x990 even though the application never requested a resize.
      // Preserve the user's character zoom and all behavioural preferences;
      // only discard the corrupted native host bounds.
      if (Number(parsed.schemaVersion) < 7
        && parsed.window
        && (Math.abs(Number(parsed.window.width) - 560) > 8
          || Math.abs(Number(parsed.window.height) - 840) > 8)) {
        parsed.window = null;
        this.needsWrite = true;
      }
      // Version 8 slows the old 62 px/s default to a relaxed desktop-pet walk.
      // Preserve any speed the user explicitly changed away from that default.
      if (Number(parsed.schemaVersion) < 8 && Math.abs(Number(parsed.wanderSpeed) - 62) < 0.0001) {
        parsed.wanderSpeed = DEFAULT_SETTINGS.wanderSpeed;
        this.needsWrite = true;
      }
      // Version 9 changes the requested first-run/reset size to 35%. Migrate
      // only the previous 15% default; deliberate custom zooms stay intact.
      if (Number(parsed.schemaVersion) < 9 && Math.abs(Number(parsed.zoom) - 0.15) < 0.0001) {
        parsed.zoom = DEFAULT_SETTINGS.zoom;
        this.needsWrite = true;
      }
      // Version 10 establishes the physical-screen bottom-right start point.
      // Reset only the native host position once; character size, selected
      // model and every user preference remain untouched.
      if (Number(parsed.schemaVersion) < 10) {
        parsed.window = null;
        this.needsWrite = true;
      }
      // Version 11 raises the deliberately conservative 42 px/s default by one
      // comfortable step. Preserve every custom speed selected by the user.
      if (Number(parsed.schemaVersion) < 11 && Math.abs(Number(parsed.wanderSpeed) - 42) < 0.0001) {
        parsed.wanderSpeed = DEFAULT_SETTINGS.wanderSpeed;
        this.needsWrite = true;
      }
      // Version 12 applies the requested 35% launch size to existing profiles
      // once. After migration, users can still change and persist another size.
      if (Number(parsed.schemaVersion) < 12) {
        parsed.zoom = DEFAULT_SETTINGS.zoom;
        this.needsWrite = true;
      }
      // Version 13 restores the explicitly requested login startup setting for
      // profiles created by older builds where the default was still false.
      if (Number(parsed.schemaVersion) < 13) {
        parsed.autoStart = true;
        this.needsWrite = true;
      }
      // Version 14 applies the user's explicit request to stop launching
      // YachiyoDesk with Windows. This migration also clears profiles that had
      // inherited the former default instead of requiring a manual toggle.
      if (Number(parsed.schemaVersion) < 14) {
        parsed.autoStart = false;
        this.needsWrite = true;
      }
      // Version 15 restores login startup after the user reversed the earlier
      // version-14 request. Apply it once to every existing profile so a stale
      // false value cannot silently remove the Windows login entry again.
      if (Number(parsed.schemaVersion) < 15) {
        parsed.autoStart = true;
        this.needsWrite = true;
      }
      const sanitized = sanitizeSettings(parsed);
      if (!Number.isFinite(parsed.schemaVersion) || parsed.schemaVersion < DEFAULT_SETTINGS.schemaVersion) {
        this.needsWrite = true;
      }
      return sanitized;
    } catch {
      this.needsWrite = true;
      return sanitizeSettings();
    }
  }

  get() {
    return structuredClone(this.data);
  }

  patch(patch) {
    this.data = sanitizeSettings({ ...this.data, ...patch });
    this.#write();
    return this.get();
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    commitTemporaryFile(temporaryPath, this.filePath);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SettingsStore,
  commitTemporaryFile,
  sanitizeSettings,
  sanitizeWindow,
};
