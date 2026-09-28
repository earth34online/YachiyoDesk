import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type { VRM } from '@pixiv/three-vrm';
import type { MotionProfile } from './types';

/**
 * A bounded, opt-in mesh-contact pass for converted PMX garments.
 *
 * The source skin and materials stay intact. A CPU-skinned render copy of each
 * clearly named skirt/sleeve receives contacts against a *posed triangle mesh*
 * of the body, with no extra cloth gravity, inertia or stretch simulation. Unsupported or
 * expensive assets keep the existing spring-bone renderer unchanged.
 */
const GARMENT_NAME = /skirt|dress|スカート|裙|sleeves?|袖/i;
const BODY_NAME = /^body(?:\s|$)/i;
const MAX_GARMENT_VERTICES = 2400;
const MAX_BODY_VERTICES = 6500;
const CONTACT_MARGIN = 0.0035;
const CONTACT_SEARCH = 0.09;

interface Link { a: number; b: number; rest: number; stiffness: number }

interface GarmentMesh {
  source: THREE.SkinnedMesh;
  display: THREE.Mesh;
  positions: THREE.Vector3[];
  pinned: boolean[];
  links: Link[];
  index: THREE.BufferAttribute;
  adjacent: Set<number>[];
  vertexCount: number;
}

function materialName(mesh: THREE.SkinnedMesh): string {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.map((item) => item.name || '').join(' ');
}

function makeLinks(index: THREE.BufferAttribute, positions: THREE.Vector3[], vertexCount: number):
  { links: Link[]; adjacent: Set<number>[] } {
  const adjacent = Array.from({ length: vertexCount }, () => new Set<number>());
  const edges = new Map<string, { a: number; b: number; opposite: number[] }>();
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const ids = [index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2)];
    for (let side = 0; side < 3; side += 1) {
      const a = ids[side];
      const b = ids[(side + 1) % 3];
      if (a === b || a >= vertexCount || b >= vertexCount) continue;
      adjacent[a].add(b);
      adjacent[b].add(a);
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key) || { a, b, opposite: [] };
      edge.opposite.push(ids[(side + 2) % 3]);
      edges.set(key, edge);
    }
  }
  const links: Link[] = [];
  for (const edge of edges.values()) {
    links.push({ a: edge.a, b: edge.b, rest: positions[edge.a].distanceTo(positions[edge.b]), stiffness: 0.68 });
    if (edge.opposite.length === 2) {
      const [a, b] = edge.opposite;
      if (a !== b && a < vertexCount && b < vertexCount) {
        links.push({ a, b, rest: positions[a].distanceTo(positions[b]), stiffness: 0.16 });
      }
    }
  }
  // PMX material splits often duplicate a position for UV seams. A zero-rest
  // link keeps those slots together while preserving both original UVs.
  const coincident = new Map<string, number>();
  for (let i = 0; i < vertexCount; i += 1) {
    const p = positions[i];
    const key = `${Math.round(p.x * 100000)}:${Math.round(p.y * 100000)}:${Math.round(p.z * 100000)}`;
    const first = coincident.get(key);
    if (first === undefined) coincident.set(key, i);
    else if (first !== i) {
      links.push({ a: first, b: i, rest: 0, stiffness: 0.95 });
      adjacent[first].add(i);
      adjacent[i].add(first);
    }
  }
  return { links, adjacent };
}

export class GarmentContactSolver {
  static lastProbe: { fallbackReason: string; candidates: string[] } | null = null;
  readonly replacements: Array<{ source: THREE.SkinnedMesh; display: THREE.Mesh }> = [];
  readonly diagnostics = {
    enabled: false,
    garmentMeshes: 0,
    garmentNames: [] as string[],
    garmentVertices: 0,
    bodyVertices: 0,
    lastContacts: 0,
    averageMs: 0,
    fallbackReason: '' as string,
  };

