import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

interface SupportPlane { normal: THREE.Vector3; offset: number }
interface BodyPart {
  node: THREE.Object3D;
  inverseRest: THREE.Quaternion;
  vertices: number[];
  planes: SupportPlane[];
  bounds: THREE.Box3;
}

const ico = new THREE.IcosahedronGeometry(1, 1).attributes.position;
const directionMap = new Map<string, THREE.Vector3>();
for (let i = 0; i < ico.count; i++) {
  const direction = new THREE.Vector3().fromBufferAttribute(ico, i).normalize();
  directionMap.set(direction.toArray().map(value => Math.round(value * 10000)).join(':'), direction);
}
const DIRECTIONS = [...directionMap.values()];
const MARGIN = .004;

/** Posed support polytopes: every original body triangle belongs to a containing part. */
export class BodyContactEnvelope {
  private readonly parts: BodyPart[];
  private readonly rotation = new THREE.Quaternion();
  private readonly contactRotation = new THREE.Quaternion();
  private readonly scratch = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly polygons = [Array.from({ length: 64 }, () => new THREE.Vector3()),
    Array.from({ length: 64 }, () => new THREE.Vector3())];

  static create(vrm: VRM, source: THREE.SkinnedMesh, geometry: THREE.BufferGeometry,
    fromWorld: THREE.Matrix4): BodyContactEnvelope | null {
    const raw = vrm.humanoid?.rawHumanBones;
    if (!raw?.hips || !raw.leftUpperLeg || !raw.rightUpperLeg) return null;
    return new BodyContactEnvelope(raw, source, geometry, fromWorld);
  }

