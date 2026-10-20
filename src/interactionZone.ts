import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { HitZone } from './types';

/** Classify the actual visible hit by its posed rig, rather than screen height. */
export function rigHitZone(vrm: VRM, hit: THREE.Intersection, source?: THREE.SkinnedMesh): HitZone | null {
  const mesh = (source ?? hit.object) as THREE.SkinnedMesh;
  if (!mesh.isSkinnedMesh || !hit.face) return null;
  const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
  if (!indices || !weights) return null;
  const human = new Map<THREE.Object3D, HitZone>();
  for (const [name, bone] of Object.entries(vrm.humanoid.rawHumanBones)) {
    if (!bone) continue;
    human.set(bone.node, /^(head|neck|jaw|leftEye|rightEye)$/.test(name) ? 'head'
      : /^(left|right)(UpperLeg|LowerLeg|Foot|Toes)$/.test(name) ? 'lower' : 'body');
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const display = hit.object as THREE.Mesh;
  // A legacy contact replacement shares the source skin's indices/weights,
  // but its displayed positions already include the contact correction.
  display.getVertexPosition(hit.face.a, a); display.getVertexPosition(hit.face.b, b); display.getVertexPosition(hit.face.c, c);
  const local = display.worldToLocal(hit.point.clone());
  const barycentric = THREE.Triangle.getBarycoord(local, a, b, c, new THREE.Vector3());
  if (!barycentric || !barycentric.toArray().every(Number.isFinite)) return null;
  const totals = { head: 0, body: 0, lower: 0 };
  const vertices = [hit.face.a, hit.face.b, hit.face.c];
  for (let corner = 0; corner < 3; corner++) {
    const vertex = vertices[corner], share = Math.max(0, barycentric.getComponent(corner));
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(vertex, slot) * share;
      if (!(weight > 0)) continue;
      let node: THREE.Object3D | null = mesh.skeleton.bones[indices.getComponent(vertex, slot)];
      while (node && !human.has(node)) node = node.parent;
      if (node) totals[human.get(node)!] += weight;
    }
  }
  const result = (Object.keys(totals) as HitZone[]).sort((left, right) => totals[right] - totals[left])[0];
  return totals[result] > 0 ? result : null;
}