  private readonly body: THREE.SkinnedMesh;
  private readonly bodyGeometry: THREE.BufferGeometry;
  private readonly bodyPosition: THREE.BufferAttribute;
  private readonly bodyIndex: THREE.BufferAttribute;
  private readonly bodyBvh: MeshBVH;
  private readonly garments: GarmentMesh[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly closest: HitPointInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  private readonly normal = new THREE.Vector3();
  private readonly relative = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private enabled = false;
  private samples = 0;
  private slowFrames = 0;
  private readonly displayWorldInverse = new THREE.Matrix4();

  private constructor(body: THREE.SkinnedMesh, garmentMeshes: THREE.SkinnedMesh[]) {
    this.body = body;
    this.bodyGeometry = new THREE.BufferGeometry();
    this.bodyPosition = new THREE.BufferAttribute(new Float32Array(body.geometry.attributes.position.count * 3), 3);
    this.bodyGeometry.setAttribute('position', this.bodyPosition);
    this.bodyGeometry.setIndex(body.geometry.index!.clone());
    this.bodyIndex = this.bodyGeometry.index!;
    this.updateBodyGeometry();
    this.bodyBvh = new MeshBVH(this.bodyGeometry, { indirect: true, targetLeafSize: 12 });
    this.diagnostics.bodyVertices = this.bodyPosition.count;

    for (const source of garmentMeshes) {
      const positions = Array.from({ length: source.geometry.attributes.position.count }, (_, i) => {
        source.getVertexPosition(i, this.scratch);
        return source.localToWorld(this.scratch.clone());
      });
      const bottom = Math.min(...positions.map((p) => p.y));
      const top = Math.max(...positions.map((p) => p.y));
      if (top - bottom < 0.025) continue;
      const index = source.geometry.index!;
      const { links, adjacent } = makeLinks(index, positions, positions.length);
      if (links.length === 0) continue;
      const geometry = source.geometry.clone();
      geometry.deleteAttribute('skinIndex');
      geometry.deleteAttribute('skinWeight');
      (geometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
      const display = new THREE.Mesh(geometry, source.material);
      display.name = `${source.name}_cloth_contact`;
      display.frustumCulled = false;
      display.renderOrder = source.renderOrder;
      display.position.copy(source.position);
      display.quaternion.copy(source.quaternion);
      display.scale.copy(source.scale);
      source.parent?.add(display);
      source.visible = false;
      const garment = {
        source,
        display,
        positions,
        pinned: positions.map((p) => p.y >= top - (top - bottom) * 0.17),
        links,
        index,
        adjacent,
        vertexCount: positions.length,
      };
      this.garments.push(garment);
      this.replacements.push({ source, display });
      this.diagnostics.garmentVertices += positions.length;
      this.diagnostics.garmentNames.push(materialName(source));
    }
    this.diagnostics.garmentMeshes = this.garments.length;
    this.setEnabled(this.garments.length > 0);
  }

  static create(vrm: VRM, profile: MotionProfile): GarmentContactSolver | null {
    if (!profile.capabilities.includes('pmx-converted')) return null;
    const skinned: THREE.SkinnedMesh[] = [];
    vrm.scene.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(object as THREE.SkinnedMesh);
    });
    const candidates = skinned.map((mesh) => `${materialName(mesh)}:${mesh.geometry.attributes.position.count}`);
    const body = skinned
      .filter((mesh) => BODY_NAME.test(materialName(mesh)))
      .sort((left, right) => right.geometry.attributes.position.count - left.geometry.attributes.position.count)[0];
    if (!body || !body.geometry.index || body.geometry.attributes.position.count > MAX_BODY_VERTICES) {
      GarmentContactSolver.lastProbe = { fallbackReason: 'body-mesh-not-found-or-too-large', candidates };
      return null;
    }
    const garments = skinned.filter((mesh) => mesh !== body && GARMENT_NAME.test(materialName(mesh))
      && !!mesh.geometry.index && mesh.geometry.attributes.position.count >= 24
      && mesh.geometry.attributes.position.count <= MAX_GARMENT_VERTICES);
    if (!garments.length || garments.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0) > 3000) {
      GarmentContactSolver.lastProbe = { fallbackReason: 'garment-mesh-not-found-or-too-large', candidates };
      return null;
    }
    GarmentContactSolver.lastProbe = null;
    return new GarmentContactSolver(body, garments);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && this.garments.length > 0 && !this.diagnostics.fallbackReason;
    this.diagnostics.enabled = this.enabled;
    for (const garment of this.garments) {
      garment.source.visible = !this.enabled;
      garment.display.visible = this.enabled;
    }
  }

  reset(): void {
    // Each frame starts from the original posed skin; no cloth state to reset.
  }

  update(delta: number): void {
    if (!this.enabled) return;
    const started = performance.now();
    this.updateBodyGeometry();
    this.bodyBvh.refit();
    void delta;
    let contacts = 0;
    for (const garment of this.garments) {
      garment.source.updateWorldMatrix(true, false);
      garment.display.updateWorldMatrix(true, false);
      for (let i = 0; i < garment.vertexCount; i += 1) {
        garment.source.getVertexPosition(i, this.scratch);
        // Preserve authored skin and spring poses. The cancelled softness
        // experiment must not retain independent material-piece motion here.
        garment.positions[i].copy(this.scratch).applyMatrix4(garment.source.matrixWorld);
      }
      // Retain the pre-existing body contact pass, without pulling the result
      // back toward a separate cloth simulation or stretching material seams.
      for (let iteration = 0; iteration < 2; iteration += 1) {
        for (let i = 0; i < garment.vertexCount; i += 1) {
          if (garment.pinned[i]) continue;
          contacts += this.projectBody(garment.positions[i]);
        }
      }
      // Vertex-only contact misses a long triangle edge that crosses a body
      // triangle while both endpoints are outside. Sample only long edges.
      for (const link of garment.links) {
        if (link.stiffness < 0.5 || link.rest < 0.035) continue;
        this.scratch.copy(garment.positions[link.a]).add(garment.positions[link.b]).multiplyScalar(0.5);
        if (!this.projectBody(this.scratch)) continue;
        const half = this.scratch.sub(garment.positions[link.a]).sub(this.b.subVectors(garment.positions[link.b], garment.positions[link.a]).multiplyScalar(0.5));
        if (!garment.pinned[link.a]) garment.positions[link.a].addScaledVector(half, 0.5);
        if (!garment.pinned[link.b]) garment.positions[link.b].addScaledVector(half, 0.5);
        contacts += 1;
      }
      const output = garment.display.geometry.attributes.position as THREE.BufferAttribute;
      // Matrix is constant within this pass. worldToLocal() otherwise walks
      // and recomputes the entire ancestor chain for every garment vertex.
      this.displayWorldInverse.copy(garment.display.matrixWorld).invert();
      for (let i = 0; i < garment.vertexCount; i += 1) {
        this.scratch.copy(garment.positions[i]).applyMatrix4(this.displayWorldInverse);
        output.setXYZ(i, this.scratch.x, this.scratch.y, this.scratch.z);
      }
      output.needsUpdate = true;
      garment.display.geometry.computeVertexNormals();
    }
    this.diagnostics.lastContacts = contacts;
    const elapsed = performance.now() - started;
    this.samples += 1;
    this.diagnostics.averageMs += (elapsed - this.diagnostics.averageMs) / Math.min(this.samples, 120);
    this.slowFrames = elapsed > 16 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames >= 20) {
      this.diagnostics.fallbackReason = 'mesh-contact-over-budget';
      this.setEnabled(false);
    }
  }

  private updateBodyGeometry(): void {
    this.body.updateWorldMatrix(true, false);
    for (let i = 0; i < this.bodyPosition.count; i += 1) {
      this.body.getVertexPosition(i, this.scratch);
      // Refresh once above, including the constructor's initial BVH build.
      this.scratch.applyMatrix4(this.body.matrixWorld);
      this.bodyPosition.setXYZ(i, this.scratch.x, this.scratch.y, this.scratch.z);
    }
    this.bodyPosition.needsUpdate = true;
  }

  private projectBody(point: THREE.Vector3): number {
    const hit = this.bodyBvh.closestPointToPoint(point, this.closest, 0, CONTACT_SEARCH);
    if (!hit) return 0;
    const base = hit.faceIndex * 3;
    if (base + 2 >= this.bodyIndex.count) return 0;
    this.a.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base));
    this.b.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 1));
    this.c.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 2));
    this.normal.subVectors(this.b, this.a).cross(this.c.sub(this.a)).normalize();
    if (this.normal.lengthSq() < 0.5) return 0;
    const signed = this.relative.subVectors(point, hit.point).dot(this.normal);
    if (signed >= CONTACT_MARGIN) return 0;
    point.addScaledVector(this.normal, Math.min(0.027, CONTACT_MARGIN - signed));
    return 1;
  }

  dispose(): void {
    for (const garment of this.garments) {
      garment.source.visible = true;
      garment.display.removeFromParent();
      garment.display.geometry.dispose();
    }
    this.bodyGeometry.dispose();
  }
}
