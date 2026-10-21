import * as THREE from 'three';
import { VRMHumanoid, type VRM, type VRMHumanBones } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { DesktopContactPose } from '../src/DesktopContactPose';
function rig(scale=1, rotation=0) {
  const scene=new THREE.Group(),bones:Record<string,THREE.Bone>={};
  const add=(name:string,parent:string|null,x:number,y:number,z=0)=>{const bone=new THREE.Bone();bone.position.set(x,y,z);(parent?bones[parent]:scene).add(bone);bones[name]=bone;};
  add('hips',null,0,1);add('spine','hips',0,.2);add('chest','spine',0,.2);add('neck','chest',0,.2);add('head','neck',0,.15);
  for(const [side,sign] of [['left',1],['right',-1]] as const){
    add(side+'UpperLeg','hips',sign*.1,0);add(side+'LowerLeg',side+'UpperLeg',0,-.45);add(side+'Foot',side+'LowerLeg',0,-.45);add(side+'Toes',side+'Foot',0,-.04,.12);
    add(side+'UpperArm','chest',sign*.2,.1);add(side+'LowerArm',side+'UpperArm',sign*.25,0);add(side+'Hand',side+'LowerArm',sign*.23,0);
  }
  scene.updateMatrixWorld(true);
  const humanoid=new VRMHumanoid(Object.fromEntries(Object.entries(bones).map(([name,node])=>[name,{node}])) as unknown as VRMHumanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);scene.scale.setScalar(scale);scene.rotation.y=rotation;scene.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(26,560/840,.01,100);camera.position.set(0,1,5);camera.lookAt(0,1,0);camera.updateMatrixWorld();
  const pose=new DesktopContactPose({scene,humanoid} as VRM,camera,{clientWidth:560,clientHeight:840} as HTMLCanvasElement);
  const point=(name:string)=>humanoid.getNormalizedBoneNode(name as any)!.getWorldPosition(new THREE.Vector3());
  const frame=(dt=1/60)=>{humanoid.resetNormalizedPose();humanoid.normalizedHumanBonesRoot.updateWorldMatrix(true,true);pose.update(dt);humanoid.update();scene.updateWorldMatrix(true,true);};
  return {humanoid,pose,point,frame};
}
describe('geometry-based contact poses',()=>{
  it('absorbs landing at the pelvis while preserving foot anchors and segment lengths across scales and rotations',()=>{
    for(const scale of [.7,1.8])for(const rotation of [0,Math.PI]){
      const r=rig(scale,rotation),feet=['left','right'].map(side=>r.point(side+'Foot')),hips=r.point('hips');
      const length=r.point('leftUpperLeg').distanceTo(r.point('leftLowerLeg'));
      r.pose.set({phase:'land',impact:1});for(let i=0;i<22;i++)r.frame();
      expect(r.point('hips').y).toBeLessThan(hips.y-.02*scale);
      ['left','right'].forEach((side,i)=>expect(r.point(side+'Foot').distanceTo(feet[i])).toBeLessThan(1e-5));
      expect(r.point('leftUpperLeg').distanceTo(r.point('leftLowerLeg'))).toBeCloseTo(length,6);
      expect(r.pose.diagnostics.footError).toBeLessThan(1e-5);
    }
  });
  it('starts and ends landing smoothly and higher impact causes more compression',()=>{
    const low=rig(),high=rig();low.pose.set({phase:'land',impact:0});high.pose.set({phase:'land',impact:1});
    low.frame(0);high.frame(0);expect(high.pose.diagnostics.compression).toBe(0);
    for(let i=0;i<25;i++){low.frame();high.frame();}
    expect(high.pose.diagnostics.compression).toBeGreaterThan(low.pose.diagnostics.compression*2);
    for(let i=0;i<100;i++)high.frame();expect(high.pose.active).toBe(false);
    expect(high.point('hips').y).toBeCloseTo(1,4);
  });
  it('clamps unreachable screen-side hand targets without bone stretching or nonfinite values',()=>{
    for(const rotation of [0,Math.PI/2,Math.PI]){
      const r=rig(1,rotation);const length=r.point('leftUpperArm').distanceTo(r.point('leftLowerArm'));
      r.pose.set({phase:'edge',wall:true,wallX:5000,direction:1});for(let i=0;i<40;i++)r.frame();
      expect(r.point('leftUpperArm').distanceTo(r.point('leftLowerArm'))).toBeCloseTo(length,6);
      expect(Object.values(r.humanoid.getNormalizedPose()).every(p=>(p.rotation||[]).every(Number.isFinite))).toBe(true);
    }
  });
  it('leaves authored pose unchanged when idle or when turning at a platform edge',()=>{
    const r=rig(),before=r.humanoid.getNormalizedPose();r.pose.update(1/60);
    expect(r.humanoid.getNormalizedPose()).toEqual(before);
    r.pose.set({phase:'edge',wall:false,direction:-1});r.pose.update(.5);
    expect(r.humanoid.getNormalizedPose()).toEqual(before);
    r.pose.set({phase:'idle'});expect(r.pose.active).toBe(false);
  });
});
