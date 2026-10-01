'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Keep this list aligned with VRMHumanoidLoaderPlugin's required bones.
const REQUIRED_BONES = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand'];

function inspectVrmFile(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size < 20 || stats.size > 512 * 1024 * 1024) {
    throw new Error('VRM 文件大小无效，支持范围为 20 字节到 512 MB。');
  }
  const handle = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(20);
    if (fs.readSync(handle, header, 0, 20, 0) !== 20
      || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2) {
      throw new Error('文件不是有效的 VRM/GLB 2.0。');
    }
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(8) !== stats.size || header.readUInt32LE(16) !== 0x4E4F534A
      || jsonLength <= 2 || jsonLength > 64 * 1024 * 1024 || jsonLength % 4 !== 0
      || 20 + jsonLength > stats.size) throw new Error('VRM 文件头或 JSON 数据块无效。');
    const buffer = Buffer.alloc(jsonLength);
    if (fs.readSync(handle, buffer, 0, jsonLength, 20) !== jsonLength) throw new Error('VRM JSON 数据块不完整。');
    const json = JSON.parse(buffer.toString('utf8').replace(/\u0000+$/g, '').trim());
    if (json.asset?.version !== '2.0') throw new Error('VRM 必须使用 glTF 2.0。');
    const sceneIndex = json.scene ?? 0;
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || !Array.isArray(json.scenes)
      || !json.scenes[sceneIndex] || typeof json.scenes[sceneIndex] !== 'object') {
      throw new Error('VRM 缺少可加载的 glTF 场景。');
    }
    const vrm0 = json.extensions?.VRM;
    const vrm1 = json.extensions?.VRMC_vrm;
    const v1Supported = vrm1 && ['1.0', '1.0-beta'].includes(vrm1.specVersion)
      && Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes('VRMC_vrm');
    const extension = v1Supported ? vrm1 : vrm0;
    if (!extension || typeof extension !== 'object' || !extension.meta
      || typeof extension.meta !== 'object') throw new Error('该文件没有可加载的 VRM 扩展与元数据。');
    if (v1Supported && extension.meta.licenseUrl !== 'https://vrm.dev/licenses/1.0/') {
      throw new Error('VRM 1.0 元数据缺少当前加载器支持的 licenseUrl。');
    }
    const sourceBones = extension.humanoid?.humanBones;
    const bones = v1Supported ? sourceBones : (Array.isArray(sourceBones)
      ? Object.fromEntries(sourceBones.map((bone) => [bone?.bone, bone])) : null);
    if (!bones || typeof bones !== 'object' || Array.isArray(bones)) throw new Error('VRM 人形骨骼数据无效。');
    const nodes = json.nodes;
    for (const name of REQUIRED_BONES) {
      if (!bones[name]) throw new Error(`VRM 缺少必要人形骨骼：${name}`);
    }
    for (const [name, bone] of Object.entries(bones)) {
      if (!bone || !Number.isInteger(bone.node) || bone.node < 0 || !Array.isArray(nodes)
        || !nodes[bone.node] || typeof nodes[bone.node] !== 'object') {
        throw new Error(`VRM 骨骼节点无效：${name}`);
      }
    }
    // Walk the remaining chunk headers too, so truncated binary data cannot
    // enter the character library after passing only the JSON inspection.
    let offset = 20 + jsonLength;
    const chunkHeader = Buffer.alloc(8);
    while (offset < stats.size) {
      if (offset + 8 > stats.size || fs.readSync(handle, chunkHeader, 0, 8, offset) !== 8) {
        throw new Error('VRM 数据块不完整。');
      }
      const length = chunkHeader.readUInt32LE(0);
      if (chunkHeader.readUInt32LE(4) === 0x4E4F534A) throw new Error('VRM 包含重复的 JSON 数据块。');
      if (length % 4 !== 0 || offset + 8 + length > stats.size) throw new Error('VRM 数据块长度无效。');
      offset += 8 + length;
    }
    const meta = extension.meta;
    const displayName = meta.title || meta.name || path.parse(filePath).name;
    const creator = meta.author || (Array.isArray(meta.authors) ? meta.authors.join('、') : '') || '本地导入';
    return { displayName: String(displayName).slice(0, 80), creator: String(creator).slice(0, 120) };
  } finally {
    fs.closeSync(handle);
  }
}

module.exports = { inspectVrmFile, REQUIRED_BONES };
