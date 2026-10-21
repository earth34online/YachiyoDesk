import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

/** External clips own a blend layer, never the physics clock or desktop position. */
export class MotionPlayer {
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;
  private state: 'entering' | 'playing' | 'leaving' | 'stopped' = 'stopped';
  private transitionTime = 0;
  private readonly transitionDuration = 0.32;
  private sequence = 0;
  private nodes: THREE.Object3D[] = [];
  private before: { position: THREE.Vector3; rotation: THREE.Quaternion }[] = [];
  private transitionFrom: { position: THREE.Vector3; rotation: THREE.Quaternion }[] = [];
  private looping = false;
  private readonly expressionBefore = new Map<string, number>();
  private expressionFrom = new Map<string, number>();
  name = '';
  constructor(private readonly vrm: VRM) {
    for (const bone of Object.values(vrm.humanoid.normalizedHumanBones)) if (bone?.node) {
      this.nodes.push(bone.node); this.before.push({ position: new THREE.Vector3(), rotation: new THREE.Quaternion() });
      this.transitionFrom.push({position:new THREE.Vector3(),rotation:new THREE.Quaternion()});
    }
  }
  async play(bytes: ArrayBuffer, name: string, loop: boolean): Promise<void> {
    const sequence = ++this.sequence;
    const loader = new GLTFLoader(); loader.register(parser => new VRMAnimationLoaderPlugin(parser));
    const asset = await loader.parseAsync(bytes, '');
    if (sequence !== this.sequence) return;
    const animation = asset.userData.vrmAnimations?.[0];
    if (!animation) throw new Error('动作加载器没有识别出 VRMA 数据。');
    if (animation.humanoidTracks.translation.size && Math.abs(animation.restHipsPosition.y) < 1e-6) throw new Error('动作缺少有效的静止髋部高度，无法安全重定向。');
    const clip = createVRMAnimationClip(animation, this.vrm);
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 600) throw new Error('动作时长需在 0–600 秒之间。');
    // No animated mesh/texture scene is retained; VRMA only supplies bone tracks.
    // AIRI anchors local hips positions before playback. Never bake the avatar
    // scene's world transform into a local animation track.
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    const rest = this.vrm.humanoid.normalizedRestPose.hips?.position;
    if (hips && rest) for (const track of clip.tracks) if (track instanceof THREE.VectorKeyframeTrack && track.name === `${hips.name}.position`) {
      const offset = new THREE.Vector3(track.values[0]-rest[0],track.values[1]-rest[1],track.values[2]-rest[2]);
      for(let i=0;i<track.values.length;i+=3){track.values[i]-=offset.x;track.values[i+1]-=offset.y;track.values[i+2]-=offset.z;}
    }
    this.captureTransition(); this.release(); this.mixer = new THREE.AnimationMixer(this.vrm.scene);
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    this.action.clampWhenFinished = true; this.action.play();
    this.looping = loop; this.state = 'entering'; this.transitionTime = 0; this.name = name;
  }
  private captureTransition(): void {
    for(let i=0;i<this.nodes.length;i++){this.transitionFrom[i].position.copy(this.nodes[i].position);this.transitionFrom[i].rotation.copy(this.nodes[i].quaternion);}
    this.expressionFrom = new Map(Object.keys(this.vrm.expressionManager?.expressionMap || {}).map(name=>[name,this.vrm.expressionManager?.getValue(name) || 0]));
  }
  stop(immediate = false): void {
    ++this.sequence;
    if(immediate){this.release();return;}
    if(!this.action || this.state === 'leaving')return;
    this.captureTransition();this.transitionTime=0;this.state='leaving';
  }
  get playing(): boolean { return this.state !== 'stopped'; }
  update(delta: number): void {
    if (!this.mixer || !this.action) return;
    for (let i = 0; i < this.nodes.length; i++) { this.before[i].position.copy(this.nodes[i].position); this.before[i].rotation.copy(this.nodes[i].quaternion); }
    for (const name of Object.keys(this.vrm.expressionManager?.expressionMap || {})) this.expressionBefore.set(name,this.vrm.expressionManager?.getValue(name) || 0);
    if (this.state !== 'leaving') this.mixer.update(delta);
    this.transitionTime += delta;
    const progress = Math.min(1,this.transitionTime/this.transitionDuration);
    const blend = progress*progress*progress*(progress*(progress*6-15)+10);
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i].quaternion.normalize();
      if(this.state === 'entering'){
        this.nodes[i].position.lerpVectors(this.transitionFrom[i].position,this.nodes[i].position,blend);
        this.nodes[i].quaternion.slerpQuaternions(this.transitionFrom[i].rotation,this.nodes[i].quaternion,blend);
      }else if(this.state === 'leaving'){
        this.nodes[i].position.lerpVectors(this.transitionFrom[i].position,this.before[i].position,blend);
        this.nodes[i].quaternion.slerpQuaternions(this.transitionFrom[i].rotation,this.before[i].rotation,blend);
      }
    }
    for (const [name,before] of this.expressionBefore) if(this.state !== 'playing')this.vrm.expressionManager?.setValue(name,THREE.MathUtils.lerp(this.expressionFrom.get(name)||0,this.state==='leaving'?before:this.vrm.expressionManager.getValue(name)||0,blend));
    if (this.state === 'entering' && progress === 1) this.state = 'playing';
    if (!this.looping && this.state === 'playing' && this.action.time >= Math.max(0,this.action.getClip().duration-this.transitionDuration)) {
      this.captureTransition();this.state='leaving';this.transitionTime=0;
    }
    if (this.state === 'leaving' && progress === 1 && this.transitionTime > 0) {
      // stopAllAction restores mixer bindings. Preserve this frame's procedural pose.
      this.release();
      for (let i = 0; i < this.nodes.length; i++) { this.nodes[i].position.copy(this.before[i].position); this.nodes[i].quaternion.copy(this.before[i].rotation); }
      for (const [name,before] of this.expressionBefore) this.vrm.expressionManager?.setValue(name,before);
    }
  }
  private release(): void {
    this.mixer?.stopAllAction(); this.mixer?.uncacheRoot(this.vrm.scene);
    this.mixer = null; this.action = null; this.name = ''; this.state = 'stopped';
  }
  dispose(): void { ++this.sequence; this.release(); }
}
