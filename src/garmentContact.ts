import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type { VRM } from '@pixiv/three-vrm';
import type { MotionProfile } from './types';
import { BodyContactEnvelope } from './bodyContactEnvelope';
import { boundGarmentCorrection } from './garmentIntegrity';
import { garmentCorrectionLimits } from './garmentMobility';
import { ContactSkinning } from './contactSkinning';

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
  authored: THREE.Vector3[];
  directions: THREE.Vector3[];
  bodyFaces: Int32Array;
  bodyWeights: THREE.Vector3[];
  bodyGaps: Float32Array;
  bodyTargets: THREE.Vector3[];
  guideActive: Uint8Array;
  smoothed: THREE.Vector3[];
  offsets: THREE.Vector3[];
  simulationVertices: number[];
  representatives: number[];
  intersectingFaces: Set<number>;
  wideTriangles: boolean;
  pinned: boolean[];
  correctionLimits: number[];
  links: Link[];
  index: THREE.BufferAttribute;
  adjacent: Set<number>[];
  vertexCount: number;
  contactGeometry: THREE.BufferGeometry;
  contactPosition: THREE.BufferAttribute;
  bvh: MeshBVH;
  corrections: THREE.Vector3[];
  contacts: Uint16Array;
  cooldown: number;
  cachedFaces: Int32Array;
  surfaceIterations: number;
  qualityRetry: number;
}

function materialName(mesh: THREE.SkinnedMesh): string {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.map((item) => item.name || '').join(' ');
}

