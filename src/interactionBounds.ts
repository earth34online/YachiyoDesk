import * as THREE from 'three';

interface Envelope {
  geometry: THREE.BufferGeometry;
  bones: Map<number, THREE.Box3>;
  morphRadius: number;
  normalized: boolean;
}
const envelopes = new WeakMap<THREE.SkinnedMesh, Envelope>();
const point = new THREE.Vector3(), delta = new THREE.Vector3();
const transformed = new THREE.Box3(), matrix = new THREE.Matrix4();

/** Conservative posed bounds from bone influences; final hits still use triangles. */
export function updateSkinnedInteractionBounds(mesh: THREE.SkinnedMesh): void {
  let envelope = envelopes.get(mesh);
  if (!envelope || envelope.geometry !== mesh.geometry) {
    const geometry=mesh.geometry,position=geometry.attributes.position;
    const indices=geometry.attributes.skinIndex,weights=geometry.attributes.skinWeight;
    if(!indices||!weights)return;
    envelope={geometry,bones:new Map(),morphRadius:0,normalized:true};
    for(let i=0;i<position.count;i++){
      point.fromBufferAttribute(position,i);let sum=0;
      for(let slot=0;slot<4;slot++){
        const weight=weights.getComponent(i,slot);sum+=weight;
        if(weight<0)envelope.normalized=false;
        if(!(weight>0))continue;
        const index=indices.getComponent(i,slot);
        const box=envelope.bones.get(index)??new THREE.Box3();box.expandByPoint(point);envelope.bones.set(index,box);
      }
      if(Math.abs(sum-1)>1e-5)envelope.normalized=false;
    }
    // Enclose every combination of ordinary morph weights. This avoids a
    // full vertex reskin whenever blink, gaze or a facial expression changes.
    for(const morph of geometry.morphAttributes.position??[]){
      let radius=0;
      for(let i=0;i<morph.count;i++){
        delta.fromBufferAttribute(morph,i);
        if(!geometry.morphTargetsRelative)delta.sub(point.fromBufferAttribute(position,i));
        radius=Math.max(radius,delta.length());
      }
      envelope.morphRadius+=radius;
    }
    envelopes.set(mesh,envelope);
  }
  if(!envelope.normalized){mesh.computeBoundingBox();mesh.computeBoundingSphere();return;}
  const bounds=mesh.boundingBox??=new THREE.Box3();bounds.makeEmpty();
  const morphScale=Math.max(1,...(mesh.morphTargetInfluences??[]).map(Math.abs));
  for(const [index,box] of envelope.bones){
    const bone=mesh.skeleton.bones[index];if(!bone)continue;
    matrix.copy(mesh.bindMatrixInverse).multiply(bone.matrixWorld).multiply(mesh.skeleton.boneInverses[index]).multiply(mesh.bindMatrix);
    transformed.copy(box).expandByScalar(envelope.morphRadius*morphScale).applyMatrix4(matrix);bounds.union(transformed);
  }
  bounds.getBoundingSphere(mesh.boundingSphere??=new THREE.Sphere());
}
