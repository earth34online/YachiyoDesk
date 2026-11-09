import {
  VRM,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
  type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clamp, damp, nextAdaptiveScale, normalizedPointer } from './math';
import { ProceduralAnimator } from './ProceduralAnimator';
import { DesktopContactPose, type DesktopContactState } from './DesktopContactPose';
import type { MotionPlaybackOptions } from './MotionPlayer';
import { DesktopProps } from './DesktopProps';
import { shouldCombineSkeletons } from './skin-policy';
import { repairPmxSkinSeams } from './skinSeams';
import { repairPmxSkinGradients } from './skinGradients';
import { configureMissingSpringContacts, type AutomaticContactReport } from './automaticSpringContacts';
import { GarmentContactSolver } from './garmentContact';
import { alphaFootprint } from './avatar-footprint';
import { prepareGenericPmxSpringSpace } from './springContactSpace';
import { connectAuthoredArmContacts } from './springArmContacts';
import { PmxPhysics } from './pmxPhysics';
import { rigHitZone } from './interactionZone';
import { updateSkinnedInteractionBounds } from './interactionBounds';
import type {
  AppSettings,
  AvatarViewportBounds,
  AutonomyCommand,
  BootstrapData,
  HitZone,
  MotionProfile,
  QualityMode,
  ReactionName,
  RuntimeDiagnostics,
  RuntimePerformanceStats,
} from './types';

interface RuntimeCallbacks {
  onProgress: (percent: number, detail: string) => void;
  onReady: (diagnostics: RuntimeDiagnostics) => void;
  onFatal: (error: Error) => void;
  onSetupRequired?: () => void;
  onViewportBounds?: (bounds: AvatarViewportBounds) => void;
  onFrame?: () => void;
}

type UpdatableMaterial = THREE.Material & { update?: (delta: number) => void };

function disposeModelScene(scene: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  const bitmaps = new Set<ImageBitmap>();
  const collectTexture = (value: unknown) => {
    if (!(value as THREE.Texture | null)?.isTexture) return;
    const image = (value as THREE.Texture).source.data;
    for (const entry of Array.isArray(image) ? image : [image]) {
      if (typeof ImageBitmap !== 'undefined' && entry instanceof ImageBitmap) bitmaps.add(entry);
    }
  };
  scene.traverse(object => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((object as THREE.SkinnedMesh).skeleton);
    const materials = (object as THREE.Mesh).material;
    for (const material of Array.isArray(materials) ? materials : materials ? [materials] : []) {
      Object.values(material).forEach(collectTexture);
      if ((material as THREE.ShaderMaterial).uniforms) {
        Object.values((material as THREE.ShaderMaterial).uniforms).forEach(uniform => collectTexture(uniform.value));
      }
    }
  });
  for (const skeleton of skeletons) skeleton.dispose();
  VRMUtils.deepDispose(scene);
  // Texture.dispose releases WebGL resources, but not ImageBitmap's decoded
  // CPU pixels. Close only when this owned model exits, never after upload:
  // a live model still needs its images for WebGL context recovery.
  for (const bitmap of bitmaps) bitmap.close();
}

export class AvatarRuntime {
  private desktopProps: DesktopProps | null = null;
  private windowPeek: { phase: string; side: number; progress: number } | null = null;
  propSnapshot(): Record<string, unknown> | null { return this.desktopProps ? { ...this.desktopProps.diagnostics } : null; }
  setWindowPeekState(state: { phase: string; side: number; progress: number }): void {
    if (!this.windowPeek && state.phase !== 'idle') { this.stopMotion(); this.animator?.setAutonomousMotion('idle', 1); }
    this.windowPeek = state.phase === 'idle' ? null : state;
  }
  private motionPlayer: import('./MotionPlayer').MotionPlayer | null = null;
  private motionSequence = 0;
  private automaticContactReport: AutomaticContactReport | null = null;

