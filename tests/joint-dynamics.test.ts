import * as THREE from 'three';
import { describe,expect,it } from 'vitest';
import { JointDynamics } from '../src/jointDynamics';

const target=(angle:number)=>({rightUpperArm:{rotation:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle).toArray()}});
describe('joint follow-through',()=>{
  it('starts at the current pose, retains full reach, and preserves continuity on interruption',()=>{
    const spring=new JointDynamics();spring.apply(target(0),0);
    const first=target(1.4);spring.apply(first,1/120);const angle=new THREE.Quaternion().fromArray(first.rightUpperArm.rotation).angleTo(new THREE.Quaternion());
    expect(angle).toBeGreaterThan(0);expect(angle).toBeLessThan(.1);
    let previous=first;
    for(let i=0;i<120;i++){previous=target(1.4);spring.apply(previous,1/120);}
    expect(new THREE.Quaternion().fromArray(previous.rightUpperArm.rotation).angleTo(new THREE.Quaternion().fromArray(target(1.4).rightUpperArm.rotation))).toBeLessThan(1e-6);
    const interrupted=target(-1.4);spring.apply(interrupted,0);expect(interrupted.rightUpperArm.rotation).toEqual(previous.rightUpperArm.rotation);
  });
  it('settles independently of frame rate without changing planted feet or root motion',()=>{
    const results=[];
    for(const hz of [30,60,120]){
      const spring=new JointDynamics();spring.apply(target(0),0);let pose=target(0);
      for(let i=0;i<hz/10;i++){pose=target(1);spring.apply(pose,1/hz);}results.push(pose.rightUpperArm.rotation);
      const support={hips:{position:[0,-.2,0]},leftFoot:{rotation:[0,0,0,1]}};spring.apply(support,1/hz);expect(support).toEqual({hips:{position:[0,-.2,0]},leftFoot:{rotation:[0,0,0,1]}});
    }
    for(const result of results)expect(new THREE.Quaternion().fromArray(result).angleTo(new THREE.Quaternion().fromArray(results[0]))).toBeLessThan(1e-7);
  });
});
