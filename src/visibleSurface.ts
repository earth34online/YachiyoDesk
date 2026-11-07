import * as THREE from 'three';

type Pixels = { image: unknown; version: number; width: number; height: number; data: ArrayLike<number>; channels: number };
const pixels = new WeakMap<THREE.Texture, Pixels>();

function textureValue(texture: THREE.Texture, uv: THREE.Vector2, channel: number): number {
  const image = texture.source.data as { width: number; height: number; data?: Uint8Array | Uint8ClampedArray } | undefined;
  if (!image?.width || !image?.height) return 1;
  let cached = pixels.get(texture);
  if (!cached || cached.image !== image || cached.version !== texture.version) {
    let data: ArrayLike<number>;
    if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) data = image.data;
    else {
      // Use the original decoded texture, with no reduction in its resolution.
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
      if (!context) return 1;
      context.drawImage(image as CanvasImageSource, 0, 0); data = context.getImageData(0, 0, image.width, image.height).data;
    }
    cached = { image, version: texture.version, width: image.width, height: image.height, data,
      channels: data.length / (image.width * image.height) };
    pixels.set(texture, cached);
  }
  if (channel >= cached.channels) return 1;
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const point = texture.transformUv(uv.clone());
  const wrap = (value: number, size: number, mode: THREE.Wrapping): number => {
    if (mode === THREE.RepeatWrapping) return (value % size + size) % size;
    if (mode === THREE.MirroredRepeatWrapping) {
      const index = (value % (size * 2) + size * 2) % (size * 2); return index < size ? index : size * 2 - index - 1;
    }
    return Math.min(size - 1, Math.max(0, value));
  };
  const sample = (x: number, y: number): number => cached.data[(wrap(y,cached.height,texture.wrapT) * cached.width
    + wrap(x,cached.width,texture.wrapS)) * cached.channels + channel] / 255;
  if (texture.magFilter === THREE.NearestFilter) return sample(Math.floor(point.x*cached.width),Math.floor(point.y*cached.height));
  const x = point.x*cached.width-.5, y = point.y*cached.height-.5, left = Math.floor(x), top = Math.floor(y);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(sample(left,top),sample(left+1,top),x-left),
    THREE.MathUtils.lerp(sample(left,top+1),sample(left+1,top+1),x-left),y-top);
}

/** Match the material's alpha discard when a geometric ray is used as a surface. */
export function visibleSurface(material: THREE.Material, hit: { uv?: THREE.Vector2; uv1?: THREE.Vector2 }): boolean {
  if (!material.visible || material.opacity <= 0) return false;
  if (!material.alphaTest && !material.transparent) return true;
  const textured = material as THREE.Material & { map?: THREE.Texture; alphaMap?: THREE.Texture };
  let alpha = material.opacity;
  for (const [texture, channel] of [[textured.map, 3], [textured.alphaMap, 1]] as const) {
    if (!texture) continue;
    const uv = texture.channel === 1 ? hit.uv1 : hit.uv;
    if (uv) alpha *= textureValue(texture, uv, channel);
  }
  return material.alphaTest > 0 ? alpha >= material.alphaTest : alpha > 0;
}
