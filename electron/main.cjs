'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  protocol,
  screen,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SettingsStore } = require('./settings.cjs');
const { calculateDragPosition, clampDragPosition } = require('./window-drag.cjs');
const { PMX_CONVERTED_MOTION_PROFILE, sanitizeMotionProfile } = require('./motion-profile.cjs');
const { convertPmxToVrm, resolvePmxConverter } = require('./pmx-converter.cjs');

// A packaged GUI can outlive the terminal/launcher pipe that started it.
// Windows then reports EPIPE on console output; without stream listeners that
// error reaches uncaughtException, whose own log attempt creates a recursion.
// File logging remains available, while a detached console is safely ignored.
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

const IS_DEV = process.argv.includes('--dev');
const IS_SMOKE = process.argv.includes('--smoke-test');
const IS_SOAK = process.argv.includes('--soak-test');
const IS_MOTION_TEST = process.argv.includes('--motion-test');
const IS_FLICKER_TEST = process.argv.includes('--flicker-test');
const IS_INTERACTION_TEST = process.argv.includes('--interaction-test');
const IS_AUTOMATED_TEST = IS_SMOKE || IS_SOAK || IS_MOTION_TEST || IS_FLICKER_TEST || IS_INTERACTION_TEST;
const APP_NAME = 'YachiyoDesk';
const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 840;
const USER_INACTIVITY_RESUME_MS = 15000;
const AUTONOMY_ACTION_DURATION_MS = Object.freeze({
  greet: 3600,
  joy: 3000,
  sleepy: 3600,
  bow: 3100,
  stretch: 4200,
  dance: 6400,
  lookAround: 4600,
  nod: 2500,
  shakeHead: 2800,
  shy: 3800,
  cheer: 4800,
  think: 5200,
  crouch: 4400,
  tiptoe: 3800,
  sway: 6200,
});
const DEFAULT_BEHAVIOR_PROFILE = Object.freeze({
  minIntervalSeconds: 6,
  maxIntervalSeconds: 12,
  actions: Object.freeze([
    Object.freeze({ action: 'walk', weight: 40 }),
    Object.freeze({ action: 'lookAround', weight: 16 }),
    Object.freeze({ action: 'stretch', weight: 12 }),
    Object.freeze({ action: 'bow', weight: 8 }),
    Object.freeze({ action: 'dance', weight: 8 }),
    Object.freeze({ action: 'nod', weight: 6 }),
    Object.freeze({ action: 'shakeHead', weight: 4 }),
    Object.freeze({ action: 'shy', weight: 6 }),
    Object.freeze({ action: 'think', weight: 8 }),
    Object.freeze({ action: 'crouch', weight: 6 }),
    Object.freeze({ action: 'tiptoe', weight: 6 }),
    Object.freeze({ action: 'sway', weight: 10 }),
    Object.freeze({ action: 'cheer', weight: 5 }),
  ]),
});
const ALLOWED_BEHAVIOR_ACTIONS = new Set([
  'walk', 'greet', 'joy', 'sleepy', 'bow', 'stretch', 'dance', 'lookAround',
  'nod', 'shakeHead', 'shy', 'cheer', 'think', 'crouch', 'tiptoe', 'sway',
]);
const SMOKE_ARTIFACTS = process.env.YACHIYO_DESK_SMOKE_DIR
  ? path.resolve(process.env.YACHIYO_DESK_SMOKE_DIR)
  : app.isPackaged
    ? path.join(app.getPath('temp'), 'YachiyoDesk-smoke')
    : path.join(__dirname, '..', 'artifacts');

if (IS_AUTOMATED_TEST) {
  app.setPath('userData', path.join(SMOKE_ARTIFACTS, 'test-profile'));
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appasset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;
let tray = null;
let settingsStore = null;
let isQuitting = false;
let smokeTimer = null;
let boundsSaveTimer = null;
let logFile = null;
let latestRuntimeTelemetry = null;
let windowDrag = null;
let windowDragTimer = null;
let autonomyTimer = null;
let autonomyMoveTimer = null;
let autonomyMove = null;
let lastAutonomousAction = null;
let walksSinceInterlude = 0;
let nextInterludeAfterWalks = 3;
let patrolDirection = -1;
let interactionPanelOpen = false;
let runtimeIsReady = false;
let lastUserActivityAt = 0;
let focusTimer = null;
let focusState = {
  running: false,
  mode: 'focus',
  totalSeconds: 25 * 60,
  endAt: 0,
  sessionsCompleted: 0,
};
let petStates = {};
let petStateTimer = null;

function log(level, message, extra) {
  const suffix = extra === undefined
    ? ''
    : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      // Logging must never crash the companion.
    }
  }
}

function projectRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function bundledCharactersRoot() {
  return path.join(projectRoot(), 'characters');
}

function characterRoot() {
  return path.join(bundledCharactersRoot(), 'yachiyo');
}

function userCharactersRoot() {
  return path.join(app.getPath('userData'), 'characters');
}

function prepareSmokeCharacter() {
  if (!IS_SMOKE) return;
  const id = 'smoke-local';
  const directory = path.join(userCharactersRoot(), id);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(characterRoot(), 'model.vrm'), path.join(directory, 'model.vrm'));
  const manifest = {
    id,
    displayName: '本地测试角色',
    originalTitle: 'Automated local character',
    creator: 'YachiyoDesk 自动验证',
    sourceFileName: 'smoke-model.vrm',
    model: 'model.vrm',
    credit: '自动化角色库验证',
    messages: genericMessages('本地测试角色'),
  };
  fs.writeFileSync(path.join(directory, 'character.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  settingsStore.patch({ activeCharacterId: id });
}

function isSafeCharacterId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

function genericMessages(displayName) {
  return {
    greet: [`你好，我是${displayName}。`],
    joy: ['今天心情不错。'],
    surprised: ['欸？发生什么了？'],
    head: ['这样有一点痒……'],
    body: ['呀！突然怎么了？'],
    lower: ['不要一直戳这里啦。'],
    angry: ['再闹的话，我真的要生气了哦。'],
    sleepy: ['有一点困了……'],
    poke: ['嗯？'],
    bow: ['请多关照。'],
    stretch: ['嗯——稍微活动一下。'],
    dance: ['跟上节拍吧。'],
    lookAround: ['今天桌面上有什么新鲜事呢？'],
    idleChat: [
      '今天桌面上有什么新鲜事呢？',
      '忙了这么久，要不要稍微伸个懒腰？',
      '我会在这里陪着你，慢慢来就好。',
      '刚才是不是有个窗口悄悄闪过去了？',
      '今天也整理得很有你的风格呢。',
    ],
    nod: ['嗯，我在听。'],
    shakeHead: ['唔，不是这样。'],
    shy: ['别、别一直看着我……'],
    cheer: ['好耶！'],
    think: ['让我想一想……'],
    crouch: ['稍微下蹲休息一下。'],
    tiptoe: ['再高一点就能看见了。'],
    sway: ['跟着节奏晃一晃。'],
    focusComplete: ['辛苦了，这一轮完成得很好。'],
    breakComplete: ['休息结束啦，要继续吗？'],
  };
}

function sanitizeBehaviorProfile(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  const minimum = Math.max(5, Math.min(180, Number(candidate.minIntervalSeconds) || DEFAULT_BEHAVIOR_PROFILE.minIntervalSeconds));
  const maximum = Math.max(minimum, Math.min(300, Number(candidate.maxIntervalSeconds) || DEFAULT_BEHAVIOR_PROFILE.maxIntervalSeconds));
  const actions = [];
  const seen = new Set();
  if (Array.isArray(candidate.actions)) {
    for (const item of candidate.actions) {
      const action = typeof item?.action === 'string' ? item.action : '';
      const weight = Number(item?.weight);
      if (!ALLOWED_BEHAVIOR_ACTIONS.has(action) || seen.has(action) || !Number.isFinite(weight) || weight <= 0) continue;
      seen.add(action);
      actions.push({ action, weight: Math.min(100, weight) });
    }
  }
  return {
    minIntervalSeconds: minimum,
    maxIntervalSeconds: maximum,
    actions: actions.length > 0
      ? actions
      : DEFAULT_BEHAVIOR_PROFILE.actions.map((item) => ({ ...item })),
  };
}

function readCharacterManifest(directory, id, builtIn) {
  const manifestPath = path.join(directory, 'character.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const displayName = typeof manifest.displayName === 'string' && manifest.displayName.trim()
    ? manifest.displayName.trim()
    : id;
  return {
    id,
    displayName,
    originalTitle: manifest.originalTitle || displayName,
    creator: manifest.creator || '本地导入',
    model: 'model.vrm',
    credit: manifest.credit || `${displayName} · 本地模型`,
    sourceFileName: manifest.sourceFileName,
    sourceFormat: manifest.sourceFormat === 'pmx' ? 'pmx' : 'vrm',
    messages: {
      ...genericMessages(displayName),
      ...(manifest.messages && typeof manifest.messages === 'object' ? manifest.messages : {}),
    },
    behavior: sanitizeBehaviorProfile(manifest.behavior),
    motionProfile: sanitizeMotionProfile(manifest.motionProfile, { id, builtIn }),
    builtIn,
  };
}

function characterRecord(id) {
  if (!isSafeCharacterId(id)) return null;
  if (id === 'yachiyo') {
    try {
      const manifest = readCharacterManifest(characterRoot(), id, true);
      const modelPath = path.join(characterRoot(), 'model.vrm');
      return {
        manifest,
        // The public distribution intentionally omits the author's model file
        // because its terms prohibit redistribution. Keep the manifest usable
        // so the first-run UI can guide the user to import a locally licensed
        // VRM/PMX instead of crashing during bootstrap.
        modelUrl: fs.existsSync(modelPath) ? 'appasset://characters/yachiyo/model.vrm' : null,
        directory: characterRoot(),
      };
    } catch (error) {
      log('ERROR', 'Bundled character manifest failed', String(error));
      return null;
    }
  }
  const directory = path.resolve(userCharactersRoot(), id);
  const root = path.resolve(userCharactersRoot());
  if (!directory.startsWith(`${root}${path.sep}`)) return null;
  try {
    if (!fs.statSync(path.join(directory, 'model.vrm')).isFile()) return null;
    const manifest = readCharacterManifest(directory, id, false);
    return { manifest, modelUrl: `appasset://user-characters/${id}/model.vrm`, directory };
  } catch {
    return null;
  }
}

function installedCharacters() {
  const settings = settingsStore.get();
  const records = [];
  const bundled = characterRecord('yachiyo');
  if (bundled) records.push(bundled);
  const root = userCharactersRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeCharacterId(entry.name)) continue;
      const record = characterRecord(entry.name);
      if (record) records.push(record);
    }
  } catch (error) {
    log('ERROR', 'Could not enumerate local characters', String(error));
  }
  return records.map(({ manifest }) => ({
    id: manifest.id,
    displayName: manifest.displayName,
    creator: manifest.creator,
    sourceFileName: manifest.sourceFileName,
    sourceFormat: manifest.sourceFormat,
    builtIn: manifest.builtIn,
    active: manifest.id === settings.activeCharacterId,
    motionProfileId: manifest.motionProfile.profileId,
  }));
}

