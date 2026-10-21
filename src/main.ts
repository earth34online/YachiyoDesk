import './style.css';
import './companion.css';
import { AppUI } from './AppUI';
import { AvatarRuntime } from './AvatarRuntime';
import { InteractionController } from './InteractionController';
import { CompanionUI } from './CompanionUI';
import type { AppSettings, AutonomyCommand, ReactionName } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) throw new Error('渲染画布不存在。');

const bootstrap = await window.yachiyoDesk.getBootstrap();
document.title = `YachiyoDesk ${bootstrap.appVersion}`;
const versionLabel=document.querySelector('#app-version');
if(versionLabel)versionLabel.textContent=`YACHIYO DESK · v${bootstrap.appVersion}`;
const DEFAULT_CHARACTER_ZOOM = 0.35;
let currentSettings = bootstrap.settings;
let runtime: AvatarRuntime;
let interaction: InteractionController;
let companion: CompanionUI;

async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  interaction?.cancelPendingSettings(patch);
  currentSettings = interaction.setSettings(await window.yachiyoDesk.updateSettings(patch));
  runtime.setSettings(currentSettings);
  window.yachiyoDesk.runtimeViewportBounds(runtime.avatarViewportBounds());
  ui.updateSettings(currentSettings);
  companion?.updateSettings(currentSettings);
}

function previewSettingsPatch(patch: Partial<AppSettings>): void {
  const preview = interaction.previewSettings(patch);
  runtime.setSettings(preview);
  window.yachiyoDesk.runtimeViewportBounds(runtime.avatarViewportBounds());
}

function triggerReaction(reaction: ReactionName, speechKey: string = reaction): void {
  companion?.interruptScene();
  window.yachiyoDesk.noteUserActivity();
  runtime.triggerReaction(reaction);
  ui.showSpeech(speechKey);
}

const ui = new AppUI(currentSettings, bootstrap.character, {
  onImportResult: result => companion.handleImport(result),
  renderExtension: (page, container) => companion?.attach(page, container),
  onSettingsPatch: (patch) => { void applySettingsPatch(patch); },
  onSettingsPreview: previewSettingsPatch,
  onCloseSettings: () => interaction.reevaluateClickThrough(),
  onInteractionStateChanged: () => interaction?.reevaluateClickThrough(),
  onResetPose: () => {
    companion?.interruptScene();
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
    window.yachiyoDesk.runtimeError({ message: error.message, stack: error.stack });
  },
  onSetupRequired: () => {
    ui.showSetupRequired();
    window.yachiyoDesk.runtimeSetupRequired();
  },
  onViewportBounds: (bounds) => window.yachiyoDesk.runtimeViewportBounds(bounds),
  onFrame: () => { if (ui.isSpeechVisible()) ui.positionSpeech(runtime.headScreenPosition()); },
});

