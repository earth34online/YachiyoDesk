import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { MotionProfile } from './types';

type Weights = Map<THREE.Bone, number>;
interface Vertex {
  mesh: THREE.SkinnedMesh; index: number; point: string; signature: string;
  weights: Weights; adjacent: Set<number>;
}

/** Project a vector onto nonnegative weights with unit sum, within its authored support. */
function project(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => b - a);
  let sum = 0, theta = 0;
  sorted.forEach((value, index) => {
    sum += value;
    const candidate = (sum - 1) / (index + 1);
    if (value > candidate) theta = candidate;
  });
  return values.map(value => Math.max(0, value - theta));
}

const processed = new WeakSet<THREE.BufferGeometry>();

/** Constrained harmonic interpolation of upper-body blend weights.
 * Rigid bindings and unrelated/dynamic bones are Dirichlet boundaries. Only
 * existing bone influences are permitted; no discarded fifth influence, mesh
 * smoothing, rest-position edit, material/name selection or pose restriction.
 * Whole-body skins are excluded by their lower-limb influences.
 */
export function repairPmxSkinGradients(vrm: VRM, profile: MotionProfile, damagedMeshes: ReadonlySet<THREE.SkinnedMesh>) {
  const report = { meshes: 0, vertices: 0, iterations: 0, residual: 0 };
  if (profile.profileId !== 'generic-vrm' || !profile.capabilities.includes('pmx-converted') || !damagedMeshes.size) return report;
  const raw = (name: string) => vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
  const shoulders = ['leftShoulder', 'rightShoulder'].map(raw);
  const upper = ['leftUpperArm', 'rightUpperArm'].map(raw);
  const lower = ['leftLowerArm', 'rightLowerArm'].map(raw);
  const torso = new Set(['spine', 'chest', 'upperChest'].map(raw).filter(Boolean));
  const legs = ['leftUpperLeg', 'rightUpperLeg'].map(raw).filter(Boolean);
  if (upper.some(bone => !bone) || lower.some(bone => !bone) || !torso.size) return report;
  const under = (bone: THREE.Object3D, ancestor: THREE.Object3D) => {
    for (let node: THREE.Object3D | null = bone; node; node = node.parent) if (node === ancestor) return true;
    return false;
  };
  const arm = (bone: THREE.Bone) => upper.some((root, side) => bone === shoulders[side]
    || (under(bone, root!) && (bone === lower[side] || !under(bone, lower[side]!))));
  const allowed = (bone: THREE.Bone) => arm(bone) || torso.has(bone);
  const boneIds = new Map<THREE.Bone, number>();
  const boneId = (bone: THREE.Bone) => {
    if (!boneIds.has(bone)) boneIds.set(bone, boneIds.size);
    return boneIds.get(bone)!;
  };
  const vertices: Vertex[] = [], meshes: THREE.SkinnedMesh[] = [];
  const copies = new Map<string, number[]>();
  const quantize = (value: number) => Math.round(value * 1e6);
  const geometryUses = new Map<THREE.BufferGeometry, number>();
  vrm.scene.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) geometryUses.set(mesh.geometry, (geometryUses.get(mesh.geometry) ?? 0) + 1);
  });
  vrm.scene.updateWorldMatrix(true, true);
  vrm.scene.traverse(object => {
    const mesh = object as THREE.SkinnedMesh, g = mesh.geometry;
    if (!mesh.isSkinnedMesh || processed.has(g) || !g.index || geometryUses.get(g) !== 1) return;
    const { position, skinIndex, skinWeight } = g.attributes;
    if (!position || !skinIndex || !skinWeight) return;
    const bindings: Weights[] = []; let hasArm = false, hasTorso = false, hasLeg = false;
    for (let index = 0; index < position.count; index++) {
      const weights: Weights = new Map();
      for (let slot = 0; slot < 4; slot++) {
        const weight = skinWeight.getComponent(index, slot);
        if (!Number.isFinite(weight) || weight < 0) return;
        if (!(weight > 1e-6)) continue;
        const bone = mesh.skeleton.bones[skinIndex.getComponent(index, slot)];
        if (!bone || !Number.isFinite(weight)) return;
        weights.set(bone, (weights.get(bone) ?? 0) + weight);
        hasArm ||= arm(bone); hasTorso ||= torso.has(bone);
        hasLeg ||= legs.some(root => under(bone, root!));
      }
      if (Math.abs([...weights.values()].reduce((a, b) => a + b, 0) - 1) > 1e-5) return;
      bindings.push(weights);
    }
    if (!hasArm || !hasTorso || hasLeg) return;
    meshes.push(mesh);
    const offset = vertices.length, point = new THREE.Vector3();
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      const key = point.toArray().map(quantize).join(',');
      const weights = bindings[index];
      const signature = JSON.stringify([...weights].map(([bone, weight]) => [boneId(bone), quantize(weight)])
        .sort((a, b) => a[0] - b[0])) + JSON.stringify(Object.values(g.morphAttributes).flatMap(attributes =>
          (attributes ?? []).map(attribute => Array.from({ length: attribute.itemSize }, (_, axis) => quantize(attribute.getComponent(index, axis))))));
      vertices.push({ mesh, index, point: key, signature, weights, adjacent: new Set() });
      const set = copies.get(key + signature) ?? []; set.push(offset + index); copies.set(key + signature, set);
    }
    for (let face = 0; face < g.index.count; face += 3) for (let edge = 0; edge < 3; edge++) {
      const a = offset + g.index.getX(face + edge), b = offset + g.index.getX(face + (edge + 1) % 3);
      if (a === b) continue;
      vertices[a].adjacent.add(b); vertices[b].adjacent.add(a);
    }
  });
  const parent = vertices.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) { const next = parent[index]; parent[index] = root; index = next; }
    return root;
  };
  // Rejoin only identical bindings and morphs on a shared geometric edge.
  // Coincident points alone never connect two independent layers.
  const neighborPoints = vertices.map(vertex => new Set([...vertex.adjacent].map(index => vertices[index].point)));
  for (const group of copies.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if ([...neighborPoints[a]].some(point => neighborPoints[b].has(point))) parent[find(b)] = find(a);
  }
  const groups = new Map<number, number[]>();
  vertices.forEach((_, index) => { const root = find(index), group = groups.get(root) ?? []; group.push(index); groups.set(root, group); });
  const nodes = [...groups.values()].map(group => ({
    copies: group, weights: new Map(vertices[group[0]].weights), original: vertices[group[0]].weights,
    adjacent: new Set<number>(), fixed: false,
  }));
  const nodeForVertex = new Map<number, number>();
  nodes.forEach((node, index) => node.copies.forEach(vertex => nodeForVertex.set(vertex, index)));
  nodes.forEach((node, index) => {
    for (const copy of node.copies) for (const neighbor of vertices[copy].adjacent) {
      const target = nodeForVertex.get(neighbor)!; if (target !== index) node.adjacent.add(target);
    }
    node.fixed = node.original.size === 1 || ![...node.original.keys()].some(arm)
      || [...node.original.keys()].some(bone => !allowed(bone)) || !node.adjacent.size;
  });
  // A valid skin is not a repair target merely because another harmonic field
  // exists. Restrict interpolation to topology connected to proven seam damage.
  const damaged = new Set<number>(), pending: number[] = [];
  nodes.forEach((node, index) => {
    if (node.copies.some(copy => damagedMeshes.has(vertices[copy].mesh))) { damaged.add(index); pending.push(index); }
  });
  for (let cursor = 0; cursor < pending.length; cursor++) for (const index of nodes[pending[cursor]].adjacent) {
    if (!damaged.has(index)) { damaged.add(index); pending.push(index); }
  }
  nodes.forEach((node, index) => { if (!damaged.has(index)) node.fixed = true; });
  const reachable = new Set<number>(), queue: number[] = [];
  nodes.forEach((node, index) => { if (node.fixed) { reachable.add(index); queue.push(index); } });
  for (let cursor = 0; cursor < queue.length; cursor++) for (const index of nodes[queue[cursor]].adjacent) {
    if (!reachable.has(index)) { reachable.add(index); queue.push(index); }
  }
  nodes.forEach((node, index) => { if (!reachable.has(index)) node.fixed = true; });
  const free = nodes.filter(node => !node.fixed);
  if (!free.length) return report;
  let residual = Infinity;
  // Under-relaxed Jacobi avoids the alternating mode of bipartite meshes.
  // Stop on numerical convergence, rather than a motion/frame/iteration budget.
  while (residual > 1e-7) {
    const next = free.map(node => {
      const bones = [...node.original.keys()];
      const average = bones.map(bone => [...node.adjacent].reduce((sum, index) => sum + (nodes[index].weights.get(bone) ?? 0), 0) / node.adjacent.size);
      const projected = project(average);
      return new Map(bones.map((bone, index) => [bone, .5 * (node.weights.get(bone)! + projected[index])]));
    });
    residual = 0;
    free.forEach((node, index) => {
      for (const [bone, weight] of next[index]) residual = Math.max(residual, Math.abs(weight - node.weights.get(bone)!));
      node.weights = next[index];
    });
    report.iterations++;
  }
  report.residual = residual;
  const changed = new Map<THREE.SkinnedMesh, Array<{ index: number; weights: Weights }>>();
  for (const node of free) {
    if ([...node.weights].every(([bone, weight]) => Math.abs(weight - node.original.get(bone)!) < 1e-6)) continue;
    for (const copy of node.copies) {
      const vertex = vertices[copy], list = changed.get(vertex.mesh) ?? [];
      list.push({ index: vertex.index, weights: node.weights }); changed.set(vertex.mesh, list);
    }
  }
  for (const [mesh, changes] of changed) {
    const weights = mesh.geometry.attributes.skinWeight.clone();
    for (const change of changes) for (let slot = 0; slot < 4; slot++) {
      const bone = mesh.skeleton.bones[mesh.geometry.attributes.skinIndex.getComponent(change.index, slot)];
      const original = mesh.geometry.attributes.skinWeight.getComponent(change.index, slot);
      let total = 0;
      for (let other = 0; other < 4; other++) if (mesh.skeleton.bones[mesh.geometry.attributes.skinIndex.getComponent(change.index, other)] === bone)
        total += mesh.geometry.attributes.skinWeight.getComponent(change.index, other);
      weights.setComponent(change.index, slot, total ? (change.weights.get(bone) ?? 0) * original / total : 0);
    }
    mesh.geometry.setAttribute('skinWeight', weights);
    report.meshes++; report.vertices += changes.length;
  }
  meshes.forEach(mesh => processed.add(mesh.geometry));
  return report;
}