function activeCharacterRecord() {
  const activeId = settingsStore.get().activeCharacterId;
  const record = characterRecord(activeId) || characterRecord('yachiyo');
  if (!record) throw new Error('Bundled Yachiyo character is unavailable.');
  if (record.manifest.id !== activeId) settingsStore.patch({ activeCharacterId: 'yachiyo' });
  return record;
}

function inspectVrmFile(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size < 20 || stats.size > 512 * 1024 * 1024) {
    throw new Error('VRM 文件大小无效，支持范围为 20 字节到 512 MB。');
  }
  const handle = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(20);
    fs.readSync(handle, header, 0, 20, 0);
    if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2) {
      throw new Error('文件不是有效的 VRM/GLB 2.0。');
    }
    const declaredLength = header.readUInt32LE(8);
    const jsonLength = header.readUInt32LE(12);
    const jsonType = header.readUInt32LE(16);
    if (declaredLength > stats.size || jsonType !== 0x4E4F534A || jsonLength <= 2 || jsonLength > 64 * 1024 * 1024) {
      throw new Error('VRM 文件头或 JSON 数据块无效。');
    }
    const jsonBuffer = Buffer.alloc(jsonLength);
    fs.readSync(handle, jsonBuffer, 0, jsonLength, 20);
    const json = JSON.parse(jsonBuffer.toString('utf8').replace(/\u0000+$/g, '').trim());
    const vrm0 = json.extensions?.VRM;
    const vrm1 = json.extensions?.VRMC_vrm;
    if (!vrm0 && !vrm1 && !json.extensionsUsed?.some((name) => name === 'VRM' || name === 'VRMC_vrm')) {
      throw new Error('该 GLB 文件没有 VRM 扩展。');
    }
    const meta = vrm0?.meta || vrm1?.meta || {};
    const displayName = meta.title || meta.name || path.parse(filePath).name;
    const creator = meta.author || (Array.isArray(meta.authors) ? meta.authors.join('、') : '') || '本地导入';
    return { displayName: String(displayName).slice(0, 80), creator: String(creator).slice(0, 120) };
  } finally {
    fs.closeSync(handle);
  }
}

function stableExecutablePath() {
  const portableWrapper = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableWrapper) {
    // In this local build the unpacked executable sits beside the portable
    // artifact. Prefer it for persistent shortcuts and login startup: launching
    // the portable wrapper twice can make its second cleanup remove resources
    // still used by the first extracted Electron process.
    const unpackedExecutable = path.join(path.dirname(portableWrapper), 'win-unpacked', 'YachiyoDesk.exe');
    if (fs.existsSync(unpackedExecutable)) return unpackedExecutable;
    return portableWrapper;
  }
  return process.execPath;
}

function createDesktopShortcut() {
  if (!app.isPackaged) return { ok: false, error: '开发模式不会创建桌面快捷方式。' };
  try {
    const target = stableExecutablePath();
    const shortcutPath = path.join(app.getPath('desktop'), 'YachiyoDesk - 八千代.lnk');
    const ok = shell.writeShortcutLink(shortcutPath, 'create', {
      target,
      cwd: path.dirname(target),
      icon: target,
      iconIndex: 0,
      description: 'YachiyoDesk 3D 桌面伴侣',
    });
    return ok ? { ok: true, path: shortcutPath } : { ok: false, error: 'Windows 未能写入快捷方式。' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function resolveAsset(requestUrl) {
  const url = new URL(requestUrl);
  const isUserCharacter = url.hostname === 'user-characters';
  const relative = decodeURIComponent(path.join(...url.pathname.split('/').filter(Boolean)));
  const root = path.resolve(isUserCharacter ? userCharactersRoot() : projectRoot());
  const resourceRelative = isUserCharacter ? relative : path.join(url.hostname, relative);
  const resolved = path.resolve(root, resourceRelative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Asset path escaped the application resource directory.');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Asset does not exist: ${resourceRelative}`);
  }
  return resolved;
}

async function registerAssetProtocol() {
  await protocol.handle('appasset', async (request) => {
    try {
      const assetPath = resolveAsset(request.url);
      const body = await fs.promises.readFile(assetPath);
      const extension = path.extname(assetPath).toLowerCase();
      const contentTypes = {
        '.vrm': 'model/gltf-binary',
        '.glb': 'model/gltf-binary',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
      };
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentTypes[extension] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (error) {
      log('ERROR', 'Asset request failed', String(error));
      return new Response('Not found', { status: 404 });
    }
  });
}

function defaultBounds() {
  const displayBounds = screen.getPrimaryDisplay().bounds;
  const width = Math.min(DEFAULT_WIDTH, displayBounds.width);
  const height = Math.min(DEFAULT_HEIGHT, displayBounds.height);
  return {
    width,
    height,
    x: displayBounds.x + displayBounds.width - width,
    y: displayBounds.y + displayBounds.height - height,
  };
}

function isBoundsVisible(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x));
    const overlapHeight = Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y));
    return overlapWidth >= 100 && overlapHeight >= 100;
  });
}

function fixedSurfaceBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  return {
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

function restoredBounds() {
  // Autonomous companions always enter from the physical bottom-right so the
  // first frame is predictable even if the previous session ended mid-walk.
  // A deliberately locked/non-autonomous pet keeps its manually saved place.
  const settings = settingsStore.get();
  if (settings.autonomousBehavior && !settings.lockPosition) return defaultBounds();
  const saved = settingsStore.get().window;
  const fixed = fixedSurfaceBounds(saved);
  return fixed && isBoundsVisible(fixed) ? fixed : defaultBounds();
}

function sendCommand(command, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:command', { command, payload });
  }
}

function focusStatePath() {
  return path.join(app.getPath('userData'), 'focus-state.json');
}

function publicFocusState() {
  return {
    running: focusState.running,
    mode: focusState.mode,
    totalSeconds: focusState.totalSeconds,
    remainingSeconds: focusState.running
      ? Math.max(0, Math.ceil((focusState.endAt - Date.now()) / 1000))
      : focusState.totalSeconds,
    sessionsCompleted: focusState.sessionsCompleted,
  };
}

