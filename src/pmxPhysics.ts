import type { VRM } from '@pixiv/three-vrm';
import { VRMSpringBoneManager, VRMUtils } from '@pixiv/three-vrm';
import type { MMD, PmxObject } from '@moeru/three-mmd';
import * as THREE from 'three';
import type { MotionProfile } from './types';

interface Transform {
  node: THREE.Bone;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: THREE.Vector3;
}
interface Binding {
  native: THREE.Bone;
  source: THREE.Bone;
  nativeRest: THREE.Matrix4;
  nativeRestInverse: THREE.Matrix4;
  sourceBind: THREE.Matrix4;
  sourceBindInverse: THREE.Matrix4;
  poseSource: THREE.Bone;
  poseBindInverse: THREE.Matrix4;
  sourceScale: THREE.Vector3;
  motionOwned: boolean;
}
const point = new THREE.Vector3();
const depth = (node: THREE.Object3D): number => node.parent ? depth(node.parent) + 1 : 0;
const remember = (node: THREE.Bone): Transform => ({ node, position: node.position.clone(), rotation: node.quaternion.clone(), scale: node.scale.clone() });
function restore(transform: Transform): void {
  transform.node.position.copy(transform.position);
  transform.node.quaternion.copy(transform.rotation);
  transform.node.scale.copy(transform.scale);
  // VRMSpringBoneJoint disables automatic matrix updates on its bone.
  transform.node.updateMatrix();
}
function sameName(native: string, source: string): boolean {
  native = THREE.PropertyBinding.sanitizeNodeName(native);
  if (native === source) return true;
  if (!source.startsWith(native)) return false;
  return /^(?:[._]\d+|\d{3})$/.test(source.slice(native.length));
}

/** Reject corrupt numerical input before any Ammo allocation or simulation. */
export function validatePmxPhysics(pmx: PmxObject): void {
  const vector = (value: readonly number[]) => value.length === 3 && value.every(Number.isFinite);
  const index = (value: number, count: number) => Number.isInteger(value) && value >= -1 && value < count;
  for (const bone of pmx.bones) {
    if (!vector(bone.position) || !index(bone.parentBoneIndex, pmx.bones.length)) throw new Error('PMX 骨架包含无效位置或父骨骼');
  }
  for (const body of pmx.rigidBodies) {
    if (![body.shapeSize, body.shapePosition, body.shapeRotation].every(vector)
      || body.shapeSize.some(value => value < 0) || !index(body.boneIndex, pmx.bones.length)
      || ![body.mass, body.linearDamping, body.angularDamping, body.repulsion, body.friction].every(Number.isFinite)
      || body.mass < 0 || ![0, 1, 2].includes(body.shapeType) || ![0, 1, 2].includes(body.physicsMode)
      || !Number.isInteger(body.collisionGroup) || body.collisionGroup < 0 || body.collisionGroup > 15
      || !Number.isInteger(body.collisionMask) || body.collisionMask < 0 || body.collisionMask > 65535) {
      throw new Error(`PMX 刚体参数无效：${body.name}`);
    }
  }
  for (const joint of pmx.joints) {
    if (![joint.position, joint.rotation, joint.positionMin, joint.positionMax, joint.rotationMin, joint.rotationMax,
      joint.springPosition, joint.springRotation].every(vector)
      || !index(joint.rigidbodyIndexA, pmx.rigidBodies.length) || !index(joint.rigidbodyIndexB, pmx.rigidBodies.length)) {
      throw new Error(`PMX 关节参数无效：${joint.name}`);
    }
  }
}

/** Bind-space bridge: the VRM owns authored poses; the original PMX owns physics. */
export class PmxPoseBinding {
  readonly diagnostics = { mappedBones: 0, nativeBones: 0, maximumBindError: 0, linkedColliderChains: 0 };
  private readonly bindings: Binding[] = [];
  private readonly nativeBindings = new Map<THREE.Bone, Binding>();
  private readonly sourceBindings = new Map<THREE.Bone, Binding>();
  private readonly nativeRest: Transform[];
  private readonly sourceRest: Transform[];
  private readonly sourceOrder: THREE.Bone[];
  private readonly rootAtBind: THREE.Matrix4;
  private readonly rootAtBindInverse: THREE.Matrix4;
  private readonly nativeToReference: THREE.Matrix4;
  private readonly referenceToNative: THREE.Matrix4;
  private readonly worldToReference = new THREE.Matrix4();
  private readonly referenceToWorld = new THREE.Matrix4();
  private readonly a = new THREE.Matrix4();
  private readonly b = new THREE.Matrix4();