  springContactConfigurationSnapshot(): AutomaticContactReport | null {
    return this.automaticContactReport ? structuredClone(this.automaticContactReport) : null;
  }
  private voiceMouth = 0;
  private naturalIdleBytes: ArrayBuffer | null = null;
  private naturalIdlePending = false;
  private naturalIdleFailed = false;
  private readonly reactionMotions = new Map<ReactionName, { bytes: ArrayBuffer; name: string }>();
  private motionKind: 'natural' | 'user' | 'reaction' | 'window' | null = null;
  private readonly windowRestMotions = new Map<'enter' | 'idle' | 'exit', { bytes: ArrayBuffer; name: string }>();
  private windowRestStage: 'off' | 'enter' | 'idle' | 'exit' | 'leaving' = 'off';
  private windowRestSequence = 0;
  private windowRestLoading = false;
  private windowRestElapsed = 0;
  private windowRestStartWeight = 0;
  private seatWeight = 0;
  private footExtents: { bone: THREE.Object3D; corners: THREE.Vector3[] }[] = [];
  private motionKeepsHipsHeight = false;
  private motionCameraOffset = 0;
  private nextViewportNotification = 0;
  private viewportDirty = false;
  private queuedWindowAction: { run: () => void; cancel: () => void } | null = null;
  private idleResumeAt = 0;
  configureNaturalIdle(bytes: ArrayBuffer): void { this.naturalIdleBytes = bytes; this.naturalIdleFailed = false; }
  configureReactionMotion(reaction: ReactionName, bytes: ArrayBuffer, name: string): void {
    if (!this.disposed) this.reactionMotions.set(reaction, { bytes, name });
  }
  configureWindowRestMotion(kind: 'enter' | 'idle' | 'exit', bytes: ArrayBuffer, name: string): void {
    if (!this.disposed) this.windowRestMotions.set(kind, { bytes, name });
  }
  async playMotion(bytes: ArrayBuffer, name: string, loop = false, options: MotionPlaybackOptions = {}): Promise<void> {
    if (this.windowRestStage !== 'off') {
      return new Promise<void>((resolve, reject) => {
        this.queuedWindowAction?.cancel();
        this.queuedWindowAction = {
          run: () => { void this.startMotion(bytes, name, loop, 'user', options).then(resolve, reject); },
          cancel: () => reject(new Error('动作已取消。')),
        };
        this.requestWindowRise();
      });
    }
    return this.startMotion(bytes,name,loop,'user',options);
  }
  private async startMotion(bytes: ArrayBuffer,name: string,loop: boolean,kind: 'natural'|'user'|'reaction'|'window',options: MotionPlaybackOptions = {}): Promise<void> {
    const sequence = ++this.motionSequence;
    const vrm=this.vrm;
    if (!vrm || this.disposed) throw new Error('请先载入角色。');
    if (!this.motionPlayer) { const { MotionPlayer } = await import('./MotionPlayer'); if(sequence !== this.motionSequence || this.vrm!==vrm || this.disposed) return; this.motionPlayer ||= new MotionPlayer(vrm, this.animator?.drivenBoneNames); }
    this.motionKind=kind;
    this.motionKeepsHipsHeight = Boolean(options.preserveHipsHeight);
    await this.motionPlayer.play(bytes, name, loop, options);
    if (sequence !== this.motionSequence || this.vrm !== vrm || this.disposed) return;
    this.desktopProps?.dispose(); this.desktopProps = null;
    if (options.prop && this.motionPlayer.clip) this.desktopProps = new DesktopProps(vrm, options.prop, this.motionPlayer.clip);
    this.noteActivity();
  }
  stopMotion(): void {
    this.queuedWindowAction?.cancel(); this.queuedWindowAction = null;
    if (this.windowRestStage !== 'off') { this.requestWindowRise(); return; }
    this.stopLayers();
  }
  private stopLayers(immediate = false): void {
    if (immediate) { this.desktopProps?.dispose(); this.desktopProps = null; }
    else this.desktopProps?.cancel();
    ++this.motionSequence; this.motionPlayer?.stop(immediate);
    if (immediate || this.motionKind !== 'window') this.motionKind=null;
    this.idleResumeAt=performance.now()+3000;
  }
  private cancelWindowRest(immediate = true): void {
    ++this.windowRestSequence;
    this.windowRestStage = 'off'; this.windowRestLoading = false; this.windowRestElapsed = 0; this.seatWeight = 0;
    this.queuedWindowAction?.cancel(); this.queuedWindowAction = null;
    this.viewportDirty = true;
    this.desktopContactPose?.set({ phase: 'idle' });
    this.stopLayers(immediate);
  }
  private async beginWindowMotion(stage: 'enter' | 'idle' | 'exit'): Promise<void> {
    const sequence = ++this.windowRestSequence, motion = this.windowRestMotions.get(stage);
    this.windowRestStage = stage; this.windowRestLoading = true; this.windowRestElapsed = 0;
    this.windowRestStartWeight = this.seatWeight;
    try {
      if (!motion) throw new Error('窗口休息动作尚未载入。');
      await this.startMotion(motion.bytes, motion.name, stage === 'idle', 'window', { preserveHipsHeight: true, hold: stage !== 'idle' });
      if (sequence !== this.windowRestSequence || this.disposed) return;
      this.windowRestElapsed = 0;
    } catch (error) {
      if (sequence !== this.windowRestSequence || this.disposed) return;
      console.warn('Window rest motion unavailable; releasing contact.', error);
      this.cancelWindowRest();
    } finally {
      if (sequence === this.windowRestSequence) this.windowRestLoading = false;
    }
  }
  private requestWindowRise(): void {
    if (this.windowRestStage === 'off' || this.windowRestStage === 'exit' || this.windowRestStage === 'leaving') return;
    this.desktopContactPose?.set({ phase: 'rise' });
    void this.beginWindowMotion('exit');
  }
  private updateWindowRest(delta: number): void {
    if (this.windowRestStage === 'off') return;
    this.viewportDirty = true;
    if (this.windowRestLoading) return;
    this.windowRestElapsed += delta;
    const progress = clamp(this.windowRestElapsed / Math.max(.001, this.motionPlayer?.duration || 1), 0, 1);
    const smooth = progress * progress * (3 - 2 * progress);
    if (this.windowRestStage === 'enter') {
      this.seatWeight = THREE.MathUtils.lerp(this.windowRestStartWeight, 1, smooth);
      if (this.motionPlayer?.finished) { this.seatWeight = 1; void this.beginWindowMotion('idle'); }
    } else if (this.windowRestStage === 'idle') {
      this.seatWeight = 1;
    } else if (this.windowRestStage === 'exit') {
      this.seatWeight = THREE.MathUtils.lerp(this.windowRestStartWeight, 0, smooth);
      if (this.motionPlayer?.finished) { this.seatWeight = 0; this.windowRestStage = 'leaving'; this.stopLayers(); }
    } else if (!this.motionPlayer?.playing) {
      this.windowRestStage = 'off'; this.seatWeight = 0;
      this.desktopContactPose?.set({ phase: 'idle' });
      const queued = this.queuedWindowAction; this.queuedWindowAction = null;
      queued?.run();
    }
  }
  get motionPlaying(): boolean { return this.motionPlayer?.playing ?? false; }
  get canPlayLibraryMotion(): boolean { return this.windowRestStage==='off' && Boolean(this.animator?.canUseIdleAnimation && (this.motionKind==='natural' || !this.motionPlaying)); }
  setVoiceMouth(value: number): void { this.voiceMouth = Number.isFinite(value) ? clamp(value, 0, 1) : 0; }
  captureImage(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
  private readonly canvas: HTMLCanvasElement;
  private readonly bootstrap: BootstrapData;
  private readonly callbacks: RuntimeCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100);
  private readonly avatarPivot = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly shadow: THREE.Mesh;
  private readonly interactiveMeshes: THREE.Object3D[] = [];
  private vrm: VRM | null = null;
  private animator: ProceduralAnimator | null = null;
  private desktopContactPose: DesktopContactPose | null = null;
  private pointerDragging = false;
  private garmentContact: GarmentContactSolver | null = null;
  private pmxPhysics: PmxPhysics | null = null;
  private pmxPhysicsFailure = '';
  private loading: Promise<void> | null = null;
  private loadSequence = 0;
  private settings: AppSettings;
  private modelHeight = 1.65;
  private modelWidth = 0.55;
  private modelDepth = 0.30;
  private baseCameraDistance = 3;
  private targetRotationY = 0;
  private currentRotationY = 0;
  private autonomyFacing = 0;
  private declaredTextureCount = 0;
  private tunedSpringJointCount = 0;
  private previousTimestamp = 0;
  private lastRenderedTimestamp = 0;
  private nextAdaptiveAssessment = 8000;
  private renderedFrameCount = 0;
  private interactionBoundsFrame = -1;
  private adaptiveScale = 1;
  private readonly frameDurations: number[] = [];
  private started = false;
  private disposed = false;
  private suspended = false;
  private diagnosticBindPose = false;
  private footprintTarget: THREE.WebGLRenderTarget | null = null;
  private footprintPixels = new Uint8Array(0);
  private renderedFootprint: AvatarViewportBounds | null = null;
  private footprintZoom = 0;
  private footprintPending = false;
  private nextFootprintAt = 0;
  private footprintFailed = false;

  constructor(canvas: HTMLCanvasElement, bootstrap: BootstrapData, callbacks: RuntimeCallbacks) {
    this.canvas = canvas;
    this.bootstrap = bootstrap;
    this.callbacks = callbacks;
    this.settings = bootstrap.settings;
    this.pmxPhysicsFailure = bootstrap.pmxPhysicsError ?? '';
    this.suspended = bootstrap.stageSuspended ?? false;
    this.targetRotationY = this.settings.rotationY;
    this.currentRotationY = this.settings.rotationY;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // Let Chromium choose the adapter that owns the Windows compositor.
      // Forcing a discrete GPU can make a transparent surface cross adapters
      // on hybrid systems, adding copies and visible presentation instability.
      powerPreference: 'default',
      preserveDrawingBuffer: false,
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.sortObjects = true;

    this.scene.add(this.avatarPivot);
    this.shadow = this.createContactShadow();
    this.scene.add(this.shadow);
    this.configureLighting();
    this.applyQuality(this.settings.quality);
    this.resize();
  }