function persistFocusState() {
  try {
    fs.writeFileSync(focusStatePath(), `${JSON.stringify(focusState, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('ERROR', 'Could not persist focus timer', String(error));
  }
}

function emitFocusState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus:changed', publicFocusState());
  }
}

function stopFocusTimer(resetRemaining = true) {
  clearInterval(focusTimer);
  focusTimer = null;
  focusState.running = false;
  if (resetRemaining) focusState.endAt = 0;
  persistFocusState();
  emitFocusState();
  return publicFocusState();
}

function completeFocusTimer() {
  const completedMode = focusState.mode;
  clearInterval(focusTimer);
  focusTimer = null;
  focusState.running = false;
  focusState.endAt = 0;
  if (completedMode === 'focus') focusState.sessionsCompleted += 1;
  persistFocusState();
  emitFocusState();
  sendCommand('focus-complete', { mode: completedMode });
  if (Notification.isSupported()) {
    const title = completedMode === 'focus' ? '专注完成' : '休息结束';
    const body = completedMode === 'focus' ? '辛苦了，和八千代一起休息一下吧。' : '休息好了，准备开始下一轮。';
    new Notification({ title, body, silent: false }).show();
  }
}

function startFocusTimer(mode, minutes) {
  const safeMode = mode === 'break' ? 'break' : 'focus';
  const safeMinutes = Math.max(1, Math.min(180, Number(minutes) || (safeMode === 'focus' ? 25 : 5)));
  clearInterval(focusTimer);
  focusState = {
    ...focusState,
    running: true,
    mode: safeMode,
    totalSeconds: Math.round(safeMinutes * 60),
    endAt: Date.now() + Math.round(safeMinutes * 60 * 1000),
  };
  persistFocusState();
  emitFocusState();
  focusTimer = setInterval(() => {
    if (focusState.endAt <= Date.now()) completeFocusTimer();
    else emitFocusState();
  }, 1000);
  sendCommand('reaction', safeMode === 'focus' ? 'nod' : 'stretch');
  return publicFocusState();
}

function restoreFocusTimer() {
  try {
    const saved = JSON.parse(fs.readFileSync(focusStatePath(), 'utf8'));
    focusState = {
      running: Boolean(saved.running) && Number(saved.endAt) > Date.now(),
      mode: saved.mode === 'break' ? 'break' : 'focus',
      totalSeconds: Math.max(60, Math.min(10800, Number(saved.totalSeconds) || 1500)),
      endAt: Number(saved.endAt) || 0,
      sessionsCompleted: Math.max(0, Math.floor(Number(saved.sessionsCompleted) || 0)),
    };
    if (focusState.running) {
      focusTimer = setInterval(() => {
        if (focusState.endAt <= Date.now()) completeFocusTimer();
        else emitFocusState();
      }, 1000);
    }
  } catch {
    // First run has no timer state yet.
  }
}

function petStatePath() {
  return path.join(app.getPath('userData'), 'pet-state.json');
}

function clampStat(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function defaultPetState() {
  return { hunger: 82, energy: 88, happiness: 86, affection: 35, updatedAt: Date.now() };
}

function applyPetDecay(state) {
  const now = Date.now();
  const elapsedHours = Math.max(0, Math.min(720, (now - (Number(state.updatedAt) || now)) / 3600000));
  state.hunger = clampStat(state.hunger - elapsedHours * 0.72);
  state.energy = clampStat(state.energy - elapsedHours * 0.30);
  state.happiness = clampStat(state.happiness - elapsedHours * 0.20);
  state.affection = clampStat(state.affection);
  state.updatedAt = now;
  return state;
}

function currentPetState() {
  const id = settingsStore.get().activeCharacterId;
  const existing = petStates[id] && typeof petStates[id] === 'object' ? petStates[id] : defaultPetState();
  petStates[id] = applyPetDecay(existing);
  return { ...petStates[id] };
}

function persistPetStates() {
  try {
    fs.writeFileSync(petStatePath(), `${JSON.stringify({ characters: petStates }, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('ERROR', 'Could not persist companion status', String(error));
  }
}

function emitPetState() {
  const status = currentPetState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet:status-changed', status);
  return status;
}

function restorePetStates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(petStatePath(), 'utf8'));
    petStates = parsed.characters && typeof parsed.characters === 'object' ? parsed.characters : {};
  } catch {
    petStates = {};
  }
  petStateTimer = setInterval(() => {
    emitPetState();
    persistPetStates();
  }, 60000);
}

function interactWithPet(action) {
  const id = settingsStore.get().activeCharacterId;
  const state = currentPetState();
  const effects = {
    snack: { hunger: 12, energy: 1, happiness: 3, affection: 0.5, reaction: 'joy' },
    meal: { hunger: 28, energy: 3, happiness: 5, affection: 1, reaction: 'joy' },
    drink: { hunger: 7, energy: 2, happiness: 2, affection: 0.3, reaction: 'nod' },
    play: { hunger: -3, energy: -6, happiness: 15, affection: 2.5, reaction: 'dance' },
    rest: { hunger: -1, energy: 18, happiness: 3, affection: 0.5, reaction: 'sleepy' },
    praise: { hunger: 0, energy: 0, happiness: 7, affection: 3, reaction: 'shy' },
  };
  const effect = effects[action];
  if (!effect) return state;
  state.hunger = clampStat(state.hunger + effect.hunger);
  state.energy = clampStat(state.energy + effect.energy);
  state.happiness = clampStat(state.happiness + effect.happiness);
  state.affection = clampStat(state.affection + effect.affection);
  state.updatedAt = Date.now();
  petStates[id] = state;
  persistPetStates();
  sendCommand('reaction', effect.reaction);
  emitPetState();
  return { ...state };
}

function notifySettings(settings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', settings);
  }
  rebuildTrayMenu();
}

function applySettings(settings) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  mainWindow.setVisibleOnAllWorkspaces(settings.alwaysOnTop, { visibleOnFullScreen: false });
  if (!settings.clickThrough) mainWindow.setIgnoreMouseEvents(false);
  applyAutoStart(settings.autoStart);
}

function patchSettings(patch) {
  const settings = settingsStore.patch(patch);
  applySettings(settings);
  notifySettings(settings);
  if (!settings.autonomousBehavior || settings.lockPosition) {
    stopAutonomousMovement();
    clearTimeout(autonomyTimer);
    autonomyTimer = null;
  } else if (runtimeIsReady && !IS_AUTOMATED_TEST) {
    scheduleAutonomy(8000);
  }
  return settings;
}

function applyAutoStart(enabled) {
  if (!app.isPackaged || IS_SMOKE) return;
  const loginPath = stableExecutablePath();
  const current = app.getLoginItemSettings({ path: loginPath });
  if (current.openAtLogin !== enabled) {
    app.setLoginItemSettings({ openAtLogin: enabled, path: loginPath });
    log('INFO', 'Login startup setting updated', {
      enabled,
      path: loginPath,
      openAtLogin: app.getLoginItemSettings({ path: loginPath }).openAtLogin,
    });
  }
}

function resetWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  stopAutonomousMovement(false);
  const bounds = defaultBounds();
  mainWindow.setBounds(bounds, false);
  const clamped = clampCurrentWindowToDisplay() || bounds;
  settingsStore.patch({ window: clamped });
  return clamped;
}

