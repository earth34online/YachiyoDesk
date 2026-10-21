import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { VRMSpringBoneManager, VRMSpringBoneJoint, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere, type VRM } from '@pixiv/three-vrm';
import { configureMissingSpringContacts } from '../src/automaticSpringContacts';
import type { MotionProfile } from '../src/types';

const profile={profileId:'generic-vrm',capabilities:[]} as unknown as MotionProfile;
function fixture(scale=1) {
  const scene=new THREE.Group();scene.scale.setScalar(scale);scene.rotation.set(.2,.6,-.1);
  const nodes:Record<string,THREE.Bone>={};
  const specifications:Record<string,[string|null,number,number,number]>={
    hips:[null,0,1,0],spine:['hips',0,.2,0],chest:['spine',0,.2,0],neck:['chest',0,.2,0],head:['neck',0,.1,0],
    leftUpperArm:['chest',.2,0,0],leftLowerArm:['leftUpperArm',.3,0,0],leftHand:['leftLowerArm',.3,0,0],
    rightUpperArm:['chest',-.2,0,0],rightLowerArm:['rightUpperArm',-.3,0,0],rightHand:['rightLowerArm',-.3,0,0],
    leftUpperLeg:['hips',.1,0,0],leftLowerLeg:['leftUpperLeg',0,-.4,0],leftFoot:['leftLowerLeg',0,-.4,0],
    rightUpperLeg:['hips',-.1,0,0],rightLowerLeg:['rightUpperLeg',0,-.4,0],rightFoot:['rightLowerLeg',0,-.4,0],
  };
  for(const [name,[parent,x,y,z]]of Object.entries(specifications)){const bone=nodes[name]=new THREE.Bone();bone.position.set(x,y,z);(parent?nodes[parent]:scene).add(bone);}
  const hair=new THREE.Bone(),tip=new THREE.Bone();nodes.head.add(hair);hair.position.z=.25;hair.add(tip);tip.position.y=-.3;
  scene.updateMatrixWorld(true);
  const bones=Object.values(nodes),skeleton=new THREE.Skeleton(bones);skeleton.calculateInverses();
  const positions:number[]=[],indices:number[]=[],weights:number[]=[],triangles:number[]=[];
  const pairs=[['hips','spine'],['spine','chest'],['chest','neck'],['leftUpperArm','leftLowerArm'],['leftLowerArm','leftHand'],['rightUpperArm','rightLowerArm'],['rightLowerArm','rightHand'],['leftUpperLeg','leftLowerLeg'],['leftLowerLeg','leftFoot'],['rightUpperLeg','rightLowerLeg'],['rightLowerLeg','rightFoot']];
  for(const [name,end]of pairs){const base=positions.length/3,bone=nodes[name],start=bone.getWorldPosition(new THREE.Vector3()),finish=nodes[end].getWorldPosition(new THREE.Vector3());
    const axis=finish.clone().sub(start).normalize(),basis=new THREE.Vector3(0,0,1).applyQuaternion(scene.quaternion).cross(axis).normalize(),other=basis.clone().cross(axis).normalize();
    for(const t of [.2,.5,.8])for(let n=0;n<12;n++){const angle=n*Math.PI/6,point=start.clone().lerp(finish,t).addScaledVector(basis,.035*scale*Math.cos(angle)).addScaledVector(other,.035*scale*Math.sin(angle));scene.worldToLocal(point);positions.push(...point.toArray());indices.push(bones.indexOf(bone),0,0,0);weights.push(1,0,0,0);}
    for(let ring=0;ring<2;ring++)for(let n=0;n<12;n++){const a=base+ring*12+n,b=base+ring*12+(n+1)%12,c=a+12,d=b+12;triangles.push(a,b,c,b,d,c);}}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  geometry.setIndex(triangles);
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());scene.add(mesh);scene.updateMatrixWorld(true);mesh.bind(skeleton,mesh.matrixWorld);
  const manager=new VRMSpringBoneManager(),joint=new VRMSpringBoneJoint(hair,tip,{hitRadius:.005});manager.addJoint(joint);manager.setInitState();
  const vrm={scene,springBoneManager:manager,humanoid:{getRawBoneNode:(name:string)=>nodes[name]??null,rawHumanBones:Object.fromEntries(Object.entries(nodes).map(([name,node])=>[name,{node}]))}} as unknown as VRM;
  return {scene,vrm,mesh,joint,manager,nodes};
}
describe('missing spring contact configuration',()=>{
  it.each([.5,1,2])('fits an inner body at scale %s without touching skin or spring settings',scale=>{
    const f=fixture(scale),position=f.mesh.geometry.attributes.position.array.slice(),settings={...f.joint.settings};
    const report=configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'});
    expect(report.status).toBe('generated');expect(report.colliders.length).toBeGreaterThanOrEqual(8);
    expect(report.colliders.every(c=>c.radius>0&&c.radius<=.035*Math.cos(Math.PI/12)+1e-7)).toBe(true);
    expect(f.mesh.geometry.attributes.position.array).toEqual(position);expect(f.joint.settings).toEqual(settings);
    const groups=f.joint.colliderGroups.length;expect(configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'})).toBe(report);expect(f.joint.colliderGroups).toHaveLength(groups);
    for(let i=0;i<60;i++)f.manager.update(1/60);
    expect(f.joint.bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
  });
  it('keeps existing authored colliders, native PMX, Yachiyo and old imports intact',()=>{
    const f=fixture();expect(configureMissingSpringContacts(f.vrm,profile,false).status).toBe('not-requested');
    expect(configureMissingSpringContacts(f.vrm,profile,true,{mode:'automatic'}).status).toBe('native');
    expect(configureMissingSpringContacts(f.vrm,{...profile,profileId:'yachiyo'},false,{mode:'automatic'}).status).toBe('native');
    const source=new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({radius:.1}));f.nodes.head.add(source);
    expect(configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'}).status).toBe('authored');expect(f.joint.colliderGroups).toHaveLength(0);
  });
  it('requires a valid body selection when multiple full-body skins exist',()=>{
    const f=fixture();const duplicate=f.mesh.clone();f.scene.add(duplicate);f.scene.updateMatrixWorld(true);
    expect(configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'}).status).toBe('needs-body');
    expect(configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic',bodyMesh:8}).status).toBe('needs-body');
    expect(configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic',bodyMesh:0,radiusScale:{leftUpperArm:.5},disabledBones:['rightUpperArm']}).colliders.find(c=>c.bone==='leftUpperArm')?.radius).toBeCloseTo(.0175*Math.cos(Math.PI/12),5);
  });
  it('does not invent cloth bones or enlarge capsules through a rest spring tip',()=>{
    const f=fixture();f.joint.bone.position.set(.2,-.4,0);f.scene.updateMatrixWorld(true);f.manager.setInitState();
    configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'});
    const tip=f.joint.bone.localToWorld(f.joint.initialLocalChildPosition.clone());
    for(const collider of f.manager.colliders){collider.updateWorldMatrix(true,false);expect(collider.shape.calculateCollision(collider.colliderMatrix,tip,f.joint.settings.hitRadius,new THREE.Vector3())).toBeGreaterThan(-1e-7);}
    const noRig=fixture();noRig.manager.deleteJoint(noRig.joint);expect(configureMissingSpringContacts(noRig.vrm,profile,false,{mode:'automatic'}).status).toBe('no-springs');
  });
  it('fits a rigid sleeve surface when the source omitted hidden arm skin',()=>{
    const f=fixture(),body=f.mesh.geometry,sleeve=body.clone();
    const arm=f.mesh.skeleton.bones.indexOf(f.nodes.leftUpperArm);
    for(const [geometry,keep]of [[body,false],[sleeve,true]] as const){
      const ids=Array.from({length:geometry.attributes.position.count},(_,i)=>i).filter(i=>(geometry.attributes.skinIndex.getX(i)===arm)===keep);
      const map=new Map(ids.map((id,index)=>[id,index])),oldIndex=geometry.index!,newIndex:number[]=[];
      for(let face=0;face<oldIndex.count;face+=3){const points=[0,1,2].map(k=>oldIndex.getX(face+k));if(points.every(i=>map.has(i)))newIndex.push(...points.map(i=>map.get(i)!));}geometry.setIndex(newIndex);
      for(const name of ['position','skinIndex','skinWeight']){
        const attribute=geometry.attributes[name],values=ids.flatMap(i=>Array.from({length:attribute.itemSize},(_,k)=>attribute.getComponent(i,k)));
        geometry.setAttribute(name,name==='skinIndex'?new THREE.Uint16BufferAttribute(values,attribute.itemSize):new THREE.Float32BufferAttribute(values,attribute.itemSize));
      }
    }
    const garment=new THREE.SkinnedMesh(sleeve,f.mesh.material);f.scene.add(garment);f.scene.updateMatrixWorld(true);garment.bind(f.mesh.skeleton,garment.matrixWorld);
    const report=configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'});
    expect(report.candidates).toHaveLength(1);expect(report.bodyMesh).toBe(0);
    expect(report.colliders.find(c=>c.bone==='leftUpperArm')?.radius).toBeCloseTo(.035*Math.cos(Math.PI/12),5);
  });
  it('does not fit a capsule when its axis crosses a body triangle interior',()=>{
    const f=fixture(),g=f.mesh.geometry,base=g.attributes.position.count,arm=f.mesh.skeleton.bones.indexOf(f.nodes.leftUpperArm);
    g.setAttribute('position',new THREE.Float32BufferAttribute([...g.attributes.position.array,.35,1.35,-.05,.35,1.45,-.05,.35,1.4,.05],3));
    g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute([...g.attributes.skinIndex.array,arm,0,0,0,arm,0,0,0,arm,0,0,0],4));
    g.setAttribute('skinWeight',new THREE.Float32BufferAttribute([...g.attributes.skinWeight.array,1,0,0,0,1,0,0,0,1,0,0,0],4));
    g.setIndex([...g.index!.array,base,base+1,base+2]);
    const report=configureMissingSpringContacts(f.vrm,profile,false,{mode:'automatic'});
    expect(report.status).toBe('generated');expect(report.colliders.some(c=>c.bone==='leftUpperArm')).toBe(false);
  });
});
