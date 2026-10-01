import type { Vector3 } from 'three';

interface GarmentEdge { a: number; b: number; rest: number; stiffness: number }

/** Extra contact travel follows free fabric length, rather than an absolute 12 cm cap. */
export function garmentCorrectionLimits(points: Vector3[], pinned: boolean[], edges: GarmentEdge[],
  representatives: number[], bodyHeight: number): number[] {
  const count = points.length, distance = new Float64Array(count).fill(Infinity);
  const neighbours: { vertex: number; length: number }[][] = Array.from({ length: count }, () => []);
  const heap: { vertex: number; distance: number }[] = [];
  const push = (vertex: number, value: number): void => {
    const entry = { vertex, distance: value }; let i = heap.length; heap.push(entry);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent].distance <= value) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = entry;
  };
  for (const edge of edges) {
    if (edge.stiffness < .5 || !Number.isFinite(edge.rest) || edge.rest < 0) continue;
    const a = representatives[edge.a], b = representatives[edge.b];
    if (a === b) continue;
    neighbours[a].push({ vertex: b, length: edge.rest });
    neighbours[b].push({ vertex: a, length: edge.rest });
  }
  for (let i = 0; i < count; i++) if (pinned[i]) {
    const vertex = representatives[i];
    if (distance[vertex] === 0) continue;
    distance[vertex] = 0; push(vertex, 0);
  }
  while (heap.length) {
    const entry = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].distance < heap[child].distance) child++;
        if (heap[child].distance >= last.distance) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    if (entry.distance > distance[entry.vertex]) continue;
    for (const edge of neighbours[entry.vertex]) {
      const candidate = entry.distance + edge.length;
      if (candidate >= distance[edge.vertex]) continue;
      distance[edge.vertex] = candidate; push(edge.vertex, candidate);
    }
  }
  const maximum = Number.isFinite(bodyHeight) && bodyHeight > 0 ? Math.max(.012, bodyHeight * .12) : .12;
  return points.map((_, i) => {
    const travel = distance[representatives[i]];
    // A disconnected material piece has no demonstrated attachment reach;
    // retain the previous conservative limit rather than inventing one.
    if (!Number.isFinite(travel)) return Math.min(maximum, .12);
    return Math.min(maximum, .012 + travel * .65);
  });
}