function clampCurrentWindowToDisplay(anchorPoint) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const bounds = mainWindow.getBounds();
  const point = anchorPoint && Number.isFinite(Number(anchorPoint.x)) && Number.isFinite(Number(anchorPoint.y))
    ? { x: Math.round(Number(anchorPoint.x)), y: Math.round(Number(anchorPoint.y)) }
    : { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  const display = screen.getDisplayNearestPoint(point);
  const target = clampDragPosition(bounds, display.bounds, { width: bounds.width, height: bounds.height });
  if (!target) return fixedSurfaceBounds(bounds);
  if (target.x !== bounds.x || target.y !== bounds.y) {
    mainWindow.setBounds({ x: target.x, y: target.y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, false);
  }
  return { x: target.x, y: target.y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function randomRange(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function stopAutonomousMovement(persist = true, faceViewer = false) {
  if (autonomyMoveTimer) clearInterval(autonomyMoveTimer);
  autonomyMoveTimer = null;
  const wasMoving = Boolean(autonomyMove);
  autonomyMove = null;
  if (wasMoving || faceViewer) {
    sendCommand('autonomy', { action: 'idle' });
  }
  if (wasMoving) {
    if (persist && mainWindow && !mainWindow.isDestroyed()) {
      settingsStore.patch({ window: fixedSurfaceBounds(mainWindow.getBounds()) });
    }
  }
}

function scheduleAutonomy(delayMs) {
  clearTimeout(autonomyTimer);
  autonomyTimer = null;
  if ((IS_AUTOMATED_TEST && !IS_INTERACTION_TEST) || !runtimeIsReady || !settingsStore) return;
  const settings = settingsStore.get();
  if (!settings.autonomousBehavior || settings.lockPosition) return;
  if (interactionPanelOpen) return;
  autonomyTimer = setTimeout(runAutonomousBehavior, Math.max(120, delayMs ?? 450));
}

function noteUserActivity() {
  lastUserActivityAt = Date.now();
  clearTimeout(autonomyTimer);
  autonomyTimer = null;
  // Pointer-down is the hard interrupt. Stop the native walk immediately and
  // send an idle command even if a timer, rather than a walk, was active so the
  // avatar starts damping back toward the viewer in this same interaction.
  stopAutonomousMovement(true, true);
  if (!interactionPanelOpen) scheduleAutonomy(USER_INACTIVITY_RESUME_MS);
}

function setInteractionPanelOpen(open) {
  interactionPanelOpen = Boolean(open);
  lastUserActivityAt = Date.now();
  clearTimeout(autonomyTimer);
  autonomyTimer = null;
  stopAutonomousMovement(true, true);
  if (!interactionPanelOpen) scheduleAutonomy(USER_INACTIVITY_RESUME_MS);
}

function startAutonomousWalk() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const settings = settingsStore.get();
  const bounds = mainWindow.getBounds();
  const currentDisplay = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  });
  const displayBounds = currentDisplay.bounds;
  const minimumX = displayBounds.x;
  const maximumX = displayBounds.x + Math.max(0, displayBounds.width - bounds.width);
  if (maximumX - minimumX < 100) return false;

  let direction = settings.wanderMode === 'random'
    ? (Math.random() < 0.5 ? -1 : 1)
    : patrolDirection;
  if (bounds.x <= minimumX + 80) direction = 1;
  if (bounds.x >= maximumX - 80) direction = -1;
  if (settings.wanderMode === 'patrol') patrolDirection = direction;
  const available = direction > 0 ? maximumX - bounds.x : bounds.x - minimumX;
  const distance = Math.min(available, randomRange(
    settings.wanderMode === 'patrol' ? 280 : 180,
    settings.wanderMode === 'patrol' ? 500 : 520,
  ));
  if (distance < 70) return false;

  const floorY = Math.round(displayBounds.y + displayBounds.height - bounds.height);
  if (bounds.y !== floorY) {
    mainWindow.setBounds({ x: bounds.x, y: floorY, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, false);
  }
  const startX = bounds.x;
  const startY = floorY;
  const targetX = Math.round(startX + direction * distance);
  const targetY = startY;
  const motionProfile = activeCharacterRecord().manifest.motionProfile;
  const effectiveSpeed = Math.max(12, settings.wanderSpeed * motionProfile.walk.speedScale);
  const durationMs = Math.max(3200, distance / effectiveSpeed * 1000);
  const startedAt = Date.now();
  autonomyMove = {
    startX,
    startY,
    targetX,
    targetY,
    startedAt,
    durationMs,
    effectiveSpeed,
    width: bounds.width,
    height: bounds.height,
  };
  log('INFO', 'Autonomous walk started', {
    from: { x: startX, y: startY },
    to: { x: targetX, y: targetY },
    durationMs,
    display: {
      id: currentDisplay.id,
      scaleFactor: currentDisplay.scaleFactor,
      bounds: displayBounds,
      wanderMode: settings.wanderMode,
    },
  });
  sendCommand('autonomy', { action: 'walk', direction, duration: durationMs / 1000 });

  autonomyMoveTimer = setInterval(() => {
    if (!autonomyMove || !mainWindow || mainWindow.isDestroyed()) {
      stopAutonomousMovement(false);
      return;
    }
    const progress = Math.min(1, (Date.now() - autonomyMove.startedAt) / autonomyMove.durationMs);
    const eased = 0.5 - Math.cos(progress * Math.PI) * 0.5;
    const x = Math.round(autonomyMove.startX + (autonomyMove.targetX - autonomyMove.startX) * eased);
    const y = autonomyMove.startY;
    const [currentX, currentY] = mainWindow.getPosition();
    if (x !== currentX || y !== currentY) {
      // Electron's setPosition() can accidentally re-convert the existing
      // transparent HWND size on fractional Windows DPI (observed at 150%),
      // making the pet grow a few pixels on every move. Supplying the complete
      // fixed rectangle turns this into an explicit move-without-resize.
      try {
        mainWindow.setBounds({
          x: Math.trunc(x),
          y: Math.trunc(y),
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        }, false);
        const movedBounds = mainWindow.getBounds();
        if (Math.abs(movedBounds.width - DEFAULT_WIDTH) > 8
          || Math.abs(movedBounds.height - DEFAULT_HEIGHT) > 8) {
          log('ERROR', 'Native window size drift detected during autonomous walk', {
            expected: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
            actual: movedBounds,
          });
          // Recover exactly once and stop this walk. Continuously resizing a
          // transparent window would itself produce the flash we are avoiding.
          mainWindow.setBounds({
            x: movedBounds.x,
            y: movedBounds.y,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
          }, false);
          stopAutonomousMovement(true);
          scheduleAutonomy(1200);
          return;
        }
      } catch (error) {
        log('ERROR', 'Autonomous native window move failed', String(error));
        stopAutonomousMovement(false);
        scheduleAutonomy(1200);
        return;
      }
    }
    if (progress >= 1) {
      stopAutonomousMovement();
      lastAutonomousAction = 'walk';
      walksSinceInterlude += 1;
      if (settingsStore.get().wanderMode === 'patrol') patrolDirection = direction;
      if (walksSinceInterlude >= nextInterludeAfterWalks) runAutonomousInterlude();
      else scheduleAutonomy(randomRange(320, 760));
    }
  }, 16);
  return true;
}

function chooseAutonomousInterlude() {
  const pet = currentPetState();
  let forcedAction = null;
  if (pet.energy < 20 && Math.random() < 0.72) forcedAction = 'sleepy';
  else if (pet.happiness < 24 && Math.random() < 0.55) forcedAction = 'shy';
  if (forcedAction) return forcedAction;
  const actions = activeCharacterRecord().manifest.behavior.actions
    .filter((item) => item.action !== 'walk')
    .map((item) => ({
    ...item,
    effectiveWeight: item.weight * (item.action === lastAutonomousAction ? 0.16 : 1),
  }));
  const totalWeight = actions.reduce((sum, item) => sum + item.effectiveWeight, 0);
  let cursor = Math.random() * totalWeight;
  for (const item of actions) {
    cursor -= item.effectiveWeight;
    if (cursor <= 0) return item.action;
  }
  return actions.at(-1)?.action || 'lookAround';
}

function runAutonomousInterlude() {
  if (interactionPanelOpen) return;
  const action = chooseAutonomousInterlude();
  lastAutonomousAction = action;
  walksSinceInterlude = 0;
  const frequency = settingsStore.get().activityFrequency || 1;
  nextInterludeAfterWalks = Math.max(1, Math.round(randomRange(2, 4) / frequency));
  const durationMs = AUTONOMY_ACTION_DURATION_MS[action] || 4200;
  log('INFO', 'Autonomous walk interlude selected', { action, durationMs, nextInterludeAfterWalks });
  sendCommand('autonomous-reaction', action);
  const talkativeAction = ['lookAround', 'think', 'nod', 'sway'].includes(action);
  if (Math.random() < (talkativeAction ? 0.72 : 0.28)) sendCommand('speech', 'idleChat');
  scheduleAutonomy(durationMs + 220);
}

function runAutonomousBehavior() {
  autonomyTimer = null;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || windowDrag) {
    scheduleAutonomy(1200);
    return;
  }
  const settings = settingsStore.get();
  if (!settings.autonomousBehavior || settings.lockPosition || interactionPanelOpen) return;
  const inactiveFor = Date.now() - lastUserActivityAt;
  if (lastUserActivityAt > 0 && inactiveFor < USER_INACTIVITY_RESUME_MS) {
    scheduleAutonomy(USER_INACTIVITY_RESUME_MS - inactiveFor);
    return;
  }
  if (!startAutonomousWalk()) scheduleAutonomy(1200);
}

function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || IS_SMOKE || windowDrag || autonomyMove) return;
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const fixed = fixedSurfaceBounds(mainWindow.getBounds());
      settingsStore.patch({ window: fixed });
    }
  }, 250);
}

function toggleSetting(key) {
  const current = settingsStore.get();
  patchSettings({ [key]: !current[key] });
}

function switchCharacter(id) {
  const record = characterRecord(id);
  if (!record) return { ok: false, error: '角色不存在或文件已损坏。' };
  settingsStore.patch({ activeCharacterId: id });
  notifySettings(settingsStore.get());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.webContents.reloadIgnoringCache();
  }
  return { ok: true };
}

function characterSubmenu() {
  const characters = installedCharacters();
  return [
    ...characters.map((character) => ({
      label: `${character.active ? '✓ ' : ''}${character.displayName}`,
      enabled: !character.active,
      click: () => switchCharacter(character.id),
    })),
    { type: 'separator' },
    { label: '导入或管理角色…', click: () => sendCommand('show-characters') },
  ];
}

function settingsSubmenu(settings) {
  return [
    { label: '鼠标视线跟随', type: 'checkbox', checked: settings.mouseLook, click: () => toggleSetting('mouseLook') },
    { label: '头发与衣物物理', type: 'checkbox', checked: settings.physics, click: () => toggleSetting('physics') },
    { label: '呼吸与待机动作', type: 'checkbox', checked: settings.idleMotion, click: () => toggleSetting('idleMotion') },
    { label: '屏幕底部自主活动', type: 'checkbox', checked: settings.autonomousBehavior, click: () => toggleSetting('autonomousBehavior') },
    { label: '点击反应', type: 'checkbox', checked: settings.reactions, click: () => toggleSetting('reactions') },
    { label: '对白气泡', type: 'checkbox', checked: settings.speech, click: () => toggleSetting('speech') },
    { label: '脚下柔和阴影', type: 'checkbox', checked: settings.contactShadow, click: () => toggleSetting('contactShadow') },
    { label: '自动流畅度优化', type: 'checkbox', checked: settings.adaptivePerformance, click: () => toggleSetting('adaptivePerformance') },
    { type: 'separator' },
    { label: '透明区域穿透点击', type: 'checkbox', checked: settings.clickThrough, click: () => toggleSetting('clickThrough') },
    { label: '锁定当前位置', type: 'checkbox', checked: settings.lockPosition, click: () => toggleSetting('lockPosition') },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: () => toggleSetting('alwaysOnTop') },
    { label: '开机自动启动', type: 'checkbox', checked: settings.autoStart, click: () => toggleSetting('autoStart') },
  ];
}

function qualitySubmenu(settings) {
  return [
    { label: '极致（最高画质）', type: 'radio', checked: settings.quality === 'ultra', click: () => patchSettings({ quality: 'ultra' }) },
    { label: '高（较低显存占用）', type: 'radio', checked: settings.quality === 'high', click: () => patchSettings({ quality: 'high' }) },
    { label: '均衡（低功耗）', type: 'radio', checked: settings.quality === 'balanced', click: () => patchSettings({ quality: 'balanced' }) },
  ];
}

