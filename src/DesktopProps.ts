import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { solveTwoLink } from './genericPoseConstraints';
import { visibleSurface } from './visibleSurface';

export type DesktopPropKind = 'cup' | 'parcel';
const smooth = (x: number): number => THREE.MathUtils.smootherstep(x, 0, 1);

/** Keep the CC0 authored motion; give a pickup its reverse path to put it back. */
export function preparePropClip(source: THREE.AnimationClip, kind: DesktopPropKind): THREE.AnimationClip {
  if (kind === 'cup') {
    const clip = source.clone();
    for (const track of clip.tracks) for (let i = 0; i < track.times.length; i++) track.times[i] *= 3.8 / source.duration;
    clip.duration = 3.8;
    return clip;
  }
  const reach = source.duration * .63, speed = 2.2, pause = .65;
  const tracks = source.tracks.map(track => {
    const times = [...Array.from(track.times).filter(time => time < reach), reach];
    const values: number[] = [], outputTimes: number[] = [];
    const interpolant = (track as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant();
    for (const time of times) { outputTimes.push(time * speed); values.push(...Array.from(interpolant.evaluate(time))); }
    outputTimes.push(reach * speed + pause); values.push(...Array.from(interpolant.evaluate(reach)));
    for (const time of times.slice(0, -1).reverse()) {
      outputTimes.push((2 * reach - time) * speed + pause); values.push(...Array.from(interpolant.evaluate(time)));
    }
    const result = track.clone(); result.times = new Float32Array(outputTimes); result.values = new Float32Array(values); return result;
  });
  return new THREE.AnimationClip(`${source.name}-pickup-return`, 2 * reach * speed + pause, tracks);
}

/** A bone-only sample: no textures, meshes, live-avatar writes or physics changes. */
function sampleHand(vrm: VRM, clip: THREE.AnimationClip, time: number): THREE.Matrix4 {
  const root = vrm.humanoid.normalizedHumanBonesRoot.clone(true);
  const handName = vrm.humanoid.getNormalizedBoneNode('leftHand')!.name;
  // Animation clips also contain expression tracks. The bone-only sampler must
  // not bind those to the actual avatar or emit missing-target warnings.
  const names = new Set<string>(); root.traverse(node => names.add(node.name));
  const sampleClip = new THREE.AnimationClip('prop-contact', clip.duration, clip.tracks.filter(track => names.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName)));
  const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(sampleClip);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(time);
  root.updateMatrixWorld(true);
  const matrix = root.getObjectByName(handName)!.matrixWorld.clone();
  mixer.stopAllAction(); mixer.uncacheRoot(root); return matrix;
}

/** Task-local prop layer. Only the active sip owns a temporary mouth-contact
 * goal; ordinary motions, rest poses, fingers, meshes and physics stay untouched. */
export class DesktopProps {
  readonly root = new THREE.Group();
  private readonly object = new THREE.Group();
  private readonly station = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly grip = new THREE.Matrix4();
  private readonly contact = new THREE.Matrix4();
  private readonly heldOffset = new THREE.Matrix4();
  private readonly mouthInHead = new THREE.Vector3();
  private faceForwardSign = 1;
  private held = false;
  private cancelled = false;
  private opacity = 0;
  private readonly graspTime: number;
  private readonly releaseTime: number;
  readonly diagnostics = { kind: '', held: false, phase: 'ready', contactError: 0, scale: 0, visible: false, mouth: [] as number[], rim: [] as number[], wristError: 0 };

