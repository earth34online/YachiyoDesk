import type {
  AppSettings,
  CharacterManifest,
  InstalledCharacter,
  FocusStatus,
  PetInteraction,
  PetStatus,
  QualityMode,
  ReactionName,
  RuntimePerformanceStats,
} from './types';

export type SettingsPage = 'general' | 'actions' | 'focus' | 'characters' | 'performance';

interface UiCallbacks {
  onSettingsPatch: (patch: Partial<AppSettings>) => void;
  onSettingsPreview: (patch: Partial<AppSettings>) => void;
  onCloseSettings: () => void;
  onResetPose: () => void;
  onResetWindow: () => void;
  onReaction: (reaction: ReactionName, speechKey?: string) => void;
}

interface ToggleDefinition {
  key: keyof AppSettings;
  label: string;
  description: string;
}

const GENERAL_TOGGLES: ToggleDefinition[] = [
  { key: 'mouseLook', label: '鼠标视线跟随', description: '眼睛与头部平滑追踪鼠标。' },
  { key: 'physics', label: '头发与衣物物理', description: '启用 VRM 摇摆骨骼与碰撞体。' },
  { key: 'idleMotion', label: '呼吸与待机动作', description: '呼吸、重心变化与随机观察。' },
  { key: 'autonomousBehavior', label: '屏幕底部自主活动', description: '无操作时散步、观察、伸懒腰与跳舞；触碰立即停止。' },
  { key: 'reactions', label: '点击反应', description: '摸头、戳身体及连续点击反馈。' },
  { key: 'speech', label: '对白气泡', description: '互动时显示角色本地对白。' },
  { key: 'contactShadow', label: '脚下柔和阴影', description: '增强角色站在桌面的空间感。' },
  { key: 'clickThrough', label: '透明区域穿透', description: '模型周围仍能操作桌面。' },
  { key: 'lockPosition', label: '锁定窗口位置', description: '避免误拖动角色窗口。' },
  { key: 'alwaysOnTop', label: '始终置顶', description: '显示在普通窗口上方。' },
  { key: 'autoStart', label: '开机自动启动', description: '登录 Windows 后自动运行。' },
];

const ACTIONS: Array<{ reaction: ReactionName; icon: string; label: string; description: string; speechKey?: string }> = [
  { reaction: 'think', icon: '✧', label: '八千代的话', description: '听听八千代安静而温柔的心声', speechKey: 'characterChat' },
  { reaction: 'lookAround', icon: '…', label: '闲聊', description: '边观察桌面边说几句话', speechKey: 'idleChat' },
  { reaction: 'greet', icon: '✦', label: '打招呼', description: '轻快招呼与挥手反应' },
  { reaction: 'joy', icon: '♡', label: '开心', description: '笑容与活泼摆动' },
  { reaction: 'surprised', icon: '!', label: '惊讶', description: '快速后仰与惊讶表情' },
  { reaction: 'angry', icon: '♢', label: '生气', description: '短暂不满的小动作' },
  { reaction: 'sleepy', icon: '☾', label: '困倦', description: '闭眼与慢速呼吸' },
  { reaction: 'poke', icon: '·', label: '戳一戳', description: '轻微躲闪反馈' },
  { reaction: 'bow', icon: '⌁', label: '鞠躬', description: '重心前移的礼貌鞠躬' },
  { reaction: 'stretch', icon: '↟', label: '伸懒腰', description: '肩、肘、腰协调舒展' },
  { reaction: 'dance', icon: '♪', label: '轻舞', description: '左右踏步与全身律动' },
  { reaction: 'lookAround', icon: '◌', label: '四处看看', description: '身体带动头部环顾桌面' },
  { reaction: 'nod', icon: '⌄', label: '点头', description: '颈部与上身自然回应' },
  { reaction: 'shakeHead', icon: '↔', label: '摇头', description: '带缓冲的否定动作' },
  { reaction: 'shy', icon: '❀', label: '害羞', description: '缩肩、低头并移开视线' },
  { reaction: 'cheer', icon: '★', label: '欢呼', description: '双臂上举、屈膝与连续跳步' },
  { reaction: 'think', icon: '?', label: '思考', description: '扶额、偏头与重心转换' },
  { reaction: 'crouch', icon: '⌄', label: '下蹲', description: '自然屈膝下蹲后平稳起身' },
  { reaction: 'tiptoe', icon: '↑', label: '踮脚', description: '伸展身体并张臂保持平衡' },
  { reaction: 'sway', icon: '≈', label: '摇摆', description: '左右踏步与全身摆动' },
];