function contextTemplate() {
  const settings = settingsStore.get();
  const activeName = activeCharacterRecord().manifest.displayName;
  return [
    { label: `和${activeName}打招呼`, click: () => sendCommand('reaction', 'greet') },
    { label: '切换开心表情', click: () => sendCommand('reaction', 'joy') },
    { label: '切换惊讶表情', click: () => sendCommand('reaction', 'surprised') },
    { type: 'separator' },
    { label: '详细设置…', click: () => sendCommand('show-settings') },
    { label: '切换角色', submenu: characterSubmenu() },
    { label: '画质', submenu: qualitySubmenu(settings) },
    { label: '功能开关', submenu: settingsSubmenu(settings) },
    { type: 'separator' },
    { label: '恢复默认姿态', click: () => sendCommand('reset-pose') },
    { label: '恢复默认位置', click: () => resetWindowPosition() },
    { label: '打开配置与日志目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '创建桌面快捷方式', click: () => createDesktopShortcut() },
    { type: 'separator' },
    { label: `隐藏${activeName}`, click: () => mainWindow.hide() },
    { label: '退出 YachiyoDesk', click: () => quitApplication() },
  ];
}

function showContextMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setInteractionPanelOpen(true);
  mainWindow.setIgnoreMouseEvents(false);
  Menu.buildFromTemplate(contextTemplate()).popup({
    window: mainWindow,
    callback: () => setInteractionPanelOpen(false),
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const settings = settingsStore.get();
  const activeName = activeCharacterRecord().manifest.displayName;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示${activeName}`, click: () => { mainWindow.showInactive(); mainWindow.setAlwaysOnTop(settings.alwaysOnTop); } },
    { label: `隐藏${activeName}`, click: () => mainWindow.hide() },
    { type: 'separator' },
    { label: '详细设置…', click: () => { mainWindow.showInactive(); sendCommand('show-settings'); } },
    { label: '切换角色', submenu: characterSubmenu() },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: () => toggleSetting('alwaysOnTop') },
    { label: '锁定当前位置', type: 'checkbox', checked: settings.lockPosition, click: () => toggleSetting('lockPosition') },
    { label: '开机自动启动', type: 'checkbox', checked: settings.autoStart, click: () => toggleSetting('autoStart') },
    { type: 'separator' },
    { label: '恢复默认位置', click: () => resetWindowPosition() },
    { label: '创建桌面快捷方式', click: () => createDesktopShortcut() },
    { label: '退出', click: () => quitApplication() },
  ]));
}

function createTray() {
  const iconPath = path.join(characterRoot(), 'thumbnail.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(icon);
  tray.setToolTip(`YachiyoDesk · ${activeCharacterRecord().manifest.displayName}`);
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.showInactive();
  });
  rebuildTrayMenu();
}

function flushWindowDrag() {
  windowDragTimer = null;
  if (!windowDrag || !mainWindow || mainWindow.isDestroyed() || settingsStore.get().lockPosition) return;
  const rawPosition = calculateDragPosition(windowDrag);
  if (!rawPosition) return;
  const currentBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(windowDrag.screenX),
    y: Math.round(windowDrag.screenY),
  });
  const position = clampDragPosition(rawPosition, display.bounds, {
    width: currentBounds.width,
    height: currentBounds.height,
  });
  if (!position) return;
  const { x, y } = position;
  const [currentX, currentY] = mainWindow.getPosition();
  if (x !== currentX || y !== currentY) {
    // Use the same DPI-safe full rectangle as autonomous walking. Both paths
    // previously called setPosition(), so both exhibited the same resize flash.
    mainWindow.setBounds({ x, y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, false);
  }
}

function scheduleWindowDragFlush() {
  if (windowDragTimer) return;
  // Keep one native window move per compositor frame. The renderer already
  // coalesces raw mouse packets, so a second 8 ms scheduler only duplicates
  // transparent-surface paints and can produce visible flashing on Windows.
  windowDragTimer = setTimeout(flushWindowDrag, 16);
}

function beginWindowDrag(point) {
  if (!mainWindow || mainWindow.isDestroyed() || settingsStore.get().lockPosition) return;
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  noteUserActivity();
  const [windowX, windowY] = mainWindow.getPosition();
  windowDrag = { originScreenX: screenX, originScreenY: screenY, screenX, screenY, windowX, windowY };
}

function updateWindowDrag(point, finish = false) {
  if (!windowDrag) return;
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  if (Number.isFinite(screenX)) windowDrag.screenX = screenX;
  if (Number.isFinite(screenY)) windowDrag.screenY = screenY;
  if (finish) {
    clearTimeout(windowDragTimer);
    windowDragTimer = null;
    flushWindowDrag();
    windowDrag = null;
    persistWindowBounds();
    noteUserActivity();
  } else {
    scheduleWindowDragFlush();
  }
}

async function createWindow() {
  const settings = settingsStore.get();
  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 300,
    minHeight: 460,
    show: false,
    icon: path.join(characterRoot(), 'thumbnail.png'),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    // Electron otherwise keeps WS_THICKFRAME even on a frameless Windows
    // window. Besides adding four invisible DIPs, that style enables native
    // resize animations which are especially noticeable on transparent pets.
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Keep a normal Windows taskbar entry in addition to the tray icon. The
    // previous true value deliberately hid the window and looked like a bug.
    skipTaskbar: false,
    alwaysOnTop: settings.alwaysOnTop,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  mainWindow.setVisibleOnAllWorkspaces(settings.alwaysOnTop, { visibleOnFullScreen: false });

  mainWindow.on('move', persistWindowBounds);
  mainWindow.on('resize', persistWindowBounds);
  mainWindow.on('closed', () => {
    clearTimeout(windowDragTimer);
    windowDragTimer = null;
    windowDrag = null;
    clearTimeout(autonomyTimer);
    autonomyTimer = null;
    stopAutonomousMovement(false);
    runtimeIsReady = false;
    mainWindow = null;
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', 'Renderer process exited unexpectedly', details);
    if (IS_AUTOMATED_TEST) app.exit(1);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log('ERROR', 'Renderer page failed to load', { errorCode, errorDescription });
  });

  if (IS_DEV) await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Chromium can create a frameless HWND a few DIPs larger than requested
  // while its non-client style is being finalised. Canonicalise it only while
  // hidden, after the page has loaded, so the first visible frame and all
  // subsequent position-only moves share exactly the same native surface.
  const initialBounds = fixedSurfaceBounds(mainWindow.getBounds());
  mainWindow.setBounds(initialBounds, false);
  const clampedInitialBounds = clampCurrentWindowToDisplay() || initialBounds;
  settingsStore.patch({ window: clampedInitialBounds });
  log('INFO', 'Native companion surface initialised', {
    requested: clampedInitialBounds,
    actual: mainWindow.getBounds(),
  });
  mainWindow.showInactive();
}

function bindIpc() {
  ipcMain.handle('app:get-bootstrap', () => {
    const active = activeCharacterRecord();
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      smokeTest: IS_AUTOMATED_TEST,
      modelUrl: active.modelUrl,
      setupRequired: !active.modelUrl,
      character: active.manifest,
      settings: settingsStore.get(),
    };
  });

  ipcMain.handle('settings:update', (_event, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return settingsStore.get();
    return patchSettings(patch);
  });

  ipcMain.on('window:set-click-through', (_event, ignore) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const settings = settingsStore.get();
    mainWindow.setIgnoreMouseEvents(settings.clickThrough && Boolean(ignore), { forward: true });
  });

  ipcMain.on('window:drag-start', (_event, point) => beginWindowDrag(point));
  ipcMain.on('window:drag-move', (_event, point) => updateWindowDrag(point));
  ipcMain.on('window:drag-end', (_event, point) => updateWindowDrag(point, true));
  ipcMain.on('autonomy:activity', () => noteUserActivity());
  ipcMain.on('autonomy:panel', (_event, open) => setInteractionPanelOpen(open));

  ipcMain.on('window:context-menu', () => showContextMenu());
  ipcMain.handle('window:reset', () => resetWindowPosition());
  ipcMain.handle('app:open-data-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:create-desktop-shortcut', () => createDesktopShortcut());
  ipcMain.handle('focus:get', () => publicFocusState());
  ipcMain.handle('focus:start', (_event, request) => startFocusTimer(request?.mode, request?.minutes));
  ipcMain.handle('focus:stop', () => stopFocusTimer());
  ipcMain.handle('pet:get-status', () => currentPetState());
  ipcMain.handle('pet:interact', (_event, action) => interactWithPet(action));
  ipcMain.handle('characters:list', () => installedCharacters());
  ipcMain.handle('characters:switch', (_event, id) => switchCharacter(id));
  ipcMain.handle('characters:import', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地 VRM 角色',
      buttonLabel: '导入角色',
      properties: ['openFile'],
      filters: [{ name: 'VRM 角色模型', extensions: ['vrm'] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    let importDirectory = null;
    try {
      const sourcePath = selection.filePaths[0];
      const metadata = inspectVrmFile(sourcePath);
      const rawBase = path.parse(sourcePath).name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 38) || 'character';
      const id = `${rawBase}-${Date.now().toString(36)}`.slice(0, 63);
      const root = userCharactersRoot();
      const directory = path.resolve(root, id);
      if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('角色目录不安全。');
      importDirectory = directory;
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(directory, 'model.vrm'));
      const manifest = {
        id,
        displayName: metadata.displayName,
        originalTitle: metadata.displayName,
        creator: metadata.creator,
        sourceFileName: path.basename(sourcePath),
        model: 'model.vrm',
        credit: `${metadata.displayName} · ${metadata.creator}`,
        messages: genericMessages(metadata.displayName),
        behavior: sanitizeBehaviorProfile(),
      };
      fs.writeFileSync(path.join(directory, 'character.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      rebuildTrayMenu();
      const character = installedCharacters().find((item) => item.id === id);
      log('INFO', 'Imported local character', { id, sourceFileName: path.basename(sourcePath) });
      return { canceled: false, character };
    } catch (error) {
      if (importDirectory && importDirectory.startsWith(`${path.resolve(userCharactersRoot())}${path.sep}`)) {
        try { fs.rmSync(importDirectory, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
      }
      log('ERROR', 'Character import failed', String(error?.stack || error));
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '角色导入失败',
        message: '无法导入这个 VRM 文件',
        detail: String(error?.message || error),
      });
      return { canceled: false };
    }
  });
  ipcMain.handle('characters:import-pmx', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '导入并转换本地 PMX 角色',
      buttonLabel: '转换并导入',
      properties: ['openFile'],
      filters: [{ name: 'MikuMikuDance PMX 模型', extensions: ['pmx'] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    let importDirectory = null;
    try {
      const sourcePath = selection.filePaths[0];
      const rawBase = path.parse(sourcePath).name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 38) || 'pmx-character';
      const id = `${rawBase}-${Date.now().toString(36)}`.slice(0, 63);
      const root = userCharactersRoot();
      const directory = path.resolve(root, id);
      if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('角色目录不安全。');
      importDirectory = directory;
      fs.mkdirSync(directory, { recursive: true });
      const outputPath = path.join(directory, 'model.vrm');
      const reportPath = path.join(directory, 'conversion-report.json');
      const conversion = await convertPmxToVrm({
        sourcePath,
        outputPath,
        reportPath,
        converter: resolvePmxConverter({
          moduleDirectory: __dirname,
          resourcesPath: process.resourcesPath,
          portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
        }),
      });
      const metadata = inspectVrmFile(outputPath);
      const manifest = {
        id,
        displayName: metadata.displayName,
        originalTitle: metadata.displayName,
        creator: metadata.creator,
        sourceFileName: path.basename(sourcePath),
        sourceFormat: 'pmx',
        model: 'model.vrm',
        credit: `${metadata.displayName} · 本机 PMX 自动转换`,
        messages: genericMessages(metadata.displayName),
        behavior: sanitizeBehaviorProfile(),
        motionProfile: PMX_CONVERTED_MOTION_PROFILE,
      };
      fs.writeFileSync(path.join(directory, 'character.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      rebuildTrayMenu();
      const character = installedCharacters().find((item) => item.id === id);
      log('INFO', 'Converted and imported local PMX character', {
        id,
        sourceFileName: path.basename(sourcePath),
        armatureBones: conversion.report.armatureBones,
        springBones: conversion.report.springBones,
      });
      return { canceled: false, character };
    } catch (error) {
      if (importDirectory && importDirectory.startsWith(`${path.resolve(userCharactersRoot())}${path.sep}`)) {
        try { fs.rmSync(importDirectory, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
      }
      log('ERROR', 'PMX character conversion/import failed', String(error?.stack || error));
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'PMX 导入失败',
        message: '无法把这个 PMX 转换为可用角色',
        detail: String(error?.message || error),
      });
      return { canceled: false };
    }
  });
  ipcMain.handle('characters:remove', async (_event, id) => {
    if (!isSafeCharacterId(id) || id === 'yachiyo') return { ok: false, error: '内置八千代不能删除。' };
    const record = characterRecord(id);
    if (!record || record.manifest.builtIn) return { ok: false, error: '角色不存在。' };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', '删除本地角色'],
      defaultId: 0,
      cancelId: 0,
      title: '删除本地角色',
      message: `确定删除“${record.manifest.displayName}”吗？`,
      detail: '只会删除导入到 YachiyoDesk 角色库中的副本，不会删除原始 VRM 文件。',
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    const wasActive = settingsStore.get().activeCharacterId === id;
    fs.rmSync(record.directory, { recursive: true, force: false });
    if (wasActive) settingsStore.patch({ activeCharacterId: 'yachiyo' });
    rebuildTrayMenu();
    if (wasActive && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    return { ok: true };
  });

  ipcMain.on('runtime:ready', async (_event, details) => {
    log('INFO', 'Avatar runtime ready', details);
    runtimeIsReady = true;
    if (IS_INTERACTION_TEST) {
      await runInteractionTimingTest(details);
      return;
    }
    if (!IS_AUTOMATED_TEST) scheduleAutonomy(350);
    if (!IS_AUTOMATED_TEST || !mainWindow || mainWindow.isDestroyed()) return;
    clearTimeout(smokeTimer);
    if (IS_SOAK) {
      await runSoakTest(details);
      return;
    }
    if (IS_MOTION_TEST) {
      await runMotionTest(details);
      return;
    }
    if (IS_FLICKER_TEST) {
      await runFlickerTest(details);
      return;
    }
    try {
      // Wait until the opening greeting has fully blended out so the screenshot
      // also validates the neutral arm pose and settled spring bones.
      await new Promise((resolve) => setTimeout(resolve, 4300));
      const artifacts = SMOKE_ARTIFACTS;
      fs.mkdirSync(artifacts, { recursive: true });
      const image = await mainWindow.webContents.capturePage();
      const screenshotPath = path.join(artifacts, 'yachiyo-smoke.png');
      fs.writeFileSync(screenshotPath, image.toPNG());

      // Exercise the same coalesced absolute-position path used by pointer drag.
      // The target is calculated from a fixed origin, which avoids cumulative
      // IPC rounding and limits native window movement to one update per frame.
      const dragStartBounds = mainWindow.getBounds();
      const { x: dragStartX, y: dragStartY } = dragStartBounds;
      beginWindowDrag({ screenX: 500, screenY: 500 });
      updateWindowDrag({ screenX: 460, screenY: 475 });
      await new Promise((resolve) => setTimeout(resolve, 40));
      updateWindowDrag({ screenX: 460, screenY: 475 }, true);
      const dragEndBounds = mainWindow.getBounds();
      const { x: dragEndX, y: dragEndY } = dragEndBounds;
      const dragTest = {
        start: { x: dragStartX, y: dragStartY },
        end: { x: dragEndX, y: dragEndY },
        expected: { x: dragStartX - 40, y: dragStartY - 25 },
        startSize: { width: dragStartBounds.width, height: dragStartBounds.height },
        endSize: { width: dragEndBounds.width, height: dragEndBounds.height },
        passed: dragEndX === dragStartX - 40
          && dragEndY === dragStartY - 25
          && Math.abs(dragEndBounds.width - DEFAULT_WIDTH) <= 2
          && Math.abs(dragEndBounds.height - DEFAULT_HEIGHT) <= 2,
      };
      mainWindow.setBounds({
        x: dragStartX,
        y: dragStartY,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      }, false);
      if (!dragTest.passed) throw new Error(`Window drag mismatch: ${JSON.stringify(dragTest)}`);

      const focusStarted = startFocusTimer('focus', 1);
      const focusStopped = stopFocusTimer();
      const focusTest = {
        started: focusStarted.running && focusStarted.remainingSeconds > 0,
        stopped: !focusStopped.running,
      };
      const petBefore = currentPetState();
      const petAfter = interactWithPet('meal');
      const petTest = {
        beforeHunger: petBefore.hunger,
        afterHunger: petAfter.hunger,
        passed: petAfter.hunger >= petBefore.hunger,
      };
      if (!focusTest.started || !focusTest.stopped || !petTest.passed) {
        throw new Error(`Feature state test failed: ${JSON.stringify({ focusTest, petTest })}`);
      }

      sendCommand('show-settings');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settingsImage = await mainWindow.webContents.capturePage();
      const settingsScreenshotPath = path.join(artifacts, 'settings-smoke.png');
      fs.writeFileSync(settingsScreenshotPath, settingsImage.toPNG());

      const panelScreenshots = { general: settingsScreenshotPath };
      for (const [index, pageName] of [[1, 'actions'], [2, 'focus'], [3, 'characters'], [4, 'performance']]) {
        await mainWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.control-tab')[${index}]?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, pageName === 'characters' ? 500 : 180));
        const pageImage = await mainWindow.webContents.capturePage();
        const pagePath = path.join(artifacts, `${pageName}-smoke.png`);
        fs.writeFileSync(pagePath, pageImage.toPNG());
        panelScreenshots[pageName] = pagePath;
      }

      // Validate the two dismissal paths requested by the desktop UI: an
      // action selection closes immediately, and a pointer press outside the
      // panel closes without requiring the X button.
      sendCommand('show-settings');
      await new Promise((resolve) => setTimeout(resolve, 220));
      await mainWindow.webContents.executeJavaScript(
        `document.querySelectorAll('.control-tab')[1]?.click(); document.querySelector('.action-button')?.click()`,
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 260));
      const actionAutoClosed = await mainWindow.webContents.executeJavaScript(
        `document.querySelector('#settings-panel')?.hidden === true`,
        true,
      );

      sendCommand('show-settings');
      await new Promise((resolve) => setTimeout(resolve, 220));
      await mainWindow.webContents.executeJavaScript(
        `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }))`,
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 260));
      const outsideClickClosed = await mainWindow.webContents.executeJavaScript(
        `document.querySelector('#settings-panel')?.hidden === true`,
        true,
      );

      await mainWindow.webContents.executeJavaScript(
        `document.body.classList.add('companion-dock-open')`,
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
      const dockImage = await mainWindow.webContents.capturePage();
      const dockScreenshotPath = path.join(artifacts, 'companion-dock-smoke.png');
      fs.writeFileSync(dockScreenshotPath, dockImage.toPNG());
      const dockState = await mainWindow.webContents.executeJavaScript(
        `({ actions: document.querySelectorAll('#dock-actions button').length,
            stats: document.querySelectorAll('#dock-status > div').length,
            visible: getComputedStyle(document.querySelector('#companion-dock')).opacity === '1' })`,
        true,
      );
      await mainWindow.webContents.executeJavaScript(
        `document.body.classList.remove('companion-dock-open')`,
        true,
      );
      const uiTest = {
        actionAutoClosed: Boolean(actionAutoClosed),
        outsideClickClosed: Boolean(outsideClickClosed),
        dockActions: Number(dockState?.actions),
        dockStats: Number(dockState?.stats),
        dockVisible: Boolean(dockState?.visible),
        passed: Boolean(actionAutoClosed)
          && Boolean(outsideClickClosed)
          && Number(dockState?.actions) === 6
          && Number(dockState?.stats) === 4
          && Boolean(dockState?.visible),
      };
      if (!uiTest.passed) throw new Error(`Companion UI test failed: ${JSON.stringify(uiTest)}`);
      fs.writeFileSync(
        path.join(artifacts, 'smoke-diagnostics.json'),
        `${JSON.stringify({
          ok: true,
          timestamp: new Date().toISOString(),
          details,
          dragTest,
          focusTest,
          petTest,
          uiTest,
          screenshotPath,
          settingsScreenshotPath,
          dockScreenshotPath,
          panelScreenshots,
        }, null, 2)}\n`,
        'utf8',
      );
      log('INFO', 'Smoke test passed', { screenshotPath });
      app.exit(0);
    } catch (error) {
      log('ERROR', 'Smoke test capture failed', String(error));
      app.exit(1);
    }
  });

  ipcMain.on('runtime:telemetry', (_event, details) => {
    if (!details || typeof details !== 'object') return;
    latestRuntimeTelemetry = details;
  });

  ipcMain.on('runtime:error', (_event, details) => {
    log('ERROR', 'Avatar runtime error', details);
    if (IS_AUTOMATED_TEST) {
      const artifacts = SMOKE_ARTIFACTS;
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(
        path.join(artifacts, 'smoke-diagnostics.json'),
        `${JSON.stringify({ ok: false, timestamp: new Date().toISOString(), details }, null, 2)}\n`,
        'utf8',
      );
      app.exit(1);
    }
  });
}

async function runInteractionTimingTest(details) {
  const artifacts = SMOKE_ARTIFACTS;
  fs.mkdirSync(artifacts, { recursive: true });
  const sample = (label) => ({ label, at: Date.now(), bounds: mainWindow.getBounds() });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const initial = sample('initial');
    const display = screen.getDisplayNearestPoint({
      x: initial.bounds.x + initial.bounds.width / 2,
      y: initial.bounds.y + initial.bounds.height / 2,
    });
    if (!startAutonomousWalk()) throw new Error('Initial walk did not start.');
    await new Promise((resolve) => setTimeout(resolve, 900));
    const walking = sample('walking');
    setInteractionPanelOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const stopped = sample('panel-open-stopped');
    setInteractionPanelOpen(false);
    const closedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after5Seconds = sample('after-close-5s');
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const after14Seconds = sample('after-close-14s');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after17Seconds = sample('after-close-17s');
    stopAutonomousMovement(false);
    sendCommand('test-hide-overlays', true);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const image = await mainWindow.webContents.capturePage();
    const pixels = visiblePixelBounds(image);
    const screenshotPath = path.join(artifacts, 'interaction-floor.png');
    fs.writeFileSync(screenshotPath, image.toPNG());

    const expectedRight = display.bounds.x + display.bounds.width;
    const expectedBottom = display.bounds.y + display.bounds.height;
    const positionTolerance = 2;
    const startsBottomRight = Math.abs(initial.bounds.x + initial.bounds.width - expectedRight) <= positionTolerance
      && Math.abs(initial.bounds.y + initial.bounds.height - expectedBottom) <= positionTolerance;
    const movedBeforeStop = walking.bounds.x !== initial.bounds.x;
    const stationaryUntil15Seconds = stopped.bounds.x === after5Seconds.bounds.x
      && stopped.bounds.x === after14Seconds.bounds.x;
    const resumedAfter15Seconds = after17Seconds.bounds.x !== after14Seconds.bounds.x;
    const feetReachCanvasBottom = Boolean(pixels)
      && pixels.y + pixels.height >= image.getSize().height - 2;
    const result = {
      ok: startsBottomRight && movedBeforeStop && stationaryUntil15Seconds
        && resumedAfter15Seconds && feetReachCanvasBottom,
      timestamp: new Date().toISOString(),
      details,
      displayBounds: display.bounds,
      startsBottomRight,
      movedBeforeStop,
      stationaryUntil15Seconds,
      resumedAfter15Seconds,
      feetReachCanvasBottom,
      cooldownMeasuredFrom: closedAt,
      samples: [initial, walking, stopped, after5Seconds, after14Seconds, after17Seconds],
      visiblePixels: pixels,
      screenshotPath,
    };
    fs.writeFileSync(
      path.join(artifacts, 'interaction-diagnostics.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    if (!result.ok) throw new Error(`Interaction timing test failed: ${JSON.stringify(result)}`);
    log('INFO', 'Interaction timing test completed', result);
    app.exit(0);
  } catch (error) {
    log('ERROR', 'Interaction timing test failed', String(error?.stack || error));
    app.exit(1);
  }
}

async function runSoakTest(details) {
  const artifacts = SMOKE_ARTIFACTS;
  fs.mkdirSync(artifacts, { recursive: true });
  const requestedSeconds = Number(process.env.YACHIYO_DESK_SOAK_SECONDS);
  const durationSeconds = Number.isFinite(requestedSeconds)
    ? Math.max(15, Math.min(600, requestedSeconds))
    : 60;
  const samples = [];
  try {
    for (let elapsed = 0; elapsed <= durationSeconds; elapsed += 5) {
      const metrics = app.getAppMetrics();
      const totalWorkingSetMb = metrics.reduce(
        (sum, metric) => sum + (metric.memory?.workingSetSize || 0) / 1024,
        0,
      );
      samples.push({
        elapsedSeconds: elapsed,
        processCount: metrics.length,
        totalWorkingSetMb: Number(totalWorkingSetMb.toFixed(2)),
        renderer: latestRuntimeTelemetry,
        processes: metrics.map((metric) => ({
          type: metric.type,
          cpuPercent: Number((metric.cpu?.percentCPUUsage || 0).toFixed(2)),
          workingSetMb: Number(((metric.memory?.workingSetSize || 0) / 1024).toFixed(2)),
        })),
      });
      if (elapsed < durationSeconds) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const initialMemory = samples[0].totalWorkingSetMb;
    const finalMemory = samples[samples.length - 1].totalWorkingSetMb;
    const memoryGrowthMb = Number((finalMemory - initialMemory).toFixed(2));
    const maximumMemoryMb = Math.max(...samples.map((sample) => sample.totalWorkingSetMb));
    const image = await mainWindow.webContents.capturePage();
    const screenshotPath = path.join(artifacts, 'soak-final.png');
    fs.writeFileSync(screenshotPath, image.toPNG());
    const ok = memoryGrowthMb < 220 && maximumMemoryMb < 1600;
    fs.writeFileSync(
      path.join(artifacts, 'soak-diagnostics.json'),
      `${JSON.stringify({
        ok,
        timestamp: new Date().toISOString(),
        durationSeconds,
        memoryGrowthMb,
        maximumMemoryMb: Number(maximumMemoryMb.toFixed(2)),
        details,
        screenshotPath,
        samples,
      }, null, 2)}\n`,
      'utf8',
    );
    log(ok ? 'INFO' : 'ERROR', 'Soak test completed', { durationSeconds, memoryGrowthMb, maximumMemoryMb });
    app.exit(ok ? 0 : 1);
  } catch (error) {
    log('ERROR', 'Soak test failed', String(error?.stack || error));
    app.exit(1);
  }
}

function visiblePixelBounds(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return null;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * 4 + 3];
      if (alpha <= 10) continue;
      if (x < minimumX) minimumX = x;
      if (x > maximumX) maximumX = x;
      if (y < minimumY) minimumY = y;
      if (y > maximumY) maximumY = y;
    }
  }
  if (maximumX < minimumX || maximumY < minimumY) return null;
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
}

function visibleSizeRatio(boundsList) {
  const valid = boundsList.filter(Boolean);
  if (valid.length < 2) return Number.POSITIVE_INFINITY;
  const widths = valid.map((bounds) => bounds.width);
  const heights = valid.map((bounds) => bounds.height);
  return Number(Math.max(
    Math.max(...widths) / Math.max(1, Math.min(...widths)),
    Math.max(...heights) / Math.max(1, Math.min(...heights)),
  ).toFixed(4));
}

function sampledAlphaCount(image, stride = 3) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  let count = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (bitmap[(y * width + x) * 4 + 3] > 10) count += 1;
    }
  }
  return count;
}

async function runFlickerTest(details) {
  const artifacts = SMOKE_ARTIFACTS;
  fs.mkdirSync(artifacts, { recursive: true });
  const samples = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 4500));
    sendCommand('test-hide-overlays', true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    for (let index = 0; index < 180; index += 1) {
      const image = await mainWindow.webContents.capturePage();
      const alphaCount = sampledAlphaCount(image);
      samples.push({
        index,
        alphaCount,
        bounds: mainWindow.getBounds(),
      });
      if (index === 0 || index === 90 || index === 179) {
        fs.writeFileSync(path.join(artifacts, `flicker-frame-${index}.png`), image.toPNG());
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    const nonBlankCounts = samples.map((sample) => sample.alphaCount).filter((count) => count > 0);
    const blankFrames = samples.length - nonBlankCounts.length;
    const alphaRatio = nonBlankCounts.length > 0
      ? Math.max(...nonBlankCounts) / Math.max(1, Math.min(...nonBlankCounts))
      : Number.POSITIVE_INFINITY;
    const nativeBounds = new Set(samples.map((sample) => JSON.stringify(sample.bounds)));
    const result = {
      ok: blankFrames === 0 && alphaRatio <= 1.18 && nativeBounds.size === 1,
      timestamp: new Date().toISOString(),
      details,
      blankFrames,
      alphaRatio: Number(alphaRatio.toFixed(4)),
      uniqueNativeBounds: nativeBounds.size,
      minimumAlphaSamples: Math.min(...nonBlankCounts),
      maximumAlphaSamples: Math.max(...nonBlankCounts),
      frames: samples.length,
      telemetry: latestRuntimeTelemetry,
    };
    fs.writeFileSync(path.join(artifacts, 'flicker-diagnostics.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (!result.ok) throw new Error(`Flicker stability test failed: ${JSON.stringify(result)}`);
    log('INFO', 'Flicker stability test completed', result);
    app.exit(0);
  } catch (error) {
    log('ERROR', 'Flicker stability test failed', String(error?.stack || error));
    app.exit(1);
  }
}

async function runMotionTest(details) {
  const artifacts = SMOKE_ARTIFACTS;
  fs.mkdirSync(artifacts, { recursive: true });
  const screenshots = {};
  const poseSnapshots = {};
  const requestedCaptureZoom = Number(process.env.YACHIYO_DESK_MOTION_ZOOM);
  if (Number.isFinite(requestedCaptureZoom) && requestedCaptureZoom >= 0.10 && requestedCaptureZoom <= 1.8) {
    patchSettings({ zoom: requestedCaptureZoom });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const requestedRotationY = Number(process.env.YACHIYO_DESK_MOTION_ROTATION_Y);
  if (Number.isFinite(requestedRotationY) && Math.abs(requestedRotationY) <= Math.PI * 2) {
    patchSettings({ rotationY: requestedRotationY });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const allMotions = [
    { name: 'greet', sampleAt: 1.50, duration: 3.60 },
    { name: 'joy', sampleAt: 1.30, duration: 3.00 },
    { name: 'surprised', sampleAt: 0.65, duration: 1.90 },
    { name: 'angry', sampleAt: 1.25, duration: 2.90 },
    { name: 'sleepy', sampleAt: 1.70, duration: 3.60 },
    { name: 'poke', sampleAt: 0.48, duration: 1.25 },
    { name: 'bow', sampleAt: 1.35, duration: 3.10 },
    { name: 'stretch', sampleAt: 1.75, duration: 4.20 },
    { name: 'dance', sampleAt: 2.05, duration: 6.40 },
    { name: 'lookAround', sampleAt: 2.05, duration: 4.60 },
    { name: 'nod', sampleAt: 1.15, duration: 2.50 },
    { name: 'shakeHead', sampleAt: 1.25, duration: 2.80 },
    { name: 'shy', sampleAt: 1.65, duration: 3.80 },
    { name: 'cheer', sampleAt: 1.35, duration: 4.80 },
    { name: 'think', sampleAt: 2.10, duration: 5.20 },
    { name: 'crouch', sampleAt: 1.80, duration: 4.40 },
    { name: 'tiptoe', sampleAt: 1.55, duration: 3.80 },
    { name: 'sway', sampleAt: 2.15, duration: 6.20 },
  ];
  const motionOnly = String(process.env.YACHIYO_DESK_MOTION_ONLY || '').trim();
  const motions = motionOnly
    ? allMotions.filter((motion) => motionOnly.split(',').includes(motion.name))
    : allMotions;
  try {
    // The runtime starts with one greeting. Let it complete before sampling the
    // neutral idle pose so each following reaction begins from a settled rig.
    // Greeting remains visible for 3.3 s and its CSS exit transition needs a
    // little more time. Waiting here keeps speech UI out of alpha-bound checks.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    // Keep UI chrome out of the alpha bounds used to detect accidental camera
    // scaling. capturePage() includes speech bubbles and toasts, which are much
    // wider than a 15% avatar and would otherwise look like model growth.
    sendCommand('test-hide-overlays', true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const idleImage = await mainWindow.webContents.capturePage();
    const idleBounds = visiblePixelBounds(idleImage);
    screenshots.idle = path.join(artifacts, 'motion-idle.png');
    fs.writeFileSync(screenshots.idle, idleImage.toPNG());

    const walkStart = mainWindow.getPosition();
    if (!startAutonomousWalk()) throw new Error('Autonomous walk could not find a valid desktop destination.');
    const walkFrames = [];
    const walkPoseFrames = [];
    let walkImage = null;
    for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
      await new Promise((resolve) => setTimeout(resolve, 240));
      const frame = await mainWindow.webContents.capturePage();
      const bounds = visiblePixelBounds(frame);
      walkFrames.push({ elapsedMs: (frameIndex + 1) * 240, bounds });
      const pose = await mainWindow.webContents.executeJavaScript(
        'window.__desktopPetPoseSnapshot?.() ?? null',
        true,
      );
      walkPoseFrames.push({ elapsedMs: (frameIndex + 1) * 240, pose });
      if (frameIndex === 2) walkImage = frame;
    }
    if (!walkImage) throw new Error('Autonomous walk did not produce a capture frame.');
    screenshots.walk = path.join(artifacts, 'motion-walk.png');
    fs.writeFileSync(screenshots.walk, walkImage.toPNG());
    const walkEnd = mainWindow.getPosition();
    const inMotionSizeRatio = visibleSizeRatio(walkFrames.map((frame) => frame.bounds));
    const blankCaptureCount = walkFrames.filter((frame) => !frame.bounds).length;
    const walkTest = {
      start: { x: walkStart[0], y: walkStart[1] },
      sampled: { x: walkEnd[0], y: walkEnd[1] },
      frameBounds: walkFrames,
      poseFrames: walkPoseFrames,
      footMotionRange: 0,
      inMotionSizeRatio,
      blankCaptureCount,
      finalBounds: null,
      settledSizeRatio: null,
      passed: false,
    };
    stopAutonomousMovement(false);
    mainWindow.setBounds({
      x: walkStart[0],
      y: walkStart[1],
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    }, false);
    await new Promise((resolve) => setTimeout(resolve, 420));
    const settledWalkImage = await mainWindow.webContents.capturePage();
    walkTest.finalBounds = visiblePixelBounds(settledWalkImage);
    walkTest.settledSizeRatio = visibleSizeRatio([idleBounds, walkTest.finalBounds]);
    const footSamples = walkPoseFrames
      .map((frame) => frame.pose)
      .filter((pose) => pose && typeof pose === 'object');
    const footComponentRanges = [];
    for (const boneName of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
      for (const component of ['rx', 'ry', 'rz']) {
        const values = footSamples
          .map((pose) => Number(pose[boneName]?.[component]))
          .filter((value) => Number.isFinite(value));
        if (values.length > 1) footComponentRanges.push(Math.max(...values) - Math.min(...values));
      }
    }
    if (footComponentRanges.length > 0) walkTest.footMotionRange = Math.max(...footComponentRanges);
    walkTest.passed = walkStart[0] !== walkEnd[0]
      && walkTest.settledSizeRatio <= 1.08
      && walkTest.footMotionRange >= 0.01;
    if (!walkTest.passed) throw new Error(`Autonomous walk did not move the window: ${JSON.stringify(walkTest)}`);

    for (const motion of motions) {
      sendCommand('reaction', motion.name);
      await new Promise((resolve) => setTimeout(resolve, motion.sampleAt * 1000));
      const image = await mainWindow.webContents.capturePage();
      const screenshotPath = path.join(artifacts, `motion-${motion.name}.png`);
      fs.writeFileSync(screenshotPath, image.toPNG());
      screenshots[motion.name] = screenshotPath;
      poseSnapshots[motion.name] = await mainWindow.webContents.executeJavaScript(
        'window.__desktopPetPoseSnapshot?.() ?? null',
        true,
      );
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.max(250, (motion.duration - motion.sampleAt + 0.25) * 1000),
      ));
    }

    sendCommand('test-drag', true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const raisedImage = await mainWindow.webContents.capturePage();
    screenshots.raised = path.join(artifacts, 'motion-raised.png');
    fs.writeFileSync(screenshots.raised, raisedImage.toPNG());
    sendCommand('test-drag', false);
    await new Promise((resolve) => setTimeout(resolve, 650));

    fs.writeFileSync(
      path.join(artifacts, 'motion-diagnostics.json'),
      `${JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
        details,
        telemetry: latestRuntimeTelemetry,
        walkTest,
        poseSnapshots,
        screenshots,
      }, null, 2)}\n`,
      'utf8',
    );
    log('INFO', 'Motion test completed', { screenshots });
    app.exit(0);
  } catch (error) {
    log('ERROR', 'Motion test failed', String(error?.stack || error));
    app.exit(1);
  }
}

function quitApplication() {
  isQuitting = true;
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(settingsStore.get().alwaysOnTop);
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('local.yachiyodesk.app');
    const logDirectory = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    logFile = path.join(logDirectory, 'YachiyoDesk.log');
    settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    restoreFocusTimer();
    restorePetStates();
    prepareSmokeCharacter();
    await registerAssetProtocol();
    bindIpc();
    await createWindow();
    createTray();
    if (app.isPackaged && !IS_AUTOMATED_TEST) {
      const shortcut = createDesktopShortcut();
      log(shortcut.ok ? 'INFO' : 'ERROR', 'Desktop shortcut result', shortcut);
    }
    applySettings(settingsStore.get());
    log('INFO', 'Application started', { version: app.getVersion(), packaged: app.isPackaged });

    if (IS_AUTOMATED_TEST) {
      smokeTimer = setTimeout(() => {
        log('ERROR', 'Automated test timed out before renderer became ready');
        app.exit(1);
      }, IS_MOTION_TEST ? 140000 : 30000);
    }
  }).catch((error) => {
    log('ERROR', 'Fatal startup error', String(error?.stack || error));
    app.exit(1);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(smokeTimer);
  clearTimeout(boundsSaveTimer);
  clearTimeout(autonomyTimer);
  stopAutonomousMovement(false);
  clearInterval(focusTimer);
  clearInterval(petStateTimer);
  persistPetStates();
});

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught main-process exception', String(error?.stack || error));
});

process.on('unhandledRejection', (error) => {
  log('ERROR', 'Unhandled main-process rejection', String(error?.stack || error));
});
