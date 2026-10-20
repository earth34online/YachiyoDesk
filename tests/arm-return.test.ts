import { createRequire } from 'node:module';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { ProceduralAnimator } from '../src/ProceduralAnimator';
import type { AppSettings, ReactionName } from '../src/types';

const require=createRequire(import.meta.url);
const { DEFAULT_SETTINGS }=require('../electron/settings.cjs');
const { sanitizeMotionProfile }=require('../electron/motion-profile.cjs');
const actions:ReactionName[]=['greet','joy','surprised','angry','sleepy','poke','bow','stretch',
  'dance','lookAround','nod','shakeHead','shy','cheer','think','crouch','tiptoe','sway'];
type Pose=Record<string,{rotation:number[]}>;

function rig(radius:number,pmx=true){
  const scene=new THREE.Group(),nodes:Record<string,THREE.Bone>={};
  for(const [name,y] of [['hips',1],['head',1.5],['leftFoot',0]] as const){
    const node=new THREE.Bone();node.position.y=y;nodes[name]=node;scene.add(node);
  }
  const joints=[];
  for(const [x,z] of [[radius,.16],[-radius,.16],[radius,-.16],[-radius,-.16]]){
    const bone=new THREE.Bone();bone.name='skirt';bone.position.set(x,.9,z);scene.add(bone);
    joints.push({bone});
  }
  const expressions=new Map<string,number>();let displayed:Pose={};
  const vrm={scene,springBoneManager:{joints:new Set(joints),reset:()=>{}},expressionManager:{
    expressionMap:{blink:{},relaxed:{},happy:{},surprised:{},aa:{}},
    setValue:(name:string,value:number)=>expressions.set(name,value),
    update:()=>{},
  },humanoid:{
    getRawBoneNode:(name:string)=>nodes[name],
    setNormalizedPose:(pose:Pose)=>{displayed=structuredClone(pose);},
    resetNormalizedPose:()=>{displayed={};},update:()=>{},
  }} as unknown as VRM;
  const animator=new ProceduralAnimator(vrm,{...DEFAULT_SETTINGS,idleMotion:false} as AppSettings,
    pmx?sanitizeMotionProfile({capabilities:['pmx-converted']}):sanitizeMotionProfile({profileId:'yachiyo-long-garment-v1'},{id:'yachiyo',builtIn:true}));
  // Inspect the boundary at exactly zero envelope, holding time/idle state
  // constant. This isolates an idle-only pose switch from deliberate movement.
  const inspect=animator as unknown as {
    updatePose:(sleep:number,reaction:ReactionName|null,weight:number,time:number,duration:number)=>void;
    pose:Pose;
  };
  const snapshot=(action:ReactionName|null,weight:number)=>{
    inspect.updatePose(0,action,weight,1,1);
    return structuredClone(inspect.pose);
  };
  return {animator,snapshot,expressions,displayed:()=>displayed};
}