const QUALITY_LABELS: Record<QualityMode, string> = {
  ultra: '极致 · 最高画质',
  high: '高 · 较低显存占用',
  balanced: '均衡 · 低功耗 30 FPS',
};

export class AppUI {
  private readonly loading = document.querySelector<HTMLElement>('#loading')!;
  private readonly loadingDetail = document.querySelector<HTMLElement>('#loading-detail')!;
  private readonly loadingProgress = document.querySelector<HTMLElement>('#loading-progress')!;
  private readonly speech = document.querySelector<HTMLElement>('#speech')!;
  private readonly toast = document.querySelector<HTMLElement>('#toast')!;
  private readonly companionDock = document.querySelector<HTMLElement>('#companion-dock')!;
  private readonly dockStatus = document.querySelector<HTMLElement>('#dock-status')!;
  private readonly dockActions = document.querySelector<HTMLElement>('#dock-actions')!;
  private readonly settingsPanel = document.querySelector<HTMLElement>('#settings-panel')!;
  private readonly settingsContent = document.querySelector<HTMLElement>('#settings-content')!;
  private readonly fatal = document.querySelector<HTMLElement>('#fatal')!;
  private readonly fatalMessage = document.querySelector<HTMLElement>('#fatal-message')!;
  private readonly setupRequired = document.querySelector<HTMLElement>('#setup-required');
  private settings: AppSettings;
  private readonly character: CharacterManifest;
  private readonly callbacks: UiCallbacks;
  private activePage: SettingsPage = 'general';
  private characters: InstalledCharacter[] = [];
  private performance: RuntimePerformanceStats | null = null;
  private focus: FocusStatus = {
    running: false,
    mode: 'focus',
    totalSeconds: 1500,
    remainingSeconds: 1500,
    sessionsCompleted: 0,
  };
  private petStatus: PetStatus = { hunger: 82, energy: 88, happiness: 86, affection: 35, updatedAt: Date.now() };
  private speechTimer = 0;
  private toastTimer = 0;
  private dockHideTimer = 0;
  private settingsHideTimer = 0;
  private settingsShowFrame = 0;
  private settingsOpen = false;

