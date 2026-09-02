export type QualityMode = 'ultra' | 'high' | 'balanced';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppSettings {
  schemaVersion: number;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  lockPosition: boolean;
  mouseLook: boolean;
  physics: boolean;
  idleMotion: boolean;
  autonomousBehavior: boolean;
  reactions: boolean;
  speech: boolean;
  contactShadow: boolean;
  autoStart: boolean;
  adaptivePerformance: boolean;
  quality: QualityMode;
  zoom: number;
  rotationY: number;
  motionIntensity: number;
  wanderSpeed: number;
  wanderMode: 'patrol' | 'random';
  activityFrequency: number;
  lookIntensity: number;
  activeCharacterId: string;
  sleepMinutes: number;
  window: WindowBounds | null;
}

export interface CharacterManifest {
  id: string;
  displayName: string;
  originalTitle: string;
  creator: string;
  model: string;
  credit: string;
  messages: Record<string, string[]>;
  behavior: BehaviorProfile;
  motionProfile: MotionProfile;
}

export interface MotionProfile {
  profileId: string;
  baseStandard: 'generic-vrm';
  capabilities: Array<'long-garment' | 'pmx-converted'>;
  walk: {
    speedScale: number;
    cadence: number;
    strideScale: number;
    kneeLiftScale: number;
    hipBobScale: number;
    armSwingScale: number;
  };
  physics: {
    stepHz: number;
    maxSubsteps: number;
  };
  handPose: {
    palmFacingSign: -1 | 1;
    armAxisSign: -1 | 1;
    bodyForwardAxisSign: -1 | 1;
    legForwardAxisSign: -1 | 1;
    rootDepthAxisSign: -1 | 1;
    wristAmplitudeScale: number;
    elbowBendScale: number;
    fingerCurlScale: number;
  };
  legPose: {
    kneeBendSign: -1 | 1;
    seizaHipsDrop: number;
    kneeHandReach: number;
  };
  springBone: {
    enabled: boolean;
    jointNamePatterns: string[];
    colliderSourcePatterns: string[];
    colliderTargetPatterns: string[];
    stiffnessScale: number;
    dragForceAdd: number;
    gravityPowerAdd: number;
    hitRadiusScale: number;
    copyColliderGroups: boolean;
  };
}

export interface WeightedBehaviorAction {
  action: 'walk' | Exclude<ReactionName, 'surprised' | 'angry' | 'poke'>;
  weight: number;
}

export interface BehaviorProfile {
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  actions: WeightedBehaviorAction[];
}

export interface BootstrapData {
  appVersion: string;
  platform: string;
  isPackaged: boolean;
  smokeTest: boolean;
  modelUrl: string | null;
  setupRequired?: boolean;
  character: CharacterManifest;
  settings: AppSettings;
}

export interface InstalledCharacter {
  id: string;
  displayName: string;
  creator: string;
  builtIn: boolean;
  active: boolean;
  sourceFileName?: string;
  sourceFormat?: 'vrm' | 'pmx';
  motionProfileId: string;
}

export interface CharacterImportResult {
  canceled: boolean;
  character?: InstalledCharacter;
}

export type AppCommand =
  | 'show-settings'
  | 'show-characters'
  | 'reset-pose'
  | 'reaction'
  | 'autonomous-reaction'
  | 'speech'
  | 'autonomy'
  | 'focus-complete'
  | 'test-drag'
  | 'test-hide-overlays';

export interface CommandMessage {
  command: AppCommand;
  payload?: unknown;
}

export interface RuntimeDiagnostics {
  renderer: string;
  webglVersion: string;
  modelName: string;
  modelMetaVersion: string;
  modelHeight: number;
  meshCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  expressionNames: string[];
  springJointCount: number;
  colliderCount: number;
  humanoidBoneCount: number;
  quality: QualityMode;
  initialPixelRatio: number;
  motionProfileId: string;
  tunedSpringJointCount: number;
}

export interface RuntimePerformanceStats {
  averageFps: number;
  averageFrameMs: number;
  p95FrameMs: number;
  maximumFrameMs: number;
  sampleCount: number;
  targetFps: number;
  pixelRatio: number;
  adaptiveScale: number;
  drawCalls: number;
  renderedTriangles: number;
  gpuTextureCount: number;
  gpuGeometryCount: number;
}

export interface FocusStatus {
  running: boolean;
  mode: 'focus' | 'break';
  totalSeconds: number;
  remainingSeconds: number;
  sessionsCompleted: number;
}

export interface PetStatus {
  hunger: number;
  energy: number;
  happiness: number;
  affection: number;
  updatedAt: number;
}

export type PetInteraction = 'snack' | 'meal' | 'drink' | 'play' | 'rest' | 'praise';

export type ReactionName =
  | 'greet'
  | 'joy'
  | 'surprised'
  | 'angry'
  | 'sleepy'
  | 'poke'
  | 'bow'
  | 'stretch'
  | 'dance'
  | 'lookAround'
  | 'nod'
  | 'shakeHead'
  | 'shy'
  | 'cheer'
  | 'think'
  | 'crouch'
  | 'tiptoe'
  | 'sway';
export type AutonomousMotion = 'idle' | 'walk';
export interface AutonomyCommand {
  action: AutonomousMotion;
  direction?: -1 | 1;
  duration?: number;
}
export type HitZone = 'head' | 'body' | 'lower';