  private constructor(raw: VRM['humanoid']['rawHumanBones'], source: THREE.SkinnedMesh,
    private readonly geometry: THREE.BufferGeometry, private readonly fromWorld: THREE.Matrix4) {
    const names = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      ...['left', 'right'].flatMap(side => ['UpperLeg', 'LowerLeg', 'Foot', 'UpperArm', 'LowerArm', 'Hand'].map(part => side + part)),
      ...['left', 'right'].flatMap(side => ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap(finger =>
        ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'].map(joint => side + finger + joint)))];
    const entries = names.flatMap(name => {
      const bone = raw[name as keyof typeof raw]; return bone ? [{ name, node: bone.node }] : [];
    });
    const byNode = new Map(entries.map((entry, i) => [entry.node, i]));
    this.parts = entries.map(entry => ({ node: entry.node, inverseRest: new THREE.Quaternion(), vertices: [],
      planes: DIRECTIONS.map(() => ({ normal: new THREE.Vector3(), offset: 0 })), bounds: new THREE.Box3() }));
    fromWorld.decompose(this.scratch, this.contactRotation, this.scale);
    this.parts.forEach(part => part.inverseRest.copy(part.node.getWorldQuaternion(this.rotation))
      .premultiply(this.contactRotation).invert());
    const boneParts = source.skeleton.bones.map(bone => {
      let node: THREE.Object3D | null = bone;
      while (node) { const part = byNode.get(node); if (part !== undefined) return part; node = node.parent; }
      return -1;
    });
    const sets = this.parts.map(() => new Set<number>()), index = geometry.index!;
    const skinIndex = source.geometry.attributes.skinIndex, skinWeight = source.geometry.attributes.skinWeight;
    const votes = new Float64Array(this.parts.length);
    for (let face = 0; face < index.count; face += 3) {
      votes.fill(0);
      const ids = [index.getX(face), index.getX(face + 1), index.getX(face + 2)];
      for (const id of ids) for (let j = 0; j < 4; j++) {
        const part = boneParts[skinIndex.getComponent(id, j)];
        if (part >= 0) votes[part] += skinWeight.getComponent(id, j);
      }
      let owner = votes.indexOf(Math.max(...votes));
      if (!votes[owner]) {
        const center = new THREE.Vector3();
        for (const id of ids) center.add(this.scratch.fromBufferAttribute(geometry.attributes.position, id));
        center.multiplyScalar(1 / 3);
        let nearest = Infinity;
        this.parts.forEach((part, i) => {
          const distance = part.node.getWorldPosition(this.scratch).applyMatrix4(fromWorld).distanceToSquared(center);
          if (distance < nearest) { nearest = distance; owner = i; }
        });
      }
      ids.forEach(id => sets[owner].add(id));
    }
    this.parts.forEach((part, i) => { part.vertices = [...sets[i]]; });
    this.parts = this.parts.filter(part => part.vertices.length > 0);
    this.update();
  }

  update(): void {
    this.fromWorld.decompose(this.scratch, this.contactRotation, this.scale);
    const position = this.geometry.attributes.position;
    for (const part of this.parts) {
      // The caller has already refreshed the complete posed hierarchy. Avoid
      // walking every ancestor again for each hand/finger support part.
      part.node.matrixWorld.decompose(this.scratch, this.rotation, this.scale);
      this.rotation.premultiply(this.contactRotation).multiply(part.inverseRest);
      part.bounds.makeEmpty();
      part.planes.forEach((plane, i) => { plane.normal.copy(DIRECTIONS[i]).applyQuaternion(this.rotation); plane.offset = -Infinity; });
      for (const id of part.vertices) {
        this.scratch.fromBufferAttribute(position, id); part.bounds.expandByPoint(this.scratch);
        for (const plane of part.planes) plane.offset = Math.max(plane.offset, plane.normal.dot(this.scratch));
      }
      part.bounds.expandByScalar(MARGIN);
      part.planes.forEach(plane => { plane.offset += MARGIN; });
    }
  }

  projectPoint(point: THREE.Vector3, preferred: THREE.Vector3): number {
    let contacts = 0;
    for (const part of this.parts) {
      if (!part.bounds.containsPoint(point)) continue;
      let inside = true, nearest = Infinity, nearestPlane: SupportPlane | null = null;
      for (const plane of part.planes) {
        const gap = plane.offset - plane.normal.dot(point);
        if (gap < 0) { inside = false; break; }
        if (gap < nearest) { nearest = gap; nearestPlane = plane; }
      }
      if (!inside || !nearestPlane) continue;
      // Use the nearest admissible exit plane. A rest-pose normal can point
      // along a folded sleeve; ray-exiting in that direction stretches a cuff
      // across the whole arm instead of resolving the local contact.
      let best = nearestPlane, score = Infinity;
      for (const plane of part.planes) {
        const alignment = plane.normal.dot(preferred);
        if (preferred.lengthSq() > .5 && alignment < -.2) continue;
        const gap = plane.offset - plane.normal.dot(point);
        const cost = gap * gap * (preferred.lengthSq() > .5 ? 2 - alignment : 1);
        if (cost < score) { score = cost; best = plane; }
      }
      const depth = best.offset - best.normal.dot(point) + .00002;
      point.addScaledVector(best.normal, depth);
      contacts++;
    }
    return contacts;
  }

  projectTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, preferred: THREE.Vector3): number {
    let contacts = 0;
    for (const part of this.parts) {
      const box = part.bounds;
      if (Math.max(a.x, b.x, c.x) < box.min.x || Math.min(a.x, b.x, c.x) > box.max.x
        || Math.max(a.y, b.y, c.y) < box.min.y || Math.min(a.y, b.y, c.y) > box.max.y
        || Math.max(a.z, b.z, c.z) < box.min.z || Math.min(a.z, b.z, c.z) > box.max.z) continue;
      if (!this.intersects(part, a, b, c)) continue;
      let best: SupportPlane | null = null, score = Infinity;
      for (const plane of part.planes) {
        const alignment = plane.normal.dot(preferred);
        if (preferred.lengthSq() > .5 && alignment < -.2) continue;
        const cost = [a, b, c].reduce((sum, point) => sum + Math.max(0, plane.offset - plane.normal.dot(point)) ** 2, 0)
          * (preferred.lengthSq() > .5 ? 2 - alignment : 1);
        if (cost < score) { score = cost; best = plane; }
      }
      if (!best) continue;
      for (const point of [a, b, c]) {
        const depth = best.offset - best.normal.dot(point) + .00002;
        if (depth > 0) point.addScaledVector(best.normal, depth);
      }
      contacts++;
    }
    return contacts;
  }

  private intersects(part: BodyPart, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    let input = this.polygons[0], output = this.polygons[1], count = 3;
    input[0].copy(a); input[1].copy(b); input[2].copy(c);
    for (const plane of part.planes) {
      let nextCount = 0;
      for (let i = 0; i < count; i++) {
        const start = input[i], end = input[(i + 1) % count];
        const ds = plane.normal.dot(start) - plane.offset, de = plane.normal.dot(end) - plane.offset;
        if (ds <= 0) output[nextCount++].copy(start);
        if ((ds < 0 && de > 0) || (ds > 0 && de < 0)) output[nextCount++].copy(start).lerp(end, ds / (ds - de));
      }
      if (!nextCount) return false;
      count = nextCount; [input, output] = [output, input];
    }
    return count > 0;
  }
}