  load(): Promise<void> {
    if (this.disposed || this.started) return Promise.resolve();
    if (!this.loading) this.loading = this.loadModel().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async loadModel(): Promise<void> {
    const sequence = ++this.loadSequence;
    const current = () => !this.disposed && sequence === this.loadSequence;
    let detachedScene: THREE.Object3D | null = null;
    try {
      const modelUrl = this.bootstrap.modelUrl;
      if (!modelUrl) {
        this.callbacks.onSetupRequired?.();
        return;
      }
      this.callbacks.onProgress(4, '初始化 WebGL 与 MToon 材质…');
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

      const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
        loader.load(
          modelUrl,
          resolve,
          (event) => {
            if (!current()) return;
            const progress = event.total > 0 ? event.loaded / event.total : 0;
            this.callbacks.onProgress(8 + progress * 68, `载入角色模型 ${Math.round(progress * 100)}%`);
          },
          reject,
        );
      });

      detachedScene = gltf.scene;
      if (!current()) {
        disposeModelScene(detachedScene);
        detachedScene = null;
        return;
      }

      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) throw new Error('该文件未包含可识别的 VRM 数据。');
      const parserJson = (gltf.parser as unknown as { json?: { images?: unknown[] } }).json;
      this.declaredTextureCount = parserJson?.images?.length ?? 0;
      this.callbacks.onProgress(80, '优化蒙皮与显存布局…');

      if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      // Preserve converted PMX skeleton/bind pairs; combining them can detach
      // garment vertices even when the exported skin is symmetric.
      // Built-in and direct VRM characters retain the original optimization.
      if (shouldCombineSkeletons(this.bootstrap.character.motionProfile)) {
        VRMUtils.combineSkeletons(vrm.scene);
      }
      const damagedSkins = new Set<THREE.SkinnedMesh>();
      const seamRepairs = repairPmxSkinSeams(vrm.scene, this.bootstrap.character.motionProfile, mesh => damagedSkins.add(mesh));
      if (seamRepairs.vertices) console.info('Repaired split PMX skin seams', seamRepairs);
      const gradientRepairs = repairPmxSkinGradients(vrm, this.bootstrap.character.motionProfile, damagedSkins);
      if (gradientRepairs.vertices) console.info('Repaired PMX upper-body skin gradients', gradientRepairs);
      this.vrm = vrm;
      detachedScene = null; // The runtime now owns this model, including failure cleanup.
      this.prepareModel(vrm);
      this.applyMotionProfile(vrm, this.bootstrap.character.motionProfile);
      prepareGenericPmxSpringSpace(vrm, this.bootstrap.character.motionProfile);
      if (this.bootstrap.pmxPhysicsUrl) {
        this.callbacks.onProgress(84, '载入 PMX 原始刚体与关节…');
        try {
          this.pmxPhysics = await PmxPhysics.load(vrm, this.bootstrap.character.motionProfile, this.bootstrap.pmxPhysicsUrl, current);
        } catch (error) {
          this.pmxPhysicsFailure = String(error instanceof Error ? error.message : error);
          console.warn('Original PMX physics unavailable; retaining VRM physics.', error);
        }
        if (!current()) return;
      }

      this.automaticContactReport = configureMissingSpringContacts(vrm, this.bootstrap.character.motionProfile, !!this.pmxPhysics,
        this.bootstrap.character.contactConfiguration);
      const armContacts = connectAuthoredArmContacts(vrm, this.bootstrap.character.motionProfile, !!this.pmxPhysics);
      if (armContacts.joints) console.info('Connected authored arm contacts', armContacts);

      // Converted PMX garments with identifiable body/cloth meshes receive a
      // local triangle-contact pass. Built-in Yachiyo and direct VRM assets
      // never enter this path; unsupported meshes keep their original skin.
      this.garmentContact = this.pmxPhysics ? null : GarmentContactSolver.create(vrm, this.bootstrap.character.motionProfile);
      if (this.garmentContact) {
        for (const { source, display } of this.garmentContact.replacements) {
          const index = this.interactiveMeshes.indexOf(source);
          // Keep both targets: the solver may fall back to the source mesh at
          // runtime, and hitTest already ignores whichever one is invisible.
          if (index >= 0) this.interactiveMeshes.push(display);
        }
        this.garmentContact.setEnabled(this.settings.physics);
      }

      this.animator = new ProceduralAnimator(vrm, this.settings, this.bootstrap.character.motionProfile);
      this.animator.setOriginalPmxPhysics(!!this.pmxPhysics);
      vrm.springBoneManager?.setInitState();
      this.callbacks.onProgress(94, '启动表情、视线与摇摆骨骼…');

      // Compile while the loading UI still owns the window, before advancing
      // simulation time. The first interactive frame must not include shader
      // compilation or instantiate physics from a different bind pose.
      this.pmxPhysics?.beforePose();
      this.animator.update(0);
      this.updateVrm(0);
      this.measureFootExtents(vrm);
      this.callbacks.onProgress(96, '准备角色材质…');
      await this.renderer.compileAsync(this.scene, this.camera);
      if (!current()) return;

      // Measure the posed avatar before anchoring its first window at the edge.
      // Never feed animated bounds back into camera fitting or window size.
      if (this.usesRenderedFootprint()) {
        await this.measureRenderedFootprint();
      }

      if (!current()) return;

