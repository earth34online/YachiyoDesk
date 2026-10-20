import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { rigHitZone } from '../src/interactionZone';

function fixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0,0,0,0, 1,0,0,0, 2,0,0,0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0], 4));
  const head=new THREE.Bone(),hand=new THREE.Bone(),leg=new THREE.Bone();
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());
  for(const bone of [head,hand,leg])mesh.add(bone);
  mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([head,hand,leg]));
  const vrm={humanoid:{rawHumanBones:{head:{node:head},rightHand:{node:hand},leftUpperLeg:{node:leg}}}} as unknown as VRM;
  const hit=(x:number,y:number):THREE.Intersection=>({object:mesh,distance:1,point:mesh.localToWorld(new THREE.Vector3(x,y,0)),
    face:{a:0,b:1,c:2,normal:new THREE.Vector3(0,0,1),materialIndex:0}});
  return{mesh,head,hand,leg,vrm,hit};
}

describe('visible mesh interaction zones',()=>{
  it('identifies a raised hand as body and a crouched head as head, independent of world height',()=>{
    const {mesh,vrm,hit}=fixture();mesh.position.y=2;mesh.updateMatrixWorld(true);
    expect(rigHitZone(vrm,hit(.9,.05))).toBe('body');
    mesh.position.y=-1;mesh.updateMatrixWorld(true);
    expect(rigHitZone(vrm,hit(.05,.05))).toBe('head');
    expect(rigHitZone(vrm,hit(.05,.9))).toBe('lower');
  });
  it('follows a garment helper to its humanoid ancestor without enlarging the clickable silhouette',()=>{
    const {mesh,leg,vrm,hit}=fixture();const helper=new THREE.Bone();leg.add(helper);
    mesh.skeleton.bones[2]=helper;mesh.skeleton.boneInverses[2]=new THREE.Matrix4();mesh.updateMatrixWorld(true);
    expect(rigHitZone(vrm,hit(.05,.9))).toBe('lower');
  });
  it('can classify a displayed contact replacement with the original skin weights',()=>{
    const {mesh,vrm,hit}=fixture(),display=new THREE.Mesh(mesh.geometry.clone(),mesh.material);
    const intersection=hit(.9,.05);intersection.object=display;
    expect(rigHitZone(vrm,intersection)).toBeNull();
    expect(rigHitZone(vrm,intersection,mesh)).toBe('body');
  });
  it('falls back for missing skin or a degenerate triangle instead of inventing a zone',()=>{
    const {mesh,vrm,hit}=fixture();mesh.geometry.attributes.position.array.fill(0);
    expect(rigHitZone(vrm,hit(0,0))).toBeNull();
    expect(rigHitZone(vrm,{object:new THREE.Object3D()} as THREE.Intersection)).toBeNull();
  });
});
