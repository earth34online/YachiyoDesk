import * as THREE from 'three';

interface Edge { a: number; b: number; rest: number; stiffness: number }
export interface GarmentIntegrityState {
  positions: THREE.Vector3[];
  authored: THREE.Vector3[];
  simulationVertices: number[];
  pinned: boolean[];
  correctionLimits?: number[];
  links: Edge[];
  index: THREE.BufferAttribute;
}

/** A final geometric guard; infeasible contact remains a reported contact failure. */
export function boundGarmentCorrection(garment: GarmentIntegrityState): {
  scale: number; maximumStretchExcess: number; maximumCorrection: number;
  maximumAttachmentOffset: number; collapsedFaces: number;
} {
  const e = new THREE.Vector3(), d = new THREE.Vector3(), f = new THREE.Vector3(), h = new THREE.Vector3();
  const n = new THREE.Vector3(), cross = new THREE.Vector3();
  let scale = 1;
  for (const i of garment.simulationVertices) {
    const distance = garment.positions[i].distanceTo(garment.authored[i]);
    if (!Number.isFinite(distance)) { scale = 0; break; }
    const allowed = garment.correctionLimits?.[i] ?? (garment.pinned[i] ? .012 : .12);
    if (distance > allowed) scale = Math.min(scale, allowed / distance);
  }
  for (const link of garment.links) {
    if (link.stiffness < .5 || link.rest < 1e-5) continue;
    e.subVectors(garment.authored[link.b], garment.authored[link.a]);
    d.subVectors(garment.positions[link.b], garment.positions[link.a]).sub(e);
    const allowed = e.length() * 1.4 + .003;
    if (cross.copy(e).add(d).lengthSq() <= allowed * allowed) continue;
    const a = d.lengthSq(), b = 2 * e.dot(d), c = e.lengthSq() - allowed * allowed;
    if (a > 1e-16) scale = Math.min(scale, Math.max(0, (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a)));
  }
  for (let face = 0; face < garment.index.count; face += 3) {
    const a = garment.index.getX(face), b = garment.index.getX(face + 1), c = garment.index.getX(face + 2);
    e.subVectors(garment.authored[b], garment.authored[a]); f.subVectors(garment.authored[c], garment.authored[a]);
    n.crossVectors(e, f); const restArea = n.lengthSq();
    if (restArea < 1e-12) continue;
    d.subVectors(garment.positions[b], garment.positions[a]).sub(e);
    h.subVectors(garment.positions[c], garment.positions[a]).sub(f);
    // A garment can legitimately bend through more than 90 degrees. Test
    // area, which is invariant under rotation, rather than treating a changed
    // rest-pose normal as an inside-out mesh.
    const areaAt = (blend: number): number => {
      const ab = e.clone().addScaledVector(d, blend), ac = f.clone().addScaledVector(h, blend);
      return cross.crossVectors(ab, ac).lengthSq();
    };
    if (areaAt(scale) >= restArea * .01) continue;
    let lower = 0, upper = scale;
    for (let iteration = 0; iteration < 18; iteration++) {
      const middle = (lower + upper) * .5;
      if (areaAt(middle) >= restArea * .01) lower = middle; else upper = middle;
    }
    scale = lower;
  }
  scale = THREE.MathUtils.clamp(scale, 0, 1);
  if (scale < 1) for (const i of garment.simulationVertices) {
    const point = garment.positions[i];
    if (scale === 0) point.copy(garment.authored[i]);
    else point.lerp(garment.authored[i], 1 - scale);
  }
  let maximumStretchExcess = 0, maximumCorrection = 0, maximumAttachmentOffset = 0, collapsedFaces = 0;
  for (const i of garment.simulationVertices) {
    const distance = garment.positions[i].distanceTo(garment.authored[i]);
    maximumCorrection = Math.max(maximumCorrection, distance);
    if (garment.pinned[i]) maximumAttachmentOffset = Math.max(maximumAttachmentOffset, distance);
  }
  for (const link of garment.links) {
    if (link.stiffness < .5 || link.rest < 1e-5) continue;
    const allowed = garment.authored[link.a].distanceTo(garment.authored[link.b]) * 1.4 + .003;
    maximumStretchExcess = Math.max(maximumStretchExcess, garment.positions[link.a].distanceTo(garment.positions[link.b]) - allowed);
  }
  for (let face = 0; face < garment.index.count; face += 3) {
    const a = garment.index.getX(face), b = garment.index.getX(face + 1), c = garment.index.getX(face + 2);
    n.crossVectors(e.subVectors(garment.authored[b], garment.authored[a]), f.subVectors(garment.authored[c], garment.authored[a]));
    if (n.lengthSq() < 1e-12) continue;
    cross.crossVectors(d.subVectors(garment.positions[b], garment.positions[a]), h.subVectors(garment.positions[c], garment.positions[a]));
    if (cross.lengthSq() < n.lengthSq() * .009999) collapsedFaces++;
  }
  // A later face may reduce the common blend into another face's collapse
  // interval. Recheck the final geometry, and keep the authored skin if this
  // candidate still violates a guard. Contact verification follows this guard.
  if (collapsedFaces || maximumStretchExcess > 1e-6 || maximumAttachmentOffset > .012001
    || !Number.isFinite(maximumCorrection)) {
    for (const i of garment.simulationVertices) garment.positions[i].copy(garment.authored[i]);
    return { scale: 0, maximumStretchExcess: 0, maximumCorrection: 0, maximumAttachmentOffset: 0, collapsedFaces: 0 };
  }
  return { scale, maximumStretchExcess, maximumCorrection, maximumAttachmentOffset, collapsedFaces };
}
