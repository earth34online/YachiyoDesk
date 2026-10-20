import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { boundGarmentCorrection, type GarmentIntegrityState } from '../src/garmentIntegrity';

function garment(points: number[][]): GarmentIntegrityState {
  const authored = points.map(p => new THREE.Vector3().fromArray(p));
  return { authored, positions: authored.map(p => p.clone()), simulationVertices: points.map((_, i) => i),
    pinned: points.map(() => false), index: new THREE.Uint32BufferAttribute([0, 1, 2], 1),
    links: [{ a: 0, b: 1, rest: authored[0].distanceTo(authored[1]), stiffness: .68 },
      { a: 1, b: 2, rest: authored[1].distanceTo(authored[2]), stiffness: .68 },
      { a: 2, b: 0, rest: authored[2].distanceTo(authored[0]), stiffness: .68 }] };
}

describe('garment integrity before displaying contact results', () => {
  it('permits rigid bending beyond 90 degrees without confusing rotation with collapse', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [0, .01, 0]]);
    const rotation = new THREE.Matrix4().makeRotationX(130 * Math.PI / 180);
    for (const point of g.positions) point.applyMatrix4(rotation);
    const before = g.positions.map(point => point.toArray());
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBe(1);
    expect(state.collapsedFaces).toBe(0);
    expect(g.positions.map(point => point.toArray())).toEqual(before);
  });

  it('bounds an over-stretched panel and its attachment without modifying the authored skin', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [0, .01, 0]]);
    g.pinned[0] = true; g.positions[0].z = .05; g.positions[1].x = .1;
    const original = g.authored.map(p => p.toArray()), state = boundGarmentCorrection(g);
    expect(state.scale).toBeLessThan(1);
    expect(state.maximumStretchExcess).toBeLessThan(1e-8);
    expect(state.maximumAttachmentOffset).toBeLessThanOrEqual(.012001);
    expect(g.authored.map(p => p.toArray())).toEqual(original);
  });

  it('prevents a thin triangle from collapsing even when its edge lengths are similar', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [.001, .003, 0]]);
    g.positions[2].y = 0;
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBeLessThan(1);
    expect(state.collapsedFaces).toBe(0);
    expect(g.positions[2].y).toBeGreaterThanOrEqual(.00029999);
  });

  it('applies the correction once to a shared seam particle, preserving distinct render slots', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [0, .01, 0]]);
    g.positions.push(g.positions[0]); g.authored.push(g.authored[0].clone()); g.pinned.push(false);
    g.positions[0].z = .2;
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBeLessThan(1);
    expect(g.positions[3]).toBe(g.positions[0]);
    expect(g.positions[0].z).toBeCloseTo(.2 * state.scale, 8);
  });

  // Two faces: the first is admissible on [0, .75] but collapses (passes
  // through a line) around t = 1 and recovers; the second forces the common
  // blend below 1. The old bisection kept a scale inside the first face's
  // collapse interval, failed the final recheck and reset the whole garment.
  function disjointIntervalFixture(): GarmentIntegrityState {
    const authored = [[0, 0, 0], [.05, 0, 0], [0, .05, 0], [0, 0, .1], [.05, 0, .1], [0, .05, .1]]
      .map(p => new THREE.Vector3().fromArray(p));
    const positions = authored.map(p => p.clone());
    positions[1].x = -.01; positions[4].x = -.004;
    return { authored, positions, index: new THREE.Uint32BufferAttribute([0, 1, 2, 3, 4, 5], 1), links: [],
      simulationVertices: [0, 1, 2, 3, 4, 5], pinned: authored.map(() => false), correctionLimits: authored.map(() => .3) };
  }
  const faceArea = (p: THREE.Vector3[]) => new THREE.Vector3().crossVectors(p[1].clone().sub(p[0]), p[2].clone().sub(p[0])).lengthSq();

  it('keeps a valid partial correction when faces have disconnected admissible blends', () => {
    const g = disjointIntervalFixture(), candidate = g.positions.map(p => p.clone());
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBeCloseTo(.75, 6);
    expect(state.collapsedFaces).toBe(0);
    expect(state.maximumCorrection).toBeGreaterThan(.04);
    // Every smaller blend is admissible for both faces.
    for (let step = 0; step <= 128; step++) {
      const t = state.scale * step / 128;
      for (let face = 0; face < 2; face++) {
        const p = [0, 1, 2].map(k => g.authored[face * 3 + k].clone().lerp(candidate[face * 3 + k], t));
        expect(faceArea(p)).toBeGreaterThanOrEqual(.05 ** 4 * .009999);
      }
    }
  });

  it('gives the same blend after a rigid rotation and translation', () => {
    const g = disjointIntervalFixture(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.7, -1.1, .2));
    for (const list of [g.authored, g.positions]) list.forEach(p => p.applyQuaternion(q).add(new THREE.Vector3(2, -3, 4)));
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBeCloseTo(.75, 6);
    expect(state.collapsedFaces).toBe(0);
  });

  it('never returns collapsed or non-finite faces for random candidates', () => {
    let seed = 49811;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 200; trial++) {
      const g = disjointIntervalFixture();
      g.positions.forEach((p, i) => p.copy(g.authored[i]).add(new THREE.Vector3((random() - .5) * .14, (random() - .5) * .14, (random() - .5) * .14)));
      const state = boundGarmentCorrection(g);
      expect(state.collapsedFaces).toBe(0);
      expect(Number.isFinite(state.maximumCorrection)).toBe(true);
      for (let face = 0; face < 2; face++) expect(faceArea(g.positions.slice(face * 3, face * 3 + 3))).toBeGreaterThanOrEqual(.05 ** 4 * .009999);
    }
  });

  it('restores finite authored geometry when a contact calculation returns invalid coordinates', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [0, .01, 0]]);
    g.positions[1].x = Number.NaN;
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBe(0);
    expect(g.positions.map(p => p.toArray())).toEqual(g.authored.map(p => p.toArray()));
    expect(state.collapsedFaces).toBe(0);
  });
});
