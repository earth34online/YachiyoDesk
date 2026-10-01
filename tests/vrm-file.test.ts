import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

const { inspectVrmFile, REQUIRED_BONES } = require('../electron/vrm-file.cjs') as {
  inspectVrmFile(file: string): { displayName: string; creator: string }; REQUIRED_BONES: string[];
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function writeGlb(json: object) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-vrm-')); directories.push(directory);
  const source = JSON.stringify(json); const text = Buffer.from(source + ' '.repeat((4 - Buffer.byteLength(source) % 4) % 4));
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length, 8); header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4E4F534A, 16);
  const file = path.join(directory, 'fixture.vrm'); fs.writeFileSync(file, Buffer.concat([header, text])); return file;
}
function vrm(version: '0' | '1') {
  const bones = REQUIRED_BONES.map((bone, node) => ({ bone, node }));
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: bones.map(({ node }) => node) }],
    nodes: bones.map(() => ({})), extensionsUsed: [version === '1' ? 'VRMC_vrm' : 'VRM'],
    extensions: version === '1' ? { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Fixture', authors: ['Author'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
      humanoid: { humanBones: Object.fromEntries(bones.map(({ bone, node }) => [bone, { node }])) } } }
      : { VRM: { meta: { title: 'Fixture', author: 'Author' }, humanoid: { humanBones: bones } } } };
}

describe('VRM import structural validation', () => {
  it('rejects a declaration without real extension data', () => {
    expect(() => inspectVrmFile(writeGlb({ asset: { version: '2.0' }, scenes: [{}], extensionsUsed: ['VRMC_vrm'] }))).toThrow('VRM 扩展');
    expect(() => inspectVrmFile(writeGlb({ asset: { version: '2.0' }, extensions: { VRMC_vrm: {} } }))).toThrow();
  });
  it.each(['0', '1'] as const)('accepts runtime-supported VRM %s humanoid structures', (version) => {
    expect(inspectVrmFile(writeGlb(vrm(version)))).toEqual({ displayName: 'Fixture', creator: 'Author' });
  });
  it.each(['0', '1'] as const)('accepted VRM %s also creates a VRM object in the real loader', async (version) => {
    const file = writeGlb(vrm(version)); inspectVrmFile(file);
    const bytes = fs.readFileSync(file);
    const loader = new GLTFLoader().register((parser) => new VRMLoaderPlugin(parser));
    const loaded = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    expect(loaded.userData.vrm).toBeDefined();
  });
  it('rejects missing required bones, invalid indices and unsupported versions', () => {
    const json = vrm('1'); const ext = json.extensions.VRMC_vrm!;
    ext.humanoid.humanBones.hips.node = 999;
    expect(() => inspectVrmFile(writeGlb(json))).toThrow('节点无效');
    delete ext.humanoid.humanBones.hips;
    expect(() => inspectVrmFile(writeGlb(json))).toThrow('hips');
    ext.specVersion = '2.0';
    expect(() => inspectVrmFile(writeGlb(json))).toThrow('VRM 扩展');
  });
  it('rejects VRM 1 metadata that the runtime loader cannot accept', () => {
    const json = vrm('1'); json.extensions.VRMC_vrm!.meta.licenseUrl = '';
    expect(() => inspectVrmFile(writeGlb(json))).toThrow('licenseUrl');
  });
  it('rejects a truncated GLB and a declared JSON chunk exceeding the file', () => {
    const file = writeGlb(vrm('1')); const bytes = fs.readFileSync(file);
    bytes.writeUInt32LE(bytes.length + 32, 12); fs.writeFileSync(file, bytes);
    expect(() => inspectVrmFile(file)).toThrow('JSON 数据块');
    fs.writeFileSync(file, bytes.subarray(0, bytes.length - 4));
    expect(() => inspectVrmFile(file)).toThrow();
  });
  it('rejects a second JSON chunk that would replace the validated extension in GLTFLoader', () => {
    const file = writeGlb(vrm('1')); const bytes = fs.readFileSync(file);
    const second = fs.readFileSync(writeGlb({ asset: { version: '2.0' } })).subarray(12);
    const combined = Buffer.concat([bytes, second]); combined.writeUInt32LE(combined.length, 8);
    fs.writeFileSync(file, combined);
    expect(() => inspectVrmFile(file)).toThrow('重复的 JSON');
  });
});
