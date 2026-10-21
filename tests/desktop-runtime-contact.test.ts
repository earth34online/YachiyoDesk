import { describe, expect, it, vi } from 'vitest';
import { AvatarRuntime } from '../src/AvatarRuntime';
import * as THREE from 'three';

describe('pointer and desktop contact ownership',()=>{
  it('late idle/cancel commands cannot release an actual captured pointer drag',()=>{
    const runtime=Object.create(AvatarRuntime.prototype) as any;
    const animator={setDragging:vi.fn(),setAutonomousMotion:vi.fn()};
    Object.assign(runtime,{vrm:{},animator,desktopContactPose:{set:vi.fn()},stopMotion:vi.fn()});
    runtime.setDragging(true);runtime.setDesktopContact({phase:'idle'});
    expect(animator.setDragging).toHaveBeenLastCalledWith(true);
    runtime.setDragging(false);runtime.setDesktopContact({phase:'fall'});
    expect(animator.setDragging).toHaveBeenLastCalledWith(true);
    runtime.setDesktopContact({phase:'land',impact:.5});
    expect(animator.setDragging).toHaveBeenLastCalledWith(false);
  });
  it('counts toes in the support footprint when a side-facing foot extends beyond its ankle',()=>{
    const runtime=Object.create(AvatarRuntime.prototype) as any;
    const camera=new THREE.PerspectiveCamera(26,560/840,.01,100);camera.position.set(0,1,5);camera.lookAt(0,1,0);camera.updateMatrixWorld();
    const positions:Record<string,THREE.Vector3>={leftFoot:new THREE.Vector3(.1,0,0),rightFoot:new THREE.Vector3(-.1,0,0),
      leftToes:new THREE.Vector3(.35,0,0),rightToes:new THREE.Vector3(-.35,0,0)};
    Object.assign(runtime,{canvas:{clientWidth:560,clientHeight:840},camera,modelHeight:1.65,
      vrm:{humanoid:{getRawBoneNode:(name:string)=>({getWorldPosition:(target:THREE.Vector3)=>target.copy(positions[name])})}}});
    const bounds=runtime.desktopContactGeometry();
    const right=(positions.leftToes.clone().project(camera).x*.5+.5)*560;
    const left=(positions.rightToes.clone().project(camera).x*.5+.5)*560;
    expect(bounds.footLeft).toBeLessThan(left);expect(bounds.footRight).toBeGreaterThan(right);
  });
});
