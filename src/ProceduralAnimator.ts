import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { FRONT_PALM_TWIST_RADIANS, viewerFacingPalmTwists } from './handPose';
import { ExpressionController } from './ExpressionController';
import { clamp, damp, randomBetween, reactionEnvelope, smoothstep01 } from './math';
import type { AppSettings, AutonomousMotion, MotionProfile, ReactionName } from './types';

interface ActiveReaction {
  name: ReactionName;
  startedAt: number;
  duration: number;
}

type PoseRotation = [number, number, number, number];
type PosePosition = [number, number, number];
type PoseEntry = { rotation?: PoseRotation; position?: PosePosition };
type NormalizedPose = Record<string, PoseEntry>;

const REACTION_DURATION: Record<ReactionName, number> = {
  greet: 3.6,
  joy: 3.0,
  surprised: 1.9,
  angry: 2.9,
  sleepy: 3.6,
  poke: 1.25,
  bow: 3.1,
  stretch: 4.2,
  dance: 6.4,
  lookAround: 4.6,
  nod: 2.5,
  shakeHead: 2.8,
  shy: 3.8,
  cheer: 4.8,
  think: 5.2,
  crouch: 4.4,
  tiptoe: 3.8,
  sway: 6.2,
};

const REACTION_BLEND: Record<ReactionName, { fadeIn: number; fadeOut: number }> = {
  greet: { fadeIn: 0.58, fadeOut: 0.72 },
  joy: { fadeIn: 0.42, fadeOut: 0.68 },
  surprised: { fadeIn: 0.16, fadeOut: 0.72 },
  angry: { fadeIn: 0.36, fadeOut: 0.72 },
  sleepy: { fadeIn: 0.82, fadeOut: 0.82 },
  poke: { fadeIn: 0.12, fadeOut: 0.48 },
  bow: { fadeIn: 0.48, fadeOut: 0.72 },
  stretch: { fadeIn: 0.72, fadeOut: 0.82 },
  dance: { fadeIn: 0.46, fadeOut: 0.78 },
  lookAround: { fadeIn: 0.62, fadeOut: 0.78 },
  nod: { fadeIn: 0.30, fadeOut: 0.52 },
  shakeHead: { fadeIn: 0.30, fadeOut: 0.52 },
  shy: { fadeIn: 0.55, fadeOut: 0.72 },
  cheer: { fadeIn: 0.38, fadeOut: 0.72 },
  think: { fadeIn: 0.62, fadeOut: 0.82 },
  crouch: { fadeIn: 0.58, fadeOut: 0.78 },
  tiptoe: { fadeIn: 0.52, fadeOut: 0.72 },
  sway: { fadeIn: 0.55, fadeOut: 0.82 },
};

const ROTATION_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot', 'leftToes', 'rightToes',
] as const;

// Finger chains are intentionally opt-in. The built-in Yachiyo asset and
// ordinary VRM imports keep their authored finger pose untouched; PMX imports
// opt in after the converter has verified that these normalized humanoid bones
// exist. This prevents adding identity rotations from changing legacy assets.
const FINGER_BONES = [
  'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
  'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
  'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
  'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
  'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal',
  'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
  'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
  'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
  'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
] as const;
const POSE_BONES = [...ROTATION_BONES, ...FINGER_BONES] as const;

function createReusablePose(includeFingerBones = false): NormalizedPose {
  const pose: NormalizedPose = {};
  const bones = includeFingerBones ? POSE_BONES : ROTATION_BONES;
  for (const bone of bones) pose[bone] = { rotation: [0, 0, 0, 1] };
  pose.hips.position = [0, 0, 0];
  return pose;
}

function clonePose(source: NormalizedPose): NormalizedPose {
  const clone: NormalizedPose = {};
  for (const [bone, entry] of Object.entries(source)) {
    clone[bone] = {
      rotation: entry.rotation ? [...entry.rotation] as PoseRotation : undefined,
      position: entry.position ? [...entry.position] as PosePosition : undefined,
    };
  }
  return clone;
}

function windowPulse(value: number, start: number, fadeInEnd: number, fadeOutStart: number, end: number): number {
  if (value <= start || value >= end) return 0;
  if (value < fadeInEnd) return smoothstep01((value - start) / Math.max(0.001, fadeInEnd - start));
  if (value > fadeOutStart) return smoothstep01((end - value) / Math.max(0.001, end - fadeOutStart));
  return 1;
}

function progress01(elapsed: number, duration: number): number {
  return clamp(elapsed / Math.max(0.001, duration), 0, 1);
}

export class ProceduralAnimator {
  readonly expressions: ExpressionController;
  private readonly vrm: VRM;
  private readonly pose: NormalizedPose;
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly transitionQuaternion = new THREE.Quaternion();
  private settings: AppSettings;
  private readonly motionProfile: MotionProfile;
  private elapsed = 0;
  private nextBlinkAt = randomBetween(2.2, 4.8);
  private blinkStartedAt = -1;
  private blinkDuration = 0.18;
  private nextWanderAt = randomBetween(3.8, 7.0);
  private readonly wanderTarget = new THREE.Vector2(0, 0);
  private readonly lookCurrent = new THREE.Vector2(0, 0);
  private readonly pointerTarget = new THREE.Vector2(0, 0);
  private pointerActive = false;
  private lastActivityAt = 0;
  private motionWeight = 1;
  private reaction: ActiveReaction | null = null;
  private transitionPose: NormalizedPose | null = null;
  private transitionStartedAt = 0;
  private readonly transitionDuration = 0.32;
  private autonomousMotion: AutonomousMotion = 'idle';
  private autonomousStartedAt = 0;
  private autonomousDirection: -1 | 1 = 1;
  private walkWeight = 0;
  private dragging = false;
  private draggingWeight = 0;