function collisionIndex(mesh: Pick<THREE.Mesh, 'geometry' | 'material'>): THREE.BufferAttribute {
  const geometry = mesh.geometry, index = geometry.index!;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!geometry.groups.length || materials.length === 1) return index.clone();
  const indices: number[] = [];
  for (const group of geometry.groups) {
    if (/outline|輪郭|描边/i.test(materials[group.materialIndex ?? 0]?.name ?? '')) continue;
    for (let i = group.start; i < Math.min(index.count, group.start + group.count); i++) indices.push(index.getX(i));
  }
  return indices.length ? new THREE.Uint32BufferAttribute(indices, 1) : index.clone();
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
  private readonly skinning = new ContactSkinning();
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
    lastMs: 0,
    surfaceIntersections: 0,
    envelopeContacts: 0,
    unresolvedIntersections: 0,
    maximumResidualDepthBound: 0,
    maximumResidualSpan: 0,
    pinnedIntersections: 0,
    surfaceChecks: 0,
    surfaceCheckComplete: true,
    coolingMeshes: 0,
    reducedMeshes: 0,
    retryInSeconds: 0,
    shapeCheckComplete: false,
    shapePreservationPassed: false,
    shapeLimitedMeshes: 0,
    maximumStretchExcess: 0,
    maximumCorrection: 0,
    maximumAttachmentOffset: 0,
    collapsedFaces: 0,
    bodyMs: 0,
    vertexMs: 0,
    surfaceMs: 0,
    meshMs: [] as Array<{ name: string; ms: number }>,
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
  private readonly identity = new THREE.Matrix4();
  private readonly bodyNormals: THREE.Vector3[];
  private readonly envelope: BodyContactEnvelope | null;
  private readonly cachedTriangle = new THREE.Triangle();
  private readonly cachedPoint = new THREE.Vector3();
  private readonly intersection = new THREE.Line3();
  private readonly barycentric = new THREE.Vector3();
  private enabled = false;
  private requested = false;
  private samples = 0;
  private slowFrames = 0;
  private readonly displayWorldInverse = new THREE.Matrix4();
  private readonly contactFromWorld = new THREE.Matrix4();
  private readonly contactToWorld = new THREE.Matrix4();
  private readonly skinToContact = new THREE.Matrix4();

  private constructor(body: THREE.SkinnedMesh, garmentMeshes: THREE.SkinnedMesh[], private readonly surfaceEnabled: boolean,
    private readonly modelRoot: THREE.Object3D, vrm: VRM) {
    this.body = body;
    this.updateContactSpace();
    this.bodyGeometry = new THREE.BufferGeometry();
    this.bodyPosition = new THREE.BufferAttribute(new Float32Array(body.geometry.attributes.position.count * 3), 3);
    this.bodyGeometry.setAttribute('position', this.bodyPosition);
    this.bodyGeometry.setIndex(surfaceEnabled ? collisionIndex(body) : body.geometry.index!.clone());
    this.bodyIndex = this.bodyGeometry.index!;
    this.updateBodyGeometry();
    this.bodyBvh = new MeshBVH(this.bodyGeometry, { indirect: true, targetLeafSize: surfaceEnabled ? 1 : 12 });
    this.bodyNormals = Array.from({ length: this.bodyIndex.count / 3 }, () => new THREE.Vector3());
    this.updateBodyNormals();
    this.envelope = surfaceEnabled ? BodyContactEnvelope.create(vrm, body, this.bodyGeometry, this.contactFromWorld) : null;
    this.diagnostics.bodyVertices = this.bodyPosition.count;

    for (const source of garmentMeshes) {
      const positions = Array.from({ length: source.geometry.attributes.position.count }, (_, i) => {
        if (surfaceEnabled) this.skinning.sample(source, i, this.scratch);
        else source.getVertexPosition(i, this.scratch);
        return source.localToWorld(this.scratch.clone());
      });
      const bottom = Math.min(...positions.map((p) => p.y));
      const top = Math.max(...positions.map((p) => p.y));
      if (top - bottom < 0.025) continue;
      positions.forEach(p => p.applyMatrix4(this.contactFromWorld));
      const contactBottom = Math.min(...positions.map(p => p.y)), contactTop = Math.max(...positions.map(p => p.y));
      const pinned = positions.map(p => p.y >= contactTop - (contactTop - contactBottom) * .17);
      if (this.envelope && /sleeves?|袖/i.test(materialName(source))) {
        const wrists = ['leftHand', 'rightHand'].flatMap(name => {
          const node = vrm.humanoid.rawHumanBones[name as 'leftHand' | 'rightHand']?.node;
          return node ? [node.getWorldPosition(new THREE.Vector3()).applyMatrix4(this.contactFromWorld)] : [];
        });
        for (let i = 0; i < pinned.length; i++) if (wrists.some(wrist => wrist.distanceTo(positions[i]) < .075)) pinned[i] = true;
      }
      const geometry = source.geometry.clone();
      const index = surfaceEnabled ? collisionIndex({ geometry, material: source.material }) : source.geometry.index!;
      let { links, adjacent } = makeLinks(index, positions, positions.length);
      const representatives = positions.map((_, i) => i);
      if (this.envelope) {
        // UV slots remain separate in the render mesh, but identical skinned
        // seam slots are one physical point throughout contact solving.
        const seams = new Map<string, number>();
        const skinIndices = source.geometry.attributes.skinIndex, skinWeights = source.geometry.attributes.skinWeight;
        for (let i = 0; i < positions.length; i++) {
          const key = positions[i].toArray().map(v => Math.round(v * 100000)).join(':') + ':'
            + Array.from({ length: 4 }, (_, j) => ({ bone: skinIndices.getComponent(i, j), weight: skinWeights.getComponent(i, j) }))
              .filter(influence => influence.weight > 1e-6).sort((a, b) => a.bone - b.bone)
              .map(influence => `${influence.bone}:${Math.round(influence.weight * 100000)}`).join(':');
          const first = seams.get(key);
          if (first === undefined) seams.set(key, i);
          else { representatives[i] = first; positions[i] = positions[first]; }
        }
        const uniqueLinks = new Map<string, Link>();
        adjacent = positions.map(() => new Set<number>());
        for (const link of links) {
          const a = representatives[link.a], b = representatives[link.b];
          if (a === b) continue;
          const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
          if (!uniqueLinks.has(key) || uniqueLinks.get(key)!.stiffness < link.stiffness) uniqueLinks.set(key, { ...link, a, b });
          adjacent[a].add(b); adjacent[b].add(a);
        }
        links = [...uniqueLinks.values()];
      }
      const simulationVertices = representatives.flatMap((first, i) => first === i ? [i] : []);
      const bodyHeight = Math.max(...Array.from({ length: this.bodyPosition.count }, (_, i) => this.bodyPosition.getY(i)))
        - Math.min(...Array.from({ length: this.bodyPosition.count }, (_, i) => this.bodyPosition.getY(i)));
      const correctionLimits = this.envelope
        ? garmentCorrectionLimits(positions, pinned, links, representatives, bodyHeight)
        : pinned.map(value => value ? .012 : .12);
      if (links.length === 0) continue;
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
      const contactGeometry = new THREE.BufferGeometry();
      const contactPosition = new THREE.BufferAttribute(new Float32Array(positions.length * 3), 3);
      for (let i = 0; i < positions.length; i++) contactPosition.setXYZ(i, positions[i].x, positions[i].y, positions[i].z);
      contactGeometry.setAttribute('position', contactPosition);
      // A single index range also checks faces hidden by duplicated outline groups.
      contactGeometry.setIndex(index.clone());
      const garment = {
        source,
        display,
        positions,
        authored: positions.map(p => p.clone()),
        directions: positions.map(() => new THREE.Vector3()),
        ...this.bindSurface(positions),
        bodyTargets: positions.map(() => new THREE.Vector3()),
        guideActive: new Uint8Array(positions.length),
        smoothed: positions.map(() => new THREE.Vector3()),
        offsets: positions.map(() => new THREE.Vector3()),
        simulationVertices, representatives, correctionLimits, intersectingFaces: new Set<number>(),
        wideTriangles: links.some(link => link.stiffness > .5 && link.rest > CONTACT_SEARCH * 1.25),
        pinned,
        links,
        index,
        adjacent,
        vertexCount: positions.length,
        contactGeometry, contactPosition,
        bvh: new MeshBVH(contactGeometry, { indirect: true, targetLeafSize: 1 }),
        corrections: positions.map(() => new THREE.Vector3()),
        contacts: new Uint16Array(positions.length), cooldown: 0,
        cachedFaces: new Int32Array(positions.length).fill(-1),
        surfaceIterations: 3, qualityRetry: 0,
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
    return new GarmentContactSolver(body, garments, profile.profileId === 'generic-vrm', vrm.scene, vrm);
  }

  setEnabled(enabled: boolean): void {
    if (this.requested !== enabled) {
      this.reset();
      this.diagnostics.surfaceCheckComplete = false;
      this.diagnostics.shapeCheckComplete = false;
      this.diagnostics.shapePreservationPassed = false;
    }
    this.requested = enabled;
    if (enabled) {
      for (const garment of this.garments) {
        garment.cooldown = 0; garment.surfaceIterations = 3; garment.qualityRetry = 0;
      }
      this.slowFrames = 0;
      this.diagnostics.fallbackReason = '';
      this.diagnostics.coolingMeshes = 0;
      this.diagnostics.reducedMeshes = 0;
      this.diagnostics.retryInSeconds = 0;
    }
    this.enabled = enabled && this.garments.length > 0;
    this.diagnostics.enabled = this.enabled;
    for (const garment of this.garments) {
      garment.source.visible = !this.enabled;
      garment.display.visible = this.enabled;
    }
  }

  reset(): void {
    for (const garment of this.garments) garment.offsets.forEach(offset => offset.set(0, 0, 0));
  }

  update(delta: number): void {
    if (!this.requested) return;
    for (const garment of this.garments) {
      garment.cooldown = Math.max(0, garment.cooldown - Math.max(0, delta));
      if (garment.qualityRetry > 0) {
        garment.qualityRetry = Math.max(0, garment.qualityRetry - Math.max(0, delta));
        if (!garment.qualityRetry) garment.surfaceIterations = 3;
      }
    }
    const active = this.garments.filter(garment => garment.cooldown <= 0);
    this.enabled = active.length > 0;
    this.diagnostics.enabled = this.enabled;
    for (const garment of this.garments) {
      garment.display.visible = garment.cooldown <= 0;
      garment.source.visible = !garment.display.visible;
    }
    this.diagnostics.coolingMeshes = this.garments.length - active.length;
    this.diagnostics.reducedMeshes = active.filter(garment => garment.surfaceIterations < 3).length;
    this.diagnostics.retryInSeconds = Math.max(...this.garments.map(garment => garment.cooldown));
    this.diagnostics.fallbackReason = this.diagnostics.coolingMeshes ? 'mesh-contact-cooling-down'
      : this.diagnostics.reducedMeshes ? 'mesh-contact-reduced-surface-passes' : '';
    if (!active.length) {
      this.diagnostics.surfaceCheckComplete = false;
      this.diagnostics.shapeCheckComplete = false;
      this.diagnostics.shapePreservationPassed = false;
      return;
    }
    const started = performance.now();
    this.updateContactSpace();
    this.updateBodyGeometry();
    this.bodyBvh.refit();
    this.updateBodyNormals();
    this.envelope?.update();
    this.diagnostics.bodyMs = performance.now() - started;
    this.diagnostics.vertexMs = 0;
    this.diagnostics.surfaceMs = 0;
    this.diagnostics.meshMs = [];
    let contacts = 0;
    this.diagnostics.surfaceIntersections = 0;
    this.diagnostics.envelopeContacts = 0;
    this.diagnostics.unresolvedIntersections = 0;
    this.diagnostics.maximumResidualDepthBound = 0;
    this.diagnostics.maximumResidualSpan = 0;
    this.diagnostics.pinnedIntersections = 0;
    this.diagnostics.surfaceChecks = 0;
    this.diagnostics.surfaceCheckComplete = this.surfaceEnabled && active.length === this.garments.length;
    this.diagnostics.shapeCheckComplete = !!this.envelope && active.length === this.garments.length;
    this.diagnostics.shapeLimitedMeshes = 0;
    this.diagnostics.maximumStretchExcess = 0;
    this.diagnostics.maximumCorrection = 0;
    this.diagnostics.maximumAttachmentOffset = 0;
    this.diagnostics.collapsedFaces = 0;
    let mostExpensive: GarmentMesh | null = null;
    let maximumMs = 0;
    for (const garment of active) {
      const garmentStarted = performance.now();
      garment.source.updateWorldMatrix(true, false);
      garment.display.updateWorldMatrix(true, false);
      this.skinToContact.multiplyMatrices(this.contactFromWorld, garment.source.matrixWorld);
      for (let i = 0; i < garment.vertexCount; i += 1) {
        if (this.surfaceEnabled) this.skinning.sample(garment.source, i, this.scratch);
        else garment.source.getVertexPosition(i, this.scratch);
        garment.positions[i].copy(this.scratch).applyMatrix4(this.skinToContact);
        // Preserve authored skin and spring poses. The cancelled softness
        // experiment must not retain independent material-piece motion here.
        garment.authored[i].copy(garment.positions[i]);
        if (this.surfaceEnabled) {
          // Advect the previous correction with the authored skin, then decay
          // it. This is solver warm-starting, with no free cloth dynamics.

          const face = garment.bodyFaces[i], base = face * 3, weights = garment.bodyWeights[i];
          garment.directions[i].copy(this.bodyNormals[face]);
          this.a.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base));
          this.b.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 1));
          this.c.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 2));
          garment.bodyTargets[i].copy(this.a).multiplyScalar(weights.x).addScaledVector(this.b, weights.y)
            .addScaledVector(this.c, weights.z).addScaledVector(garment.directions[i], garment.bodyGaps[i]);
        }
      }
      if (this.surfaceEnabled && !this.envelope) for (const i of garment.simulationVertices)
        garment.positions[i].addScaledVector(garment.offsets[i], Math.exp(-Math.max(0, delta) * 3));
      let deepContact = garment.wideTriangles;
      const vertexStarted = performance.now();
      garment.guideActive.fill(0);
      // Retain the pre-existing body contact pass, without pulling the result
      // back toward a separate cloth simulation or stretching material seams.
      for (let i = 0; i < garment.vertexCount; i += 1) {
        if (this.surfaceEnabled) {
          if (this.envelope) {
            if (garment.representatives[i] !== i) continue;
            const hit = this.closestBody(garment.authored[i], garment.cachedFaces, i);
            const normal = hit && this.bodyNormals[hit.faceIndex];
            const signed = hit && normal ? this.relative.subVectors(garment.authored[i], hit.point).dot(normal) : Infinity;
            // A persistent contact must retain its converged displacement;
            // decaying it every frame would deliberately reinsert the cloth.
            // Once the source skin clears the body, recover its authored pose.
            garment.positions[i].addScaledVector(garment.offsets[i], signed < CONTACT_MARGIN
              ? 1 : Math.exp(-Math.max(0, delta) * 3));
            if (signed < -CONTACT_MARGIN * 5) deepContact = true;
            // A corrected point may have gone around the thigh and now face
            // another surface. Reusing the source point's normal would keep
            // pushing it even when it is already safely outside the body.
            const currentHit = garment.offsets[i].lengthSq() > 1e-12
              ? this.closestBody(garment.positions[i], garment.cachedFaces, i) : hit;
            if (currentHit) {
              const currentNormal = this.bodyNormals[currentHit.faceIndex];
              const depth = CONTACT_MARGIN - this.relative.subVectors(garment.positions[i], currentHit.point).dot(currentNormal);
              if (depth > 0) { garment.positions[i].addScaledVector(currentNormal, Math.min(.012, depth)); contacts++; }
            }
            continue;
          }
          const hit = this.closestBody(garment.positions[i], garment.cachedFaces, i);
          if (hit && this.relative.subVectors(garment.positions[i], hit.point).dot(this.bodyNormals[hit.faceIndex]) < CONTACT_MARGIN) {
            garment.cachedFaces[i] = hit.faceIndex;
            garment.guideActive[i] = 1;
            contacts += this.projectGuide(garment, i) || this.projectBody(garment.positions[i]);
          }
          continue;
        }
        if (garment.pinned[i]) continue;
        // Only corrected points need a second nearest-surface query.
        if (this.projectBody(garment.positions[i], garment.cachedFaces, i)) {
          contacts += 1 + this.projectBody(garment.positions[i], garment.cachedFaces, i);
        } else if (!this.surfaceEnabled) {
          contacts += this.projectBody(garment.positions[i]);
        }
      }
      this.diagnostics.vertexMs += performance.now() - vertexStarted;
      const surfaceStarted = performance.now();
      if (this.envelope) this.preserveShape(garment);
      else if (this.surfaceEnabled) for (let iteration = 0; iteration < 2; iteration++) this.preserveShape(garment);
      if (!this.surfaceEnabled) {
        // Preserve the existing Yachiyo-specific PMX contact response.
        for (const link of garment.links) {
          if (link.stiffness < .5 || link.rest < .035) continue;
          this.scratch.copy(garment.positions[link.a]).add(garment.positions[link.b]).multiplyScalar(.5);
          if (!this.projectBody(this.scratch)) continue;
          const displacement = this.scratch.sub(garment.positions[link.a])
            .sub(this.b.subVectors(garment.positions[link.b], garment.positions[link.a]).multiplyScalar(.5));
          if (!garment.pinned[link.a]) garment.positions[link.a].addScaledVector(displacement, .5);
          if (!garment.pinned[link.b]) garment.positions[link.b].addScaledVector(displacement, .5);
          contacts++;
        }
      }
      for (let iteration = 0; this.surfaceEnabled && iteration < garment.surfaceIterations; iteration++) {
        if (this.envelope && !deepContact) {
          this.refitGarment(garment);
          const pairs = this.surfaceContacts(garment, true, true);
          this.diagnostics.surfaceIntersections += pairs;
          if (!pairs) break;
          for (const i of garment.simulationVertices) if (garment.contacts[i])
            garment.positions[i].addScaledVector(garment.corrections[i], 1 / garment.contacts[i]);
          this.limitStrain(garment, 4);
          continue;
        }
        if (this.envelope) {
          this.refitGarment(garment);
          const intersections = this.surfaceContacts(garment, true);
          this.diagnostics.surfaceIntersections += intersections;
          if (!intersections) break;
          for (let sweep = 0; sweep < 3; sweep++) for (const face of garment.intersectingFaces) {
            const base = face * 3, ids = [garment.index.getX(base), garment.index.getX(base + 1), garment.index.getX(base + 2)];
            this.a.copy(garment.directions[ids[0]]).add(garment.directions[ids[1]]).add(garment.directions[ids[2]]).normalize();
            this.diagnostics.envelopeContacts += this.envelope.projectTriangle(garment.positions[ids[0]], garment.positions[ids[1]], garment.positions[ids[2]], this.a);
          }
          this.limitStrain(garment, 4);
          continue;
        }
        this.refitGarment(garment);
        const intersections = this.surfaceContacts(garment, true);
        this.diagnostics.surfaceIntersections += intersections;
        if (!intersections) break;
        for (let i = 0; i < garment.vertexCount; i++) {
          if (!garment.contacts[i]) continue;
          garment.positions[i].addScaledVector(garment.corrections[i], 1 / garment.contacts[i]);
          contacts += this.projectGuide(garment, i);
        }
        this.preserveShape(garment);
      }
      // A UV/material seam is one surface point. Preserve its two render
      // slots without letting contact split them into a visible crack.
      for (const link of garment.links) {
        if (this.envelope || !this.surfaceEnabled || link.rest !== 0 || garment.pinned[link.a] || garment.pinned[link.b]) continue;
        this.scratch.copy(garment.positions[link.a]).add(garment.positions[link.b]).multiplyScalar(.5);
        garment.positions[link.a].copy(this.scratch);
        garment.positions[link.b].copy(this.scratch);
      }
      if (this.envelope) {
        this.limitStrain(garment, 16);
        for (let iteration = 0; iteration < 4; iteration++) {
          this.refitGarment(garment);
          const pairs = this.surfaceContacts(garment, true, true);
          this.diagnostics.surfaceIntersections += pairs;
          if (!pairs) break;
          for (const i of garment.simulationVertices) if (garment.contacts[i])
            garment.positions[i].addScaledVector(garment.corrections[i], 1 / garment.contacts[i]);
          this.limitStrain(garment, 4);
        }
      }
      if (this.envelope) {
        const integrity = boundGarmentCorrection(garment);
        if (integrity.scale < .999999) this.diagnostics.shapeLimitedMeshes++;
        this.diagnostics.maximumStretchExcess = Math.max(this.diagnostics.maximumStretchExcess, integrity.maximumStretchExcess);
        this.diagnostics.maximumCorrection = Math.max(this.diagnostics.maximumCorrection, integrity.maximumCorrection);
        this.diagnostics.maximumAttachmentOffset = Math.max(this.diagnostics.maximumAttachmentOffset, integrity.maximumAttachmentOffset);
        this.diagnostics.collapsedFaces += integrity.collapsedFaces;
      }
      if (this.surfaceEnabled) {
        for (let i = 0; i < garment.vertexCount; i++) {
          if (!this.envelope) this.projectBody(garment.positions[i], garment.cachedFaces, i);
        }
        this.refitGarment(garment);
        this.diagnostics.unresolvedIntersections += this.surfaceContacts(garment, false);
        for (let i = 0; i < garment.vertexCount; i++) garment.offsets[i].subVectors(garment.positions[i], garment.authored[i]);
      }
      this.diagnostics.surfaceMs += performance.now() - surfaceStarted;
      const output = garment.display.geometry.attributes.position as THREE.BufferAttribute;
      // Matrix is constant within this pass. worldToLocal() otherwise walks
      // and recomputes the entire ancestor chain for every garment vertex.
      this.displayWorldInverse.copy(garment.display.matrixWorld).invert().multiply(this.contactToWorld);
      for (let i = 0; i < garment.vertexCount; i += 1) {
        this.scratch.copy(garment.positions[i]).applyMatrix4(this.displayWorldInverse);
        output.setXYZ(i, this.scratch.x, this.scratch.y, this.scratch.z);
      }
      output.needsUpdate = true;
      garment.display.geometry.computeVertexNormals();
      const garmentMs = performance.now() - garmentStarted;
      this.diagnostics.meshMs.push({ name: garment.source.name, ms: garmentMs });
      if (garmentMs > maximumMs) { maximumMs = garmentMs; mostExpensive = garment; }
    }
    this.diagnostics.lastContacts = contacts;
    const elapsed = performance.now() - started;
    this.diagnostics.lastMs = elapsed;
    this.samples += 1;
    this.diagnostics.averageMs += (elapsed - this.diagnostics.averageMs) / Math.min(this.samples, 120);
    this.slowFrames = elapsed > 16 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames >= 20) {
      // Bound the damage to the most expensive garment, then retry after a
      // cooldown. Other pieces retain protection, and the physics toggle can
      // explicitly start a fresh probe instead of permanently locking out.
      if (mostExpensive) {
        if (this.surfaceEnabled && mostExpensive.surfaceIterations > 1) {
          mostExpensive.surfaceIterations = 1; mostExpensive.qualityRetry = 10;
        } else {
          mostExpensive.cooldown = 5;
        }
      }
      this.slowFrames = 0;
    }
    this.diagnostics.coolingMeshes = this.garments.filter(garment => garment.cooldown > 0).length;
    this.diagnostics.reducedMeshes = this.garments.filter(garment => garment.surfaceIterations < 3 && !garment.cooldown).length;
    this.diagnostics.retryInSeconds = Math.max(...this.garments.map(garment => Math.max(garment.cooldown, garment.qualityRetry)));
    this.diagnostics.enabled = this.enabled = this.garments.some(garment => !garment.cooldown);
    this.diagnostics.fallbackReason = this.diagnostics.coolingMeshes ? 'mesh-contact-cooling-down'
      : this.diagnostics.reducedMeshes ? 'mesh-contact-reduced-surface-passes' : '';
    if (this.diagnostics.coolingMeshes) {
      this.diagnostics.surfaceCheckComplete = false;
      this.diagnostics.shapeCheckComplete = false;
    }
    this.diagnostics.shapePreservationPassed = this.diagnostics.shapeCheckComplete
      && this.diagnostics.maximumStretchExcess < 1e-6 && this.diagnostics.collapsedFaces === 0
      && this.diagnostics.maximumAttachmentOffset <= .012001;
    for (const garment of this.garments) {
      garment.display.visible = !garment.cooldown; garment.source.visible = !garment.display.visible;
    }
  }

  private updateBodyNormals(): void {
    for (let face = 0; face < this.bodyNormals.length; face++) {
      const base = face * 3;
      this.a.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base));
      this.b.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 1));
      this.c.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 2));
      this.bodyNormals[face].subVectors(this.b, this.a).cross(this.c.sub(this.a)).normalize();
    }
  }

  private bindSurface(points: THREE.Vector3[]): Pick<GarmentMesh, 'bodyFaces' | 'bodyWeights' | 'bodyGaps'> {
    const bodyFaces = new Int32Array(points.length), bodyGaps = new Float32Array(points.length);
    const bodyWeights = points.map((point, i) => {
      const hit = this.bodyBvh.closestPointToPoint(point, this.closest)!;
      bodyFaces[i] = hit.faceIndex;
      bodyGaps[i] = CONTACT_MARGIN;
      const base = hit.faceIndex * 3;
      this.cachedTriangle.a.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base));
      this.cachedTriangle.b.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 1));
      this.cachedTriangle.c.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 2));
      return this.cachedTriangle.getBarycoord(hit.point, new THREE.Vector3()) ?? new THREE.Vector3(1, 0, 0);
    });
    return { bodyFaces, bodyWeights, bodyGaps };
  }

  private projectGuide(garment: GarmentMesh, i: number): number {
    if (!garment.guideActive[i]) return 0;
    const point = garment.positions[i], normal = garment.directions[i];
    const depth = this.relative.subVectors(garment.bodyTargets[i], point).dot(normal);
    if (depth <= 0) return 0;
    point.addScaledVector(normal, Math.min(.3, depth));
    return 1;
  }

  private preserveShape(garment: GarmentMesh): void {
    // Smooth only the contact displacement, leaving the authored pleats and
    // spring pose as the reference. Attachment vertices retain stronger tethers.
    for (const i of garment.simulationVertices) {
      const target = garment.smoothed[i].set(0, 0, 0), neighbours = garment.adjacent[i];
      for (const j of neighbours) target.add(this.relative.subVectors(garment.positions[j], garment.authored[j]));
      target.multiplyScalar(neighbours.size ? .7 / neighbours.size : 0);
      target.addScaledVector(this.relative.subVectors(garment.positions[i], garment.authored[i]), .3);
      if (garment.pinned[i]) target.multiplyScalar(.35);
      target.add(garment.authored[i]);
    }
    for (const i of garment.simulationVertices) garment.positions[i].copy(garment.smoothed[i]);
    for (const link of garment.links) {
      if (link.rest < 1e-5 || link.stiffness < .5) continue;
      const a = garment.positions[link.a], b = garment.positions[link.b];
      const length = this.relative.subVectors(b, a).length();
      const authored = garment.authored[link.a].distanceTo(garment.authored[link.b]);
      if (length < 1e-7 || authored < 1e-7) continue;
      const allowed = THREE.MathUtils.clamp(length, authored * .8, authored * 1.4);
      const strengthA = garment.pinned[link.a] ? .25 : 1, strengthB = garment.pinned[link.b] ? .25 : 1;
      this.relative.multiplyScalar((length - allowed) / length / (strengthA + strengthB));
      a.addScaledVector(this.relative, strengthA); b.addScaledVector(this.relative, -strengthB);
    }
    for (const i of garment.simulationVertices) this.projectGuide(garment, i);
  }


  private limitStrain(garment: GarmentMesh, iterations: number): void {
    // Contact cannot take priority over garment integrity. Keep the authored
    // skin as the reference and report unresolved contact when constraints
    // conflict; never hide an over-stretched sleeve behind a zero-pair count.
    for (let iteration = 0; iteration < iterations; iteration++) {
      let adjusted = false;
      for (const link of garment.links) {
        if (link.stiffness < .5 || link.rest < 1e-5) continue;
        const a = garment.positions[link.a], b = garment.positions[link.b];
        const length = this.relative.subVectors(b, a).length();
        const authored = garment.authored[link.a].distanceTo(garment.authored[link.b]);
        const allowed = authored * 1.35 + .002;
        if (length <= allowed || length < 1e-7) continue;
        adjusted = true;
        const wa = garment.pinned[link.a] ? .15 : 1, wb = garment.pinned[link.b] ? .15 : 1;
        this.relative.multiplyScalar((length - allowed) / length / (wa + wb));
        a.addScaledVector(this.relative, wa); b.addScaledVector(this.relative, -wb);
      }
      for (const i of garment.simulationVertices) {
        const limit = garment.correctionLimits[i];
        this.relative.subVectors(garment.positions[i], garment.authored[i]);
        if (this.relative.lengthSq() > limit * limit) {
          adjusted = true;
          garment.positions[i].copy(garment.authored[i]).add(this.relative.setLength(limit));
        }
      }
      if (!adjusted) break;
    }
  }

  private refitGarment(garment: GarmentMesh): void {
    for (let i = 0; i < garment.vertexCount; i++) {
      const p = garment.positions[i];
      garment.contactPosition.setXYZ(i, p.x, p.y, p.z);
    }
    garment.bvh.refit();
  }

  private surfaceContacts(garment: GarmentMesh, correct: boolean, local = false): number {
    let pairs = 0, checks = 0;
    if (correct) {
      garment.intersectingFaces.clear();
      garment.contacts.fill(0);
      garment.corrections.forEach(p => p.set(0, 0, 0));
    }
    this.bodyBvh.bvhcast(garment.bvh, this.identity, {
      intersectsTriangles: (bodyTriangle, clothTriangle, bodyFace, clothFace) => {
        checks++;
        // A pathological dense overlap remains measurable without unbounded
        // triangle work. Incomplete verification can never report zero as safe.
        if (checks > 24000) { this.diagnostics.surfaceCheckComplete = false; return true; }
        if (!bodyTriangle.intersectsTriangle(clothTriangle, this.intersection)) return false;
        pairs++;
        const base = garment.bvh.resolveTriangleIndex(clothFace) * 3;
        const ids = [garment.index.getX(base), garment.index.getX(base + 1), garment.index.getX(base + 2)]
          .map(id => garment.representatives[id]);
        if (!correct) {
          if (ids.some(id => garment.pinned[id])) this.diagnostics.pinnedIntersections++;
          this.diagnostics.maximumResidualSpan = Math.max(this.diagnostics.maximumResidualSpan,
            this.intersection.start.distanceTo(this.intersection.end));
          const normal = this.bodyNormals[this.bodyBvh.resolveTriangleIndex(bodyFace)];
          if (!normal || normal.lengthSq() < .5) {
            this.diagnostics.surfaceCheckComplete = false;
          } else {
            // This whole-face plane bound deliberately overestimates local
            // penetration. It can certify a very small contact, but is not a
            // measured penetration depth for a large curved triangle.
            for (const point of [clothTriangle.a, clothTriangle.b, clothTriangle.c]) {
              this.diagnostics.maximumResidualDepthBound = Math.max(this.diagnostics.maximumResidualDepthBound,
                -this.relative.subVectors(point, bodyTriangle.a).dot(normal));
            }
          }
          return false;
        }
        garment.intersectingFaces.add(garment.bvh.resolveTriangleIndex(clothFace));
        const normal = this.bodyNormals[this.bodyBvh.resolveTriangleIndex(bodyFace)];
        if (!normal || normal.lengthSq() < .5) return false;
        this.scratch.copy(this.intersection.start).add(this.intersection.end).multiplyScalar(.5);
        if (!clothTriangle.getBarycoord(this.scratch, this.barycentric)) return false;
        const weights = [this.barycentric.x, this.barycentric.y, this.barycentric.z];
        const outward = this.a.set(0, 0, 0);
        for (let i = 0; i < 3; i++) outward.addScaledVector(garment.directions[ids[i]], weights[i]);
        if (!local && normal.dot(outward) < .1) return false;
        if (local) {
          const mobility = ids.map(id => garment.pinned[id] ? .15 : 1);
          const denominator = weights.reduce((sum, weight, i) => sum + weight * weight * mobility[i], 0);
          if (denominator < 1e-6) return false;
          for (let i = 0; i < 3; i++) {
            garment.corrections[ids[i]].addScaledVector(normal, CONTACT_MARGIN * weights[i] * mobility[i] / denominator);
            garment.contacts[ids[i]]++;
          }
          return false;
        }
        for (const id of ids) garment.guideActive[id] = 1;
        outward.normalize();
        for (const id of ids) {
          const signed = this.relative.subVectors(garment.positions[id], bodyTriangle.a).dot(normal);
          const depth = Math.min(.2, Math.max(0, CONTACT_MARGIN - signed) / Math.max(.2, normal.dot(outward)));
          if (depth * depth > garment.corrections[id].lengthSq()) {
            garment.corrections[id].copy(outward).multiplyScalar(depth);
            garment.contacts[id] = 1;
          }
        }
        return false;
      },
    });
    this.diagnostics.surfaceChecks += checks;
    return pairs;
  }

  private updateBodyGeometry(): void {
    this.body.updateWorldMatrix(true, false);
    this.skinToContact.multiplyMatrices(this.contactFromWorld, this.body.matrixWorld);
    for (let i = 0; i < this.bodyPosition.count; i += 1) {
      if (this.surfaceEnabled) this.skinning.sample(this.body, i, this.scratch);
      else this.body.getVertexPosition(i, this.scratch);
      // Refresh once above, including the constructor's initial BVH build.
      this.scratch.applyMatrix4(this.skinToContact);
      this.bodyPosition.setXYZ(i, this.scratch.x, this.scratch.y, this.scratch.z);
    }
    this.bodyPosition.needsUpdate = true;
  }

  private updateContactSpace(): void {
    // Rotating the desktop avatar must not rotate every BVH leaf's bounds into
    // a heavily overlapping tree. The converted model's common space keeps
    // contact equivalent while removing view rotation from collision work.
    if (this.surfaceEnabled) {
      this.modelRoot.updateWorldMatrix(true, false);
      // Refresh descendants via updateMatrixWorld, including SkinnedMesh's
      // attached bindMatrixInverse override. CPU skinning must use the same
      // posed bones and bind transforms as this frame's GPU render.
      this.modelRoot.updateMatrixWorld(true);
      this.skinning.beginFrame();
      this.contactToWorld.copy(this.modelRoot.matrixWorld);
      this.contactFromWorld.copy(this.contactToWorld).invert();
    } else {
      this.contactToWorld.identity(); this.contactFromWorld.identity();
    }
  }

  private closestBody(point: THREE.Vector3, hints?: Int32Array, slot = 0): HitPointInfo | null {
    let radius = CONTACT_SEARCH;
    const cached = hints?.[slot] ?? -1;
    if (cached >= 0) {
      const base = cached * 3;
      this.cachedTriangle.a.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base));
      this.cachedTriangle.b.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 1));
      this.cachedTriangle.c.fromBufferAttribute(this.bodyPosition, this.bodyIndex.getX(base + 2));
      this.cachedTriangle.closestPointToPoint(point, this.cachedPoint);
      radius = Math.min(radius, point.distanceTo(this.cachedPoint) + .00001);
    }
    // The cached face bounds the exact query; it is never blindly reused as a
    // contact normal after a limb moves or the nearest surface changes.
    const hit = this.bodyBvh.closestPointToPoint(point, this.closest, 0, radius);
    if (hit && hints) hints[slot] = hit.faceIndex;
    return hit;
  }

  private projectBody(point: THREE.Vector3, hints?: Int32Array, slot = 0): number {
    const hit = this.closestBody(point, hints, slot);
    if (!hit) return 0;
    const base = hit.faceIndex * 3;
    if (base + 2 >= this.bodyIndex.count) return 0;
    this.normal.copy(this.bodyNormals[hit.faceIndex]);
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
      garment.contactGeometry.dispose();
    }
    this.bodyGeometry.dispose();
  }
}
