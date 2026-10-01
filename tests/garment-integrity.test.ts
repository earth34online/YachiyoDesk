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

  it('restores finite authored geometry when a contact calculation returns invalid coordinates', () => {
    const g = garment([[0, 0, 0], [.01, 0, 0], [0, .01, 0]]);
    g.positions[1].x = Number.NaN;
    const state = boundGarmentCorrection(g);
    expect(state.scale).toBe(0);
    expect(g.positions.map(p => p.toArray())).toEqual(g.authored.map(p => p.toArray()));
    expect(state.collapsedFaces).toBe(0);
  });
});
