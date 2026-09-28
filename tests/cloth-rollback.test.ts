import { createRequire } from 'node:module';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { GarmentContactSolver } from '../src/garmentContact';
import { ProceduralAnimator } from '../src/ProceduralAnimator';
import type { AppSettings, MotionProfile } from '../src/types';

const require = createRequire(import.meta.url);
const { sanitizeMotionProfile } = require('../electron/motion-profile.cjs');
const { DEFAULT_SETTINGS } = require('../electron/settings.cjs');

function patch(name: string, bone: THREE.Bone, x: number): THREE.SkinnedMesh {
  const geometry = new THREE.PlaneGeometry(1, 1, 5, 5);
  geometry.translate(x, .5, 0);
  const count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(count*4),4));
  const weights = new Float32Array(count*4);
  for (let i=0;i<count;i++) weights[i*4]=1;
  geometry.setAttribute('skinWeight',new THREE.BufferAttribute(weights,4));
  const material = new THREE.MeshBasicMaterial(); material.name=name;
  const mesh = new THREE.SkinnedMesh(geometry,material);
  mesh.bind(new THREE.Skeleton([bone]));
  return mesh;
}

describe('scope of the cancelled cloth softness work',()=>{
  it('preserves posed skin without material-piece gravity/inertia/stretch drift',()=>{
    const scene=new THREE.Group(),bone=new THREE.Bone(); scene.add(bone);
    const body=patch('BODY',bone,10),sleeve=patch('SLEEVES',bone,0);
    scene.add(body,sleeve); scene.updateMatrixWorld(true);
    const weights=sleeve.geometry.attributes.skinWeight;
    const solver=GarmentContactSolver.create({scene} as unknown as VRM,
      sanitizeMotionProfile({capabilities:['pmx-converted']}))!;
    const display=solver.replacements[0].display;
    const expected=new THREE.Vector3(),actual=new THREE.Vector3();
    // Repeated changing arm poses exposed lag/sag in the cancelled PBD pass.
    for(let frame=0;frame<20;frame++){
      bone.rotation.z=Math.sin(frame*.3)*.9; scene.updateMatrixWorld(true);
      solver.update(1/60);
      for(let i=0;i<display.geometry.attributes.position.count;i++){
        sleeve.getVertexPosition(i,expected); sleeve.localToWorld(expected);
        actual.fromBufferAttribute(display.geometry.attributes.position,i);
        display.localToWorld(actual);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
      }
    }
    expect(solver.diagnostics.enabled).toBe(true);
    expect(sleeve.geometry.attributes.skinWeight).toBe(weights);
    expect(display.material).toBe(sleeve.material);
    solver.dispose();
  });

  it('retains the existing body penetration correction',()=>{
    const scene=new THREE.Group(),bone=new THREE.Bone();scene.add(bone);
    const body=patch('BODY',bone,0),sleeve=patch('SLEEVES',bone,0);
    sleeve.geometry.translate(0,0,-.02);
    scene.add(body,sleeve);scene.updateMatrixWorld(true);
    const solver=GarmentContactSolver.create({scene} as unknown as VRM,
      sanitizeMotionProfile({capabilities:['pmx-converted']}))!;
    solver.update(1/60);
    const position=solver.replacements[0].display.geometry.attributes.position;
    for(let i=0;i<position.count;i++){
      if(position.getY(i)<.8) expect(position.getZ(i)).toBeGreaterThanOrEqual(.0034);
    }
    expect(solver.diagnostics.lastContacts).toBeGreaterThan(0);
    solver.dispose();
  });

  it('keeps the separately requested larger walking arm swing PMX-only',()=>{
    const amplitude=(capabilities:string[])=>{
      let pose:Record<string,{rotation:number[]}>= {};
      const vrm={humanoid:{setNormalizedPose(value:typeof pose){pose=value;}}} as unknown as VRM;
      const profile:MotionProfile=sanitizeMotionProfile({capabilities});
      const animator=new ProceduralAnimator(vrm,DEFAULT_SETTINGS as AppSettings,profile);
      animator.setAutonomousMotion('walk');
      let minimum=Infinity,maximum=-Infinity;
      for(let i=0;i<240;i++){
        animator.update(1/60);
        if(i<60) continue;
        const euler=new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion().fromArray(pose.leftUpperArm.rotation),'YXZ');
        minimum=Math.min(minimum,euler.x); maximum=Math.max(maximum,euler.x);
      }
      return maximum-minimum;
    };
    const ordinary=amplitude([]),builtIn=amplitude(['long-garment']),pmx=amplitude(['pmx-converted']);
    expect(pmx/ordinary).toBeCloseTo(.29/.18,2);
    expect(builtIn).toBeCloseTo(ordinary,6);
  });
});
