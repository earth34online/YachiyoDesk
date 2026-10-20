import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { updateSkinnedInteractionBounds } from '../src/interactionBounds';

function fixture(){
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Array(12).fill(0),4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0],4));
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})),bone=new THREE.Bone();
  mesh.add(bone);mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([bone]));
  mesh.computeBoundingBox();mesh.computeBoundingSphere();
  return{mesh,bone};
}

describe('posed bounds for exact visible mesh interactions',()=>{
  it('restores a real triangle hit outside the cached neutral bounds without enlarging the mesh',()=>{
    const {mesh,bone}=fixture();bone.position.x=10;mesh.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(new THREE.Vector3(10.2,.2,2),new THREE.Vector3(0,0,-1));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    updateSkinnedInteractionBounds(mesh);
    expect(ray.intersectObject(mesh)).toHaveLength(1);
    ray.ray.origin.x=11.2;expect(ray.intersectObject(mesh)).toHaveLength(0);
    expect(mesh.geometry.attributes.position.getX(0)).toBe(0);
  });
  it('encloses every actual posed vertex under rotation, scale and morphs',()=>{
    const {mesh,bone}=fixture();mesh.geometry.morphTargetsRelative=true;
    mesh.geometry.morphAttributes.position=[new THREE.Float32BufferAttribute([0,0,3,0,0,1,0,0,2],3)];
    mesh.updateMorphTargets();mesh.morphTargetInfluences![0]=1.8;
    bone.rotation.set(.8,1.2,-.4);bone.scale.set(2,.5,1.2);bone.position.set(3,-2,1);mesh.updateMatrixWorld(true);
    updateSkinnedInteractionBounds(mesh);
    for(let i=0;i<3;i++)expect(mesh.boundingBox!.containsPoint(mesh.getVertexPosition(i,new THREE.Vector3()))).toBe(true);
  });
  it('uses exact bounds for non-unit skin weights that do not satisfy the convex envelope contract',()=>{
    const {mesh,bone}=fixture();mesh.geometry.attributes.skinWeight.setX(1,2);
    bone.position.x=10;mesh.updateMatrixWorld(true);updateSkinnedInteractionBounds(mesh);
    expect(mesh.boundingBox!.containsPoint(mesh.getVertexPosition(1,new THREE.Vector3()))).toBe(true);
  });
});
