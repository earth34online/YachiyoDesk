'use strict';
const path = require('node:path');
function safeRelative(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f:]/.test(value) || /^[\\/]/.test(value)) throw new Error('资源路径不安全。');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('资源路径不安全。');
  return normalized;
}
function pmxTextures(bytes) {
  let offset = 0;
  const requireBytes = size => { if (!Number.isInteger(size) || size < 0 || offset + size > bytes.length) throw new Error('PMX 数据不完整。'); };
  const skip = size => { requireBytes(size); offset += size; };
  const int = () => { requireBytes(4); const value = bytes.readInt32LE(offset); offset += 4; return value; };
  const count = maximum => { const value = int(); if (value < 0 || value > maximum) throw new Error('PMX 数据数量不合理。'); return value; };
  if (bytes.subarray(0,4).toString('ascii') !== 'PMX ') throw new Error('不是 PMX 文件。');
  offset = 8; requireBytes(1); const headerSize = bytes[offset++]; requireBytes(headerSize);
  if (headerSize < 8) throw new Error('PMX 头信息不完整。');
  const flags = bytes.subarray(offset, offset + headerSize); skip(headerSize);
  const encoding = flags[0] === 0 ? 'utf16le' : flags[0] === 1 ? 'utf8' : null;
  if (!encoding || flags[1] > 4 || ![1,2,4].includes(flags[2]) || ![1,2,4].includes(flags[5])) throw new Error('PMX 编码或索引格式不受支持。');
  const string = () => { const size = count(4 * 1024 * 1024); requireBytes(size); const value = bytes.subarray(offset,offset+size).toString(encoding); skip(size); return value; };
  for (let i=0;i<4;i++) string();
  const vertices = count(2000000), boneIndex = flags[5];
  for (let i=0;i<vertices;i++) {
    skip(32 + flags[1] * 16); requireBytes(1); const type = bytes[offset++];
    const sizes = [boneIndex, 2*boneIndex+4, 4*boneIndex+16, 2*boneIndex+40, 4*boneIndex+16];
    if (sizes[type] === undefined) throw new Error('PMX 蒙皮类型不受支持。'); skip(sizes[type] + 4);
  }
  skip(count(12000000) * flags[2]);
  const textureCount = count(4096), start = offset, textures = [];
  for (let i=0;i<textureCount;i++) textures.push(string());
  return { textures, start, end: offset, encoding, vertices };
}
function rewritePmxTextures(bytes, replacements) {
  const info = pmxTextures(bytes), textures = [...info.textures];
  for (const [index, value] of Object.entries(replacements)) {
    if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= textures.length) throw new Error('贴图索引无效。');
    textures[Number(index)] = safeRelative(value);
  }
  const blocks = textures.flatMap(value => { const string = Buffer.from(value,info.encoding), header = Buffer.alloc(4); header.writeInt32LE(string.length); return [header,string]; });
  return Buffer.concat([bytes.subarray(0, info.start), ...blocks, bytes.subarray(info.end)]);
}
module.exports = { pmxTextures, rewritePmxTextures, safeRelative };
