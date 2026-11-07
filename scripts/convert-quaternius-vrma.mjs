#!/usr/bin/env node
/**
 * Offline Quaternius CC0 GLB -> normalized, animation-only VRMA.
 * Retarget formula adapted from pixiv/three-vrm (MIT), commit
 * 3caf7a21ee68f0d5dfa363ab3d577450bbf60136,
 * packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js.
 * Run: node scripts/convert-quaternius-vrma.mjs --source-root <downloaded motions directory>
 * No source models, meshes, translations of limb bones, or scales are shipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const sourceRoot = path.resolve(option('--source-root', path.join(repo, '../artifacts/companion-expansion-20261107/motions')));
const output = path.resolve(option('--output', path.join(repo, 'assets/motions')));
const reportPath = path.resolve(option('--report', path.join(sourceRoot, '../quaternius-conversion-report.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const selected = {
  1: ['Idle_Talking_Loop', 'Dance_Loop', 'PickUp_Table', 'Push_Loop',
    'Sitting_Enter', 'Sitting_Idle_Loop', 'Sitting_Exit'],
  2: ['Yes', 'Idle_No_Loop', 'Idle_FoldArms_Loop', 'Consume', 'Idle_TalkingPhone_Loop', 'OverhandThrow'],
};
const rigMap = { pelvis: 'hips', spine_01: 'spine', spine_02: 'chest', spine_03: 'upperChest', neck_01: 'neck', Head: 'head' };
for (const [suffix, side] of [['l', 'left'], ['r', 'right']]) {
  for (const [source, target] of Object.entries({ clavicle: 'Shoulder', upperarm: 'UpperArm', lowerarm: 'LowerArm', hand: 'Hand', thigh: 'UpperLeg', calf: 'LowerLeg', foot: 'Foot', ball: 'Toes' })) rigMap[`${source}_${suffix}`] = side + target;
  for (const [source, target] of [['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['pinky', 'Little'], ['thumb', 'Thumb']]) {
    const segments = source === 'thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    segments.forEach((segment, i) => { rigMap[`${source}_0${i + 1}_${suffix}`] = side + target + segment; });
  }
}
function readGlb(filename) {
  const bytes = Buffer.isBuffer(filename) ? filename : fs.readFileSync(filename);
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error('Invalid source GLB');
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trim());
  const binary = bytes.subarray(28 + jsonLength);
  function accessor(index) {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    if (a.componentType !== 5126 || !width || a.sparse || view.buffer !== 0) throw Error('Unsupported source accessor');
    const values = new Float32Array(a.count * width);
    const start = (view.byteOffset || 0) + (a.byteOffset || 0), stride = view.byteStride || width * 4;
    for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) values[i * width + k] = binary.readFloatLE(start + i * stride + k * 4);
    if (!values.every(Number.isFinite)) throw Error('Non-finite source values');
    return values;
  }
  return { bytes, json, accessor };
}
function calibratedRig(source) {
  const { json, accessor } = source;
  const nodes = json.nodes.map(n => {
    const node = new THREE.Object3D(); node.name = n.name || '';
    if (n.matrix) { new THREE.Matrix4().fromArray(n.matrix).decompose(node.position, node.quaternion, node.scale); }
    else { if (n.translation) node.position.fromArray(n.translation); if (n.rotation) node.quaternion.fromArray(n.rotation); if (n.scale) node.scale.fromArray(n.scale); }
    return node;
  });
  json.nodes.forEach((n, i) => n.children?.forEach(child => nodes[i].add(nodes[child])));
  const calibration = json.animations.find(a => a.name === 'A_TPose');
  if (!calibration) throw Error('Author A_TPose calibration is required');
  for (const channel of calibration.channels) {
    const sampler = calibration.samplers[channel.sampler], times = accessor(sampler.input), values = accessor(sampler.output);
    if (times[0] !== 0 || (sampler.interpolation && !['LINEAR', 'STEP'].includes(sampler.interpolation))) throw Error('Unsupported T-pose calibration');
    const node = nodes[channel.target.node];
    if (channel.target.path === 'rotation') node.quaternion.fromArray(values).normalize();
    if (channel.target.path === 'translation') node.position.fromArray(values);
    if (channel.target.path === 'scale') node.scale.fromArray(values);
  }
  for (const node of nodes) if (!node.parent) node.updateMatrixWorld(true);
  const named = name => nodes.find(n => n.name === name);
  const world = name => named(name).getWorldPosition(new THREE.Vector3());
  const left = world('hand_l'), right = world('hand_r'), hip = world('pelvis');
  const leftShoulder = world('upperarm_l'), rightShoulder = world('upperarm_r');
  const toesForward = world('ball_l').sub(world('foot_l'));
  if (!(left.x > hip.x && right.x < hip.x && Math.abs(left.y - leftShoulder.y) < .01 && Math.abs(right.y - rightShoulder.y) < .01 && toesForward.z > 0 && hip.y > .1)) throw Error('Source calibration is not the expected +Z-facing T pose');
  const mapped = nodes.map((node, sourceIndex) => ({ node, sourceIndex, humanBone: rigMap[node.name] })).filter(entry => entry.humanBone);
  const indexMap = new Map(mapped.map((entry, index) => [entry.node, index]));
  for (const entry of mapped) {
    entry.restWorld = entry.node.getWorldQuaternion(new THREE.Quaternion());
    entry.parentRestWorld = entry.node.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion();
    entry.worldPosition = entry.node.getWorldPosition(new THREE.Vector3());
    let parent = entry.node.parent;
    while (parent && !indexMap.has(parent)) parent = parent.parent;
    entry.parent = parent ? indexMap.get(parent) : null;
  }
  return { nodes, mapped, hip, evidence: { calibration: 'A_TPose', forward: '+Z', leftHand: left.toArray(), rightHand: right.toArray(), leftShoulder: leftShoulder.toArray(), rightShoulder: rightShoulder.toArray(), hips: hip.toArray(), leftFootToToe: toesForward.toArray() } };
}
function convert(source, rig, clip) {
  const json = { asset: { version: '2.0', generator: 'YachiyoDesk offline Quaternius retargeter' }, extensionsUsed: ['VRMC_vrm_animation'], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: {} } } }, scene: 0, scenes: [{ nodes: [] }], nodes: [], animations: [{ name: clip.name, channels: [], samplers: [] }], buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
  const chunks = [];
  let byteLength = 0;
  const animation = json.animations[0];
  function addAccessor(values, type) {
    const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const bufferView = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length });
    chunks.push(data); byteLength += data.length;
    const accessor = { bufferView, componentType: 5126, count: values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[type]), type };
    if (type === 'SCALAR') { accessor.min = [Math.min(...values)]; accessor.max = [Math.max(...values)]; }
    return json.accessors.push(accessor) - 1;
  }
  rig.mapped.forEach((entry, index) => {
    const position = entry.worldPosition.clone();
    if (entry.parent != null) position.sub(rig.mapped[entry.parent].worldPosition);
    json.nodes.push({ name: entry.humanBone, translation: position.toArray(), children: [] });
    json.extensions.VRMC_vrm_animation.humanoid.humanBones[entry.humanBone] = { node: index };
  });
  rig.mapped.forEach((entry, index) => { if (entry.parent == null) json.scenes[0].nodes.push(index); else json.nodes[entry.parent].children.push(index); });
  for (const node of json.nodes) if (!node.children.length) delete node.children;
  const indexMap = new Map(rig.mapped.map((entry, index) => [entry.sourceIndex, index]));
  let maxQuaternionNormError = 0;
  for (const channel of clip.channels) {
    const index = indexMap.get(channel.target.node);
    if (index == null || !['rotation', 'translation'].includes(channel.target.path)) continue;
    const entry = rig.mapped[index];
    if (channel.target.path === 'translation' && entry.humanBone !== 'hips') continue;
    const sampler = clip.samplers[channel.sampler], interpolation = sampler.interpolation || 'LINEAR';
    if (!['LINEAR', 'STEP'].includes(interpolation)) throw Error('Cubic interpolation requires tangent retargeting');
    const times = source.accessor(sampler.input), values = source.accessor(sampler.output);
    if (channel.target.path === 'rotation') {
      const inverseRest = entry.restWorld.clone().invert(), q = new THREE.Quaternion(), previous = new THREE.Quaternion();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i).premultiply(entry.parentRestWorld).multiply(inverseRest).normalize();
        if (i && q.dot(previous) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        q.toArray(values, i); previous.copy(q);
        maxQuaternionNormError = Math.max(maxQuaternionNormError, Math.abs(q.length() - 1));
      }
    } else {
      // A translation track is in the source parent's local frame, not world Y.
      const parentWorld = entry.node.parent?.matrixWorld || new THREE.Matrix4(), v = new THREE.Vector3();
      for (let i = 0; i < values.length; i += 3) v.fromArray(values, i).applyMatrix4(parentWorld).toArray(values, i);
    }
    const samplerIndex = animation.samplers.push({ input: addAccessor(times, 'SCALAR'), output: addAccessor(values, channel.target.path === 'rotation' ? 'VEC4' : 'VEC3'), interpolation }) - 1;
    animation.channels.push({ sampler: samplerIndex, target: { node: index, path: channel.target.path } });
  }
  json.buffers[0].byteLength = byteLength;
  const rawJson = Buffer.from(JSON.stringify(json)), jsonPadding = (4 - rawJson.length % 4) % 4;
  const jsonBytes = Buffer.concat([rawJson, Buffer.alloc(jsonPadding, 0x20)]), bin = Buffer.concat(chunks);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonBytes.length + bin.length, 8); header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonBytes, binHeader, bin]), duration: Math.max(...animation.samplers.map(s => json.accessors[s.input].max[0])), channels: animation.channels.length, maxQuaternionNormError };
}
function repeatConverted(bytes, repeatCount) {
  const source = readGlb(bytes), json = structuredClone(source.json), animation = source.json.animations[0];
  const duration = Math.max(...animation.samplers.map(s => source.accessor(s.input).at(-1)));
  json.animations = [{ name: animation.name, channels: [], samplers: [] }]; json.accessors = []; json.bufferViews = []; json.buffers = [{ byteLength: 0 }];
  const chunks = []; let byteLength = 0, maxLoopSeamRadians = 0, maxLoopSeamPosition = 0;
  function add(values, type) {
    const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength), bufferView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length }); chunks.push(data); byteLength += data.length;
    const accessor = { bufferView, componentType: 5126, count: values.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4), type };
    if (type === 'SCALAR') { accessor.min = [values[0]]; accessor.max = [values.at(-1)]; }
    return json.accessors.push(accessor) - 1;
  }
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler], rotation = channel.target.path === 'rotation', width = rotation ? 4 : 3;
    const times = source.accessor(sampler.input), values = source.accessor(sampler.output), outTimes = [], outValues = [];
    if (rotation) maxLoopSeamRadians = Math.max(maxLoopSeamRadians, new THREE.Quaternion().fromArray(values).normalize().angleTo(new THREE.Quaternion().fromArray(values, values.length - width).normalize()));
    else maxLoopSeamPosition = Math.max(maxLoopSeamPosition, new THREE.Vector3().fromArray(values).distanceTo(new THREE.Vector3().fromArray(values, values.length - width)));
    for (let repeat = 0; repeat < repeatCount; repeat++) for (let key = repeat ? 1 : 0; key < times.length; key++) {
      outTimes.push(repeat * duration + times[key]);
      if (rotation) {
        const q = new THREE.Quaternion().fromArray(values, key * width).normalize();
        if (outValues.length && q.dot(new THREE.Quaternion().fromArray(outValues, outValues.length - width)) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        outValues.push(q.x, q.y, q.z, q.w);
      } else outValues.push(...values.slice(key * width, key * width + width));
    }
    const samplerIndex = json.animations[0].samplers.push({ input: add(Float32Array.from(outTimes), 'SCALAR'), output: add(Float32Array.from(outValues), rotation ? 'VEC4' : 'VEC3'), interpolation: sampler.interpolation || 'LINEAR' }) - 1;
    json.animations[0].channels.push({ sampler: samplerIndex, target: channel.target });
  }
  if (maxLoopSeamRadians > 1e-4 || maxLoopSeamPosition > 1e-4) throw Error('Authored loop endpoints are not closed; refusing a repeated hard seam');
  json.buffers[0].byteLength = byteLength;
  const rawJson = Buffer.from(JSON.stringify(json)), jsonBytes = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 0x20)]), bin = Buffer.concat(chunks);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonBytes.length + bin.length, 8); header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonBytes, binHeader, bin]), duration: duration * repeatCount, repetition: { repeatCount, sourceDuration: duration, maxLoopSeamRadians, maxLoopSeamPosition } };
}
fs.mkdirSync(output, { recursive: true });
const report = { generatedAt: new Date().toISOString(), license: 'CC0-1.0', retargetReference: 'pixiv/three-vrm@3caf7a21ee68f0d5dfa363ab3d577450bbf60136', rigMap, sources: [], clips: [] };
for (const pack of [1, 2]) {
  const dirname = pack === 1 ? 'quaternius-ual-standard/Universal Animation Library[Standard]' : 'quaternius-ual2-standard/Universal Animation Library 2[Standard]';
  const filename = path.join(sourceRoot, dirname, `Unreal-Godot/UAL${pack}_Standard.glb`);
  const license = fs.readFileSync(path.join(sourceRoot, dirname, 'License.txt'), 'utf8');
  if (!license.includes('CC0 1.0')) throw Error('Expected explicit archive CC0 license');
  const source = readGlb(filename), rig = calibratedRig(source);
  const calibrationResult = convert(source, rig, source.json.animations.find(a => a.name === 'A_TPose'));
  const calibrationAsset = readGlb(calibrationResult.bytes);
  let tPoseMaxRotationRadians = 0;
  for (const channel of calibrationAsset.json.animations[0].channels) if (channel.target.path === 'rotation') {
    const values = calibrationAsset.accessor(calibrationAsset.json.animations[0].samplers[channel.sampler].output);
    for (let i = 0; i < values.length; i += 4) tPoseMaxRotationRadians = Math.max(tPoseMaxRotationRadians, 2 * Math.acos(Math.min(1, Math.abs(values[i + 3]))));
  }
  if (tPoseMaxRotationRadians > 1e-4) throw Error('Canonical T-pose should have identity rotations');
  report.sources.push({ pack, url: `https://quaternius.itch.io/universal-animation-library${pack === 2 ? '-2' : ''}`, filename: path.basename(filename), sha256: sha(source.bytes), calibration: { ...rig.evidence, tPoseMaxRotationRadians } });
  for (const clipName of selected[pack]) {
    const clip = source.json.animations.find(a => a.name === clipName);
    if (!clip) throw Error(`Missing source clip ${clipName}`);
    let result = convert(source, rig, clip);
    if (clipName === 'Dance_Loop') result = { ...result, ...repeatConverted(result.bytes, 6) };
    const basename = `quaternius-${clipName.toLowerCase().replaceAll('_', '-')}.vrma`;
    const validation = await require('gltf-validator').validateBytes(new Uint8Array(result.bytes), { uri: basename, maxIssues: 30 });
    if (validation.issues.numErrors) throw Error(`${basename}: ${JSON.stringify(validation.issues.messages)}`);
    const loader = new GLTFLoader(); loader.register(parser => new VRMAnimationLoaderPlugin(parser));
    const arrayBuffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
    const loaded = await loader.parseAsync(arrayBuffer, '');
    const animation = loaded.userData.vrmAnimations?.[0];
    if (!animation || Math.abs(animation.duration - result.duration) > 1e-5 || Math.abs(animation.restHipsPosition.y - rig.hip.y) > 1e-5) throw Error(`VRMA loader mismatch: ${basename}`);
    let loadedNormError = 0, loadedValueError = 0;
    const exported = readGlb(result.bytes);
    for (const channel of exported.json.animations[0].channels) {
      const humanBone = exported.json.nodes[channel.target.node].name;
      const track = (channel.target.path === 'rotation' ? animation.humanoidTracks.rotation : animation.humanoidTracks.translation).get(humanBone);
      const sampler = exported.json.animations[0].samplers[channel.sampler];
      if (!track) throw Error(`Loader discarded ${humanBone} track`);
      for (const [actual, expected] of [[track.times, exported.accessor(sampler.input)], [track.values, exported.accessor(sampler.output)]]) {
        if (actual.length !== expected.length) throw Error('Loader changed the keyframe count');
        for (let i = 0; i < actual.length; i++) loadedValueError = Math.max(loadedValueError, Math.abs(actual[i] - expected[i]));
      }
    }
    if (loadedValueError > 1e-5) throw Error('Loader changed normalized animation values or time');
    for (const track of animation.humanoidTracks.rotation.values()) for (let i = 0; i < track.values.length; i += 4) {
      const norm = Math.hypot(...track.values.slice(i, i + 4));
      if (!Number.isFinite(norm)) throw Error('Non-finite loaded quaternion');
      loadedNormError = Math.max(loadedNormError, Math.abs(norm - 1));
    }
    if (loadedNormError > 1e-5) throw Error('Loaded quaternion not normalized');
    fs.writeFileSync(path.join(output, basename), result.bytes);
    report.clips.push({ pack, sourceClip: clipName, filename: basename, duration: result.duration, repetition: result.repetition, channels: result.channels, bytes: result.bytes.length, sha256: sha(result.bytes), validatorErrors: validation.issues.numErrors, validatorWarnings: validation.issues.numWarnings, rotationTracks: animation.humanoidTracks.rotation.size, hipsTracks: animation.humanoidTracks.translation.size, loadedQuaternionNormError: loadedNormError, loadedValuesAndTimesMaxError: loadedValueError });
  }
}
fs.writeFileSync(path.join(output, 'quaternius-provenance.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'quaternius-LICENSE.txt'), fs.readFileSync(path.join(sourceRoot, 'quaternius-ual-standard/Universal Animation Library[Standard]/License.txt')));
const upstreamMit = `Retarget formula derived from pixiv/three-vrm, commit 3caf7a21ee68f0d5dfa363ab3d577450bbf60136.\nhttps://github.com/pixiv/three-vrm\n\n` + fs.readFileSync(path.join(repo, 'node_modules/@pixiv/three-vrm/LICENSE'), 'utf8');
fs.writeFileSync(path.join(output, 'quaternius-retarget-NOTICE.txt'), upstreamMit);
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Converted ${report.clips.length} clips; gltf-validator and VRMA loader checks passed. Report: ${reportPath}`);