  constructor(private readonly vrm: VRM, private readonly mmd: MMD, weightedNativeBones?: Set<number>) {
    vrm.scene.updateWorldMatrix(true, true);
    mmd.mesh.updateWorldMatrix(true, true);
    this.rootAtBind = vrm.scene.matrixWorld.clone();
    this.rootAtBindInverse = this.rootAtBind.clone().invert();
    const source = new Map<string, THREE.Bone>();
    vrm.scene.traverse(object => {
      if ((object as THREE.Bone).isBone && !object.name.startsWith('Normalized_')) source.set(object.name, object as THREE.Bone);
    });
    const bind = new Map<THREE.Bone, THREE.Matrix4>();
    vrm.scene.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.skeleton.bones.forEach((bone, index) => bind.set(bone,
        this.rootAtBind.clone().multiply(mesh.skeleton.boneInverses[index].clone().invert())));
    });
    const nativeByName = new Map<string, THREE.Bone>();
    for (const bone of mmd.mesh.skeleton.bones) if (!nativeByName.has(bone.name)) nativeByName.set(bone.name, bone);
    const landmarks = ['hips', 'head', 'leftUpperArm', 'rightUpperArm'] as const;
    const sourceLandmarks = landmarks.map(name => vrm.humanoid.getRawBoneNode(name));
    if (sourceLandmarks.some(node => !node)) throw new Error('PMX 物理缺少必要的人体骨骼映射');
    const nativeLandmarks = sourceLandmarks.map(node => [...nativeByName.values()].find(bone => sameName(bone.name, node!.name)));
    if (nativeLandmarks.some(node => !node)) throw new Error('PMX 原始骨架与 VRM 人体骨骼不对应');
    const basis = (nodes: THREE.Object3D[]) => {
      const origin = nodes[0].getWorldPosition(new THREE.Vector3());
      const up = nodes[1].getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
      const right = nodes[2].getWorldPosition(new THREE.Vector3()).sub(nodes[3].getWorldPosition(new THREE.Vector3())).normalize();
      const forward = right.clone().cross(up).normalize(); right.copy(up).cross(forward).normalize();
      if (up.lengthSq() < .9 || forward.lengthSq() < .9) throw new Error('PMX 人体基准轴退化');
      return new THREE.Matrix4().makeBasis(right, up, forward).setPosition(origin);
    };
    const sourcePoints = sourceLandmarks as THREE.Object3D[], nativePoints = nativeLandmarks as THREE.Object3D[];
    const sourceHeight = sourcePoints[1].getWorldPosition(new THREE.Vector3()).distanceTo(sourcePoints[0].getWorldPosition(new THREE.Vector3()));
    const nativeHeight = nativePoints[1].getWorldPosition(new THREE.Vector3()).distanceTo(nativePoints[0].getWorldPosition(new THREE.Vector3()));
    const scale = sourceHeight / nativeHeight;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('PMX 模型比例无效');
    this.nativeToReference = basis(sourcePoints).multiply(new THREE.Matrix4().makeScale(scale, scale, scale)).multiply(basis(nativePoints).invert());
    this.referenceToNative = this.nativeToReference.clone().invert();
    const used = new Set<THREE.Bone>();
    const tolerance = Math.max(0.0002, sourceHeight * .002);
    for (const bone of mmd.mesh.skeleton.bones) {
      const target = bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(this.nativeToReference);
      const candidates = [...source.values()].filter(node => !used.has(node) && bind.has(node) && sameName(bone.name, node.name));
      candidates.sort((left, right) => point.setFromMatrixPosition(bind.get(left)!).distanceToSquared(target)
        - point.setFromMatrixPosition(bind.get(right)!).distanceToSquared(target));
      const node = candidates[0];
      if (!node) continue;
      const error = point.setFromMatrixPosition(bind.get(node)!).distanceTo(target);
      if (error > tolerance) continue;
      const record: Binding = { native: bone, source: node, nativeRest: bone.matrixWorld.clone(), nativeRestInverse: bone.matrixWorld.clone().invert(),
        sourceBind: bind.get(node)!, sourceBindInverse: bind.get(node)!.clone().invert(), poseSource: node, poseBindInverse: bind.get(node)!.clone().invert(),
        sourceScale: node.scale.clone(), motionOwned: false };
      this.bindings.push(record); this.nativeBindings.set(bone, record); this.sourceBindings.set(node, record); used.add(node);
      this.diagnostics.maximumBindError = Math.max(this.diagnostics.maximumBindError, error);
    }
    if (!this.bindings.length) throw new Error('PMX 原始骨架与 VRM 绑定姿态不匹配');
    const missing = [...(weightedNativeBones ?? [])].filter(index => !this.nativeBindings.has(mmd.mesh.skeleton.bones[index]));
    if (missing.length) {
      throw new Error(`PMX 存在无法对应的蒙皮骨骼：${missing.slice(0, 6).map(index => mmd.mesh.skeleton.bones[index]?.name).join('、')}`);
    }
    const human = new Set(Object.values(vrm.humanoid.rawHumanBones).map(bone => bone!.node));
    const dynamic = new Set<THREE.Bone>();
    for (const body of mmd.pmx.rigidBodies) {
      if (body.physicsMode === 0) continue;
      const bone = body.boneIndex >= 0 ? mmd.mesh.skeleton.bones[body.boneIndex] : nativeByName.get(body.name);
      if (bone) dynamic.add(bone);
    }
    for (const record of this.bindings) {
      // Kinematic humanoid bones are inputs to physics. Feeding their rounded
      // matrix decomposition back into the next pose accumulates scale and
      // translation error, visibly enlarging one sleeve during long sessions.
      record.motionOwned = human.has(record.source) && !dynamic.has(record.native);
      if (!human.has(record.source)) continue;
      const index = mmd.mesh.skeleton.bones.indexOf(record.native);
      const append = mmd.pmx.bones[index].appendTransform;
      if (!append || Math.abs(append.ratio - 1) > 1e-6) continue;
      const parent = this.nativeBindings.get(mmd.mesh.skeleton.bones[append.parentIndex]);
      if (!parent || human.has(parent.source)) continue;
      if (point.setFromMatrixPosition(parent.nativeRest).distanceTo(new THREE.Vector3().setFromMatrixPosition(record.nativeRest)) * scale > tolerance) continue;
      // A converter may drive D/deform bones while original PMX colliders use
      // their append source. Both chains must follow the same authored pose.
      parent.poseSource = record.source; parent.poseBindInverse = record.sourceBindInverse;
      this.diagnostics.linkedColliderChains++;
    }
    this.nativeRest = [...mmd.mesh.skeleton.bones].sort((a, b) => depth(a) - depth(b)).map(remember);
    this.sourceOrder = [...source.values()].sort((a, b) => depth(a) - depth(b));
    this.sourceRest = this.sourceOrder.filter(bone => !human.has(bone)).map(remember);
    this.diagnostics.mappedBones = this.bindings.length; this.diagnostics.nativeBones = mmd.mesh.skeleton.bones.length;
  }

  owns(bone: THREE.Object3D): boolean { return this.sourceBindings.has(bone as THREE.Bone); }

  beforePose(): void { for (const transform of this.sourceRest) restore(transform); }

  toNative(): void {
    this.vrm.scene.updateWorldMatrix(true, true);
    this.worldToReference.copy(this.vrm.scene.matrixWorld).invert().premultiply(this.rootAtBind);
    this.mmd.beforeUpdate();
    for (const transform of this.nativeRest) {
      restore(transform);
      const record = this.nativeBindings.get(transform.node);
      if (record) {
        this.a.copy(this.referenceToNative).multiply(this.worldToReference).multiply(record.poseSource.matrixWorld)
          .multiply(record.poseBindInverse).multiply(this.nativeToReference).multiply(record.nativeRest);
        this.b.copy(transform.node.parent!.matrixWorld).invert().multiply(this.a);
        this.b.decompose(transform.node.position, transform.node.quaternion, transform.node.scale);
        transform.node.quaternion.normalize();
        // Bullet simulates rigid transforms; a decomposed scale is not a
        // physical result. Keep the original native rig's authored scale.
        transform.node.scale.copy(transform.scale);
        transform.node.updateMatrix();
      }
      transform.node.updateWorldMatrix(false, false);
    }
  }

  toVrm(): void {
    this.referenceToWorld.copy(this.vrm.scene.matrixWorld).multiply(this.rootAtBindInverse);
    // Traverse all bones, including unmatched imported helper bones, so every
    // parent's matrix is current before deriving a child's local transform.
    for (const node of this.sourceOrder) {
      const record = this.sourceBindings.get(node);
      if (record && !record.motionOwned) {
        this.a.copy(this.referenceToWorld).multiply(this.nativeToReference).multiply(record.native.matrixWorld)
          .multiply(record.nativeRestInverse).multiply(this.referenceToNative).multiply(record.sourceBind);
        this.b.copy(node.parent!.matrixWorld).invert().multiply(this.a);
        if (!this.b.elements.every(Number.isFinite)) throw new Error('PMX 物理产生了非有限骨骼变换');
        this.b.decompose(node.position, node.quaternion, node.scale);
        node.quaternion.normalize();
        node.scale.copy(record.sourceScale);
        node.updateMatrix();
      }
      node.updateWorldMatrix(false, false);
    }
  }
}

