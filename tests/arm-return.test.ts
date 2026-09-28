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

function rig(radius:number){
  const scene=new THREE.Group(),nodes:Record<string,THREE.Bone>={};
  for(const [name,y] of [['hips',1],['head',1.5],['leftFoot',0]] as const){
    const node=new THREE.Bone();node.position.y=y;nodes[name]=node;scene.add(node);
  }
  const joints=[];
  for(const [x,z] of [[radius,.16],[-radius,.16],[radius,-.16],[-radius,-.16]]){
    const bone=new THREE.Bone();bone.name='skirt';bone.position.set(x,.9,z);scene.add(bone);
    joints.push({bone});
  }
  const vrm={scene,springBoneManager:{joints:new Set(joints)},humanoid:{
    getRawBoneNode:(name:string)=>nodes[name],setNormalizedPose:()=>{},
  }} as unknown as VRM;
  const animator=new ProceduralAnimator(vrm,{...DEFAULT_SETTINGS,idleMotion:false} as AppSettings,
    sanitizeMotionProfile({capabilities:['pmx-converted']}));
  // Inspect the boundary at exactly zero envelope, holding time/idle state
  // constant. This isolates an idle-only pose switch from deliberate movement.
  const inspect=animator as unknown as {
    updatePose:(sleep:boolean,reaction:ReactionName|null,weight:number,time:number,duration:number)=>void;
    pose:Pose;
  };
  const snapshot=(action:ReactionName|null,weight:number)=>{
    inspect.updatePose(false,action,weight,1,1);
    return structuredClone(inspect.pose);
  };
  return {animator,snapshot};
}

describe('single final destination for gesture return',()=>{
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
