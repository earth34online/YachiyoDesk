import './style.css';
import { AppUI } from './AppUI';
import { AvatarRuntime } from './AvatarRuntime';
import { InteractionController } from './InteractionController';
import type { AppSettings, AutonomyCommand, ReactionName } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) throw new Error('渲染画布不存在。');

const bootstrap = await window.yachiyoDesk.getBootstrap();
const DEFAULT_CHARACTER_ZOOM = 0.35;
let currentSettings = bootstrap.settings;
let runtime: AvatarRuntime;
let interaction: InteractionController;

async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  currentSettings = await window.yachiyoDesk.updateSettings(patch);
  runtime.setSettings(currentSettings);
  interaction.setSettings(currentSettings);
  ui.updateSettings(currentSettings);
}

function previewSettingsPatch(patch: Partial<AppSettings>): void {
  const preview = { ...currentSettings, ...patch };
  runtime.setSettings(preview);
  interaction.setSettings(preview);
}

function triggerReaction(reaction: ReactionName, speechKey: string = reaction): void {
  window.yachiyoDesk.noteUserActivity();
  runtime.triggerReaction(reaction);
  ui.showSpeech(speechKey);
}

const ui = new AppUI(currentSettings, bootstrap.character, {
  onSettingsPatch: (patch) => { void applySettingsPatch(patch); },
  onSettingsPreview: previewSettingsPatch,
  onCloseSettings: () => interaction.reevaluateClickThrough(),
  onResetPose: () => {
    runtime.resetPose();
    void applySettingsPatch({ zoom: DEFAULT_CHARACTER_ZOOM, rotationY: 0 });
    ui.showToast('已恢复默认姿态');
  },
  onResetWindow: () => {
    void window.yachiyoDesk.resetWindow().then(() => ui.showToast('已恢复默认位置'));
  },
  onReaction: triggerReaction,
});

runtime = new AvatarRuntime(canvas, bootstrap, {
  onProgress: (percent, detail) => ui.setLoading(percent, detail),
  onReady: (diagnostics) => {
    ui.finishLoading();
    interaction.reevaluateClickThrough();
    window.yachiyoDesk.runtimeReady(diagnostics);
  },
  onFatal: (error) => {
    ui.showFatal(error);
    window.yachiyoDesk.setClickThrough(false);
    window.yachiyoDesk.runtimeError({ message: error.message, stack: error.stack });
  },
  onSetupRequired: () => ui.showSetupRequired(),
});

interaction = new InteractionController(canvas, runtime, ui, currentSettings);
document.querySelector<HTMLButtonElement>('#setup-open-characters')?.addEventListener('click', () => {
  ui.showSettings('characters');
});
if (bootstrap.smokeTest) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __desktopPetPoseSnapshot: () => runtime.humanoidPoseSnapshot(),
  });
}

const removeCommandListener = window.yachiyoDesk.onCommand(({ command, payload }) => {
  if (command === 'show-settings') {
    window.yachiyoDesk.noteUserActivity();
    ui.showSettings();
  } else if (command === 'show-characters') {
    ui.showSettings('characters');
  } else if (command === 'reset-pose') {
    runtime.resetPose();
    void applySettingsPatch({ zoom: DEFAULT_CHARACTER_ZOOM, rotationY: 0 });
    ui.showToast('已恢复默认姿态');
  } else if (command === 'reaction') {
    const allowed = new Set<ReactionName>([
      'greet', 'joy', 'surprised', 'angry', 'sleepy', 'poke',
      'bow', 'stretch', 'dance', 'lookAround',
      'nod', 'shakeHead', 'shy',
      'cheer', 'think', 'crouch', 'tiptoe', 'sway',
    ]);
    if (allowed.has(payload as ReactionName)) {
      triggerReaction(payload as ReactionName);
    }
  } else if (command === 'autonomous-reaction') {
    const allowed = new Set<ReactionName>([
      'greet', 'joy', 'surprised', 'angry', 'sleepy', 'poke',
      'bow', 'stretch', 'dance', 'lookAround', 'nod', 'shakeHead',
      'shy', 'cheer', 'think', 'crouch', 'tiptoe', 'sway',
    ]);
    if (allowed.has(payload as ReactionName)) runtime.triggerReaction(payload as ReactionName);
  } else if (command === 'speech' && typeof payload === 'string') {
    ui.showSpeech(payload);
  } else if (command === 'autonomy' && payload && typeof payload === 'object') {
    runtime.setAutonomy(payload as AutonomyCommand);
  } else if (command === 'test-drag' && bootstrap.smokeTest) {
    runtime.setDragging(Boolean(payload));
  } else if (command === 'test-hide-overlays' && bootstrap.smokeTest) {
    ui.setTransientOverlaysHidden(Boolean(payload));
  } else if (command === 'focus-complete' && payload && typeof payload === 'object') {
    const mode = (payload as { mode?: string }).mode;
    triggerReaction(mode === 'focus' ? 'joy' : 'stretch');
    ui.showSpeech(mode === 'focus' ? 'focusComplete' : 'breakComplete', 4200);
    ui.showToast(mode === 'focus' ? '本轮专注完成' : '休息结束', 3200);
  }
});

const removeSettingsListener = window.yachiyoDesk.onSettingsChanged((settings) => {
  currentSettings = settings;
  runtime.setSettings(settings);
  interaction.setSettings(settings);
  ui.updateSettings(settings);
});
const removeFocusListener = window.yachiyoDesk.onFocusChanged((status) => ui.updateFocus(status));
const removePetListener = window.yachiyoDesk.onPetStatusChanged((status) => ui.updatePetStatus(status));

let resizeFrame = 0;
const handleWindowResize = (): void => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => runtime.resize());
};
window.addEventListener('resize', handleWindowResize, { passive: true });

let speechFrame = 0;
function updateSpeechPosition(): void {
  ui.positionSpeech(runtime.headScreenPosition());
  speechFrame = requestAnimationFrame(updateSpeechPosition);
}
speechFrame = requestAnimationFrame(updateSpeechPosition);

const telemetryTimer = window.setInterval(() => {
  const stats = runtime.getPerformanceStats();
  ui.updatePerformance(stats);
  window.yachiyoDesk.runtimeTelemetry(stats);
}, 2000);

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(speechFrame);
  window.clearInterval(telemetryTimer);
  cancelAnimationFrame(resizeFrame);
  window.removeEventListener('resize', handleWindowResize);
  removeCommandListener();
  removeSettingsListener();
  removeFocusListener();
  removePetListener();
  runtime.dispose();
}, { once: true });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) runtime.noteActivity();
});

void runtime.load();
