import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { MeshBVH } from 'three-mesh-bvh';

/** The authored lower-body surface, queried at the hand's actual depth and
 * height. It never identifies outfits by name, changes meshes, or replaces
 * their spring/rigid-body simulation. Coordinates follow the posed pelvis. */
export class ArmContactSurface {
  private readonly bvh: MeshBVH | null;
  private readonly outside: number;
  private readonly hips: THREE.Object3D;
  private readonly root: THREE.Object3D;
  private readonly ray = new THREE.Ray();
  private readonly hit = new THREE.Vector3();
  private readonly transform = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(vrm: VRM, legLength: number) {
    const triangles:THREE.Triangle[]=[];
    this.root=vrm.humanoid.normalizedHumanBonesRoot;
    this.hips=vrm.humanoid.getNormalizedBoneNode('hips')!;
    vrm.scene.updateWorldMatrix(true,true);
    const toHips=new THREE.Matrix4().copy(this.hips.matrixWorld).invert();
    const excluded=['leftUpperArm','rightUpperArm','neck','head'].map(name=>vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName)).filter(Boolean);
    const isExcluded=(node:THREE.Object3D):boolean=>{for(let parent:THREE.Object3D|null=node;parent;parent=parent.parent)if(excluded.includes(parent))return true;return false;};
    vrm.scene.traverse(object=>{
      const mesh=object as THREE.SkinnedMesh;
      if(!mesh.isSkinnedMesh || !mesh.geometry.index)return;
      const positions=mesh.geometry.attributes.position, skinIndex=mesh.geometry.attributes.skinIndex, skinWeight=mesh.geometry.attributes.skinWeight;
      if(!skinIndex || !skinWeight)return;
      const excludedIndices=new Set(mesh.skeleton.bones.flatMap((bone,index)=>isExcluded(bone)?[index]:[]));
      const points:Array<THREE.Vector3|null>=[];
      for(let i=0;i<positions.count;i++){
        let excludedWeight=0;
        for(let slot=0;slot<4;slot++)if(excludedIndices.has(skinIndex.getComponent(i,slot)))excludedWeight+=skinWeight.getComponent(i,slot);
        points.push(excludedWeight>.5?null:mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).applyMatrix4(toHips));
      }
      const index=mesh.geometry.index;
      for(let i=0;i<index.count;i+=3){
        const a=points[index.getX(i)],b=points[index.getX(i+1)],c=points[index.getX(i+2)];
        if(!a||!b||!c || Math.min(a.y,b.y,c.y)>legLength*.12 || Math.max(a.y,b.y,c.y)<-legLength*.65)continue;
        triangles.push(new THREE.Triangle(a,b,c));
      }
    });
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(triangles.flatMap(triangle=>[...triangle.a.toArray(),...triangle.b.toArray(),...triangle.c.toArray()]),3));
    geometry.computeBoundingBox();
    this.outside=geometry.boundingBox?.getSize(new THREE.Vector3()).length() || legLength;
    this.bvh=triangles.length?new MeshBVH(geometry):null;
  }

  get available(): boolean { return !!this.bvh; }

  clearance(point: THREE.Vector3, lateral: THREE.Vector3, sign: number, radius: number): number {
    this.root.updateWorldMatrix(true,true);
    this.transform.copy(this.root.matrixWorld).invert().multiply(this.hips.matrixWorld);
    this.inverse.copy(this.transform).invert();
    this.origin.copy(point).applyMatrix4(this.inverse);
    this.direction.copy(lateral).transformDirection(this.inverse).multiplyScalar(sign);
    // Start on the pelvis mid-plane; inspect just this cross-section. A skirt's
    // hem or back bow cannot force a hand sideways at a different height/depth.
    const distance=this.origin.dot(this.direction);
    this.origin.addScaledVector(this.direction,-distance);
    this.ray.set(this.origin.clone().addScaledVector(this.direction,this.outside*2),this.direction.clone().negate());
    const intersection=this.bvh?.raycastFirst(this.ray,THREE.DoubleSide);
    const surface=intersection?this.hit.copy(intersection.point).sub(this.origin).dot(this.direction):0;
    return surface>0 ? Math.max(0,surface+radius-distance) : 0;
  }

  resolve(point:THREE.Vector3,shoulder:THREE.Vector3,forward:THREE.Vector3,lateral:THREE.Vector3,sign:number,radius:number,armLength:number,offsets:THREE.Vector3[]=[]):THREE.Vector3 {
    const probe=new THREE.Vector3();
    const clearance=(position:THREE.Vector3):number=>Math.max(this.clearance(position,lateral,sign,radius),...offsets.map(offset=>this.clearance(probe.copy(position).add(offset),lateral,sign,radius*.55)));
    const initial=clearance(point);
    if(initial<=0)return point;
    const original=point.clone(),relative=original.clone().sub(shoulder);
    const reach=Math.min(armLength*.99,relative.length());
    const depth=relative.dot(forward),side=relative.dot(lateral)*sign;
    let best=original.clone().addScaledVector(lateral,initial*sign),cost=Infinity;
    // Sample at palm-size resolution. Search the reachable arm arc, allowing
    // a bent elbow and a hand in front of a wide garment instead of forcing
    // both arms into a rigid sideways spread. Raised/reaching hands are free.
    const forwardTravel=Math.min(armLength*.5,Math.max(0,reach-depth-radius));
    const spacing=Math.max(radius,armLength*.04);
    for(let advance=0;advance<=forwardTravel;advance+=spacing){
      const z=depth+advance;
      let low=Math.max(0,side),high=Math.sqrt(Math.max(0,reach*reach-z*z));
      if(low>=high)continue;
      const candidate=original.clone().addScaledVector(forward,advance);
      const fit=(x:number)=>candidate.copy(shoulder).addScaledVector(forward,z).addScaledVector(lateral,x*sign)
        .addScaledVector(new THREE.Vector3(0,-1,0),Math.sqrt(Math.max(0,reach*reach-z*z-x*x)));
      // Bisection converges to a sub-millimetre contact, with tolerance derived
      // from hand size rather than a per-outfit angle or physics frame budget.
      while(high-low>radius*.002){const x=(low+high)*.5;fit(x);if(clearance(candidate)>radius*.002)low=x;else high=x;}
      fit(high);
      if(clearance(candidate)>radius*.01)continue;
      const offset=candidate.clone().sub(original),outward=offset.dot(lateral),up=offset.y;
      const value=offset.lengthSq()+outward*outward+up*up;
      if(value<cost){cost=value;best=candidate.clone();}
    }
    return best;
  }
}
