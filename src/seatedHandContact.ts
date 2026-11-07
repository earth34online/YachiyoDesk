import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { MeshBVH } from 'three-mesh-bvh';
import { visibleSurface } from './visibleSurface';

/** Posed thigh triangles and skin-derived hand probes, for hands resting on a lap. */
export class SeatedHandContact {
  private readonly vertices: { mesh: THREE.SkinnedMesh; index: number }[] = [];
  private readonly geometry = new THREE.BufferGeometry();
  private readonly surfaces: { mesh: THREE.SkinnedMesh; material: THREE.Material }[] = [];
  private readonly bvh: MeshBVH | null;
  private readonly probes = new Map<string, { node: THREE.Object3D; radius: number }[]>();
  private readonly root: THREE.Object3D;
  private readonly ray = new THREE.Ray();
  private readonly point = new THREE.Vector3();
  private readonly bounds = new THREE.Box3();

  constructor(private readonly vrm: VRM) {
    this.root = vrm.humanoid.normalizedHumanBonesRoot;
    const legs = ['leftUpperLeg', 'rightUpperLeg'].map(name => vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName));
    const hands = ['left', 'right'].map(side => ({ side, raw: vrm.humanoid.getRawBoneNode(`${side}Hand` as VRMHumanBoneName), skin: [] as THREE.Vector3[] }));
    const under = (node: THREE.Object3D, parent: THREE.Object3D | null): boolean => {
      for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === parent) return true;
      return false;
    };
    vrm.humanoid.update(); vrm.scene.updateWorldMatrix(true, true);
    vrm.scene.traverse(object => {
      const mesh = object as THREE.SkinnedMesh, g = mesh.geometry;
      if (!mesh.isSkinnedMesh || !g.index || !g.attributes.skinIndex || !g.attributes.skinWeight) return;
      const thigh: boolean[] = [];
      for (let i = 0; i < g.attributes.position.count; i++) {
        let legWeight = 0; const handWeight = [0, 0];
        for (let k = 0; k < 4; k++) {
          const bone = mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i, k)], weight = g.attributes.skinWeight.getComponent(i, k);
          if (legs.includes(bone)) legWeight += weight;
          hands.forEach((hand, j) => { if (bone && hand.raw && under(bone, hand.raw)) handWeight[j] += weight; });
        }
        thigh.push(legWeight > .5);
        handWeight.forEach((weight, j) => {
          if (weight > .5) hands[j].skin.push(this.root.worldToLocal(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)));
        });
      }
      for (let i = 0; i < g.index.count; i += 3) {
        const indices = [g.index.getX(i), g.index.getX(i + 1), g.index.getX(i + 2)];
        if (indices.every(index => thigh[index])) {
          const group = g.groups.find(group => i >= group.start && i < group.start + group.count);
          const material = Array.isArray(mesh.material) ? mesh.material[group?.materialIndex ?? 0] : mesh.material;
          if (!material) continue;
          this.surfaces.push({ mesh, material });
          for (const index of indices) this.vertices.push({ mesh, index });
        }
      }
    });
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.vertices.length * 3), 3));
    for (const name of ['uv', 'uv1']) this.geometry.setAttribute(name, new THREE.Float32BufferAttribute(
      this.vertices.flatMap(({mesh,index}) => {
        const attribute = mesh.geometry.getAttribute(name); return attribute ? [attribute.getX(index), attribute.getY(index)] : [0,0];
      }), 2));
    this.update();
    this.bvh = this.vertices.length ? new MeshBVH(this.geometry, { indirect: true }) : null;
    for (const hand of hands) {
      const probes: { node: THREE.Object3D; radius: number }[] = [];
      for (const suffix of ['Hand', ...['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap(finger =>
        (finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map(part => finger + part))]) {
        const node = vrm.humanoid.getRawBoneNode((hand.side + suffix) as VRMHumanBoneName);
        if (!node || !hand.skin.length) continue;
        const p = this.root.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
        const radius = Math.sqrt(hand.skin.reduce((distance, vertex) => Math.min(distance, vertex.distanceToSquared(p)), Infinity));
        if (Number.isFinite(radius)) probes.push({ node, radius });
      }
      this.probes.set(hand.side, probes);
    }
  }

  update(): void {
    const attr = this.geometry.getAttribute('position');
    this.vrm.humanoid.update(); this.vrm.scene.updateWorldMatrix(true, true);
    this.bounds.makeEmpty();
    this.vertices.forEach(({ mesh, index }, i) => {
      this.root.worldToLocal(mesh.getVertexPosition(index, this.point).applyMatrix4(mesh.matrixWorld));
      attr.setXYZ(i, this.point.x, this.point.y, this.point.z); this.bounds.expandByPoint(this.point);
    });
    this.bvh?.refit();
  }

  resolve(side: string, hand: THREE.Vector3, maintainContact = false): THREE.Vector3 {
    if (!this.bvh || this.bounds.isEmpty()) return hand;
    let lift = maintainContact ? -Infinity : 0;
    const probes = this.probes.get(side) ?? [];
    const wrist = probes[0]?.node.getWorldPosition(new THREE.Vector3());
    const offset = wrist ? hand.clone().sub(this.root.worldToLocal(wrist)) : new THREE.Vector3();
    for (const probe of probes) {
      const p = this.root.worldToLocal(probe.node.getWorldPosition(new THREE.Vector3())).add(offset);
      // A downward ray finds the actual upper surface, including a bent thigh.
      this.ray.set(new THREE.Vector3(p.x, this.bounds.max.y + probe.radius, p.z), new THREE.Vector3(0, -1, 0));
      const hit = this.bvh.raycast(this.ray, THREE.DoubleSide).sort((a,b) => a.distance-b.distance).find(candidate => {
        const surface = this.surfaces[candidate.faceIndex!];
        if (!surface || !surface.mesh.visible || !visibleSurface(surface.material, candidate)) return false;
        return surface.material.side === THREE.DoubleSide || !candidate.face
          || (candidate.face.normal.dot(this.ray.direction) < 0) === (surface.material.side === THREE.FrontSide);
      });
      if (hit) lift = Math.max(lift, hit.point.y + probe.radius - p.y);
    }
    return Number.isFinite(lift) ? hand.clone().add(new THREE.Vector3(0, lift, 0)) : hand;
  }
}
