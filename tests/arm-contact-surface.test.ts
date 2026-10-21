import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe,expect,it } from 'vitest';
import { ArmContactSurface } from '../src/armContactSurface';

function surface(){
  const scene=new THREE.Group(),hips=new THREE.Bone(),root=new THREE.Group();scene.add(root);root.add(hips);
  const add=(width:number,height:number,depth:number,y:number,z=0)=>{
    const geometry=new THREE.BoxGeometry(width,height,depth);geometry.translate(0,y,z);
    const n=geometry.attributes.position.count;geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(n*4),4));const w=new Float32Array(n*4);for(let i=0;i<n;i++)w[i*4]=1;geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(w,4));
    const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());scene.add(mesh);mesh.bind(new THREE.Skeleton([hips]));
  };
  add(.3,.2,.2,-.15); // torso-level cross-section
  add(1,.2,.4,-.5); // a wide hem below the hands
  add(.8,.2,.2,-.15,-.5); // a back ornament far behind the hand
  scene.updateWorldMatrix(true,true);
  const vrm={scene,humanoid:{normalizedHumanBonesRoot:root,getNormalizedBoneNode:()=>hips,getRawBoneNode:()=>null}} as unknown as VRM;
  return {contact:new ArmContactSurface(vrm,1),hips};
}
describe('spatial arm clearance',()=>{
  it('uses the local height and depth instead of spreading arms to the widest skirt or ornament',()=>{
    const {contact}=surface();expect(contact.available).toBe(true);
    const axis=new THREE.Vector3(1,0,0);
    expect(contact.clearance(new THREE.Vector3(.1,-.15,0),axis,1,.03)).toBeCloseTo(.08,6);
    expect(contact.clearance(new THREE.Vector3(.2,-.15,0),axis,1,.03)).toBe(0);
    expect(contact.clearance(new THREE.Vector3(-.1,-.15,0),axis,-1,.03)).toBeCloseTo(.08,6);
    expect(contact.clearance(new THREE.Vector3(.1,.4,0),axis,1,.03)).toBe(0);
  });
  it('follows the pelvis and preserves the same clearance when the character turns',()=>{
    const {contact,hips}=surface();hips.rotation.y=Math.PI/2;hips.position.y=.2;
    expect(contact.clearance(new THREE.Vector3(0,.05,-.1),new THREE.Vector3(0,0,-1),1,.03)).toBeCloseTo(.08,6);
  });
});