  constructor(private readonly vrm: VRM, readonly kind: DesktopPropKind, private readonly clip: THREE.AnimationClip) {
    if (!vrm.humanoid.getRawBoneNode('leftHand') || !vrm.humanoid.getNormalizedBoneNode('leftHand')) throw new Error('角色缺少左手骨骼，无法拿取道具。');
    this.root.name = 'Desktop props'; vrm.scene.add(this.root); this.root.add(this.station, this.object);
    const hand = vrm.humanoid.getNormalizedBoneNode('leftHand')!;
    const middle = vrm.humanoid.getNormalizedBoneNode('leftMiddleProximal');
    const index = vrm.humanoid.getNormalizedBoneNode('leftIndexProximal');
    const little = vrm.humanoid.getNormalizedBoneNode('leftLittleProximal');
    const palmLength = middle ? hand.getWorldPosition(new THREE.Vector3()).distanceTo(middle.getWorldPosition(new THREE.Vector3())) : .065;
    const palmWidth = index && little ? index.getWorldPosition(new THREE.Vector3()).distanceTo(little.getWorldPosition(new THREE.Vector3())) : palmLength * .65;
    const worldScale = vrm.scene.getWorldScale(new THREE.Vector3()).x;
    const unit = Math.max(palmLength * .76, palmWidth) / Math.max(1e-6, Math.abs(worldScale));
    this.diagnostics.scale = unit * (kind==='cup'?1.4:1);
    this.diagnostics.kind = kind;
    const head=vrm.humanoid.getNormalizedBoneNode('head');
    const eyes=['leftEye','rightEye'].map(name=>vrm.humanoid.getNormalizedBoneNode(name as 'leftEye'|'rightEye')).filter((node):node is THREE.Object3D=>Boolean(node));
    if(head){
      if(eyes.length){for(const eye of eyes)this.mouthInHead.add(head.worldToLocal(eye.getWorldPosition(new THREE.Vector3())));this.mouthInHead.divideScalar(eyes.length);this.faceForwardSign=Math.sign(this.mouthInHead.z)||1;this.mouthInHead.y*=.42;this.mouthInHead.z+=this.faceForwardSign*unit*.12;}
      else {const neck=vrm.humanoid.getNormalizedBoneNode('neck');const height=neck?head.getWorldPosition(new THREE.Vector3()).distanceTo(neck.getWorldPosition(new THREE.Vector3())):.09;this.mouthInHead.set(0,height*.55,height*.95);}
      if(kind==='cup') {
        // Eye bones are inside the head; project to the actual opaque lower
        // face rather than letting the cup meet an internal skeletal point.
        vrm.humanoid.update();vrm.scene.updateWorldMatrix(true,true);
        const rawHead=vrm.humanoid.getRawBoneNode('head');
        const ray=new THREE.Raycaster(head.localToWorld(this.mouthInHead.clone().add(new THREE.Vector3(0,0,this.faceForwardSign*unit*8))),new THREE.Vector3(0,0,-this.faceForwardSign).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion())));
        vrm.scene.traverse(node=>{const mesh=node as THREE.SkinnedMesh;if(mesh.isSkinnedMesh){mesh.skeleton.update();mesh.computeBoundingSphere();}});
        const underHead=(node:THREE.Object3D|undefined):boolean=>{for(let n=node;n;n=n.parent??undefined)if(n===rawHead)return true;return false;};
        for(const hit of ray.intersectObject(vrm.scene,true)) {
          const mesh=hit.object as THREE.SkinnedMesh;
          if(!mesh.isSkinnedMesh || !hit.face || !mesh.geometry.attributes.skinIndex)continue;
          const material=Array.isArray(mesh.material)?mesh.material[hit.face.materialIndex]:mesh.material;
          if(!material || !visibleSurface(material,hit))continue;
          const {skinIndex,skinWeight}=mesh.geometry.attributes;
          const headWeight=[hit.face.a,hit.face.b,hit.face.c].reduce((sum,index)=>sum+[0,1,2,3].reduce((weight,k)=>weight+(underHead(mesh.skeleton.bones[skinIndex.getComponent(index,k)])?skinWeight.getComponent(index,k):0),0),0)/3;
          if(headWeight<.5)continue;
          this.mouthInHead.copy(head.worldToLocal(hit.point)).z+=this.faceForwardSign*unit*.06;break;
        }
      }
    }
    // A socket in the normalized palm basis; raw wrist position is used below.
    // The prop is uniformly scaled by measured palm dimensions, never an outfit ID.
    this.grip.makeTranslation(palmLength / worldScale * .72, -unit * .22, unit * .50);
    this.object.scale.setScalar(this.diagnostics.scale);
    if (kind === 'cup') this.makeCup(); else this.makeParcel();
    this.graspTime = kind === 'parcel' ? .30 * (clip.duration - .65) / 1.26 : 0;
    this.releaseTime = kind === 'parcel' ? clip.duration - this.graspTime : clip.duration;
    if (kind === 'parcel') {
      this.contact.copy(sampleHand(vrm, clip, this.graspTime)).multiply(this.grip);
      this.contact.decompose(this.object.position, this.object.quaternion, new THREE.Vector3());
      this.makeStand(unit);
    }
    this.setOpacity(0);
  }
  private mesh(geometry: THREE.BufferGeometry, color: number, parent = this.object): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({ color, roughness: .42, metalness: .03, transparent: true });
    const mesh = new THREE.Mesh(geometry, material); parent.add(mesh); this.materials.push(material); this.geometries.push(geometry); return mesh;
  }
  private makeCup(): void {
    // Open ceramic wall, inner base, rim and tea, rather than a capped cylinder.
    const profile = [[.53,-.70],[.59,-.63],[.68,.72],[.63,.78],[.57,.72],[.50,-.54],[0,-.54]].map(([x,y]) => new THREE.Vector2(x,y));
    this.mesh(new THREE.LatheGeometry(profile, 48), 0x75d3d0);
    const tea = this.mesh(new THREE.CircleGeometry(.56, 48), 0x91532c); tea.rotation.x = -Math.PI / 2; tea.position.y = .60;
    const handle = this.mesh(new THREE.TorusGeometry(.45, .10, 12, 36, Math.PI * 1.75), 0x75d3d0);
    handle.position.set(.65, 0, 0); handle.rotation.z = Math.PI * 1.13;
    const rim = this.mesh(new THREE.TorusGeometry(.63, .035, 10, 48), 0xe5ffff); rim.rotation.x = Math.PI / 2; rim.position.y = .735;
    // Move the body away from the gripping fingers; the handle meets the socket.
    for (const child of this.object.children) child.position.x -= .80;
  }
  private makeParcel(): void {
    this.mesh(new THREE.BoxGeometry(1.2, .95, 1.1), 0xe8b370);
    this.mesh(new THREE.BoxGeometry(.18, .97, 1.12), 0xdf667f);
    this.mesh(new THREE.BoxGeometry(1.22, .97, .18), 0xdf667f);
    const bow = this.mesh(new THREE.TorusGeometry(.19,.045,8,24),0xff91ac); bow.position.set(.18,.54,0); bow.rotation.x=Math.PI/2;
  }
  private makeStand(unit: number): void {
    const position = new THREE.Vector3().setFromMatrixPosition(this.contact);
    const top = position.y - unit * .54;
    const plate = this.mesh(new THREE.CylinderGeometry(unit*2.2,unit*2.2,unit*.20,36),0xb6c6d9,this.station);
    plate.position.set(position.x,top-unit*.10,position.z);
    const leg = this.mesh(new THREE.CylinderGeometry(unit*.18,unit*.24,Math.max(.02,top),24),0x899db9,this.station);
    leg.position.set(position.x,top/2-unit*.20,position.z);
    const base=this.mesh(new THREE.CylinderGeometry(unit*1.4,unit*1.6,unit*.18,32),0x899db9,this.station);base.position.set(position.x,unit*.09,position.z);
  }
  private socket(): THREE.Matrix4 {
    const raw = this.vrm.humanoid.getRawBoneNode('leftHand')!, normalized = this.vrm.humanoid.getNormalizedBoneNode('leftHand')!;
    const position=this.root.worldToLocal(raw.getWorldPosition(new THREE.Vector3()));
    const orientation=this.root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(normalized.getWorldQuaternion(new THREE.Quaternion()));
    const local = new THREE.Matrix4().compose(position,orientation,new THREE.Vector3(1,1,1));
    return local.multiply(this.grip);
  }
  /** Only this drinking task has a mouth contact goal. Gravity chooses the
   * elbow plane, preserving both link lengths without a global arm correction. */
  applyTaskPose(time: number): void {
    if(this.kind!=='cup' || this.cancelled)return;
    const progress=time/this.clip.duration, weight=smooth((progress-.10)/.18)*smooth((.86-progress)/.16);
    if(weight===0)return;
    const human=this.vrm.humanoid, upper=human.getNormalizedBoneNode('leftUpperArm'),lower=human.getNormalizedBoneNode('leftLowerArm'),hand=human.getNormalizedBoneNode('leftHand'),head=human.getNormalizedBoneNode('head');
    if(!upper || !lower || !hand || !head)return;
    this.vrm.scene.updateWorldMatrix(true,true);
    const at=(node:THREE.Object3D)=>node.getWorldPosition(new THREE.Vector3());
    const start=at(upper),elbow=at(lower),wrist=at(hand),mouth=head.localToWorld(this.mouthInHead.clone());
    this.diagnostics.mouth=mouth.toArray();
    const orientation=head.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),this.faceForwardSign<0?Math.PI:0)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-.24));
    const actualOrientation=hand.getWorldQuaternion(new THREE.Quaternion()).slerp(orientation,weight);
    const scale=this.vrm.scene.getWorldScale(new THREE.Vector3()).x;
    const rim=new THREE.Vector3(-.8,.735,-.56).multiplyScalar(this.diagnostics.scale).add(new THREE.Vector3().setFromMatrixPosition(this.grip)).applyQuaternion(actualOrientation).multiplyScalar(scale);
    const target=wrist.clone().lerp(mouth.sub(rim),weight);
    const chest=human.getNormalizedBoneNode('chest') ?? head;
    const outward=start.clone().sub(at(chest)).setY(0).normalize();
    const pole=new THREE.Vector3(0,-1,0).addScaledVector(outward,.35);
    const result=solveTwoLink(start,target,pole,start.distanceTo(elbow),elbow.distanceTo(wrist),Math.PI*.92);
    const aim=(node:THREE.Object3D,child:THREE.Object3D,goal:THREE.Vector3)=>{
      const point=at(node),from=at(child).sub(point).normalize(),to=goal.clone().sub(point).normalize();
      const world=new THREE.Quaternion().setFromUnitVectors(from,to).multiply(node.getWorldQuaternion(new THREE.Quaternion()));
      node.quaternion.copy(node.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));node.updateWorldMatrix(false,true);
    };
    aim(upper,lower,result.joint);aim(lower,hand,result.end);
    hand.quaternion.copy(hand.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(actualOrientation));hand.updateWorldMatrix(false,true);
  }
  update(time: number, playing: boolean, delta: number): void {
    this.vrm.scene.updateWorldMatrix(true,true);
    if (!playing) this.cancelled=true;
    const targetOpacity = this.cancelled ? 0 : smooth(time / .22) * smooth((this.clip.duration - time) / .30);
    this.opacity = THREE.MathUtils.damp(this.opacity,targetOpacity,18,delta); this.setOpacity(this.opacity);
    if (this.cancelled) { this.diagnostics.phase='leaving'; return; }
    const shouldHold = this.kind==='cup' || time>=this.graspTime && time<this.releaseTime;
    const socket = this.socket();
    if (shouldHold && !this.held) {
      this.diagnostics.contactError = this.kind==='parcel' ? new THREE.Vector3().setFromMatrixPosition(socket).distanceTo(this.object.position) : 0;
      // No remote attraction. A marker only attaches when the actual hand arrives.
      if (this.kind==='cup' || this.diagnostics.contactError < this.diagnostics.scale*.35) {
        this.held=true;
        this.object.updateMatrix();
        // Same world-preserving reparent operation as Object3D.attach. Keep
        // the exact grasp transform, without a marker-time snap to the socket.
        this.heldOffset.copy(this.kind==='cup' ? new THREE.Matrix4().makeScale(this.diagnostics.scale,this.diagnostics.scale,this.diagnostics.scale)
          : socket.clone().invert().multiply(this.object.matrix));
      }
    }
    if (!shouldHold && this.held) {
      this.held=false;
    }
    if (this.held) socket.multiply(this.heldOffset).decompose(this.object.position,this.object.quaternion,this.object.scale);
    this.diagnostics.rim=this.object.localToWorld(new THREE.Vector3(-.8,.735,-.56)).toArray();
    this.diagnostics.wristError=this.vrm.humanoid.getRawBoneNode('leftHand')!.getWorldPosition(new THREE.Vector3()).distanceTo(this.vrm.humanoid.getNormalizedBoneNode('leftHand')!.getWorldPosition(new THREE.Vector3()));
    this.diagnostics.held=this.held; this.diagnostics.phase=this.held?'held':time<this.graspTime?'waiting':'returned';
  }
  cancel(): void { this.cancelled=true; }
  get finished(): boolean { return this.cancelled && this.opacity<.005; }
  private setOpacity(opacity: number): void {
    for (const material of this.materials) material.opacity=opacity;
    this.root.visible=opacity>.005; this.diagnostics.visible=this.root.visible;
  }
  dispose(): void { this.root.removeFromParent(); for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose(); }
}