describe('single final destination for gesture return',()=>{
  for(const pmx of [true,false])it(`publishes the ${pmx?'generic PMX':'authored Yachiyo'} reset pose before a new gesture`,()=>{
    const {animator,displayed}=rig(.25,pmx);
    animator.trigger('think');animator.update(1.2);animator.reset();
    const reset=displayed();
    expect(reset.leftUpperArm).toBeDefined();
    expect(new THREE.Quaternion().fromArray(reset.leftUpperArm.rotation).angleTo(new THREE.Quaternion())).toBeGreaterThan(.5);
    animator.trigger('dance');animator.update(0);
    for(const bone of Object.keys(reset))expect(new THREE.Quaternion().fromArray(reset[bone].rotation)
      .angleTo(new THREE.Quaternion().fromArray(displayed()[bone].rotation)),bone).toBeLessThan(1e-6);
  });
  it('keeps the sleepy reaction eyelids after waking from an automatic rest',()=>{
    const {animator,expressions}=rig(.25);
    const state=animator as unknown as {elapsed:number;nextBlinkAt:number};
    state.nextBlinkAt=Infinity;state.elapsed=181;
    for(let i=0;i<120;i++)animator.update(1/60);
    animator.noteActivity();
    for(let i=0;i<120;i++)animator.update(1/60);
    animator.trigger('sleepy');
    for(let i=0;i<90;i++)animator.update(1/60);
    expect(expressions.get('blink')).toBeGreaterThan(.85);
  });
  it('closes and opens the resting eyelids gradually without sleeping during an active walk',()=>{
    const {animator,expressions}=rig(.25);
    const state=animator as unknown as {elapsed:number;nextBlinkAt:number};
    state.nextBlinkAt=Infinity;state.elapsed=180-.001;
    animator.update(.001);expect(expressions.get('blink')).toBeLessThan(.01);
    for(let i=0;i<120;i++)animator.update(1/60);
    expect(expressions.get('blink')).toBeGreaterThan(.99);
    animator.noteActivity();animator.update(0);
    expect(expressions.get('blink')).toBeGreaterThan(.99);
    for(let i=0;i<120;i++)animator.update(1/60);
    expect(expressions.get('blink')).toBeLessThan(.01);
    state.elapsed=400;animator.setAutonomousMotion('walk');
    for(let i=0;i<120;i++)animator.update(1/60);
    expect(expressions.get('blink')).toBeLessThan(.01);
    animator.setAutonomousMotion('idle');
    for(let i=0;i<60;i++)animator.update(1/60);
    expect(expressions.get('blink')).toBeLessThan(.01);
  });
  for(const pmx of [true,false])for(const change of ['fall-asleep','wake-up'] as const){
    it(`keeps ${pmx?'generic PMX':'authored Yachiyo'} pose continuous while ${change}`,()=>{
      const {animator}=rig(.25,pmx);
      const state=animator as unknown as {elapsed:number;pose:Pose};
      state.elapsed=180-.001;animator.update(0);
      if(change==='wake-up')for(let i=0;i<180;i++)animator.update(1/60);
      const before=structuredClone(state.pose);
      if(change==='wake-up')animator.noteActivity();
      animator.update(change==='fall-asleep'?.001:0);
      for(const bone of Object.keys(before)){
        const a=new THREE.Quaternion().fromArray(before[bone].rotation);
        const b=new THREE.Quaternion().fromArray(state.pose[bone].rotation);
        expect(a.angleTo(b),bone).toBeLessThan(.001);
      }
    });
  }
  for(const pmx of [true,false])for(const change of ['repeat-walk','stop-walk','turn-walk','reaction-to-walk','reaction-to-drag','release-drag'] as const){
    it(`keeps ${pmx?'generic PMX':'authored Yachiyo'} pose continuous at ${change}`,()=>{
      const {animator}=rig(.25,pmx);
      if(change.startsWith('reaction')){animator.trigger('think');animator.update(1.2);}
      else if(change==='release-drag'){animator.setDragging(true);animator.update(1.1);}
      else{animator.setAutonomousMotion('walk',-1);animator.update(1.1);}
      const read=()=>structuredClone((animator as unknown as {pose:Pose}).pose);
      const before=read();
      if(change==='repeat-walk')animator.setAutonomousMotion('walk',-1);
      else if(change==='reaction-to-walk'||change==='turn-walk')animator.setAutonomousMotion('walk');
      else if(change==='stop-walk')animator.setAutonomousMotion('idle');
      else animator.setDragging(change==='reaction-to-drag');
      // A state command alone cannot move a bone: simulation time is zero.
      // Measure quaternion distance, independent of the transition mechanism.
      animator.update(0);const after=read();
      for(const bone of Object.keys(before)){
        const a=new THREE.Quaternion().fromArray(before[bone].rotation),b=new THREE.Quaternion().fromArray(after[bone].rotation);
        expect(a.angleTo(b),bone).toBeLessThan(1e-6);
      }
    });
  }
  it('settles on the full incoming walk without reducing its amplitude',()=>{
    const {animator:interrupted}=rig(.25),{animator:reference}=rig(.25);
    interrupted.trigger('think');interrupted.update(1.2);reference.update(1.2);
    interrupted.setAutonomousMotion('walk');reference.setAutonomousMotion('walk');
    interrupted.update(.5);reference.update(.5);
    const pose=(animator:ProceduralAnimator)=>(animator as unknown as {pose:Pose}).pose;
    for(const bone of Object.keys(pose(reference))){
      const actual=new THREE.Quaternion().fromArray(pose(interrupted)[bone].rotation);
      const expected=new THREE.Quaternion().fromArray(pose(reference)[bone].rotation);
      expect(actual.angleTo(expected),bone).toBeLessThan(1e-6);
    }
  });
  for(const radius of [.15,.39]){
    for(const action of actions){
      it(`${action} reaches the same idle hand/arm pose for radius ${radius}`,()=>{
        const {animator,snapshot}=rig(radius);
        expect(animator.getGarmentPoseDiagnostics()).not.toBeNull();
        const ending=snapshot(action,0),idle=snapshot(null,0);
        for(const bone of ['leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand']){
          expect(ending[bone].rotation).toEqual(idle[bone].rotation);
        }
        const almost=snapshot(action,.001);
        for(const bone of ['leftUpperArm','rightUpperArm']){
          const a=new THREE.Quaternion().fromArray(almost[bone].rotation);
          const b=new THREE.Quaternion().fromArray(idle[bone].rotation);
          expect(a.angleTo(b)).toBeLessThan(.006);
        }
      });
    }
  }
});
