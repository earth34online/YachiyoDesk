import * as THREE from 'three';

/** Matches SkinnedMesh CPU skinning, caching each bone's transform once per contact frame. */
export class ContactSkinning {
  private frame = 0;
  private readonly palettes = new WeakMap<THREE.Skeleton, { frame: number; matrices: THREE.Matrix4[] }>();
  private readonly base = new THREE.Vector3();

  beginFrame(): void { this.frame++; }

  sample(mesh: THREE.SkinnedMesh, index: number, target: THREE.Vector3): THREE.Vector3 {
    const skeleton = mesh.skeleton;
    let palette = this.palettes.get(skeleton);
    if (!palette || palette.matrices.length !== skeleton.bones.length) {
      palette = { frame: -1, matrices: skeleton.bones.map(() => new THREE.Matrix4()) };
      this.palettes.set(skeleton, palette);
    }
    if (palette.frame !== this.frame) {
      for (let i = 0; i < skeleton.bones.length; i++)
        palette.matrices[i].multiplyMatrices(skeleton.bones[i].matrixWorld, skeleton.boneInverses[i]);
      palette.frame = this.frame;
    }
    // Mesh.getVertexPosition includes morph targets; SkinnedMesh adds skinning.
    THREE.Mesh.prototype.getVertexPosition.call(mesh, index, target);
    this.base.copy(target).applyMatrix4(mesh.bindMatrix);
    const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    const x = this.base.x, y = this.base.y, z = this.base.z;
    let sx = 0, sy = 0, sz = 0;
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(index, slot);
      if (weight === 0) continue;
      const e = palette.matrices[indices.getComponent(index, slot)].elements;
      sx += (e[0] * x + e[4] * y + e[8] * z + e[12]) * weight;
      sy += (e[1] * x + e[5] * y + e[9] * z + e[13]) * weight;
      sz += (e[2] * x + e[6] * y + e[10] * z + e[14]) * weight;
    }
    return target.set(sx, sy, sz).applyMatrix4(mesh.bindMatrixInverse);
  }
}
