import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { MMD } from '@moeru/three-mmd';
import { describe, expect, it, vi } from 'vitest';
import { PmxPoseBinding, PmxPhysics, validatePmxPhysics } from '../src/pmxPhysics';

function fixture(duplicate = false, deform = false) {
  const rig = (scale: number) => {
    const root = new THREE.Group();
    const make = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0) => {
      const bone = new THREE.Bone(); bone.name = name; bone.position.set(x*scale,y*scale,z*scale); parent.add(bone); return bone;
    };
    const hips = make('hips',root,0,10), head = make('head',hips,0,6);
    const leftUpperArm = make('leftUpperArm',hips,2,4), rightUpperArm = make('rightUpperArm',hips,-2,4);
    const skirt = make('skirt',hips,0,-1,1);
    const bones = [hips,head,leftUpperArm,rightUpperArm,skirt];
    if(duplicate){bones.push(make('ribbon',hips,1,0,1),make(scale===1?'ribbon':'ribbon001',hips,-1,0,1));}
    if(deform){bones.push(make('leg',hips,1,-2),make('legD',hips,1,-2));}
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());root.add(mesh);
    root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones),new THREE.Matrix4());
    return {root,mesh,bones,hips,head,leftUpperArm,rightUpperArm,skirt};
  };
  const source=rig(.1),native=rig(1);
  source.root.position.set(.03,.02,-.04);source.root.updateMatrixWorld(true);
  const human:any={hips:source.hips,head:source.head,leftUpperArm:source.leftUpperArm,rightUpperArm:source.rightUpperArm};
  if(deform)human.leftUpperLeg=source.bones[6];
  const vrm={scene:source.root,humanoid:{getRawBoneNode:(name:string)=>human[name],rawHumanBones:Object.fromEntries(Object.entries(human).map(([name,node])=>[name,{node}]))}} as unknown as VRM;
  const mmd={mesh:native.mesh,pmx:{rigidBodies:[],bones:native.bones.map((_,i)=>({appendTransform:deform&&i===6?{parentIndex:5,ratio:1}:undefined}))},beforeUpdate:vi.fn()} as unknown as MMD;
  return{source,native,vrm,mmd,binding:new PmxPoseBinding(vrm,mmd)};
}
describe('original PMX physics bind-space contract',()=>{
  it('never feeds numerical error back into motion-owned limbs over repeated physics frames',()=>{
    const {source,native,binding}=fixture();
    source.rightUpperArm.scale.set(1.05,.95,1.02);
    const position=source.rightUpperArm.position.clone(),scale=source.rightUpperArm.scale.clone();
    for(let frame=0;frame<3000;frame++){
      source.rightUpperArm.rotation.set(.25*Math.sin(frame*.03),.1,-.4);
      const rotation=source.rightUpperArm.quaternion.clone();source.root.updateMatrixWorld(true);
      binding.toNative();
      // A small per-frame decomposition error must remain bounded instead of
      // becoming the input for the next frame's limb pose and skinning.
      native.rightUpperArm.matrixWorld.elements[0]*=1.00001;
      native.rightUpperArm.matrixWorld.elements[12]+=.00001;
      binding.toVrm();
      expect(source.rightUpperArm.position.equals(position)).toBe(true);
      expect(source.rightUpperArm.scale.equals(scale)).toBe(true);
      expect(source.rightUpperArm.quaternion.equals(rotation)).toBe(true);
    }
  });
  it('transfers dynamic bone motion without transferring a spurious scale',()=>{
    const {source,native,binding}=fixture();
    binding.toNative();
    native.skirt.rotation.x=.45;native.skirt.position.x+=.3;native.skirt.scale.set(1.0002,.9998,1.0001);
    native.skirt.updateMatrix();native.root.updateMatrixWorld(true);binding.toVrm();
    expect(source.skirt.scale.toArray()).toEqual([1,1,1]);
    expect(source.skirt.position.x).toBeCloseTo(.03,7);
    expect(source.skirt.rotation.x).toBeCloseTo(.45,4);
    expect(source.skirt.quaternion.length()).toBeCloseTo(1,12);
  });
  it('still transfers a humanoid bone explicitly owned by a dynamic rigid body',()=>{
    const {source,native,vrm,mmd}=fixture();
    (mmd.pmx as any).rigidBodies=[{boneIndex:2,physicsMode:1,name:'leftUpperArm'}];
    const binding=new PmxPoseBinding(vrm,mmd);binding.toNative();
    native.leftUpperArm.rotation.z=.3;native.leftUpperArm.position.y-=.5;
    native.leftUpperArm.updateMatrix();native.root.updateMatrixWorld(true);binding.toVrm();
    expect(source.leftUpperArm.rotation.z).toBeCloseTo(.3,8);
    expect(source.leftUpperArm.position.y).toBeCloseTo(.35,8);
    expect(source.leftUpperArm.scale.toArray()).toEqual([1,1,1]);
  });
  it('rejects corrupt physics input while allowing authored zero-volume anchors and reversed free limits',()=>{
    const pmx:any={bones:[{position:[0,0,0],parentBoneIndex:-1}],rigidBodies:[{
      name:'anchor',shapeSize:[0,0,0],shapePosition:[0,0,0],shapeRotation:[0,0,0],boneIndex:-1,
      mass:0,linearDamping:.5,angularDamping:.5,repulsion:0,friction:.5,shapeType:0,physicsMode:0,collisionGroup:0,collisionMask:65535,
    }],joints:[{name:'joint',rigidbodyIndexA:0,rigidbodyIndexB:0,position:[0,0,0],rotation:[0,0,0],
      positionMin:[1,1,1],positionMax:[-1,-1,-1],rotationMin:[0,0,0],rotationMax:[0,0,0],springPosition:[0,0,0],springRotation:[0,0,0]}]};
    expect(()=>validatePmxPhysics(pmx)).not.toThrow();
    for(const patch of [{shapeSize:[NaN,1,1]},{mass:-1},{boneIndex:3},{collisionGroup:16}]){
      expect(()=>validatePmxPhysics({...pmx,rigidBodies:[{...pmx.rigidBodies[0],...patch}]})).toThrow('刚体');
    }
    expect(()=>validatePmxPhysics({...pmx,joints:[{...pmx.joints[0],rigidbodyIndexA:4}]})).toThrow('关节');
    expect(()=>validatePmxPhysics({...pmx,bones:[{position:[0,Infinity,0],parentBoneIndex:-1}]})).toThrow('骨架');
  });
  it('keeps an authored body pose unchanged through both directions',()=>{
    const {source,binding}=fixture();source.hips.rotation.x=.2;source.leftUpperArm.rotation.z=-.4;source.root.updateMatrixWorld(true);
    const before=[source.hips,source.head,source.leftUpperArm,source.rightUpperArm].map(b=>b.matrixWorld.clone());
    binding.toNative();binding.toVrm();
    [source.hips,source.head,source.leftUpperArm,source.rightUpperArm].forEach((b,i)=>
      b.matrixWorld.elements.forEach((v,j)=>expect(v).toBeCloseTo(before[i].elements[j],9)));
  });
  it('explicitly updates a spring-owned bone whose automatic matrices are disabled',()=>{
    const {source,native,binding}=fixture();source.skirt.matrixAutoUpdate=false;
    binding.toNative();native.skirt.rotation.x=.35;native.skirt.updateMatrix();native.root.updateMatrixWorld(true);binding.toVrm();
    expect(source.skirt.rotation.x).toBeCloseTo(.35,8);
    expect(source.skirt.matrix.elements[6]).toBeCloseTo(Math.sin(.35),8);
    binding.beforePose();expect(source.skirt.matrix.elements[6]).toBeCloseTo(0,8);
  });
  it('keeps view rotation, translation and uniform zoom out of physics input',()=>{
    const {source,native,binding}=fixture();binding.toNative();const before=native.skirt.matrixWorld.clone();
    source.root.rotation.y=1.8;source.root.scale.setScalar(1.4);source.root.position.add(new THREE.Vector3(4,2,-3));
    source.root.updateMatrixWorld(true);binding.toNative();
    native.skirt.matrixWorld.elements.forEach((v,i)=>expect(v).toBeCloseTo(before.elements[i],8));
    binding.toVrm();expect(source.skirt.rotation.x).toBeCloseTo(0,8);
  });
  it('disambiguates duplicate names with their bind positions',()=>{
    const {source,native,binding}=fixture(true);expect(binding.diagnostics.mappedBones).toBe(7);
    binding.toNative();native.bones[5].rotation.z=.2;native.bones[5].updateMatrix();native.root.updateMatrixWorld(true);binding.toVrm();
    expect(source.bones[5].rotation.z).toBeCloseTo(.2,8);expect(source.bones[6].rotation.z).toBeCloseTo(0,8);
  });
  it('matches the space sanitization applied by the GLTF loader',()=>{
    const {source,native,vrm,mmd}=fixture();source.skirt.name='BOW_A_0_1';native.skirt.name='BOW A_0_1';
    const binding=new PmxPoseBinding(vrm,mmd,new Set([4]));expect(binding.owns(source.skirt)).toBe(true);
  });
  it('moves a collider append source together with its driven deform bone',()=>{
    const {source,native,binding}=fixture(false,true);expect(binding.diagnostics.linkedColliderChains).toBe(1);
    source.bones[6].rotation.x=.6;source.root.updateMatrixWorld(true);binding.toNative();
    expect(native.bones[5].rotation.x).toBeCloseTo(.6,8);expect(native.bones[6].rotation.x).toBeCloseTo(.6,8);
    binding.toVrm();expect(source.bones[6].rotation.x).toBeCloseTo(.6,8);
  });
  it('rejects an unmapped weighted bone instead of silently leaving part of the mesh behind',()=>{
    const {vrm,mmd,native}=fixture();native.bones[4].name='unrelated';
    expect(()=>new PmxPoseBinding(vrm,mmd,new Set([4]))).toThrow('蒙皮骨骼');
  });
  it('rejects non-finite physics output',()=>{
    const {binding,native}=fixture();binding.toNative();native.skirt.matrixWorld.elements[12]=NaN;
    expect(()=>binding.toVrm()).toThrow('非有限');
  });
  it('never loads the PMX adapter for the authored Yachiyo profile',async()=>{
    expect(await PmxPhysics.load({} as VRM,{profileId:'yachiyo-author-vrm-v1',capabilities:['pmx-converted']} as any,'invalid:',()=>true)).toBeNull();
  });
});
