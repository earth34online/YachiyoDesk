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

function evaluatePolynomial(coefficients: number[], x: number): number {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) value = value * x + coefficients[i];
  return value;
}

/** Real roots on interval (lower, upper), found through monotone segments. */
function rootsOnInterval(coefficients: number[], lower: number, upper: number): number[] {
  const c = coefficients.slice();
  while (c.length > 1 && Math.abs(c.at(-1)!) < 1e-14) c.pop();
  if (c.length < 2) return [];
  if (c.length === 2) { const root = -c[0] / c[1]; return root > lower && root < upper ? [root] : []; }
  const critical = rootsOnInterval(c.slice(1).map((v, i) => v * (i + 1)), lower, upper);
  const points = [lower, ...critical, upper], roots: number[] = [];
  const tolerance = Math.max(1, ...c.map(Math.abs)) * 1e-12;
  for (const x of critical) if (Math.abs(evaluatePolynomial(c, x)) < tolerance) roots.push(x);
  for (let i = 0; i < points.length - 1; i++) {
    let a = points[i], b = points[i + 1], fa = evaluatePolynomial(c, a);
    if (fa * evaluatePolynomial(c, b) >= 0) continue;
    for (let k = 0; k < 48; k++) {
      const middle = (a + b) / 2, fm = evaluatePolynomial(c, middle);
      if (fa * fm <= 0) b = middle; else { a = middle; fa = fm; }
    }
    roots.push((a + b) / 2);
  }
  return [...new Set(roots)].sort((a, b) => a - b);
}

/**
 * Largest t in [0, maximum] such that the polynomial stays non-negative on the
 * whole of [0, t]. Requires a non-negative value at zero (the authored skin).
 * Keeps the connected admissible interval containing the untouched skin, so a
 * later triangle can reduce scale without invalidating earlier triangles.
 */
function firstAdmissibleInterval(coefficients: number[], maximum: number): number {
  if (maximum <= 0) return 0;
  let lowerBound = coefficients[0], power = maximum;
  for (let i = 1; i < coefficients.length; i++, power *= maximum)
    lowerBound += Math.min(0, coefficients[i] * power);
  if (lowerBound >= 0) return maximum;
  const derivative = coefficients.slice(1).map((v, i) => v * (i + 1));
  const points = [0, ...rootsOnInterval(derivative, 0, maximum), maximum];
  for (let i = 1; i < points.length; i++) {
    if (evaluatePolynomial(coefficients, points[i]) >= 0) continue;
    let lower = points[i - 1], upper = points[i];
    for (let k = 0; k < 48; k++) {
      const middle = (lower + upper) / 2;
      if (evaluatePolynomial(coefficients, middle) >= 0) lower = middle; else upper = middle;
    }
    return lower * (1 - 1e-9);
  }
  return maximum;
}

/** A final geometric guard; infeasible contact remains a reported contact failure. */
export function boundGarmentCorrection(garment: GarmentIntegrityState): {
  scale: number; maximumStretchExcess: number; maximumCorrection: number;
  maximumAttachmentOffset: number; collapsedFaces: number;
} {
  const e = new THREE.Vector3(), d = new THREE.Vector3(), f = new THREE.Vector3(), h = new THREE.Vector3();
  const n = new THREE.Vector3(), cross = new THREE.Vector3();
  const c0 = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
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
    // |(e + t d) x (f + t h)|^2 / restArea - 0.01 is a quartic in the blend t.
    // Keep the connected admissible interval containing the untouched skin.
    // A later triangle can then reduce scale without invalidating earlier
    // triangles and causing the whole garment to snap back to scale zero.
    c0.crossVectors(e, f);
    c1.crossVectors(e, h).add(cross.crossVectors(d, f));
    c2.crossVectors(d, h);
    const quartic = [.99, 2 * c0.dot(c1) / restArea, (c1.lengthSq() + 2 * c0.dot(c2)) / restArea,
      2 * c1.dot(c2) / restArea, c2.lengthSq() / restArea];
    scale = Math.min(scale, firstAdmissibleInterval(quartic, scale));
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