let ammoInitialization: Promise<typeof import('@moeru/three-mmd-physics-ammo')> | undefined;
function ensureAmmo() {
  ammoInitialization ??= import('@moeru/three-mmd-physics-ammo').then(async adapter => { await adapter.initAmmo(); return adapter; })
    .catch(error => { ammoInitialization = undefined; throw error; });
  return ammoInitialization;
}

export class PmxPhysics {
  readonly diagnostics: Record<string, unknown>;
  private readonly auxiliary = new VRMSpringBoneManager();
  private initialized = false;
  private disposed = false;
  private resetRequested = false;
  private constructor(private readonly mmd: MMD, readonly binding: PmxPoseBinding,
    private readonly factory: typeof import('@moeru/three-mmd-physics-ammo').MMDAmmoPhysics, vrm: VRM) {
    for (const joint of vrm.springBoneManager?.joints ?? []) if (!binding.owns(joint.bone)) this.auxiliary.addJoint(joint);
    this.diagnostics = { engine: 'pmx-ammo', enabled: true, rigidBodies: mmd.pmx.rigidBodies.length, constraints: mmd.pmx.joints.length,
      ...binding.diagnostics, auxiliaryJoints: this.auxiliary.joints.size, updateMs: 0 };
  }

  static async load(vrm: VRM, profile: MotionProfile, url: string, current: () => boolean): Promise<PmxPhysics | null> {
    if (profile.profileId !== 'generic-vrm' || !profile.capabilities.includes('pmx-converted')) return null;
    const { MMDLoader } = await import('@moeru/three-mmd');
    if (!current()) return null;
    const weighted = new Set<number>();
    const loader = new MMDLoader();
    loader.register(() => ({ name: 'YachiyoDesk-physics-only', afterParse(pmx: PmxObject) {
      validatePmxPhysics(pmx);
      for (const vertex of pmx.vertices) {
        const indices = vertex.boneWeight.boneIndices;
        const values = vertex.boneWeight.boneWeights;
        const pairWeight = values && !Array.isArray(values) && typeof values === 'object' ? values.boneWeight0 : null;
        const weights = typeof indices === 'number' ? [1] : typeof values === 'number' ? [values, 1-values]
          : Array.isArray(values) ? values : pairWeight !== null ? [pairWeight, 1-pairWeight] : [];
        (typeof indices === 'number' ? [indices] : indices).forEach((index, slot) => {
          if (index >= 0 && weights[slot] > 1e-6) weighted.add(index);
        });
      }
      // Retain the original bone/rigid-body/joint topology. No second model,
      // material, texture, vertex buffer or morph buffer is built for physics.
      return { ...pmx, vertices: [], indices: new Uint16Array(0), materials: [], textures: [], morphs: [], softBodies: [] };
    } }));
    let mmd: MMD | null = null;
    try {
      mmd = await loader.loadAsync(url);
      if (!current()) return null;
      if (!mmd.pmx.rigidBodies.length || !mmd.pmx.joints.length) throw new Error('PMX 没有可用的原始刚体与关节');
      const binding = new PmxPoseBinding(vrm, mmd, weighted);
      const adapter = await ensureAmmo();
      if (!current()) return null;
      const result = new PmxPhysics(mmd, binding, adapter.MMDAmmoPhysics, vrm);
      mmd = null; return result;
    } finally {
      if (mmd) { mmd.dispose(); VRMUtils.deepDispose(mmd.mesh); }
    }
  }

  beforePose(): void { this.binding.beforePose(); }
  update(delta: number): void {
    if (this.disposed) return;
    const start = performance.now();
    this.binding.toNative();
    if (!this.initialized) { this.mmd.setPhysics(this.factory); this.initialized = true; }
    if (this.resetRequested) {
      this.mmd.physics?.reset?.(); this.auxiliary.reset(); this.resetRequested = false;
    }
    // FK is already solved by the shared humanoid animator and its constraints.
    // Its complete bind-space pose includes PMX append-source collider chains.
    this.mmd.update(delta, { ik: false, grant: false, physics: true });
    this.binding.toVrm();
    this.auxiliary.update(delta);
    this.diagnostics.updateMs = performance.now() - start;
  }
  reset(): void {
    if (this.disposed) return;
    // Reset only after the next authored pose reaches both collider chains.
    this.resetRequested = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.diagnostics.enabled = false;
    this.mmd.dispose(); VRMUtils.deepDispose(this.mmd.mesh);
  }
}