      this.started = true;
      if (!this.suspended) this.renderer.setAnimationLoop((timestamp) => this.renderFrame(timestamp));
      this.callbacks.onProgress(100, '角色已准备好');
      const diagnostics = this.collectDiagnostics();
      this.callbacks.onReady(diagnostics);
    } catch (unknownError) {
      if (detachedScene) disposeModelScene(detachedScene);
      if (!current()) return;
      this.started = false;
      this.renderer.setAnimationLoop(null);
      this.releaseModel();
      const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
      this.callbacks.onFatal(error);
    }
  }

  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    // Freeze the simulation clock together with rendering. Resuming must not
    // feed a hidden window's elapsed wall time into springs or pose blending.
    this.previousTimestamp = 0;
    this.lastRenderedTimestamp = 0;
    this.renderer.setAnimationLoop(!suspended && this.started ? (timestamp) => this.renderFrame(timestamp) : null);
  }

  humanoidPoseSnapshot(localSpace = false): Record<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number }> {
    if (!this.vrm) return {};
    const positions: Record<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number }> = {};
    const point = new THREE.Vector3();
    const bones = [
      VRMHumanBoneName.Hips,
      VRMHumanBoneName.LeftUpperLeg, VRMHumanBoneName.LeftLowerLeg, VRMHumanBoneName.LeftFoot,
      VRMHumanBoneName.LeftToes,
      VRMHumanBoneName.RightUpperLeg, VRMHumanBoneName.RightLowerLeg, VRMHumanBoneName.RightFoot,
      VRMHumanBoneName.RightToes,
      VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.LeftLowerArm, VRMHumanBoneName.LeftHand,
      VRMHumanBoneName.RightUpperArm, VRMHumanBoneName.RightLowerArm, VRMHumanBoneName.RightHand,
      VRMHumanBoneName.RightIndexProximal, VRMHumanBoneName.RightMiddleProximal,
      VRMHumanBoneName.RightLittleProximal, VRMHumanBoneName.RightThumbProximal,
    ];
    this.avatarPivot.updateWorldMatrix(true, true);
    for (const bone of bones) {
      const node = this.vrm.humanoid.getRawBoneNode(bone);
      if (!node) continue;
      node.getWorldPosition(point);
      if (localSpace) this.avatarPivot.worldToLocal(point);
      positions[bone] = {
        x: Number(point.x.toFixed(4)),
        y: Number(point.y.toFixed(4)),
        z: Number(point.z.toFixed(4)),
        rx: Number(node.rotation.x.toFixed(4)),
        ry: Number(node.rotation.y.toFixed(4)),
        rz: Number(node.rotation.z.toFixed(4)),
      };
    }
    return positions;
  }

  secondaryPoseSnapshot(): Record<string, [number, number, number, number]> {
    const result: Record<string, [number, number, number, number]> = {};
    for (const joint of this.vrm?.springBoneManager?.joints ?? []) {
      if (!joint.bone.name.startsWith('AutoSleeve_')) continue;
      const { x, y, z, w } = joint.bone.quaternion;
      result[joint.bone.name] = [x, y, z, w];
    }
    return result;
  }

  garmentContactSnapshot(): Record<string, unknown> | null {
    if (this.pmxPhysics) return { ...this.pmxPhysics.diagnostics, enabled: this.settings.physics };
    if (this.pmxPhysicsFailure) return { ...(this.garmentContact?.diagnostics ?? {}), pmxPhysicsFailure: this.pmxPhysicsFailure };
    return this.garmentContact ? { ...this.garmentContact.diagnostics } : GarmentContactSolver.lastProbe;
  }

  anatomySnapshot(): Record<string, unknown> | null {
    return this.animator?.getAnatomyDiagnostics() ?? null;
  }

  fingerFlexionSamples(): Array<Record<string, unknown>> {
    return this.animator?.sampleFingerFlexion() ?? [];
  }

  setDiagnosticBindPose(active: boolean): void {
    if (!this.bootstrap.smokeTest || !this.vrm) return;
    this.diagnosticBindPose = active;
    if (active) {
      this.cancelWindowRest();
      this.vrm.humanoid.resetNormalizedPose();
      this.vrm.springBoneManager?.reset();
    }
  }

  setSettings(settings: AppSettings): void {
    if(this.motionKind==='natural' && !settings.naturalIdle)this.stopMotion();
    const qualityChanged = settings.quality !== this.settings.quality;
    const physicsChanged = settings.physics !== this.settings.physics;
    const adaptiveChanged = settings.adaptivePerformance !== this.settings.adaptivePerformance;
    this.settings = settings;
    this.targetRotationY = settings.rotationY;
    this.shadow.visible = settings.contactShadow;
    this.animator?.setSettings(settings);
    if (qualityChanged) {
      this.adaptiveScale = 1;
      this.applyQuality(settings.quality);
      this.resize();
    }
    if (adaptiveChanged && !settings.adaptivePerformance) {
      this.adaptiveScale = 1;
      this.updateRendererPixelRatio();
    }
    if (physicsChanged) {
      this.vrm?.springBoneManager?.reset();
      this.pmxPhysics?.reset();
      this.garmentContact?.setEnabled(settings.physics);
    }
    this.updateCamera();
  }

  setPointer(clientX: number, clientY: number, active: boolean): void {
    const normalized = normalizedPointer(clientX, clientY, this.canvas.clientWidth, this.canvas.clientHeight);
    this.animator?.setPointer(normalized.x, normalized.y, active);
  }

  noteActivity(): void {
    this.animator?.noteActivity();
  }

  triggerReaction(name: ReactionName): void {
    if (!this.settings.reactions && name !== 'sleepy') return;
    if (this.windowRestStage !== 'off') {
      this.queuedWindowAction?.cancel();
      this.queuedWindowAction = { run: () => this.triggerReaction(name), cancel: () => {} };
      this.requestWindowRise();
      return;
    }
    this.stopMotion();
    this.autonomyFacing = 0;
    this.animator?.trigger(name);
    const motion = this.reactionMotions.get(name);
    if (motion && this.bootstrap.character.motionProfile.profileId === 'generic-vrm') {
      const sequence = this.motionSequence + 1;
      void this.startMotion(motion.bytes, motion.name, false, 'reaction', { preserveHipsHeight: true }).then(() => {
        if (sequence === this.motionSequence && this.motionPlayer?.duration) {
          this.animator?.trigger(name, this.motionPlayer.duration);
        }
      }).catch(error => console.warn('Gesture animation unavailable; retaining procedural gesture.', error));
    }
  }

  setDesktopContact(state: DesktopContactState): void {
    if (!this.vrm) return;
    if (state.phase === 'sit') {
      if (this.windowRestStage !== 'off') return;
      if (!['enter','idle','exit'].every(kind => this.windowRestMotions.has(kind as 'enter'|'idle'|'exit'))) {
        console.warn('Window rest requires all three configured animation segments.');
        return;
      }
      this.stopLayers(); this.autonomyFacing = 0;
      this.animator?.setAutonomousMotion('idle',1);
      this.desktopContactPose ??= new DesktopContactPose(this.vrm,this.camera,this.canvas);
      this.desktopContactPose.set(state);
      void this.beginWindowMotion('enter');
      return;
    }
    if (state.phase === 'rise' || (state.phase === 'idle' && this.windowRestStage !== 'off')) { this.requestWindowRise(); return; }
    if (state.phase !== 'idle') {
      this.cancelWindowRest(state.phase !== 'fall');
      this.animator?.setAutonomousMotion('idle',1);
    }
    this.animator?.setDragging(this.pointerDragging || state.phase === 'fall');
    this.desktopContactPose ??= new DesktopContactPose(this.vrm,this.camera,this.canvas);
    this.desktopContactPose.set(state);
  }

  desktopContactSnapshot(): Record<string, unknown> | null {
    return this.desktopContactPose ? { ...this.desktopContactPose.diagnostics, windowRestStage: this.windowRestStage,
      seatWeight: this.seatWeight, windowRestConfigured: this.windowRestMotions.size } : null;
  }

  setAutonomy(command: AutonomyCommand): void {
    if (this.windowRestStage !== 'off') {
      this.animator?.setAutonomousMotion('idle',1);
      this.autonomyFacing = 0;
      return;
    }
    if (command.action === 'walk') this.stopMotion();
    const direction = command.direction === -1 ? -1 : 1;
    // A desktop walk travels horizontally while the camera looks at the
    // avatar. A shallow turn keeps the face almost front-facing while the
    // stronger normalized leg chain still provides a visible step;
    // the pointer/action interrupt still returns immediately to face the user.
    this.autonomyFacing = command.action === 'walk' ? direction * 0.33 : 0;
    this.animator?.setAutonomousMotion(command.action, direction);
  }

  setDragging(active: boolean): void {
    this.pointerDragging = active;
    if (active) this.cancelWindowRest(false);
    this.autonomyFacing = 0;
    this.animator?.setDragging(active);
  }

  resetPose(): void {
    this.cancelWindowRest();
    this.targetRotationY = 0;
    this.currentRotationY = 0;
    this.avatarPivot.rotation.y = 0;
    this.autonomyFacing = 0;
    this.animator?.reset();
    this.vrm?.springBoneManager?.reset();
    this.garmentContact?.reset();
    this.pmxPhysics?.reset();
  }

  setRotation(rotationY: number): void {
    this.targetRotationY = clamp(rotationY, -Math.PI, Math.PI);
  }

  setZoom(zoom: number): void {
    this.settings = { ...this.settings, zoom: clamp(zoom, 0.10, 2.4) };
    this.updateCamera();
  }

  getPerformanceStats(): RuntimePerformanceStats {
    const samples = this.frameDurations.slice(-300);
    const averageFrameMs = samples.length > 0
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const p95FrameMs = sorted[percentileIndex] ?? 0;
    return {
      renderedFrames: this.renderedFrameCount,
      suspended: this.suspended,
      averageFps: averageFrameMs > 0 ? Number((1000 / averageFrameMs).toFixed(2)) : 0,
      averageFrameMs: Number(averageFrameMs.toFixed(3)),
      p95FrameMs: Number(p95FrameMs.toFixed(3)),
      maximumFrameMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
      sampleCount: samples.length,
      targetFps: this.targetFps(),
      pixelRatio: Number(this.renderer.getPixelRatio().toFixed(3)),
      adaptiveScale: Number(this.adaptiveScale.toFixed(3)),
      drawCalls: this.renderer.info.render.calls,
      renderedTriangles: this.renderer.info.render.triangles,
      gpuTextureCount: this.renderer.info.memory.textures,
      gpuGeometryCount: this.renderer.info.memory.geometries,
    };
  }

  hitTest(clientX: number, clientY: number): THREE.Intersection | null {
    if (!this.started || !this.vrm) return null;
    if (this.interactionBoundsFrame !== this.renderedFrameCount) {
      for (const object of this.interactiveMeshes) {
        const mesh = object as THREE.Mesh;
        if (!mesh.visible) continue;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) updateSkinnedInteractionBounds(mesh as THREE.SkinnedMesh);
        else { mesh.geometry.boundingBox = null; mesh.geometry.computeBoundingSphere(); }
      }
      this.interactionBoundsFrame = this.renderedFrameCount;
    }
    const pointer = normalizedPointer(clientX, clientY, this.canvas.clientWidth, this.canvas.clientHeight);
    this.raycaster.setFromCamera(pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(this.interactiveMeshes, false);
    return intersections.find((intersection) => intersection.object.visible) ?? null;
  }

  hitZone(intersection: THREE.Intersection): HitZone {
    if (this.vrm) {
      const source = this.garmentContact?.replacements.find(item => item.display === intersection.object)?.source;
      const zone = rigHitZone(this.vrm, intersection, source);
      if (zone) return zone;
    }
    const normalizedHeight = intersection.point.y / Math.max(0.001, this.modelHeight);
    if (normalizedHeight >= 0.68) return 'head';
    if (normalizedHeight >= 0.34) return 'body';
    return 'lower';
  }

  headScreenPosition(): { x: number; y: number } | null {
    const head = this.vrm?.humanoid.getRawBoneNode(VRMHumanBoneName.Head);
    if (!head) return null;
    const position = head.getWorldPosition(new THREE.Vector3());
    position.y += this.modelHeight * 0.08;
    position.project(this.camera);
    return {
      x: (position.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-position.y * 0.5 + 0.5) * this.canvas.clientHeight,
    };
  }

  avatarViewportBounds(): AvatarViewportBounds {
    const canvasWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    if (!this.vrm) return { left: 0, right: canvasWidth, canvasWidth };
    if (this.usesRenderedFootprint() && this.renderedFootprint
      && this.renderedFootprint.canvasWidth === canvasWidth
      && this.footprintZoom === this.settings.zoom) return { ...this.renderedFootprint, ...this.desktopContactGeometry() };

    // Project the neutral mesh footprint for the current user rotation plus
    // either walking direction. This deliberately does not refit the camera or
    // inspect animated cloth every frame, so it cannot reintroduce the former
    // scale-growth/flicker bug. A small logical-pixel guard covers spring motion
    // and antialiased edge pixels while still allowing transparent host margins
    // to extend beyond the physical display.
    const halfWidth = this.modelWidth * 0.5;
    const halfDepth = this.modelDepth * 0.5;
    const horizontalFov = 2 * Math.atan(
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * Math.max(0.01, this.camera.aspect),
    );
    const tangent = Math.max(0.0001, Math.tan(horizontalFov / 2));
    const angles = [this.settings.rotationY - 0.33, this.settings.rotationY, this.settings.rotationY + 0.33];
    let projectedHalfWidth = 0;
    for (const angle of angles) {
      const cosine = Math.abs(Math.cos(angle));
      const sine = Math.abs(Math.sin(angle));
      const worldHalfWidth = halfWidth * cosine + halfDepth * sine;
      const worldHalfDepth = halfWidth * sine + halfDepth * cosine;
      const nearestDepth = Math.max(this.camera.near * 2, this.camera.position.z - worldHalfDepth);
      projectedHalfWidth = Math.max(
        projectedHalfWidth,
        worldHalfWidth / (nearestDepth * tangent) * canvasWidth * 0.5,
      );
    }
    const guard = Math.min(16, Math.max(8, canvasWidth * 0.022));
    const extent = Math.min(canvasWidth * 0.5, projectedHalfWidth + guard);
    return {
      left: Math.floor(canvasWidth * 0.5 - extent),
      right: Math.ceil(canvasWidth * 0.5 + extent),
      canvasWidth,
      ...this.desktopContactGeometry(),
    };
  }

  private desktopContactGeometry(): Partial<AvatarViewportBounds> {
    const height = Math.max(1,this.canvas.clientHeight || window.innerHeight);
    const width = Math.max(1,this.canvas.clientWidth || window.innerWidth);
    const project = (point: THREE.Vector3): THREE.Vector2 => {
      point.project(this.camera); return new THREE.Vector2((point.x*.5+.5)*width,(-point.y*.5+.5)*height);
    };
    const floor = project(new THREE.Vector3(0,0,0));
    const top = project(new THREE.Vector3(0,this.modelHeight,0));
    const feet = ['leftFoot','rightFoot','leftToes','rightToes'].flatMap(name => {
      const bone = this.vrm?.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      return bone ? [project(bone.getWorldPosition(new THREE.Vector3())).x] : [];
    });
    const soleGuard = Math.max(2,Math.abs(floor.y-top.y)*.018);
    let supportY: number | undefined;
    if ((this.windowRestStage && this.windowRestStage !== 'off') || this.seatWeight > 0) {
      const hips = this.vrm?.humanoid.getRawBoneNode('hips');
      const left = this.vrm?.humanoid.getRawBoneNode('leftUpperLeg');
      const right = this.vrm?.humanoid.getRawBoneNode('rightUpperLeg');
      if (hips && left && right) {
        const hip = hips.getWorldPosition(new THREE.Vector3());
        const leftHip = left.getWorldPosition(new THREE.Vector3()), rightHip = right.getWorldPosition(new THREE.Vector3());
        const seat = leftHip.clone().add(rightHip).multiplyScalar(.5).lerp(hip,.5);
        // Pelvis width gives a rig-derived approximation of the underside,
        // instead of a character-specific screen offset or standing feet.
        seat.y -= leftHip.distanceTo(rightHip) * .25;
        supportY = THREE.MathUtils.lerp(floor.y, project(seat).y, this.seatWeight);
      }
    }
    return { canvasHeight:height,footY:floor.y,supportY,footLeft:Math.max(0,Math.min(...feet,width*.5)-soleGuard),
      footRight:Math.min(width,Math.max(...feet,width*.5)+soleGuard),avatarHeight:Math.abs(floor.y-top.y) };
  }

  private measureFootExtents(vrm: VRM): void {
    const bounds = new Map<THREE.Object3D, THREE.Box3>();
    for (const name of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
      const bone = vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      if (bone) bounds.set(bone, new THREE.Box3());
    }
    const vertex = new THREE.Vector3();
    vrm.scene.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
      if (!indices || !weights) return;
      for (let i = 0; i < indices.count; i++) {
        let owner: THREE.Object3D | undefined, largest = 0, footWeight = 0;
        for (let slot = 0; slot < 4; slot++) {
          const bone = mesh.skeleton.bones[indices.getComponent(i, slot)], weight = weights.getComponent(i, slot);
          if (bounds.has(bone)) { footWeight += weight; if (weight > largest) { owner = bone; largest = weight; } }
        }
        if (owner && footWeight >= .5) {
          mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
          bounds.get(owner)!.expandByPoint(owner.worldToLocal(vertex));
        }
      }
    });
    this.footExtents = [...bounds].filter(([,box]) => !box.isEmpty()).map(([bone, box]) => ({ bone,
      corners: [0,1,2,3,4,5,6,7].map(mask => new THREE.Vector3(mask&1?box.max.x:box.min.x,
        mask&2?box.max.y:box.min.y,mask&4?box.max.z:box.min.z)) }));
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  dispose(): void {
    this.desktopProps?.dispose(); this.desktopProps = null;
    this.cancelWindowRest();
    this.naturalIdleBytes=null;
    this.reactionMotions?.clear();
    this.windowRestMotions?.clear();
    this.motionPlayer?.dispose(); this.motionPlayer = null;
    if (this.disposed) return;
    this.disposed = true;
    this.loadSequence++;
    this.renderer.setAnimationLoop(null);
    this.started = false;
    this.releaseModel();
    this.footprintTarget?.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private releaseModel(): void {
    this.cancelWindowRest();
    this.pmxPhysics?.dispose();
    this.pmxPhysics = null;
    this.garmentContact?.dispose();
    this.garmentContact = null;
    const vrm = this.vrm;
    this.vrm = null;
    this.animator = null;
    this.desktopContactPose = null;
    this.interactiveMeshes.length = 0;
    this.interactionBoundsFrame = -1;
    this.tunedSpringJointCount = 0;
    this.renderedFootprint = null;
    this.footprintFailed = false;
    if (vrm) {
      vrm.scene.removeFromParent();
      disposeModelScene(vrm.scene);
    }
  }

  private configureLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xeaf6ff, 0xc8b7d7, 1.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.15);
    key.position.set(-1.8, 2.8, 3.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ec8ff, 1.05);
    rim.position.set(2.2, 1.9, -2.0);
    this.scene.add(rim);
  }

  private createContactShadow(): THREE.Mesh {
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 256;
    textureCanvas.height = 256;
    const context = textureCanvas.getContext('2d');
    if (!context) throw new Error('无法创建脚下阴影纹理。');
    const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 126);
    gradient.addColorStop(0, 'rgba(35, 29, 60, 0.30)');
    gradient.addColorStop(0.42, 'rgba(53, 48, 82, 0.18)');
    gradient.addColorStop(1, 'rgba(53, 48, 82, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.003;
    mesh.renderOrder = -2;
    mesh.visible = this.settings.contactShadow;
    return mesh;
  }

  private prepareModel(vrm: VRM): void {
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      mesh.renderOrder += 1;
      this.interactiveMeshes.push(mesh);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material.transparent ||= material.opacity < 1;
        material.needsUpdate = true;
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value && value.isTexture) {
            const texture = value as THREE.Texture;
            texture.anisotropy = this.settings.quality === 'ultra'
              ? this.renderer.capabilities.getMaxAnisotropy()
              : Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
            texture.needsUpdate = true;
          }
        }
      }
    });

    this.avatarPivot.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const center = bounds.getCenter(new THREE.Vector3());
    vrm.scene.position.add(new THREE.Vector3(-center.x, -bounds.min.y, -center.z));
    vrm.scene.updateMatrixWorld(true);

    const centeredBounds = new THREE.Box3().setFromObject(vrm.scene);
    const size = centeredBounds.getSize(new THREE.Vector3());
    this.modelHeight = size.y;
    this.modelWidth = size.x;
    this.modelDepth = size.z;
    const shadowWidth = Math.max(size.x * 0.55, size.y * 0.19);
    this.shadow.scale.set(shadowWidth, size.y * 0.17, 1);
    this.fitCamera();
    for (const object of this.interactiveMeshes) if ((object as THREE.SkinnedMesh).isSkinnedMesh) {
      updateSkinnedInteractionBounds(object as THREE.SkinnedMesh);
    }
  }

  private fitCamera(): void {
    if (!this.vrm) {
      this.camera.position.set(0, 1, 3);
      this.camera.lookAt(0, 1, 0);
      return;
    }
    // Keep framing based on the neutral model measured during load. Calling
    // Box3.setFromObject while an action or spring simulation is running makes
    // transient sleeves/hair part of the camera fit. DPI/resize notifications
    // during window movement can then repeatedly change camera distance and
    // look like the avatar is growing or flashing.
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(0.01, this.camera.aspect));
    const verticalDistance = this.modelHeight / (2 * Math.tan(verticalFov / 2));
    const horizontalDistance = this.modelWidth / (2 * Math.tan(horizontalFov / 2));
    this.baseCameraDistance = Math.max(verticalDistance * 1.08, horizontalDistance * 1.12, 0.5);
    const cameraDistance = this.baseCameraDistance / this.settings.zoom;
    const targetY = this.floorAnchoredCameraY(cameraDistance) + this.motionCameraOffset;
    this.camera.position.set(0, targetY, cameraDistance);
    this.camera.lookAt(0, targetY, 0);
    this.camera.near = Math.max(0.005, this.baseCameraDistance * 0.01);
    this.camera.far = Math.max(20, cameraDistance + this.modelHeight * 4);
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(): void {
    const cameraDistance = this.baseCameraDistance / this.settings.zoom;
    const targetY = this.floorAnchoredCameraY(cameraDistance) + this.motionCameraOffset;
    this.camera.position.set(0, targetY, cameraDistance);
    this.camera.lookAt(0, targetY, 0);
    this.camera.far = Math.max(20, cameraDistance + this.modelHeight * 4);
    this.camera.updateProjectionMatrix();
  }

  private floorAnchoredCameraY(cameraDistance: number): number {
    // The transparent host itself sits on the physical display bottom. Aim the
    // horizontal camera so world Y=0 (the normalized soles/contact shadow) is
    // rendered on the final two logical pixels instead of vertically centering
    // a small avatar and leaving it floating above the desktop edge.
    const verticalHalfExtent = cameraDistance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const canvasHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const bottomInset = Math.min(2, canvasHeight * 0.0025);
    return verticalHalfExtent * Math.max(0.90, 1 - (bottomInset * 2 / canvasHeight));
  }

  private applyQuality(quality: QualityMode): void {
    void quality;
    this.updateRendererPixelRatio();
  }

  private basePixelRatio(): number {
    if (this.settings.quality === 'ultra') return Math.min(window.devicePixelRatio, 2);
    if (this.settings.quality === 'high') return Math.min(window.devicePixelRatio, 1.5);
    return Math.min(window.devicePixelRatio, 1);
  }

  private minimumAdaptiveScale(): number {
    if (this.settings.quality === 'ultra') return 0.70;
    if (this.settings.quality === 'high') return 0.75;
    return 0.85;
  }

  private updateRendererPixelRatio(): void {
    const pixelRatio = Math.max(0.75, this.basePixelRatio() * this.adaptiveScale);
    this.renderer.setPixelRatio(pixelRatio);
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
  }

  private targetFps(): number {
    return this.settings.quality === 'balanced' ? 30 : 60;
  }

  private renderFrame(timestamp: number): void {
    if (!this.vrm || !this.animator || this.disposed || this.suspended) return;
    const targetFps = this.targetFps();
    const minimumFrameDuration = 1000 / targetFps;
    // A transparent desktop window gains no visible animation quality from
    // rendering at a 240 Hz monitor's full refresh rate while its native
    // window position is composited at 60 Hz. Keeping the whole simulation on
    // one capped clock avoids four physics/repaint updates per DWM move and is
    // materially steadier during drag and autonomous walking.
    if (timestamp - this.lastRenderedTimestamp < minimumFrameDuration - 0.5) return;

    const frameDuration = this.previousTimestamp === 0 ? 0 : timestamp - this.previousTimestamp;
    const delta = this.previousTimestamp === 0
      ? 1 / 60
      : clamp(frameDuration / 1000, 1 / 240, 0.05);
    this.previousTimestamp = timestamp;
    this.lastRenderedTimestamp = timestamp;
    if (Number.isFinite(frameDuration) && frameDuration > 0) {
      this.frameDurations.push(frameDuration);
      if (this.frameDurations.length > 600) this.frameDurations.splice(0, this.frameDurations.length - 600);
    }
    this.renderedFrameCount += 1;
    this.pmxPhysics?.beforePose();
    if (!this.diagnosticBindPose) this.animator.update(delta);
    this.updateNaturalIdle(timestamp);
    this.motionPlayer?.update(delta);
    if (!this.motionPlayer?.playing && this.windowRestStage === 'off' && this.motionKind === 'window') this.motionKind = null;
    this.updateWindowRest(delta);
    this.shadow.visible = this.settings.contactShadow && !this.windowPeek && this.windowRestStage === 'off' && this.motionKind !== 'window';
    if (this.windowRestStage !== 'off' || (this.motionKind === 'window' && this.motionPlayer?.playing)) {
      this.animator.constrainSeatedHands(this.windowRestStage === 'idle');
    }
    if (this.motionPlayer?.playing && this.motionKind !== 'natural' && this.motionKind !== 'window') this.animator.constrainExternalPose();
    if (this.desktopContactPose?.active) {
      this.desktopContactPose.update(delta);
      if (this.windowRestStage === 'off' && this.motionKind !== 'window') this.animator.constrainExternalPose();
    }
    if (this.voiceMouth > 0) {
      const manager = this.vrm.expressionManager;
      const name = manager?.getExpression('aa') ? 'aa' : manager?.getExpression('a') ? 'a' : null;
      if (name) manager?.setValue(name, this.voiceMouth);
    }
    if (this.windowPeek) {
      // A small task-local lean, driven by the window interaction's smooth
      // progress. No arm, wrist or rest-pose overrides leak into ordinary play.
      const { phase, side, progress } = this.windowPeek;
      const weight = phase === 'peek' ? THREE.MathUtils.clamp(progress,0,1) : 0;
      const chest = this.vrm.humanoid.getNormalizedBoneNode('chest');
      const head = this.vrm.humanoid.getNormalizedBoneNode('head');
      chest?.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), -side * .16 * weight));
      head?.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -side*.16*weight, -side*.08*weight)));
    }
    this.currentRotationY = damp(this.currentRotationY, this.targetRotationY + this.autonomyFacing, 8.5, delta);
    this.avatarPivot.rotation.y = this.currentRotationY;
    this.desktopProps?.applyTaskPose(this.motionPlayer?.time ?? 0);
    this.updateVrm(delta);
    if (this.desktopProps) {
      this.desktopProps.update(this.motionPlayer?.time ?? 0, Boolean(this.motionPlayer?.playing), delta);
      if (this.desktopProps.finished) { this.desktopProps.dispose(); this.desktopProps=null; }
    }
    // A seated animation can put the soles below its standing origin. Keep
    // those feet inside the canvas by translating the camera vertically;
    // retain the same zoom and let the contact anchor follow the projection.
    let cameraOffset = 0;
    if (this.motionPlayer?.playing && this.motionKeepsHipsHeight) {
      for (const { bone, corners } of this.footExtents) {
        for (const corner of corners) {
          const point = bone.localToWorld(corner.clone());
          const distance = this.camera.position.z;
          cameraOffset = Math.min(cameraOffset, point.y + this.floorAnchoredCameraY(distance - point.z) - this.floorAnchoredCameraY(distance));
        }
      }
    }
    if (Math.abs(cameraOffset - this.motionCameraOffset) > 1e-6) {
      this.motionCameraOffset = cameraOffset;
      this.updateCamera();
      this.viewportDirty = true;
    }
    if (this.viewportDirty && timestamp >= this.nextViewportNotification) {
      this.nextViewportNotification = timestamp + 50;
      this.viewportDirty = false;
      this.callbacks.onViewportBounds?.(this.avatarViewportBounds());
    }
    if (this.usesRenderedFootprint() && timestamp >= this.nextFootprintAt) {
      this.nextFootprintAt = timestamp + 250;
      void this.measureRenderedFootprint();
    }
    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.();
    this.assessAdaptivePerformance(timestamp);
  }

  private updateNaturalIdle(timestamp: number): void {
    const available=!this.windowPeek && this.windowRestStage==='off' && !this.desktopContactPose?.active && this.settings.naturalIdle && this.bootstrap.character.motionProfile.profileId==='generic-vrm'
      && !this.diagnosticBindPose && this.animator?.canUseIdleAnimation;
    if(this.motionKind==='natural' && !available){++this.motionSequence;this.motionPlayer?.stop();this.motionKind=null;this.idleResumeAt=timestamp+500;}
    if(!available || !this.naturalIdleBytes || this.naturalIdleFailed || this.naturalIdlePending || this.motionPlaying || timestamp<this.idleResumeAt)return;
    this.naturalIdlePending=true;
    void this.startMotion(this.naturalIdleBytes,'AIRI 自然待机',true,'natural').catch(error=>{this.naturalIdleFailed=true;console.warn('Natural idle unavailable; retaining procedural idle.',error);}).finally(()=>{this.naturalIdlePending=false;});
  }

  private usesRenderedFootprint(): boolean {
    return this.bootstrap.character.motionProfile.profileId === 'generic-vrm';
  }

  private async measureRenderedFootprint(): Promise<void> {
    if (this.disposed || this.footprintPending || this.footprintFailed) return;
    this.footprintPending = true;
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const zoom = this.settings.zoom;
    const sampleWidth = 256;
    const sampleHeight = Math.max(1, Math.round(sampleWidth * height / width));
    if (!this.footprintTarget) this.footprintTarget = new THREE.WebGLRenderTarget(sampleWidth, sampleHeight);
    if (this.footprintTarget.height !== sampleHeight) this.footprintTarget.setSize(sampleWidth, sampleHeight);
    if (this.footprintPixels.length !== sampleWidth * sampleHeight * 4) {
      this.footprintPixels = new Uint8Array(sampleWidth * sampleHeight * 4);
    }
    const previousTarget = this.renderer.getRenderTarget();
    const shadowVisible = this.shadow.visible;
    try {
      this.shadow.visible = false;
      this.renderer.setRenderTarget(this.footprintTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(previousTarget);
      this.shadow.visible = shadowVisible;
      // PBO + GPU fence in Three.js: no synchronous gl.readPixels stall.
      await this.renderer.readRenderTargetPixelsAsync(
        this.footprintTarget, 0, 0, sampleWidth, sampleHeight, this.footprintPixels,
      );
      if (this.disposed || width !== this.canvas.clientWidth || height !== this.canvas.clientHeight
        || zoom !== this.settings.zoom) return;
      const next = alphaFootprint(this.footprintPixels, sampleWidth, sampleHeight, width);
      if (!next) return; // Keep the conservative fallback for a blank render.
      const previous = this.renderedFootprint;
      this.renderedFootprint = next;
      this.footprintZoom = zoom;
      if (this.started && (previous?.left !== next.left || previous?.right !== next.right
        || previous?.canvasWidth !== next.canvasWidth)) this.viewportDirty = true;
    } catch (error) {
      if (!this.disposed) {
        this.footprintFailed = true;
        console.warn('Avatar footprint readback failed; keeping conservative bounds.', error);
      }
    } finally {
      // Restore before the normal onscreen render, even on shader/read errors.
      if (!this.disposed) this.renderer.setRenderTarget(previousTarget);
      this.shadow.visible = shadowVisible;
      this.footprintPending = false;
    }
  }

  private updateVrm(delta: number): void {
    if (!this.vrm) return;
    this.vrm.humanoid.update();
    this.vrm.lookAt?.update(delta);
    this.vrm.expressionManager?.update();
    this.vrm.nodeConstraintManager?.update();
    if (this.settings.physics && this.pmxPhysics) {
      try {
        this.pmxPhysics.update(delta);
      } catch (error) {
        this.pmxPhysicsFailure = error instanceof Error ? error.message : String(error);
        this.pmxPhysics.beforePose();
        this.pmxPhysics.dispose(); this.pmxPhysics = null;
        this.animator?.setOriginalPmxPhysics(false);
        connectAuthoredArmContacts(this.vrm, this.bootstrap.character.motionProfile, false);
        this.vrm.humanoid.update(); this.vrm.springBoneManager?.reset();
        this.garmentContact = GarmentContactSolver.create(this.vrm, this.bootstrap.character.motionProfile);
        if (this.garmentContact) for (const { display } of this.garmentContact.replacements) this.interactiveMeshes.push(display);
        console.warn('PMX physics stopped; restored VRM physics.', error);
      }
    } else if (this.settings.physics && this.vrm.springBoneManager) {
      // The fixed-rate generic standard is shared by every VRM. It removes the
      // visible change in cloth behaviour between 30/60 Hz and splits delayed
      // frames without allowing an unbounded amount of catch-up work.
      const { stepHz, maxSubsteps } = this.bootstrap.character.motionProfile.physics;
      const steps = Math.min(maxSubsteps, Math.max(1, Math.ceil(delta / (1 / stepHz))));
      const substep = delta / steps;
      for (let index = 0; index < steps; index += 1) {
        this.vrm.springBoneManager.update(substep);
      }
    }
    if (this.settings.physics) this.garmentContact?.update(delta);
    this.vrm.materials?.forEach((material) => (material as UpdatableMaterial).update?.(delta));
  }

  private applyMotionProfile(vrm: VRM, profile: MotionProfile): void {
    const manager = vrm.springBoneManager;
    const tuning = profile.springBone;
    if (!manager || !tuning.enabled || tuning.jointNamePatterns.length === 0) return;

    const matches = (name: string, patterns: string[]): boolean => {
      const normalized = name.toLowerCase();
      return patterns.some((pattern) => normalized.includes(pattern));
    };
    const sourceColliderGroups = new Set<VRMSpringBoneColliderGroup>();
    for (const joint of manager.joints) {
      if (!matches(joint.bone.name, tuning.colliderSourcePatterns)) continue;
      for (const group of joint.colliderGroups) sourceColliderGroups.add(group);
    }

    for (const joint of manager.joints) {
      if (!matches(joint.bone.name, tuning.jointNamePatterns)) continue;
      joint.settings.stiffness = clamp(joint.settings.stiffness * tuning.stiffnessScale, 0.01, 4);
      joint.settings.dragForce = clamp(joint.settings.dragForce + tuning.dragForceAdd, 0, 0.95);
      joint.settings.gravityPower = clamp(joint.settings.gravityPower + tuning.gravityPowerAdd, 0, 2);
      joint.settings.hitRadius = clamp(joint.settings.hitRadius * tuning.hitRadiusScale, 0, 0.3);
      if (tuning.copyColliderGroups
        && matches(joint.bone.name, tuning.colliderTargetPatterns)
        && sourceColliderGroups.size > 0) {
        for (const group of sourceColliderGroups) {
          if (!joint.colliderGroups.includes(group)) joint.colliderGroups.push(group);
        }
      }
      this.tunedSpringJointCount += 1;
    }
    manager.reset();
  }

  private assessAdaptivePerformance(timestamp: number): void {
    if (
      !this.settings.adaptivePerformance
      || timestamp < this.nextAdaptiveAssessment
      || this.renderedFrameCount < this.targetFps() * 6
    ) return;
    this.nextAdaptiveAssessment = timestamp + 3000;
    const stats = this.getPerformanceStats();
    const nextScale = nextAdaptiveScale({
      currentScale: this.adaptiveScale,
      minimumScale: this.minimumAdaptiveScale(),
      targetFps: stats.targetFps,
      averageFps: stats.averageFps,
      p95FrameMs: stats.p95FrameMs,
      sampleCount: stats.sampleCount,
    });
    if (Math.abs(nextScale - this.adaptiveScale) >= 0.015) {
      this.adaptiveScale = nextScale;
      this.updateRendererPixelRatio();
    }
  }

  private collectDiagnostics(): RuntimeDiagnostics {
    if (!this.vrm) throw new Error('Diagnostics requested before the VRM loaded.');
    let meshCount = 0;
    let triangleCount = 0;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshCount += 1;
      const geometry = mesh.geometry;
      triangleCount += geometry.index
        ? geometry.index.count / 3
        : (geometry.getAttribute('position')?.count ?? 0) / 3;
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of meshMaterials) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value && value.isTexture) {
            textures.add(value as THREE.Texture);
          }
        }
      }
    });
    const humanoidBoneCount = Object.values(VRMHumanBoneName)
      .filter((boneName) => this.vrm?.humanoid.getNormalizedBoneNode(boneName)).length;
    const gl = this.renderer.getContext();
    const modelName = this.vrm.meta.metaVersion === '0'
      ? this.vrm.meta.title
      : this.vrm.meta.name;
    return {
      renderer: String(gl.getParameter(gl.RENDERER)),
      webglVersion: String(gl.getParameter(gl.VERSION)),
      modelName: modelName || this.bootstrap.character.displayName,
      modelMetaVersion: this.vrm.meta.metaVersion,
      modelHeight: Number(this.modelHeight.toFixed(4)),
      meshCount,
      triangleCount: Math.round(triangleCount),
      materialCount: materials.size,
      textureCount: Math.max(textures.size, this.declaredTextureCount),
      expressionNames: this.animator?.expressions.names ?? [],
      springJointCount: this.vrm.springBoneManager?.joints.size ?? 0,
      colliderCount: this.vrm.springBoneManager?.colliders.length ?? 0,
      humanoidBoneCount,
      quality: this.settings.quality,
      initialPixelRatio: Number(this.renderer.getPixelRatio().toFixed(3)),
      motionProfileId: this.bootstrap.character.motionProfile.profileId,
      sourceFormat: this.bootstrap.character.sourceFormat ?? 'vrm',
      motionCapabilities: [...this.bootstrap.character.motionProfile.capabilities],
      anatomy: this.animator?.getAnatomyDiagnostics() ?? null,
      tunedSpringJointCount: this.tunedSpringJointCount,
      garmentPose: this.animator?.getGarmentPoseDiagnostics() ?? null,
      garmentContact: this.garmentContactSnapshot(),
      avatarViewportBounds: this.avatarViewportBounds(),
    };
  }
}