  constructor(settings: AppSettings, character: CharacterManifest, callbacks: UiCallbacks) {
    this.settings = settings;
    this.character = character;
    this.callbacks = callbacks;
    document.querySelector('#settings-close')?.addEventListener('click', () => this.hideSettings());
    document.querySelector('#reset-pose')?.addEventListener('click', callbacks.onResetPose);
    document.querySelector('#reset-window')?.addEventListener('click', callbacks.onResetWindow);
    document.querySelector('#fatal-retry')?.addEventListener('click', () => window.location.reload());
    this.settingsPanel.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      window.yachiyoDesk.noteUserActivity();
    });
    this.settingsPanel.addEventListener('pointermove', (event) => event.stopPropagation());
    this.settingsPanel.addEventListener('keydown', () => window.yachiyoDesk.noteUserActivity());
    this.settingsPanel.addEventListener('input', () => window.yachiyoDesk.noteUserActivity());
    this.renderCompanionDock();
    this.companionDock.addEventListener('pointerenter', () => {
      window.clearTimeout(this.dockHideTimer);
      document.body.classList.add('companion-dock-open');
    });
    this.companionDock.addEventListener('pointerleave', () => this.setCompanionHover(false));
    document.addEventListener('pointerdown', (event) => {
      if (!this.isSettingsOpen()) return;
      const target = event.target;
      if (target instanceof Node && this.settingsPanel.contains(target)) return;
      this.hideSettings();
    }, true);
    this.updateAvatarScaleClass();
    this.renderSettings();
    void window.yachiyoDesk.getFocusStatus().then((status) => this.updateFocus(status));
    void window.yachiyoDesk.getPetStatus().then((status) => this.updatePetStatus(status));
  }

  setLoading(percent: number, detail: string): void {
    this.loadingProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    this.loadingDetail.textContent = detail;
  }

  finishLoading(): void {
    this.loading.classList.add('is-complete');
    window.setTimeout(() => { this.loading.hidden = true; }, 460);
  }

  showFatal(error: Error): void {
    this.loading.hidden = true;
    this.fatalMessage.textContent = error.message;
    this.fatal.hidden = false;
  }

  showSetupRequired(): void {
    this.loading.hidden = true;
    if (this.setupRequired) this.setupRequired.hidden = false;
    window.yachiyoDesk.setClickThrough(false);
  }

  showSpeech(key: string, duration = 2800): void {
    if (!this.settings.speech) return;
    const candidates = this.character.messages[key] ?? this.character.messages.greet ?? [];
    if (candidates.length === 0) return;
    const message = candidates[Math.floor(Math.random() * candidates.length)];
    this.speech.textContent = message;
    this.speech.classList.add('is-visible');
    window.clearTimeout(this.speechTimer);
    this.speechTimer = window.setTimeout(() => this.speech.classList.remove('is-visible'), duration);
  }

  positionSpeech(position: { x: number; y: number } | null): void {
    if (!position) return;
    const x = Math.max(88, Math.min(window.innerWidth - 88, position.x));
    const y = Math.max(122, Math.min(window.innerHeight - 100, position.y));
    this.speech.style.left = `${x}px`;
    this.speech.style.top = `${y}px`;
  }

  showToast(message: string, duration = 1900): void {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  showSettings(page: SettingsPage = this.activePage): void {
    window.clearTimeout(this.settingsHideTimer);
    this.settingsHideTimer = 0;
    cancelAnimationFrame(this.settingsShowFrame);
    this.settingsShowFrame = 0;
    this.settingsOpen = true;
    this.activePage = page;
    this.renderSettings();
    this.settingsPanel.hidden = false;
    document.body.classList.add('settings-open');
    this.settingsShowFrame = requestAnimationFrame(() => {
      this.settingsShowFrame = 0;
      // An outside press can close the panel between showSettings() and this
      // frame. Never let that stale frame make a logically closed panel visible.
      if (this.settingsOpen) this.settingsPanel.classList.add('is-visible');
    });
    window.yachiyoDesk.setClickThrough(false);
    window.yachiyoDesk.setInteractionPanelOpen(true);
    if (page === 'characters') void this.refreshCharacters();
  }

  hideSettings(): void {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    cancelAnimationFrame(this.settingsShowFrame);
    this.settingsShowFrame = 0;
    this.settingsPanel.classList.remove('is-visible');
    document.body.classList.remove('settings-open');
    window.clearTimeout(this.settingsHideTimer);
    this.settingsHideTimer = window.setTimeout(() => {
      // A rapid reopen cancels this timer in showSettings(). Without that
      // guard, the stale close transition can hide a newly opened panel.
      if (!this.settingsPanel.classList.contains('is-visible')) {
        this.settingsPanel.hidden = true;
      }
      this.settingsHideTimer = 0;
    }, 180);
    window.yachiyoDesk.setInteractionPanelOpen(false);
    this.callbacks.onCloseSettings();
  }

  isSettingsOpen(): boolean {
    return this.settingsOpen;
  }

  isCompanionDockTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.companionDock.contains(target);
  }

  isCompanionDockOpen(): boolean {
    return document.body.classList.contains('companion-dock-open');
  }

  setCompanionHover(active: boolean): void {
    window.clearTimeout(this.dockHideTimer);
    if (active) {
      document.body.classList.add('companion-dock-open');
      return;
    }
    this.dockHideTimer = window.setTimeout(() => {
      if (!this.companionDock.matches(':hover')) {
        document.body.classList.remove('companion-dock-open');
      }
    }, 360);
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    this.updateAvatarScaleClass();
    this.renderSettings();
  }

  setTransientOverlaysHidden(hidden: boolean): void {
    document.body.classList.toggle('test-hide-overlays', hidden);
    if (hidden) {
      window.clearTimeout(this.speechTimer);
      window.clearTimeout(this.toastTimer);
      this.speech.classList.remove('is-visible');
      this.toast.classList.remove('is-visible');
    }
  }

  private updateAvatarScaleClass(): void {
    document.body.classList.toggle('compact-avatar', this.settings.zoom < 0.35);
  }

  updatePerformance(stats: RuntimePerformanceStats): void {
    this.performance = stats;
    if (this.activePage === 'performance' && this.isSettingsOpen()) this.renderSettings();
  }

  updateFocus(status: FocusStatus): void {
    this.focus = status;
    if (this.activePage === 'focus' && this.isSettingsOpen()) this.refreshFocusDisplay();
  }

  updatePetStatus(status: PetStatus): void {
    this.petStatus = status;
    this.refreshCompanionDock();
    if (this.activePage === 'focus' && this.isSettingsOpen()) this.refreshPetDisplay();
  }

  private refreshFocusDisplay(): void {
    const label = this.settingsContent.querySelector<HTMLElement>('[data-focus-label]');
    const remaining = this.settingsContent.querySelector<HTMLElement>('[data-focus-remaining]');
    const detail = this.settingsContent.querySelector<HTMLElement>('[data-focus-detail]');
    const stop = this.settingsContent.querySelector<HTMLButtonElement>('[data-focus-stop]');
    if (!label || !remaining || !detail || !stop) return;
    label.textContent = this.focus.running
      ? (this.focus.mode === 'focus' ? '专注中' : '休息中')
      : '准备开始';
    const minutes = Math.floor(this.focus.remainingSeconds / 60);
    const seconds = this.focus.remainingSeconds % 60;
    remaining.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    detail.textContent = `本机已完成 ${this.focus.sessionsCompleted} 轮专注`;
    stop.disabled = !this.focus.running;
    stop.textContent = this.focus.running ? '停止当前计时' : '当前没有正在运行的计时';
  }

  private refreshPetDisplay(): void {
    const labels: Record<keyof Pick<PetStatus, 'hunger' | 'energy' | 'happiness' | 'affection'>, string> = {
      hunger: '饱腹',
      energy: '精力',
      happiness: '心情',
      affection: '亲密',
    };
    for (const [key, label] of Object.entries(labels)) {
      const row = this.settingsContent.querySelector<HTMLElement>(`[data-pet-stat="${key}"]`);
      if (!row) continue;
      const value = Math.round(Number(this.petStatus[key as keyof typeof labels]));
      const copy = row.querySelector<HTMLElement>('span');
      const fill = row.querySelector<HTMLElement>('b');
      if (copy) copy.textContent = `${label} ${value}`;
      if (fill) fill.style.width = `${value}%`;
    }
  }

  private async refreshCharacters(): Promise<void> {
    try {
      this.characters = await window.yachiyoDesk.listCharacters();
      if (this.activePage === 'characters') this.renderSettings();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : '读取角色库失败');
    }
  }

  private renderSettings(): void {
    this.settingsContent.replaceChildren(this.createTabs());
    const page = document.createElement('section');
    page.className = 'control-page';
    if (this.activePage === 'general') this.renderGeneral(page);
    if (this.activePage === 'actions') this.renderActions(page);
    if (this.activePage === 'focus') this.renderFocus(page);
    if (this.activePage === 'characters') this.renderCharacters(page);
    if (this.activePage === 'performance') this.renderPerformance(page);
    this.settingsContent.append(page);
  }

  private createTabs(): HTMLElement {
    const tabs = document.createElement('nav');
    tabs.className = 'control-tabs';
    const definitions: Array<[SettingsPage, string, string]> = [
      ['general', '常用', '⌁'],
      ['actions', '动作', '✦'],
      ['focus', '陪伴', '◷'],
      ['characters', '角色', '◇'],
      ['performance', '性能', '▥'],
    ];
    for (const [page, label, icon] of definitions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `control-tab${this.activePage === page ? ' is-active' : ''}`;
      button.innerHTML = `<i>${icon}</i><span>${label}</span>`;
      button.addEventListener('click', () => {
        this.activePage = page;
        this.renderSettings();
        if (page === 'characters') void this.refreshCharacters();
      });
      tabs.append(button);
    }
    return tabs;
  }

  private renderGeneral(container: HTMLElement): void {
    container.append(this.createSectionTitle('外观与控制', '滑块可实时预览，松开后保存。'));
    container.append(this.createSelectSetting(
      '显示质量',
      '极致模式保留最高分辨率、抗锯齿与各向异性过滤。',
      Object.entries(QUALITY_LABELS),
      this.settings.quality,
      (value) => this.callbacks.onSettingsPatch({ quality: value as QualityMode }),
    ));
    container.append(this.createRangeSetting(
      '角色大小', '仅缩放角色，不改变模型质量。', this.settings.zoom, 0.10, 1.8, 0.01,
      (value) => `${Math.round(value * 100)}%`, (value) => ({ zoom: value }),
    ));
    container.append(this.createRangeSetting(
      '朝向角度', '左右调整角色朝向。', this.settings.rotationY * 180 / Math.PI, -75, 75, 1,
      (value) => `${Math.round(value)}°`, (value) => ({ rotationY: value * Math.PI / 180 }),
    ));
    container.append(this.createRangeSetting(
      '动作幅度', '调节呼吸、待机与反应动作的整体强度。', this.settings.motionIntensity, 0, 1.5, 0.05,
      (value) => `${Math.round(value * 100)}%`, (value) => ({ motionIntensity: value }),
    ));
    container.append(this.createRangeSetting(
      '散步速度', '控制无操作时沿屏幕底部移动的速度；角色配置可在此基础上做独立倍率。', this.settings.wanderSpeed, 18, 90, 1,
      (value) => `${Math.round(value)} 像素/秒`, (value) => ({ wanderSpeed: value }),
    ));
    container.append(this.createSelectSetting(
      '散步路线',
      '选择沿屏幕往返，或每次随机决定方向与距离。',
      [['patrol', '屏幕间来回走'], ['random', '随机方向散步']],
      this.settings.wanderMode,
      (value) => this.callbacks.onSettingsPatch({ wanderMode: value as AppSettings['wanderMode'] }),
    ));
    container.append(this.createRangeSetting(
      '自主活动频率', '控制散步和随机小动作出现的频率。', this.settings.activityFrequency, 0.5, 2, 0.05,
      (value) => `${Math.round(value * 100)}%`, (value) => ({ activityFrequency: value }),
    ));
    container.append(this.createRangeSetting(
      '视线幅度', '调节头部和眼睛追踪鼠标的幅度。', this.settings.lookIntensity, 0, 1.5, 0.05,
      (value) => `${Math.round(value * 100)}%`, (value) => ({ lookIntensity: value }),
    ));

    container.append(this.createSectionTitle('行为开关', '所有设置都会保存在本机。'));
    for (const toggle of GENERAL_TOGGLES) container.append(this.createToggle(toggle));

    const sleepOptions = [1, 3, 5, 10, 20, 30].map((minutes) => [String(minutes), `${minutes} 分钟`] as [string, string]);
    container.append(this.createSelectSetting(
      '无操作后入睡', '角色会闭眼并进入缓慢呼吸状态。', sleepOptions,
      String(this.settings.sleepMinutes),
      (value) => this.callbacks.onSettingsPatch({ sleepMinutes: Number(value) }),
    ));

    const shortcut = document.createElement('button');
    shortcut.type = 'button';
    shortcut.className = 'wide-button';
    shortcut.textContent = '在桌面创建一键启动快捷方式';
    shortcut.addEventListener('click', async () => {
      const result = await window.yachiyoDesk.createDesktopShortcut();
      this.showToast(result.ok ? `快捷方式已创建：${result.path}` : (result.error ?? '快捷方式创建失败'));
    });
    container.append(shortcut, this.createCredit());
  }

  private renderActions(container: HTMLElement): void {
    container.append(this.createSectionTitle('即时动作', '点击即可让当前角色执行动作与表情。'));
    const grid = document.createElement('div');
    grid.className = 'action-grid';
    for (const action of ACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-button';
      const icon = document.createElement('i');
      icon.textContent = action.icon;
      const copy = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = action.label;
      const description = document.createElement('small');
      description.textContent = action.description;
      copy.append(strong, description);
      button.append(icon, copy);
      button.addEventListener('click', () => {
        this.callbacks.onReaction(action.reaction, action.speechKey);
        this.hideSettings();
      });
      grid.append(button);
    }
    container.append(grid);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'wide-button';
    reset.textContent = '恢复默认姿态、大小与朝向';
    reset.addEventListener('click', this.callbacks.onResetPose);
    container.append(reset, this.createCredit());
  }

  private renderFocus(container: HTMLElement): void {
    container.append(this.createSectionTitle('专注陪伴', '计时完全保存在本机；隐藏角色后仍会继续。'));
    const card = document.createElement('section');
    card.className = 'focus-card';
    const label = document.createElement('span');
    label.dataset.focusLabel = '';
    label.textContent = this.focus.running
      ? (this.focus.mode === 'focus' ? '专注中' : '休息中')
      : '准备开始';
    const remaining = document.createElement('strong');
    remaining.dataset.focusRemaining = '';
    const minutes = Math.floor(this.focus.remainingSeconds / 60);
    const seconds = this.focus.remainingSeconds % 60;
    remaining.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const detail = document.createElement('small');
    detail.dataset.focusDetail = '';
    detail.textContent = `本机已完成 ${this.focus.sessionsCompleted} 轮专注`;
    card.append(label, remaining, detail);

    const presets = document.createElement('div');
    presets.className = 'focus-presets';
    const options: Array<[string, 'focus' | 'break', number]> = [
      ['专注 25 分钟', 'focus', 25],
      ['深度专注 50 分钟', 'focus', 50],
      ['短休息 5 分钟', 'break', 5],
      ['长休息 15 分钟', 'break', 15],
    ];
    for (const [text, mode, duration] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'subtle-button';
      button.textContent = text;
      button.addEventListener('click', async () => {
        this.updateFocus(await window.yachiyoDesk.startFocus(mode, duration));
        this.showToast(`${text}已开始`);
      });
      presets.append(button);
    }
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'wide-button';
    stop.dataset.focusStop = '';
    stop.disabled = !this.focus.running;
    stop.textContent = this.focus.running ? '停止当前计时' : '当前没有正在运行的计时';
    stop.addEventListener('click', async () => {
      this.updateFocus(await window.yachiyoDesk.stopFocus());
      this.showToast('计时已停止');
    });
    container.append(card, presets, stop);
    this.renderPetStatus(container);
    container.append(this.createCredit());
  }

  private renderPetStatus(container: HTMLElement): void {
    container.append(this.createSectionTitle('本地陪伴状态', '数值按角色分别保存在本机，关闭程序后也会按时间缓慢变化。'));
    const stats = document.createElement('section');
    stats.className = 'pet-stats';
    const definitions: Array<[keyof PetStatus, string, string]> = [
      ['hunger', '饱腹', '#f7be77'],
      ['energy', '精力', '#86c8ff'],
      ['happiness', '心情', '#ee9fca'],
      ['affection', '亲密', '#b8a2ff'],
    ];
    for (const [key, label, color] of definitions) {
      const row = document.createElement('div');
      row.dataset.petStat = key;
      const copy = document.createElement('span');
      const value = Math.round(Number(this.petStatus[key]));
      copy.textContent = `${label} ${value}`;
      const track = document.createElement('i');
      const fill = document.createElement('b');
      fill.style.width = `${value}%`;
      fill.style.background = color;
      track.append(fill);
      row.append(copy, track);
      stats.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'pet-actions';
    const items: Array<[PetInteraction, string]> = [
      ['snack', '给零食'], ['meal', '吃正餐'], ['drink', '喝饮料'],
      ['play', '一起玩'], ['rest', '休息'], ['praise', '夸夸她'],
    ];
    for (const [action, label] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'subtle-button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        this.updatePetStatus(await window.yachiyoDesk.petInteract(action));
        this.showToast(`${label} · 状态已更新`);
      });
      actions.append(button);
    }
    container.append(stats, actions);
    this.refreshPetDisplay();
  }

  private renderCompanionDock(): void {
    const definitions: Array<[PetInteraction, string, string]> = [
      ['snack', '零食', '◇'],
      ['meal', '喂食', '♨'],
      ['drink', '饮水', '◒'],
      ['play', '玩耍', '✦'],
      ['rest', '休息', '☾'],
      ['praise', '夸奖', '♡'],
    ];
    this.dockActions.replaceChildren();
    for (const [action, label, iconText] of definitions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.dockAction = action;
      const icon = document.createElement('i');
      icon.textContent = iconText;
      const copy = document.createElement('span');
      copy.textContent = label;
      button.append(icon, copy);
      button.addEventListener('click', async () => {
        window.yachiyoDesk.noteUserActivity();
        this.updatePetStatus(await window.yachiyoDesk.petInteract(action));
        this.showToast(`${label} · 状态已更新`);
      });
      this.dockActions.append(button);
    }
    document.querySelector('#dock-more')?.addEventListener('click', () => this.showSettings('focus'));
    this.refreshCompanionDock();
  }

  private refreshCompanionDock(): void {
    if (!this.dockStatus) return;
    const definitions: Array<[keyof Pick<PetStatus, 'hunger' | 'energy' | 'happiness' | 'affection'>, string]> = [
      ['hunger', '饱腹'],
      ['energy', '精力'],
      ['happiness', '心情'],
      ['affection', '亲密'],
    ];
    this.dockStatus.replaceChildren();
    for (const [key, label] of definitions) {
      const value = Math.round(this.petStatus[key]);
      const row = document.createElement('div');
      const copy = document.createElement('span');
      copy.textContent = label;
      const number = document.createElement('strong');
      number.textContent = String(value);
      const track = document.createElement('i');
      const fill = document.createElement('b');
      fill.style.width = `${value}%`;
      track.append(fill);
      row.append(copy, number, track);
      this.dockStatus.append(row);
    }
  }

  private renderCharacters(container: HTMLElement): void {
    container.append(this.createSectionTitle('本地角色库', '支持直接导入 VRM，也可在本机把 PMX 自动转换为 VRM 后使用。'));
    const toolbar = document.createElement('div');
    toolbar.className = 'character-toolbar';
    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'primary-button';
    importButton.textContent = '＋ 导入 VRM 角色';
    importButton.addEventListener('click', async () => {
      try {
        const result = await window.yachiyoDesk.importCharacter();
        if (result.canceled) return;
        this.showToast(result.character ? `已导入 ${result.character.displayName}` : '导入未完成');
        await this.refreshCharacters();
      } catch (error) {
        this.showToast(error instanceof Error ? error.message : '导入失败');
      }
    });
    const importPmxButton = document.createElement('button');
    importPmxButton.type = 'button';
    importPmxButton.className = 'primary-button';
    importPmxButton.textContent = '＋ 导入 PMX（自动转换）';
    importPmxButton.addEventListener('click', async () => {
      importButton.disabled = true;
      importPmxButton.disabled = true;
      importPmxButton.textContent = '正在转换，请稍候…';
      this.showToast('正在用本机转换引擎检查骨骼、材质与物理，请勿关闭程序');
      try {
        const result = await window.yachiyoDesk.importPmxCharacter();
        if (result.canceled) return;
        this.showToast(result.character ? `已转换并导入 ${result.character.displayName}` : '转换未完成');
        await this.refreshCharacters();
      } catch (error) {
        this.showToast(error instanceof Error ? error.message : 'PMX 转换失败');
      } finally {
        importButton.disabled = false;
        importPmxButton.disabled = false;
        importPmxButton.textContent = '＋ 导入 PMX（自动转换）';
      }
    });
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'subtle-button';
    refresh.textContent = '刷新';
    refresh.addEventListener('click', () => void this.refreshCharacters());
    const folder = document.createElement('button');
    folder.type = 'button';
    folder.className = 'subtle-button';
    folder.textContent = '打开数据目录';
    folder.addEventListener('click', () => void window.yachiyoDesk.openDataFolder());
    toolbar.append(importButton, importPmxButton, refresh, folder);
    container.append(toolbar);

    if (this.characters.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '正在读取角色库…';
      container.append(empty);
      return;
    }

    for (const character of this.characters) {
      const card = document.createElement('article');
      card.className = `character-card${character.active ? ' is-active' : ''}`;
      const avatar = document.createElement('div');
      avatar.className = 'character-avatar';
      avatar.textContent = character.displayName.slice(0, 1).toUpperCase();
      const info = document.createElement('div');
      info.className = 'character-info';
      const title = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = character.displayName;
      title.append(name);
      if (character.active) {
        const badge = document.createElement('em');
        badge.textContent = '使用中';
        title.append(badge);
      }
      const meta = document.createElement('span');
      const profileLabel = character.motionProfileId === 'generic-vrm'
        ? '通用 VRM 标准'
        : `专属配置 ${character.motionProfileId}`;
      const sourceLabel = character.builtIn
        ? '内置高质量角色'
        : character.sourceFormat === 'pmx' ? 'PMX 本机转换' : '本地 VRM';
      meta.textContent = `${sourceLabel} · ${profileLabel} · ${character.creator}`;
      info.append(title, meta);
      const actions = document.createElement('div');
      actions.className = 'character-actions';
      if (!character.active) {
        const use = document.createElement('button');
        use.type = 'button';
        use.textContent = '使用';
        use.addEventListener('click', async () => {
          const result = await window.yachiyoDesk.switchCharacter(character.id);
          this.showToast(result.ok ? `正在切换到 ${character.displayName}` : (result.error ?? '切换失败'));
        });
        actions.append(use);
      }
      if (!character.builtIn) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger-button';
        remove.textContent = '删除';
        remove.addEventListener('click', async () => {
          const result = await window.yachiyoDesk.removeCharacter(character.id);
          if (result.ok) {
            this.showToast(`已移除 ${character.displayName}`);
            await this.refreshCharacters();
          }
        });
        actions.append(remove);
      }
      card.append(avatar, info, actions);
      container.append(card);
    }
    container.append(this.createCredit());
  }

  private renderPerformance(container: HTMLElement): void {
    container.append(this.createSectionTitle('实时流畅度', '每两秒更新，帮助判断渲染是否稳定。'));
    const stats = this.performance;
    const metrics: Array<[string, string, string]> = [
      ['平均帧率', stats ? `${stats.averageFps.toFixed(1)} FPS` : '等待采样', `目标 ${stats?.targetFps ?? '—'} FPS`],
      ['P95 帧耗时', stats ? `${stats.p95FrameMs.toFixed(1)} ms` : '—', '越低越流畅'],
      ['像素倍率', stats ? stats.pixelRatio.toFixed(2) : '—', stats ? `自适应 ${Math.round(stats.adaptiveScale * 100)}%` : '等待采样'],
      ['绘制调用', stats ? String(stats.drawCalls) : '—', stats ? `${stats.renderedTriangles.toLocaleString()} 三角面` : '渲染统计'],
      ['GPU 纹理', stats ? String(stats.gpuTextureCount) : '—', '完整模型纹理'],
      ['GPU 几何体', stats ? String(stats.gpuGeometryCount) : '—', stats ? `${stats.sampleCount} 个帧样本` : '等待采样'],
    ];
    const grid = document.createElement('div');
    grid.className = 'performance-grid';
    for (const [label, value, hint] of metrics) {
      const card = document.createElement('div');
      card.className = 'metric-card';
      const name = document.createElement('span');
      name.textContent = label;
      const number = document.createElement('strong');
      number.textContent = value;
      const small = document.createElement('small');
      small.textContent = hint;
      card.append(name, number, small);
      grid.append(card);
    }
    container.append(grid);
    container.append(this.createToggle({
      key: 'adaptivePerformance',
      label: '自动流畅度优化',
      description: '持续掉帧时仅调整内部渲染倍率，恢复后自动升回；不会压缩模型纹理。',
    }));
    const note = document.createElement('div');
    note.className = 'performance-note';
    note.innerHTML = '<strong>高质量策略</strong><span>角色始终使用原始 VRM 网格、材质和纹理。自适应模式只在必要时改变像素倍率，以避免拖动或复杂桌面场景中卡顿。</span>';
    container.append(note, this.createCredit());
  }

  private createSectionTitle(title: string, description: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'section-title';
    const strong = document.createElement('strong');
    strong.textContent = title;
    const span = document.createElement('span');
    span.textContent = description;
    element.append(strong, span);
    return element;
  }

  private createSelectSetting(
    label: string,
    description: string,
    options: Array<[string, string]>,
    selected: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const group = document.createElement('div');
    group.className = 'setting-group';
    group.append(this.createSettingCopy(label, description));
    const select = document.createElement('select');
    select.className = 'quality-select';
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = value === selected;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    group.append(select);
    return group;
  }

  private createRangeSetting(
    label: string,
    description: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
    toPatch: (value: number) => Partial<AppSettings>,
  ): HTMLElement {
    const group = document.createElement('div');
    group.className = 'setting-group range-group';
    const heading = document.createElement('div');
    heading.className = 'range-heading';
    heading.append(this.createSettingCopy(label, description));
    const output = document.createElement('output');
    output.textContent = format(value);
    heading.append(output);
    const range = document.createElement('input');
    range.className = 'setting-range';
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.addEventListener('input', () => {
      const next = Number(range.value);
      output.textContent = format(next);
      this.callbacks.onSettingsPreview(toPatch(next));
    });
    range.addEventListener('change', () => this.callbacks.onSettingsPatch(toPatch(Number(range.value))));
    group.append(heading, range);
    return group;
  }

  private createToggle(toggle: ToggleDefinition): HTMLElement {
    const row = document.createElement('label');
    row.className = 'setting-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.settings[toggle.key]);
    input.addEventListener('change', () => {
      this.callbacks.onSettingsPatch({ [toggle.key]: input.checked } as Partial<AppSettings>);
    });
    const switchControl = document.createElement('span');
    switchControl.className = 'switch-control';
    switchControl.append(input, document.createElement('i'));
    row.append(this.createSettingCopy(toggle.label, toggle.description), switchControl);
    return row;
  }

  private createSettingCopy(label: string, description: string): HTMLElement {
    const copy = document.createElement('span');
    copy.className = 'setting-copy';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = description;
    copy.append(strong, span);
    return copy;
  }

  private createCredit(): HTMLElement {
    const credit = document.createElement('div');
    credit.className = 'credit';
    credit.textContent = `${this.character.displayName} · 模型制作：${this.character.creator} · 仅本机使用`;
    return credit;
  }
}
