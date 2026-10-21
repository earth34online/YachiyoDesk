import * as THREE from 'three';
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm';
import { solveTwoLink } from './genericPoseConstraints';

export interface DesktopContactState {
  phase: 'idle' | 'fall' | 'land' | 'edge';
  impact?: number;
  direction?: -1 | 1;
  wall?: boolean;
  wallX?: number;
  wallScreenX?: number;
}

/** Contact overlays work in the normalized skeleton, after animation and
 * before humanoid/cloth updates. They never edit geometry or source assets. */
export class DesktopContactPose {
  private state: DesktopContactState = { phase: 'idle' };
  private elapsed = 0;
  private readonly lengths = new Map<string, number>();
  private readonly root: THREE.Object3D;
  private readonly forward = new THREE.Vector3();
  private readonly legLength: number;
  private compression = 0;
  readonly diagnostics = { phase: 'idle', compression: 0, footError: 0, handReachError: 0 };

  constructor(private readonly vrm: VRM, private readonly camera: THREE.Camera, private readonly canvas: HTMLCanvasElement) {
    this.root = vrm.humanoid.normalizedHumanBonesRoot;
    this.root.updateWorldMatrix(true, true);
    for (const side of ['left', 'right']) {
      for (const [a,b] of [['UpperLeg','LowerLeg'],['LowerLeg','Foot'],['UpperArm','LowerArm'],['LowerArm','Hand']]) {
        const start = this.node(side+a), end = this.node(side+b);
        if (start && end) this.lengths.set(side+a, this.point(start).distanceTo(this.point(end)));
      }
      const foot = this.node(side+'Foot'), toe = this.node(side+'Toes');
      if (foot && toe) this.forward.add(this.point(toe).sub(this.point(foot)));
    }
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-10) this.forward.set(0,0,1);
    this.forward.normalize();
    this.legLength = ['leftUpperLeg','leftLowerLeg','rightUpperLeg','rightLowerLeg']
      .reduce((sum,key) => sum + (this.lengths.get(key) || 0), 0) / 2;
  }
  set(state: DesktopContactState): void {
    if (!['idle','fall','land','edge'].includes(state.phase)) return;
    this.state = { ...state, impact: THREE.MathUtils.clamp(Number(state.impact) || 0,0,1), direction: state.direction === -1 ? -1 : 1 };
    this.elapsed = 0;
    if (state.phase === 'idle') this.compression = 0;
  }
  get active(): boolean { return this.state.phase !== 'idle'; }
  private node(name: string): THREE.Object3D | null { return this.vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName); }
  private point(node: THREE.Object3D): THREE.Vector3 { return this.root.worldToLocal(node.getWorldPosition(new THREE.Vector3())); }
  private aim(name: string, child: string, target: THREE.Vector3): void {
    const node = this.node(name)!, end = this.node(child)!;
    const from = end.getWorldPosition(new THREE.Vector3()).sub(node.getWorldPosition(new THREE.Vector3())).normalize();
    const to = this.root.localToWorld(target.clone()).sub(node.getWorldPosition(new THREE.Vector3())).normalize();
    const world = new THREE.Quaternion().setFromUnitVectors(from,to).multiply(node.getWorldQuaternion(new THREE.Quaternion()));
    node.quaternion.copy(node.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
    node.updateWorldMatrix(false,true);
  }
  private solve(side: string, limb: 'Leg'|'Arm', target: THREE.Vector3, pole: THREE.Vector3): void {
    const upper = side+'Upper'+limb, lower = side+'Lower'+limb, end = side+(limb === 'Leg' ? 'Foot' : 'Hand');
    const a = this.lengths.get(upper), b = this.lengths.get(lower);
    if (!a || !b || a < 1e-5 || b < 1e-5) return;
    const start = this.point(this.node(upper)!);
    const reachable = target.clone();
    if (limb === 'Arm' && reachable.distanceTo(start) > (a+b)*.97) {
      reachable.sub(start).setLength((a+b)*.97).add(start);
    }
    const result = solveTwoLink(start, reachable,pole,a,b,limb === 'Arm' ? 2.45 : 2.6);
    this.aim(upper,lower,result.joint); this.aim(lower,end,result.end);
  }
  update(delta: number): void {
    this.elapsed += delta;
    this.diagnostics.phase = this.state.phase; this.diagnostics.footError = 0; this.diagnostics.handReachError = 0;
    if (!this.active || this.legLength < 1e-5) return;
    const phase = this.state.phase;
    const duration = phase === 'land' ? 1 : 1.3;
    const progress = Math.min(1,this.elapsed / duration);
    const weight = Math.sin(progress * Math.PI) ** 2;
    this.root.updateWorldMatrix(true,true);
    if (phase === 'land') {
      const target = weight * (.035 + (this.state.impact || 0) * .12);
      this.compression += (target - this.compression) * (1 - Math.exp(-delta * 24));
      const hips = this.node('hips');
      if (hips) {
        const feet = ['left','right'].flatMap(side => {
          const foot = this.node(side+'Foot');
          return foot ? [{ side, target: this.point(foot), rotation: foot.getWorldQuaternion(new THREE.Quaternion()) }] : [];
        });
        // Move in rig space, then solve each whole leg to the pre-overlay foot
        // target. Feet stay planted while the pelvis absorbs the impact.
        const desired = this.point(hips).add(new THREE.Vector3(0,-this.legLength * this.compression,0));
        hips.position.copy(hips.parent!.worldToLocal(this.root.localToWorld(desired)));
        hips.updateWorldMatrix(false,true);
        for (const {side,target,rotation} of feet) {
          this.solve(side,'Leg',target,this.forward);
          const foot = this.node(side+'Foot')!;
          foot.quaternion.copy(foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));
          foot.updateWorldMatrix(false,true);
          this.diagnostics.footError = Math.max(this.diagnostics.footError,this.point(foot).distanceTo(target));
        }
      }
    } else if (phase === 'edge' && this.state.wall && Number.isFinite(this.state.wallX)) {
      const wallX = Number.isFinite(this.state.wallScreenX) && typeof window !== 'undefined'
        ? this.state.wallScreenX! - window.screenX : this.state.wallX!;
      // Choose the actual screen-side hand, including side/back rotations.
      const hands = ['left','right'].flatMap(side => {
        const hand = this.node(side+'Hand'); if (!hand) return [];
        const world = hand.getWorldPosition(new THREE.Vector3()), projected = world.clone().project(this.camera);
        return [{side,hand,world,x:(projected.x*.5+.5)*this.canvas.clientWidth}];
      }).sort((a,b) => Math.abs(a.x-wallX) - Math.abs(b.x-wallX));
      const candidate = hands[0];
      if (candidate) {
        const shoulder = this.node(candidate.side+'UpperArm');
        if (shoulder) {
          const world = candidate.world.clone(), projected = world.clone().project(this.camera);
          const shoulderPoint = shoulder.getWorldPosition(new THREE.Vector3()).project(this.camera);
          const targetNdc = new THREE.Vector3(wallX / this.canvas.clientWidth * 2 - 1,
            THREE.MathUtils.lerp(projected.y,shoulderPoint.y,.72),projected.z);
          const target = this.root.worldToLocal(targetNdc.unproject(this.camera));
          const start = this.point(candidate.hand);
          // Blend toward the boundary, clamp by measured reach in solveTwoLink.
          const blended = start.clone().lerp(target,weight);
          this.solve(candidate.side,'Arm',blended,new THREE.Vector3(0,-1,0).addScaledVector(this.forward,.45));
          this.diagnostics.handReachError = this.point(candidate.hand).distanceTo(blended);
        }
      }
    }
    this.diagnostics.compression = this.compression;
    if (phase !== 'fall' && progress >= 1 && this.compression < .001) this.set({phase:'idle'});
  }
}