interaction = new InteractionController(canvas, runtime, ui, currentSettings);
companion = new CompanionUI({ runtime, bootstrap, characterId: bootstrap.character.id,
  toast: text => ui.showToast(text), speech: text => ui.showTextSpeech(text),
  rotate: radians => runtime.setSettings({ ...currentSettings, rotationY: radians }),
  restoreView: () => runtime.setSettings(currentSettings),
  settingsPatch: applySettingsPatch,
});
const interruptScene = (): void => companion.interruptScene();
canvas.addEventListener('pointerdown',interruptScene);
canvas.addEventListener('wheel',interruptScene,{passive:true});
document.querySelector('#dock-more')?.insertAdjacentElement('beforebegin', Object.assign(document.createElement('button'), { type: 'button', className: 'dock-more', textContent: '♡ 与角色聊天', onclick: () => ui.showSettings('chat') }));
document.querySelector<HTMLButtonElement>('#setup-open-characters')?.addEventListener('click', () => {
  ui.showSettings('characters');
});
if (bootstrap.smokeTest) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __desktopPetShowFatal: (message: string) => ui.showFatal(new Error(message)),
    __desktopPetPoseSnapshot: () => runtime.humanoidPoseSnapshot(),
    __desktopPetLocalPoseSnapshot: () => runtime.humanoidPoseSnapshot(true),
    __desktopPetSetAutonomy: (command: AutonomyCommand) => runtime.setAutonomy(command),
    __desktopPetSecondarySnapshot: () => runtime.secondaryPoseSnapshot(),
    __desktopPetGarmentContactSnapshot: () => runtime.garmentContactSnapshot(),
    __desktopPetAnatomySnapshot: () => runtime.anatomySnapshot(),
    __desktopPetFingerFlexionSamples: () => runtime.fingerFlexionSamples(),
    __desktopPetViewportBounds: () => runtime.avatarViewportBounds(),
    __desktopPetPerformance: () => runtime.getPerformanceStats(),
    __desktopPetBindPose: (active: boolean) => runtime.setDiagnosticBindPose(active),
    __desktopPetPlayMotion: (bytes: number[], loop: boolean) => runtime.playMotion(new Uint8Array(bytes).buffer, 'Runtime verification', loop),
    __desktopPetStopMotion: () => runtime.stopMotion(),
    __desktopPetMotionPlaying: () => runtime.motionPlaying,
    __desktopPetTriggerReaction: (reaction: ReactionName) => runtime.triggerReaction(reaction),
    __desktopPetContact: (state: import('./DesktopContactPose').DesktopContactState) => runtime.setDesktopContact(state),
    __desktopPetContactSnapshot: () => runtime.desktopContactSnapshot(),
  });
}

const removeCommandListener = window.yachiyoDesk.onCommand(({ command, payload }) => {
  if (command === 'desktop-contact-status') {
    ui.showToast('窗口边缘检测暂不可用，拖放落地和屏幕边缘仍可使用');
  } else if (command === 'desktop-contact' && payload && typeof payload === 'object' && 'phase' in payload) {
    runtime.setDesktopContact(payload as import('./DesktopContactPose').DesktopContactState);
  } else if (command === 'stage-suspended' && typeof payload === 'boolean') {
    runtime.setSuspended(payload);
  } else if (command === 'flush-interaction-settings' && typeof payload === 'number') {
    window.yachiyoDesk.interactionSettingsFlushed(payload, interaction.flushBeforeUnload());
  } else if (command === 'show-settings') {
    window.yachiyoDesk.noteUserActivity();
    ui.showSettings();
  } else if (command === 'show-characters') {
    ui.showSettings('characters');
  } else if (command === 'reset-pose') {
    companion.interruptScene();
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
  } else if(command==='play-motion' && payload && typeof payload==='object' && 'id' in payload && typeof payload.id==='string'){
    void companion.playSavedMotion(payload.id).catch(error=>ui.showToast(error.message));
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
    if((payload as AutonomyCommand).action==='walk')companion.interruptScene();
    runtime.setAutonomy(payload as AutonomyCommand);
  } else if (command === 'dismiss-inactive-ui') {
    ui.hideSettings();
    interaction.reevaluateClickThrough();
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
  currentSettings = interaction.setSettings(settings);
  runtime.setSettings(currentSettings);
  window.yachiyoDesk.runtimeViewportBounds(runtime.avatarViewportBounds());
  ui.updateSettings(currentSettings);
  companion.updateSettings(currentSettings);
});
const removeFocusListener = window.yachiyoDesk.onFocusChanged((status) => ui.updateFocus(status));
const removePetListener = window.yachiyoDesk.onPetStatusChanged((status) => ui.updatePetStatus(status));

let resizeFrame = 0;
const handleWindowResize = (): void => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    runtime.resize();
    window.yachiyoDesk.runtimeViewportBounds(runtime.avatarViewportBounds());
  });
};
window.addEventListener('resize', handleWindowResize, { passive: true });

const telemetryTimer = window.setInterval(() => {
  const stats = runtime.getPerformanceStats();
  ui.updatePerformance(stats);
  ui.updateGarmentContact(runtime.garmentContactSnapshot());
  window.yachiyoDesk.runtimeTelemetry(stats);
}, 2000);

window.addEventListener('beforeunload', () => {
  canvas.removeEventListener('pointerdown',interruptScene);
  canvas.removeEventListener('wheel',interruptScene);
  companion.dispose();
  interaction.flushBeforeUnload();
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
