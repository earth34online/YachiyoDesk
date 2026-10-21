import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { MeshBVH } from 'three-mesh-bvh';

/** Rest head/hair cross-sections, attached to the posed normalized head. */
export class HeadContactSurface {
  private readonly root: THREE.Object3D;
  private readonly head: THREE.Object3D;
  private readonly bvh: MeshBVH | null;
  private readonly extent: number;
  private readonly probes: Array<{ node: THREE.Object3D; radius: number }> = [];

  constructor(vrm: VRM) {
    const human = vrm.humanoid;
    this.root = human.normalizedHumanBonesRoot;
    const head = human.getNormalizedBoneNode('head'), rawHead = human.getRawBoneNode('head');
    this.head = head ?? this.root;
    if (!head || !rawHead) { this.bvh = null; this.extent = 0; return; }
    const hand = human.getRawBoneNode('rightHand');
    const neck = human.getNormalizedBoneNode('neck');
    const under = (bone: THREE.Object3D, parent: THREE.Object3D) => {
      for (let n: THREE.Object3D | null = bone; n; n = n.parent) if (n === parent) return true;
      return false;
    };
    vrm.scene.updateWorldMatrix(true, true);
    const toHead = this.head.matrixWorld.clone().invert(), toRoot = this.root.matrixWorld.clone().invert();
    const triangles: number[] = [], skin: THREE.Vector3[] = [];
    const neckHeight = (neck ?? this.head).getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot).y;
    vrm.scene.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.geometry.index) return;
      const g = mesh.geometry, headPoints: Array<THREE.Vector3 | null> = [];
      if (!g.attributes.skinIndex || !g.attributes.skinWeight) return;
      for (let i = 0; i < g.attributes.position.count; i++) {
        let headWeight = 0, handWeight = 0;
        for (let k = 0; k < 4; k++) {
          const bone = mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i, k)], weight = g.attributes.skinWeight.getComponent(i, k);
          if (!bone || !(weight > 0)) continue;
          if (under(bone, rawHead)) headWeight += weight;
          if (hand && under(bone, hand)) handWeight += weight;
        }
        if (headWeight <= .5 && handWeight <= .5) { headPoints.push(null); continue; }
        const point = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
        const rootPoint = point.clone().applyMatrix4(toRoot);
        if (handWeight > .5) skin.push(rootPoint);
        headPoints.push(headWeight > .5 && rootPoint.y >= neckHeight ? point.applyMatrix4(toHead) : null);
      }
      for (let i = 0; i < g.index!.count; i += 3) {
        const points = [0, 1, 2].map(k => headPoints[g.index!.getX(i + k)]);
        if (points.every(Boolean)) triangles.push(...points.flatMap(point => point!.toArray()));
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3)); geometry.computeBoundingBox();
    this.extent = geometry.boundingBox?.getSize(new THREE.Vector3()).length() || 0;
    this.bvh = triangles.length ? new MeshBVH(geometry) : null;
    if (!skin.length) return;
    for (const name of ['rightHand', ...['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap(finger =>
      (finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map(part => `right${finger}${part}`))]) {
      const node = human.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (!node) continue;
      const point = node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);
      const radius = Math.sqrt(skin.reduce((minimum, vertex) => Math.min(minimum, vertex.distanceToSquared(point)), Infinity));
      if (Number.isFinite(radius)) this.probes.push({ node, radius });
    }
  }

  resolve(hand: THREE.Vector3, forward: THREE.Vector3): THREE.Vector3 {
    if (!this.bvh || !this.probes.length) return hand;
    this.root.updateWorldMatrix(true, true);
    const toRoot = this.root.matrixWorld.clone().invert(), fromHead = toRoot.clone().multiply(this.head.matrixWorld);
    const toHead = fromHead.clone().invert(), center = new THREE.Vector3().setFromMatrixPosition(fromHead);
    const direction = hand.clone().sub(center).setY(0);
    if (direction.lengthSq() < 1e-12) direction.copy(forward);
    direction.normalize();
    const localDirection = direction.clone().transformDirection(toHead), ray = new THREE.Ray();
    let correction = 0;
    for (const probe of this.probes) {
      const point = probe.node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);
      const origin = center.clone().setY(point.y);
      const distance = point.clone().sub(origin).dot(direction);
      const localOrigin = origin.clone().applyMatrix4(toHead).addScaledVector(localDirection, this.extent * 2);
      ray.set(localOrigin, localDirection.clone().negate());
      const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!hit) continue;
      const surface = hit.point.clone().applyMatrix4(fromHead).sub(origin).dot(direction);
      if (surface > 0) correction = Math.max(correction, surface + probe.radius - distance);
    }
    return hand.clone().addScaledVector(direction, correction);
  }
}