  constructor(vrm: VRM, settings: AppSettings, motionProfile: MotionProfile) {
    this.vrm = vrm;
    this.settings = settings;
    this.motionProfile = motionProfile;
    this.pose = createReusablePose(motionProfile.capabilities.includes('pmx-converted'));
    this.expressions = new ExpressionController(vrm.expressionManager);
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  setPointer(x: number, y: number, active: boolean): void {
    this.pointerTarget.set(clamp(x, -1, 1), clamp(y, -1, 1));
    this.pointerActive = active;
    if (active) this.noteActivity();
  }

  noteActivity(): void {
    this.lastActivityAt = this.elapsed;
  }

  setAutonomousMotion(motion: AutonomousMotion, direction: -1 | 1 = 1): void {
    this.autonomousMotion = motion;
    this.autonomousDirection = direction;
    this.autonomousStartedAt = this.elapsed;
    if (motion === 'walk') this.reaction = null;
  }

  setDragging(active: boolean): void {
    this.dragging = active;
    if (active) {
      this.reaction = null;
      this.autonomousMotion = 'idle';
      this.noteActivity();
    }
  }

  trigger(name: ReactionName): void {
    if (!this.settings.reactions && name !== 'sleepy') return;
    // Preserve the exact current pose and cross-fade from it. High-frequency
    // interaction can otherwise replace an in-progress state with a new pose
    // whose envelope starts at zero, causing a one-frame snap to neutral.
    this.transitionPose = clonePose(this.pose);
    this.transitionStartedAt = this.elapsed;
    this.reaction = { name, startedAt: this.elapsed, duration: REACTION_DURATION[name] };
    this.autonomousMotion = 'idle';
    this.noteActivity();
  }

  reset(): void {
    this.reaction = null;
    this.transitionPose = null;
    this.autonomousMotion = 'idle';
    this.walkWeight = 0;
    this.dragging = false;
    this.draggingWeight = 0;
    this.lookCurrent.set(0, 0);
    this.wanderTarget.set(0, 0);
    this.vrm.humanoid.resetNormalizedPose();
    this.vrm.lookAt?.reset();
    this.vrm.springBoneManager?.reset();
    this.expressions.reset();
  }

  update(delta: number): void {
    this.elapsed += delta;
    const sleeping = this.elapsed - this.lastActivityAt >= this.settings.sleepMinutes * 60;
    const targetMotion = this.settings.idleMotion ? 1 : 0;
    this.motionWeight = damp(this.motionWeight, targetMotion, 5.2, delta);
    this.walkWeight = damp(this.walkWeight, this.autonomousMotion === 'walk' ? 1 : 0, 7.5, delta);
    this.draggingWeight = damp(this.draggingWeight, this.dragging ? 1 : 0, this.dragging ? 11 : 6.5, delta);

    if (this.elapsed >= this.nextWanderAt) {
      this.wanderTarget.set(randomBetween(-0.36, 0.36), randomBetween(-0.20, 0.24));
      this.nextWanderAt = this.elapsed + randomBetween(4.2, 8.0);
    }

    const shouldTrackPointer = this.settings.mouseLook && this.pointerActive && !sleeping;
    const targetLook = shouldTrackPointer ? this.pointerTarget : this.wanderTarget;
    this.lookCurrent.x = damp(this.lookCurrent.x, sleeping ? 0 : targetLook.x, 3.2, delta);
    this.lookCurrent.y = damp(this.lookCurrent.y, sleeping ? -0.28 : targetLook.y, 3.2, delta);

    let reactionWeight = 0;
    let reactionElapsed = 0;
    const activeReaction = this.reaction;
    if (activeReaction) {
      reactionElapsed = this.elapsed - activeReaction.startedAt;
      const blend = REACTION_BLEND[activeReaction.name];
      reactionWeight = reactionEnvelope(reactionElapsed, activeReaction.duration, blend.fadeIn, blend.fadeOut);
      if (reactionElapsed >= activeReaction.duration) this.reaction = null;
    }

    const reactionName = activeReaction?.name ?? null;
    this.updatePose(sleeping, reactionName, reactionWeight, reactionElapsed, activeReaction?.duration ?? 1);
    this.applyPoseTransition();
    this.vrm.humanoid.setNormalizedPose(this.pose);

    if (this.vrm.lookAt) {
      this.vrm.lookAt.yaw = this.lookCurrent.x * 10 * this.settings.lookIntensity;
      this.vrm.lookAt.pitch = this.lookCurrent.y * 6 * this.settings.lookIntensity;
    }

    const naturalBlink = sleeping ? 0 : this.updateBlink();
    const blink = sleeping
      ? 1
      : reactionName === 'sleepy'
        ? Math.max(naturalBlink, reactionWeight * 0.88)
        : naturalBlink;
    const mouth = reactionName === 'greet' || reactionName === 'dance' || reactionName === 'cheer'
      ? 0.08 + Math.max(0, Math.sin(reactionElapsed * 5.6) * 0.11 + Math.sin(reactionElapsed * 8.9) * 0.06)
      : reactionName === 'sleepy'
        ? windowPulse(progress01(reactionElapsed, REACTION_DURATION.sleepy), 0.20, 0.34, 0.66, 0.80) * 0.16
        : 0;
    const displayedReaction = this.draggingWeight > 0.18
      ? 'surprised'
      : sleeping ? 'sleepy' : reactionName;
    const displayedWeight = this.draggingWeight > 0.18
      ? Math.min(0.38, this.draggingWeight * 0.38)
      : sleeping ? 0.24 : reactionWeight;
    this.expressions.update(blink, displayedReaction, displayedWeight, mouth);
  }

  private updateBlink(): number {
    if (this.blinkStartedAt < 0 && this.elapsed >= this.nextBlinkAt) {
      this.blinkStartedAt = this.elapsed;
      this.blinkDuration = Math.random() < 0.14 ? 0.27 : randomBetween(0.16, 0.22);
    }
    if (this.blinkStartedAt < 0) return 0;

    const progress = (this.elapsed - this.blinkStartedAt) / this.blinkDuration;
    if (progress >= 1) {
      this.blinkStartedAt = -1;
      this.nextBlinkAt = this.elapsed + randomBetween(2.3, 5.4);
      return 0;
    }
    return Math.sin(progress * Math.PI) ** 1.5;
  }

  private applyPoseTransition(): void {
    if (!this.transitionPose) return;
    const progress = clamp((this.elapsed - this.transitionStartedAt) / this.transitionDuration, 0, 1);
    const blend = smoothstep01(progress);
    for (const bone of POSE_BONES) {
      const from = this.transitionPose[bone]?.rotation;
      const to = this.pose[bone]?.rotation;
      if (!from || !to) continue;
      this.scratchQuaternion.fromArray(from);
      this.transitionQuaternion.fromArray(to);
      this.scratchQuaternion.slerp(this.transitionQuaternion, blend);
      to[0] = this.scratchQuaternion.x;
      to[1] = this.scratchQuaternion.y;
      to[2] = this.scratchQuaternion.z;
      to[3] = this.scratchQuaternion.w;
    }
    const fromPosition = this.transitionPose.hips?.position;
    const toPosition = this.pose.hips?.position;
    if (fromPosition && toPosition) {
      toPosition[0] = THREE.MathUtils.lerp(fromPosition[0], toPosition[0], blend);
      toPosition[1] = THREE.MathUtils.lerp(fromPosition[1], toPosition[1], blend);
      toPosition[2] = THREE.MathUtils.lerp(fromPosition[2], toPosition[2], blend);
    }
    if (progress >= 1) this.transitionPose = null;
  }

  private updatePose(
    sleeping: boolean,
    reaction: ReactionName | null,
    weight: number,
    reactionElapsed: number,
    reactionDuration: number,
  ): void {
    const idle = this.motionWeight * this.settings.motionIntensity;
    const slowPhase = this.elapsed * (sleeping ? 0.68 : 0.82);
    const breathPhase = this.elapsed * (sleeping ? 1.18 : 1.72);
    const breath = Math.sin(breathPhase) * 0.0072 * idle;
    const weightShift = Math.sin(slowPhase) * 0.0105 * idle;
    const counterShift = Math.sin(slowPhase * 0.63 + 1.1) * 0.0055 * idle;
    const walkTuning = this.motionProfile.walk;
    const palmSign = this.motionProfile.handPose.palmFacingSign;
    const armAxisSign = this.motionProfile.handPose.armAxisSign;
    const bodyForwardAxisSign = this.motionProfile.handPose.bodyForwardAxisSign;
    const legForwardAxisSign = this.motionProfile.handPose.legForwardAxisSign;
    const rootDepthAxisSign = this.motionProfile.handPose.rootDepthAxisSign;
    const wristAmplitudeScale = this.motionProfile.handPose.wristAmplitudeScale;
    const elbowBendScale = this.motionProfile.handPose.elbowBendScale;
    const fingerCurlScale = this.motionProfile.handPose.fingerCurlScale;
    const kneeBendSign = this.motionProfile.legPose.kneeBendSign;
    const squatHipsDrop = this.motionProfile.legPose.seizaHipsDrop;
    const walkPhase = (this.elapsed - this.autonomousStartedAt) * walkTuning.cadence;
    const stride = Math.sin(walkPhase);
    const stepLift = Math.max(0, Math.sin(walkPhase * 2));
    const walk = this.walkWeight * this.settings.motionIntensity;
    const progress = clamp(reactionElapsed / Math.max(0.001, reactionDuration), 0, 1);

    let hipsX = weightShift * 0.36;
    let hipsY = breath * 0.10;
    let hipsZ = 0;
    let torsoX = breath * 0.52;
    let torsoY = counterShift * 0.32;
    let torsoZ = weightShift;
    let headX = -this.lookCurrent.y * 0.052 * this.settings.lookIntensity;
    let headY = this.lookCurrent.x * 0.070 * this.settings.lookIntensity;
    let headZ = -weightShift * 0.46;
    let leftShoulderX = 0;
    let leftShoulderY = 0;
    let leftShoulderZ = 0.025 + breath * 0.25;
    let rightShoulderX = 0;
    let rightShoulderY = 0;
    let rightShoulderZ = -0.025 - breath * 0.25;
    let leftArmX = 0.025;
    let leftArmY = 0.025;
    let leftArmZ = 1.16 + weightShift * 0.7;
    let rightArmX = 0.025;
    let rightArmY = -0.025;
    let rightArmZ = -1.16 + weightShift * 0.7;
    let leftLowerX = -0.14;
    let leftLowerY = 0.045;
    // Keep the relaxed elbow bend on the forward/back axis. Sideways Z bends
    // easily become hyperextension on VRM0 sleeves, especially when the arm is
    // raised into a V pose.
    let leftLowerZ = 0;
    let rightLowerX = -0.14;
    let rightLowerY = -0.045;
    let rightLowerZ = 0;
    let leftHandX = 0.015;
    let leftHandY = 0.035;
    let leftHandZ = -0.045;
    let rightHandX = 0.015;
    let rightHandY = -0.035;
    let rightHandZ = 0.045;
    let leftFingerCurl = 0.16 * fingerCurlScale;
    let rightFingerCurl = 0.16 * fingerCurlScale;
    let leftUpperLegX = 0;
    let rightUpperLegX = 0;
    let leftUpperLegZ = -weightShift * 0.20;
    let rightUpperLegZ = -weightShift * 0.20;
    let leftKneeX = 0.004 + Math.max(0, weightShift) * 0.18;
    let rightKneeX = 0.004 + Math.max(0, -weightShift) * 0.18;
    let leftKneeZ = 0;
    let rightKneeZ = 0;
    let leftFootX = -leftKneeX * 0.32;
    let rightFootX = -rightKneeX * 0.32;
    let leftFootY = 0;
    let rightFootY = 0;
    let leftFootZ = 0;
    let rightFootZ = 0;
    let leftToeX = 0;
    let rightToeX = 0;
    let leftToeY = 0;
    let rightToeY = 0;

    if (walk > 0.001) {
      // A visible walk cycle needs more than window translation: alternate
      // swing legs, bend the swing knee, then roll the ankle/toes through
      // heel-strike -> flat-foot -> toe-off. Keep the values deliberately
      // below a full stride so long skirts do not self-intersect.
      const leftSwing = Math.max(0, -stride);
      const rightSwing = Math.max(0, stride);
      const leftStance = Math.max(0, stride);
      const rightStance = Math.max(0, -stride);
      const side = Math.sin(walkPhase * 0.5) * 0.010 * walk * walkTuning.hipBobScale;
      hipsY += stepLift * 0.010 * walk * walkTuning.hipBobScale;
      hipsX += side;
      torsoY += -stride * 0.070 * walk * walkTuning.strideScale;
      torsoZ += -side * 1.7;
      headY += this.autonomousDirection * 0.10 * walk + stride * 0.018 * walk * walkTuning.strideScale;
      headZ += side * 1.15;
      leftArmX += -stride * 0.18 * walk * walkTuning.armSwingScale;
      rightArmX += stride * 0.18 * walk * walkTuning.armSwingScale;
      leftLowerX += Math.max(0, stride) * 0.15 * walk * walkTuning.armSwingScale;
      rightLowerX += Math.max(0, -stride) * 0.15 * walk * walkTuning.armSwingScale;
      // The x axis is the humanoid forward/back axis. Keep the two thighs
      // strictly opposite in phase so one leg advances while the other trails;
      // this is the part that must remain visible even when a skirt covers the
      // knees. The amplitudes are intentionally shared by all imported rigs.
      leftUpperLegX += stride * 0.56 * walk * walkTuning.strideScale;
      rightUpperLegX -= stride * 0.56 * walk * walkTuning.strideScale;
      // Keep the walking chain in the sagittal plane. PMX rigs mirror local
      // lateral axes between the two legs; adding a shared Z rotation can then
      // pull one foot across the body's midline. Natural balance is already
      // provided by the small hip shift above.
      // A small outward support offset preserves each foot's landing side
      // while the forward/back hinge is active; it fades with walkWeight and
      // is therefore invisible in idle or reactions.
      leftUpperLegZ += 0.09 * walk * walkTuning.strideScale;
      rightUpperLegZ -= 0.09 * walk * walkTuning.strideScale;
      leftKneeX += leftSwing * 0.90 * walk * walkTuning.kneeLiftScale;
      rightKneeX += rightSwing * 0.90 * walk * walkTuning.kneeLiftScale;
      // Ankle pitch is opposite during swing and stance; the toe joint adds
      // a small toe-off roll when the planted foot leaves the floor.
      leftFootX += (leftSwing * -0.52 + leftStance * 0.17) * walk * walkTuning.kneeLiftScale;
      rightFootX += (rightSwing * 0.52 - rightStance * 0.17) * walk * walkTuning.kneeLiftScale;
      // Do not add a lateral ankle offset: it is mirrored differently by MMD
      // local axes and can make one foot drift toward the other.
      leftToeX += (leftSwing * 0.32 - leftStance * 0.24) * walk * walkTuning.kneeLiftScale;
      rightToeX += (rightSwing * 0.32 - rightStance * 0.24) * walk * walkTuning.kneeLiftScale;
    }

    if (this.draggingWeight > 0.001) {
      const held = this.draggingWeight;
      const pendulum = Math.sin(this.elapsed * 3.1) * held;
      const secondary = Math.sin(this.elapsed * 4.7 + 0.8) * held;
      // Raised/neck-grab state inspired by VPet's dedicated Raised animation:
      // shoulders bunch toward the neck, the torso hangs below the grip point,
      // arms relax, and legs trail with different phases instead of freezing.
      hipsY -= 0.020 * held;
      hipsX += pendulum * 0.010;
      torsoX -= 0.10 * held;
      torsoZ += pendulum * 0.045;
      headX += 0.14 * held;
      headY -= secondary * 0.030;
      headZ -= pendulum * 0.065;
      leftShoulderX -= 0.10 * held;
      rightShoulderX -= 0.10 * held;
      leftShoulderZ += 0.16 * held;
      rightShoulderZ -= 0.16 * held;
      leftArmX += pendulum * 0.045;
      rightArmX -= pendulum * 0.045;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 1.34, held);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -1.34, held);
      leftLowerX = THREE.MathUtils.lerp(leftLowerX, -0.04 + secondary * 0.025, held);
      rightLowerX = THREE.MathUtils.lerp(rightLowerX, -0.04 - secondary * 0.025, held);
      leftLowerY = THREE.MathUtils.lerp(leftLowerY, 0.015, held);
      rightLowerY = THREE.MathUtils.lerp(rightLowerY, -0.015, held);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.03, held);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.03, held);
      leftUpperLegX += (0.13 + pendulum * 0.045) * held;
      rightUpperLegX += (0.20 - pendulum * 0.035) * held;
      leftUpperLegZ -= 0.035 * held;
      rightUpperLegZ += 0.035 * held;
      leftKneeX += (0.38 + secondary * 0.045) * held;
      rightKneeX += (0.52 - secondary * 0.045) * held;
      leftFootX -= 0.16 * held;
      rightFootX -= 0.21 * held;
    }

    if (sleeping) {
      headX += 0.145;
      headZ += 0.055;
      torsoX += 0.035;
      torsoZ += 0.018;
      leftShoulderZ += 0.045;
      rightShoulderZ -= 0.045;
      leftArmZ -= 0.055;
      rightArmZ += 0.055;
    }

    if (reaction === 'greet') {
      const waveWindow = windowPulse(progress, 0.15, 0.25, 0.76, 0.88);
      const wave = Math.sin((reactionElapsed - 0.72) * Math.PI * 2.05) * waveWindow;
      hipsX -= 0.010 * weight;
      torsoZ += 0.026 * weight;
      torsoY -= 0.018 * weight;
      headZ -= 0.042 * weight;
      headY += 0.025 * weight;
      rightShoulderX -= 0.055 * weight;
      rightShoulderY -= 0.025 * weight;
      rightShoulderZ += 0.035 * weight;
      // Treat shoulder, upper arm, elbow and wrist as one constrained chain.
      // The upper arm carries the hand upward; the elbow has one dominant bend
      // axis, and the wave is mostly wrist yaw. This avoids the corkscrew motion
      // caused by animating all three forearm Euler axes independently.
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.07, weight);
      rightArmY = THREE.MathUtils.lerp(rightArmY, -0.025, weight);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.41, weight);
      rightLowerX = THREE.MathUtils.lerp(rightLowerX, -0.025, weight);
      rightLowerY = THREE.MathUtils.lerp(rightLowerY, -0.015, weight);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 1.08 + wave * 0.035, weight);
      // Twist only the wrist around the forearm axis so the palm, rather than
      // its edge, faces the viewer. The approved shoulder/elbow chain stays
      // exactly as tuned above.
      const palm = viewerFacingPalmTwists(palmSign, FRONT_PALM_TWIST_RADIANS);
      rightHandX = THREE.MathUtils.lerp(rightHandX, palm.right, weight);
      rightHandY += wave * 0.12 * weight;
      rightHandZ += wave * 0.055 * weight;
      // Open the waving hand while retaining a relaxed thumb; a flat rigid
      // hand reads as an animation error on converted PMX rigs.
      rightFingerCurl = THREE.MathUtils.lerp(rightFingerCurl, 0.045 * fingerCurlScale, weight);
    } else if (reaction === 'joy') {
      const lift = Math.sin(progress * Math.PI) * weight;
      const settle = Math.sin(progress * Math.PI * 2) * 0.006 * weight;
      hipsY += 0.012 * lift + settle;
      torsoX -= 0.018 * lift;
      torsoZ += 0.018 * lift;
      headX -= 0.028 * lift;
      headZ -= 0.055 * lift;
      leftShoulderZ -= 0.030 * lift;
      rightShoulderZ += 0.030 * lift;
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.10, weight);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.10, weight);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.76, weight);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.76, weight);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.24, weight);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.24, weight);
      const palms = viewerFacingPalmTwists(palmSign, FRONT_PALM_TWIST_RADIANS);
      leftHandX = THREE.MathUtils.lerp(leftHandX, palms.left, lift);
      rightHandX = THREE.MathUtils.lerp(rightHandX, palms.right, lift);
      leftFingerCurl = THREE.MathUtils.lerp(leftFingerCurl, 0.065 * fingerCurlScale, lift);
      rightFingerCurl = THREE.MathUtils.lerp(rightFingerCurl, 0.065 * fingerCurlScale, lift);
      leftKneeX += 0.025 * lift;
      rightKneeX += 0.025 * lift;
    } else if (reaction === 'surprised') {
      const recoil = Math.sin(progress * Math.PI) * weight;
      hipsZ -= 0.008 * recoil;
      torsoX -= 0.072 * recoil;
      headX -= 0.055 * recoil;
      leftShoulderZ -= 0.050 * recoil;
      rightShoulderZ += 0.050 * recoil;
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.12, weight);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.12, weight);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.88, weight);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.88, weight);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.34, weight);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.34, weight);
      const palms = viewerFacingPalmTwists(palmSign, FRONT_PALM_TWIST_RADIANS);
      leftHandX = THREE.MathUtils.lerp(leftHandX, palms.left, recoil);
      rightHandX = THREE.MathUtils.lerp(rightHandX, palms.right, recoil);
    } else if (reaction === 'angry') {
      const disapproval = Math.sin(reactionElapsed * 3.2) * 0.018 * weight;
      hipsX += 0.011 * weight;
      torsoX += 0.025 * weight;
      torsoY -= 0.025 * weight;
      headX += 0.018 * weight;
      headY += 0.055 * weight + disapproval;
      headZ += 0.028 * weight;
      leftShoulderZ += 0.022 * weight;
      rightShoulderZ -= 0.022 * weight;
      leftArmX = THREE.MathUtils.lerp(leftArmX, 0.07, weight);
      rightArmX = THREE.MathUtils.lerp(rightArmX, 0.07, weight);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.94, weight);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.94, weight);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.42, weight);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.42, weight);
      leftHandX -= 0.05 * weight;
      rightHandX -= 0.05 * weight;
    } else if (reaction === 'sleepy') {
      const yawn = Math.sin(progress * Math.PI) * weight;
      torsoX += 0.042 * yawn;
      torsoZ += 0.015 * yawn;
      headX += 0.125 * yawn;
      headZ += 0.050 * yawn;
      leftShoulderZ += 0.040 * yawn;
      rightShoulderZ -= 0.040 * yawn;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 1.08, weight);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -1.08, weight);
      leftLowerX += 0.05 * yawn;
      rightLowerX += 0.05 * yawn;
    } else if (reaction === 'poke') {
      const recoil = Math.sin(progress * Math.PI) * weight;
      hipsX -= 0.010 * recoil;
      torsoZ -= 0.042 * recoil;
      torsoY += 0.018 * recoil;
      headZ += 0.072 * recoil;
      headY -= 0.025 * recoil;
      leftShoulderZ += 0.025 * recoil;
      rightShoulderZ += 0.012 * recoil;
    } else if (reaction === 'bow') {
      const bow = windowPulse(progress, 0.05, 0.28, 0.68, 0.96) * weight;
      const hands = smoothstep01(Math.min(1, progress * 3.2)) * weight;
      hipsZ -= 0.018 * bow;
      torsoX -= 0.34 * bow;
      headX -= 0.22 * bow;
      headZ -= 0.018 * bow;
      leftArmX = THREE.MathUtils.lerp(leftArmX, 0.11, hands);
      rightArmX = THREE.MathUtils.lerp(rightArmX, 0.11, hands);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 1.08, hands);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -1.08, hands);
      leftLowerX = THREE.MathUtils.lerp(leftLowerX, -0.28, hands);
      rightLowerX = THREE.MathUtils.lerp(rightLowerX, -0.28, hands);
    } else if (reaction === 'stretch') {
      const stretch = windowPulse(progress, 0.04, 0.27, 0.72, 0.97) * weight;
      const sway = Math.sin(reactionElapsed * 1.45) * 0.10 * stretch;
      hipsY += 0.016 * stretch;
      torsoX += 0.08 * stretch;
      torsoZ += sway * 0.25;
      headX += 0.10 * stretch;
      headZ -= sway * 0.35;
      leftShoulderZ -= 0.11 * stretch;
      rightShoulderZ += 0.11 * stretch;
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.26, stretch);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.26, stretch);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, -0.52 + sway * 0.35, stretch);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, 0.52 + sway * 0.35, stretch);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.22, stretch);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.22, stretch);
      const palms = viewerFacingPalmTwists(palmSign, FRONT_PALM_TWIST_RADIANS);
      leftHandX = THREE.MathUtils.lerp(leftHandX, palms.left, stretch);
      rightHandX = THREE.MathUtils.lerp(rightHandX, palms.right, stretch);
    } else if (reaction === 'dance') {
      const dance = windowPulse(progress, 0.02, 0.11, 0.87, 0.99) * weight;
      const beat = Math.sin(reactionElapsed * Math.PI * 1.7);
      const doubleBeat = Math.sin(reactionElapsed * Math.PI * 3.4);
      hipsX += beat * 0.026 * dance;
      hipsY += Math.max(0, doubleBeat) * 0.014 * dance;
      torsoY += -beat * 0.16 * dance;
      torsoZ += beat * 0.095 * dance;
      headY += beat * 0.10 * dance;
      headZ -= beat * 0.12 * dance;
      leftArmX += -beat * 0.18 * dance;
      rightArmX += beat * 0.18 * dance;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.67 + beat * 0.16, dance);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.67 + beat * 0.16, dance);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.28, dance);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.28, dance);
      leftUpperLegX += beat * 0.14 * dance;
      rightUpperLegX -= beat * 0.14 * dance;
      leftKneeX += Math.max(0, -beat) * 0.18 * dance;
      rightKneeX += Math.max(0, beat) * 0.18 * dance;
    } else if (reaction === 'lookAround') {
      const observe = windowPulse(progress, 0.03, 0.18, 0.83, 0.98) * weight;
      const scan = Math.sin((progress * 2.25 - 0.58) * Math.PI) * observe;
      hipsX += scan * 0.008;
      torsoY += scan * 0.24;
      torsoZ -= scan * 0.035;
      headY += scan * 0.38;
      headZ -= scan * 0.055;
      leftShoulderY += scan * 0.06;
      rightShoulderY += scan * 0.06;
    } else if (reaction === 'nod') {
      const respond = windowPulse(progress, 0.02, 0.16, 0.80, 0.98) * weight;
      const nod = Math.sin(progress * Math.PI * 4.0) * respond;
      headX -= (0.11 + nod * 0.13) * respond;
      torsoX -= nod * 0.025;
      hipsY -= Math.max(0, nod) * 0.003;
    } else if (reaction === 'shakeHead') {
      const respond = windowPulse(progress, 0.02, 0.16, 0.82, 0.98) * weight;
      const shake = Math.sin(progress * Math.PI * 5.0) * respond;
      headY += shake * 0.28;
      headZ -= shake * 0.045;
      torsoY -= shake * 0.055;
    } else if (reaction === 'shy') {
      const shy = windowPulse(progress, 0.03, 0.24, 0.74, 0.97) * weight;
      torsoX -= 0.075 * shy;
      torsoZ += 0.055 * shy;
      headX -= 0.16 * shy;
      headY -= 0.20 * shy;
      headZ += 0.10 * shy;
      leftShoulderZ += 0.075 * shy;
      rightShoulderZ -= 0.075 * shy;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 1.08, shy);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -1.08, shy);
    } else if (reaction === 'cheer') {
      const active = windowPulse(progress, 0.02, 0.15, 0.84, 0.99) * weight;
      const beat = Math.sin(reactionElapsed * Math.PI * 2.15);
      const hop = Math.max(0, beat) * active;
      hipsY += 0.030 * hop;
      hipsX += Math.sin(reactionElapsed * 2.2) * 0.010 * active;
      torsoX -= 0.055 * active;
      torsoZ += beat * 0.035 * active;
      headX -= 0.075 * active;
      headZ -= beat * 0.045 * active;
      leftShoulderZ -= 0.12 * active;
      rightShoulderZ += 0.12 * active;
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.20, active);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.20, active);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, -0.48 + beat * 0.08, active);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, 0.48 + beat * 0.08, active);
      // Symmetric inward flexion: left forearm uses negative Z, right uses
      // positive Z on this normalized VRM0 rig. The previous signs bent both
      // elbows away from the body and produced the visible inverted joints.
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.32, active);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.32, active);
      // Arms are nearly vertical here, so the wrist needs an almost quarter
      // turn to present the full palm to the viewer. Keeping both normalized
      // wrists on the same signed roll also leaves each thumb on the inner,
      // face-facing edge of the V pose.
      const palms = viewerFacingPalmTwists(palmSign, FRONT_PALM_TWIST_RADIANS);
      leftHandX = THREE.MathUtils.lerp(leftHandX, palms.left, active);
      rightHandX = THREE.MathUtils.lerp(rightHandX, palms.right, active);
      leftFingerCurl = THREE.MathUtils.lerp(leftFingerCurl, 0.055 * fingerCurlScale, active);
      rightFingerCurl = THREE.MathUtils.lerp(rightFingerCurl, 0.055 * fingerCurlScale, active);
      leftKneeX += (0.10 + Math.max(0, -beat) * 0.30) * active;
      rightKneeX += (0.10 + Math.max(0, -beat) * 0.30) * active;
    } else if (reaction === 'think') {
      const active = windowPulse(progress, 0.03, 0.22, 0.79, 0.98) * weight;
      const ponder = Math.sin(reactionElapsed * 1.35) * active;
      hipsX -= 0.015 * active;
      torsoY += 0.12 * active;
      torsoZ -= 0.055 * active;
      headX -= 0.035 * active;
      headY += (0.20 + ponder * 0.055) * active;
      headZ += 0.095 * active;
      rightShoulderZ += 0.035 * active;
      // This avatar's wide sleeve makes a generic outward elbow bend read as
      // another wave. Keep the upper arm nearer the torso and fold the forearm
      // inward on its normalized bend axis so the visible hand reaches the
      // temple/cheek line instead of stopping outside the hair.
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.08, active);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -1.08, active);
      rightArmY = THREE.MathUtils.lerp(rightArmY, -0.04, active);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 2.58, active);
      rightLowerY = THREE.MathUtils.lerp(rightLowerY, -0.02, active);
      rightHandX = THREE.MathUtils.lerp(rightHandX, 0.42 * palmSign, active);
      rightHandY = THREE.MathUtils.lerp(rightHandY, -0.08, active);
      rightFingerCurl = THREE.MathUtils.lerp(rightFingerCurl, 0.10 * fingerCurlScale, active);
      leftUpperLegZ -= 0.045 * active;
      rightKneeX += 0.035 * active;
    } else if (reaction === 'crouch') {
      const active = windowPulse(progress, 0.02, 0.24, 0.72, 0.98) * weight;
      // This action is a conventional balanced squat, not the old seiza pose:
      // the pelvis lowers, thighs angle forward, knees bend under the torso,
      // and both feet remain planted. Hands stay beside the body.
      const settle = Math.sin(reactionElapsed * 1.45) * 0.006;
      hipsY -= (squatHipsDrop * 0.54 + settle) * active;
      hipsZ -= 0.018 * active;
      torsoX += 0.075 * active;
      torsoZ += settle * 0.5 * active;
      headX -= 0.020 * active;
      leftUpperLegX -= 0.62 * active;
      rightUpperLegX -= 0.62 * active;
      leftUpperLegZ += 0.035 * active;
      rightUpperLegZ -= 0.035 * active;
      leftKneeX += 1.18 * kneeBendSign * active;
      rightKneeX += 1.18 * kneeBendSign * active;
      leftFootX += 0.28 * active;
      rightFootX += 0.28 * active;
      leftFootY += 0.035 * active;
      rightFootY -= 0.035 * active;
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.055, active);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.055, active);
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.10, active);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.10, active);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.10, active);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.10, active);
      leftFingerCurl = THREE.MathUtils.lerp(leftFingerCurl, 0.08 * fingerCurlScale, active);
      rightFingerCurl = THREE.MathUtils.lerp(rightFingerCurl, 0.08 * fingerCurlScale, active);
    } else if (reaction === 'tiptoe') {
      const active = windowPulse(progress, 0.02, 0.22, 0.76, 0.98) * weight;
      const balance = Math.sin(reactionElapsed * 2.0) * active;
      hipsY += 0.052 * active;
      hipsX += balance * 0.009;
      torsoX += 0.035 * active;
      torsoZ -= balance * 0.035;
      headX -= 0.05 * active;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.48 + balance * 0.08, active);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.48 + balance * 0.08, active);
      leftLowerZ = THREE.MathUtils.lerp(leftLowerZ, -0.16, active);
      rightLowerZ = THREE.MathUtils.lerp(rightLowerZ, 0.16, active);
      leftKneeX += 0.045 * active;
      rightKneeX += 0.045 * active;
      leftFootX += 0.30 * active;
      rightFootX += 0.30 * active;
    } else if (reaction === 'sway') {
      const active = windowPulse(progress, 0.02, 0.16, 0.85, 0.99) * weight;
      const beat = Math.sin(reactionElapsed * Math.PI * 1.35);
      const step = Math.sin(reactionElapsed * Math.PI * 2.7);
      hipsX += beat * 0.034 * active;
      hipsY += Math.max(0, step) * 0.009 * active;
      torsoY -= beat * 0.11 * active;
      torsoZ += beat * 0.15 * active;
      headY += beat * 0.07 * active;
      headZ -= beat * 0.16 * active;
      leftArmX -= step * 0.10 * active;
      rightArmX += step * 0.10 * active;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, 0.74 + beat * 0.18, active);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, -0.74 + beat * 0.18, active);
      leftUpperLegX += Math.max(0, -step) * 0.16 * active;
      rightUpperLegX += Math.max(0, step) * 0.16 * active;
      leftKneeX += Math.max(0, step) * 0.22 * active;
      rightKneeX += Math.max(0, -step) * 0.22 * active;
    }

    this.setPosition('hips', hipsX, hipsY, hipsZ * rootDepthAxisSign);
    this.setRotation('hips', 0, torsoY * 0.30, torsoZ * 0.24);
    this.setRotation('spine', torsoX * 0.36 * bodyForwardAxisSign, torsoY * 0.34, torsoZ * 0.40);
    this.setRotation('chest', torsoX * 0.42 * bodyForwardAxisSign, torsoY * 0.34, torsoZ * 0.34);
    this.setRotation('upperChest', (breath + torsoX * 0.22) * bodyForwardAxisSign, torsoY * 0.22, torsoZ * 0.20);
    this.setRotation('neck', headX * 0.32 * bodyForwardAxisSign, headY * 0.34, headZ * 0.30);
    this.setRotation('head', headX * 0.68 * bodyForwardAxisSign, headY * 0.66, headZ * 0.70);
    this.setRotation('leftShoulder', leftShoulderX, leftShoulderY, leftShoulderZ);
    this.setRotation('rightShoulder', rightShoulderX, rightShoulderY, rightShoulderZ);
    // Blender's MMD coordinate convention produces the opposite arm bend axis
    // after PMX -> VRM1 normalization. The correction lives only in generated
    // PMX manifests; built-in Yachiyo and direct VRM imports retain +1 exactly.
    this.setRotation('leftUpperArm', leftArmX, leftArmY, leftArmZ * armAxisSign);
    this.setRotation('rightUpperArm', rightArmX, rightArmY, rightArmZ * armAxisSign);
    this.setRotation('leftLowerArm', leftLowerX, leftLowerY, leftLowerZ * armAxisSign * elbowBendScale);
    this.setRotation('rightLowerArm', rightLowerX, rightLowerY, rightLowerZ * armAxisSign * elbowBendScale);
    this.setRotation('leftHand', leftHandX * wristAmplitudeScale, leftHandY * wristAmplitudeScale, leftHandZ * wristAmplitudeScale);
    this.setRotation('rightHand', rightHandX * wristAmplitudeScale, rightHandY * wristAmplitudeScale, rightHandZ * wristAmplitudeScale);
    if (this.motionProfile.capabilities.includes('pmx-converted')) {
      this.setFingerPose('left', leftFingerCurl);
      this.setFingerPose('right', rightFingerCurl);
    }
    this.setRotation('leftUpperLeg', leftUpperLegX * legForwardAxisSign, 0, leftUpperLegZ);
    this.setRotation('rightUpperLeg', rightUpperLegX * legForwardAxisSign, 0, rightUpperLegZ);
    this.setRotation('leftLowerLeg', leftKneeX * legForwardAxisSign, 0, leftKneeZ);
    this.setRotation('rightLowerLeg', rightKneeX * legForwardAxisSign, 0, rightKneeZ);
    this.setRotation('leftFoot', leftFootX * legForwardAxisSign, leftFootY, leftFootZ);
    this.setRotation('rightFoot', rightFootX * legForwardAxisSign, rightFootY, rightFootZ);
    this.setRotation('leftToes', leftToeX * legForwardAxisSign, leftToeY, leftFootZ * 0.65);
    this.setRotation('rightToes', rightToeX * legForwardAxisSign, rightToeY, rightFootZ * 0.65);
  }

  private setRotation(bone: string, x: number, y: number, z: number): void {
    const target = this.pose[bone]?.rotation;
    if (!target) return;
    this.scratchEuler.set(x, y, z, 'YXZ');
    this.scratchQuaternion.setFromEuler(this.scratchEuler);
    target[0] = this.scratchQuaternion.x;
    target[1] = this.scratchQuaternion.y;
    target[2] = this.scratchQuaternion.z;
    target[3] = this.scratchQuaternion.w;
  }

  private setPosition(bone: string, x: number, y: number, z: number): void {
    const target = this.pose[bone]?.position;
    if (!target) return;
    target[0] = x;
    target[1] = y;
    target[2] = z;
  }

  private setFingerPose(side: 'left' | 'right', curl: number): void {
    const prefix = side === 'left' ? 'left' : 'right';
    const chains = [
      [`${prefix}ThumbMetacarpal`, `${prefix}ThumbProximal`, `${prefix}ThumbDistal`, 0.55],
      [`${prefix}IndexProximal`, `${prefix}IndexIntermediate`, `${prefix}IndexDistal`, 0.95],
      [`${prefix}MiddleProximal`, `${prefix}MiddleIntermediate`, `${prefix}MiddleDistal`, 1.00],
      [`${prefix}RingProximal`, `${prefix}RingIntermediate`, `${prefix}RingDistal`, 1.05],
      [`${prefix}LittleProximal`, `${prefix}LittleIntermediate`, `${prefix}LittleDistal`, 1.10],
    ] as const;
    for (const [proximal, intermediate, distal, scale] of chains) {
      this.setRotation(proximal, curl * scale, 0, 0);
      this.setRotation(intermediate, curl * scale * 1.22, 0, 0);
      this.setRotation(distal, curl * scale * 0.82, 0, 0);
    }
  }
}
