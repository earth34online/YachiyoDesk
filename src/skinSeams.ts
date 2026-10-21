import * as THREE from 'three';
import type { MotionProfile } from './types';

interface Vertex { index: number; position: string; weights: string }

/** Repair an unambiguous split at an existing UV seam, without welding geometry.
 * Coincidence alone is insufficient: the copies must share a boundary edge,
 * have identical morph displacement, and agree on a strict majority binding.
 * Balanced alternatives and disconnected overlapping layers remain authored.
 */
export function repairPmxSkinSeams(scene: THREE.Object3D, profile: MotionProfile, onRepair?: (mesh: THREE.SkinnedMesh) => void): {
  meshes: number; seamGroups: number; vertices: number;
} {
  const report = { meshes: 0, seamGroups: 0, vertices: 0 };
  if (profile.profileId !== 'generic-vrm' || !profile.capabilities.includes('pmx-converted')) return report;
  scene.traverse(object => {
    const mesh = object as THREE.SkinnedMesh, g = mesh.geometry;
    if (!mesh.isSkinnedMesh || !g.index) return;
    const { position, skinIndex, skinWeight } = g.attributes;
    if (!position || !skinIndex || !skinWeight) return;
    const quantize = (value: number) => Math.round(value * 1e6);
    const vertices: Vertex[] = [];
    const groups = new Map<string, Vertex[]>();
    for (let index = 0; index < position.count; index++) {
      const weights: [number, number][] = [];
      for (let slot = 0; slot < 4; slot++) {
        const weight = skinWeight.getComponent(index, slot);
        if (weight > 1e-6) weights.push([skinIndex.getComponent(index, slot), quantize(weight)]);
      }
      weights.sort((a, b) => a[0] - b[0]);
      const vertex: Vertex = { index,
        position: [0, 1, 2].map(axis => quantize(position.getComponent(index, axis))).join(','),
        weights: JSON.stringify(weights),
      };
      vertices.push(vertex);
      const copies = groups.get(vertex.position) ?? [];
      copies.push(vertex); groups.set(vertex.position, copies);
    }
    const candidates = [...groups.values()].filter(copies => copies.length >= 3
      && new Set(copies.map(vertex => vertex.weights)).size > 1);
    if (!candidates.length) return;

    // Count indexed edges once even when an outline repeats the same triangle.
    const edges = new Map<string, { a: number; b: number; count: number }>();
    const faces = new Set<string>();
    for (let face = 0; face < g.index.count; face += 3) {
      const triangle = [0, 1, 2].map(slot => g.index!.getX(face + slot));
      const key = triangle.slice().sort((a, b) => a - b).join(',');
      if (faces.has(key)) continue;
      faces.add(key);
      for (let side = 0; side < 3; side++) {
        const a = triangle[side], b = triangle[(side + 1) % 3];
        const edgeKey = a < b ? `${a},${b}` : `${b},${a}`;
        const edge = edges.get(edgeKey) ?? { a, b, count: 0 };
        edge.count++; edges.set(edgeKey, edge);
      }
    }
    const neighbors = new Map<number, Set<string>>();
    for (const { a, b, count } of edges.values()) {
      if (count !== 1) continue;
      for (const [from, to] of [[a, b], [b, a]]) {
        const set = neighbors.get(from) ?? new Set<string>();
        set.add(vertices[to].position); neighbors.set(from, set);
      }
    }
    const repairs: [number, number][] = [];
    const morphSignature = (index: number) => JSON.stringify(Object.values(g.morphAttributes).flatMap(attributes =>
      (attributes ?? []).map(attribute => Array.from({ length: attribute.itemSize }, (_, axis) => quantize(attribute.getComponent(index, axis))))));
    for (const copies of candidates) {
      if (new Set(copies.map(vertex => morphSignature(vertex.index))).size !== 1) continue;
      // Restrict consensus to a connected seam, not separate touching layers.
      const connected = new Set([copies[0].index]);
      let previousSize = 0;
      while (previousSize !== connected.size) {
        previousSize = connected.size;
        for (const a of copies) for (const b of copies) {
          if (!connected.has(a.index) || connected.has(b.index)) continue;
          const shared = [...(neighbors.get(a.index) ?? [])].some(point => neighbors.get(b.index)?.has(point));
          if (shared) connected.add(b.index);
        }
      }
      if (connected.size !== copies.length) continue;
      const bindings = new Map<string, Vertex[]>();
      for (const vertex of copies) {
        const binding = bindings.get(vertex.weights) ?? [];
        binding.push(vertex); bindings.set(vertex.weights, binding);
      }
      const ordered = [...bindings.values()].sort((a, b) => b.length - a.length);
      if (ordered.length !== 2 || ordered[0].length * 2 <= copies.length) continue;
      for (const vertex of ordered[1]) repairs.push([vertex.index, ordered[0][0].index]);
      report.seamGroups++;
    }
    if (!repairs.length) return;
    // Clone only changed attributes; positions, UVs, normals, topology, morphs,
    // material groups and every other vertex retain their original values.
    const indices = skinIndex.clone(), weights = skinWeight.clone();
    for (const [target, source] of repairs) for (let slot = 0; slot < 4; slot++) {
      indices.setComponent(target, slot, skinIndex.getComponent(source, slot));
      weights.setComponent(target, slot, skinWeight.getComponent(source, slot));
    }
    g.setAttribute('skinIndex', indices); g.setAttribute('skinWeight', weights);
    onRepair?.(mesh);
    report.meshes++; report.vertices += repairs.length;
  });
  return report;
}
