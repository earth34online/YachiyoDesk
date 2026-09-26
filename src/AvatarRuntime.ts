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
import { shouldCombineSkeletons } from './skin-policy';
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
}

type UpdatableMaterial = THREE.Material & { update?: (delta: number) => void };

export class AvatarRuntime {
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
  private adaptiveScale = 1;
  private readonly frameDurations: number[] = [];
  private started = false;
  private disposed = false;
  private diagnosticBindPose = false;

  constructor(canvas: HTMLCanvasElement, bootstrap: BootstrapData, callbacks: RuntimeCallbacks) {
    this.canvas = canvas;
    this.bootstrap = bootstrap;
    this.callbacks = callbacks;
    this.settings = bootstrap.settings;
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

  async load(): Promise<void> {
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
            const progress = event.total > 0 ? event.loaded / event.total : 0;
            this.callbacks.onProgress(8 + progress * 68, `载入原始高清模型 ${Math.round(progress * 100)}%`);
          },
          reject,
        );
      });

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
      this.vrm = vrm;
      this.prepareModel(vrm);
      this.applyMotionProfile(vrm, this.bootstrap.character.motionProfile);

      this.animator = new ProceduralAnimator(vrm, this.settings, this.bootstrap.character.motionProfile);
      vrm.springBoneManager?.setInitState();
      this.callbacks.onProgress(94, '启动表情、视线与摇摆骨骼…');

      this.started = true;
      this.renderer.setAnimationLoop((timestamp) => this.renderFrame(timestamp));
      this.callbacks.onProgress(100, '八千代已准备好');
      const diagnostics = this.collectDiagnostics();
      this.callbacks.onReady(diagnostics);
    } catch (unknownError) {
      const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
      this.callbacks.onFatal(error);
    }
  }

  humanoidPoseSnapshot(): Record<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number }> {
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
    ];
    this.avatarPivot.updateWorldMatrix(true, true);
    for (const bone of bones) {
      const node = this.vrm.humanoid.getRawBoneNode(bone);
      if (!node) continue;
      node.getWorldPosition(point);
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

  setDiagnosticBindPose(active: boolean): void {
    if (!this.bootstrap.smokeTest || !this.vrm) return;
    this.diagnosticBindPose = active;
    if (active) {
      this.vrm.humanoid.resetNormalizedPose();
      this.vrm.springBoneManager?.reset();
    }
  }

  setSettings(settings: AppSettings): void {
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
    if (physicsChanged) this.vrm?.springBoneManager?.reset();
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
    this.autonomyFacing = 0;
    this.animator?.trigger(name);
  }

  setAutonomy(command: AutonomyCommand): void {
    const direction = command.direction === -1 ? -1 : 1;
    // A desktop walk travels horizontally while the camera looks at the
    // avatar. A shallow turn keeps the face almost front-facing while the
    // stronger normalized leg chain still provides a visible step;
    // the pointer/action interrupt still returns immediately to face the user.
    this.autonomyFacing = command.action === 'walk' ? direction * 0.33 : 0;
    this.animator?.setAutonomousMotion(command.action, direction);
  }

  setDragging(active: boolean): void {
    this.autonomyFacing = 0;
    this.animator?.setDragging(active);
  }

  resetPose(): void {
    this.targetRotationY = 0;
    this.currentRotationY = 0;
    this.avatarPivot.rotation.y = 0;
    this.autonomyFacing = 0;
    this.animator?.reset();
    this.vrm?.springBoneManager?.reset();
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
    const pointer = normalizedPointer(clientX, clientY, this.canvas.clientWidth, this.canvas.clientHeight);
    this.raycaster.setFromCamera(pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(this.interactiveMeshes, false);
    return intersections.find((intersection) => intersection.object.visible) ?? null;
  }

  hitZone(intersection: THREE.Intersection): HitZone {
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
    };
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
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.renderer.dispose();
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
    const targetY = this.floorAnchoredCameraY(cameraDistance);
    this.camera.position.set(0, targetY, cameraDistance);
    this.camera.lookAt(0, targetY, 0);
    this.camera.near = Math.max(0.005, this.baseCameraDistance * 0.01);
    this.camera.far = Math.max(20, cameraDistance + this.modelHeight * 4);
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(): void {
    const cameraDistance = this.baseCameraDistance / this.settings.zoom;
    const targetY = this.floorAnchoredCameraY(cameraDistance);
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
    if (!this.vrm || !this.animator || this.disposed) return;
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
    if (frameDuration > 0 && frameDuration < 250) {
      this.frameDurations.push(frameDuration);
      if (this.frameDurations.length > 600) this.frameDurations.splice(0, this.frameDurations.length - 600);
    }
    this.renderedFrameCount += 1;
    if (!this.diagnosticBindPose) this.animator.update(delta);
    this.currentRotationY = damp(this.currentRotationY, this.targetRotationY + this.autonomyFacing, 8.5, delta);
    this.avatarPivot.rotation.y = this.currentRotationY;
    this.updateVrm(delta);
    this.renderer.render(this.scene, this.camera);
    this.assessAdaptivePerformance(timestamp);
  }

  private updateVrm(delta: number): void {
    if (!this.vrm) return;
    this.vrm.humanoid.update();
    this.vrm.lookAt?.update(delta);
    this.vrm.expressionManager?.update();
    this.vrm.nodeConstraintManager?.update();
    if (this.settings.physics && this.vrm.springBoneManager) {
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
      tunedSpringJointCount: this.tunedSpringJointCount,
      avatarViewportBounds: this.avatarViewportBounds(),
    };
  }
}
