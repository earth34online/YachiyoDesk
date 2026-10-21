'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { readJson, writeJson, isId } = require('./ai-store.cjs');

function readGlb(bytes) {
  if (bytes.length < 28 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('不是有效的 GLB 2.0 文件。');
  const length = bytes.readUInt32LE(12);
  if (length > 8 * 1024 * 1024 || length % 4 || 20 + length > bytes.length) throw new Error('GLB JSON 数据损坏。');
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8').trim());
  for (const item of [...(json.buffers || []), ...(json.images || [])]) {
    if (item.uri && !/^data:[\w/+.-]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(item.uri)) throw new Error('请使用资源全部嵌入的文件，不能引用外部文件或网络。');
  }
  return json;
}
class MotionLibrary {
  constructor(directory, bundledDirectory) { this.directory = directory; this.bundledDirectory = bundledDirectory; this.index = path.join(directory, 'library.json'); this.epoch = 0; this.workers = new Set(); }
  list() {
    const stored=readJson(this.index, { version: 1, items: [] });
    if(stored.version!==1 || !Array.isArray(stored.items))throw new Error('动作库索引无法识别，原文件已保留。');
    const items=stored.items.filter(item => isId(item.id) && !item.builtin && fs.existsSync(this.file(item.id)));
    if(this.bundledDirectory && fs.existsSync(this.file('builtin-airi-idle'))) items.unshift({id:'builtin-airi-idle',name:'AIRI 自然待机',builtin:true});
    return items;
  }
  file(id) { if (!isId(id)) throw new Error('动作标识无效。'); return path.join(id==='builtin-airi-idle' && this.bundledDirectory ? this.bundledDirectory : this.directory, `${id==='builtin-airi-idle' && this.bundledDirectory?'airi-idle':id}.vrma`); }
  async import(filename) {
    const epoch = this.epoch;
    if (fs.statSync(filename).size > 64 * 1024 * 1024) throw new Error('动作文件超过 64 MB。');
    const bytes = fs.readFileSync(filename), json = readGlb(bytes), extension = json.extensions?.VRMC_vrm_animation;
    if (json.meshes?.length || json.images?.length || json.textures?.length) throw new Error('动作文件应只包含动画和骨架，不能夹带模型或贴图。');
    if (!extension?.humanoid?.humanBones || !json.animations?.some(item => item.channels?.length)) throw new Error('文件中没有可播放的 VRMA 人形动作。');
    for (const bone of Object.values(extension.humanoid.humanBones)) {
      if (!Number.isInteger(bone.node) || !json.nodes?.[bone.node]) throw new Error('动作引用了不存在的骨骼节点。');
    }
    const humanNodes = new Set(Object.values(extension.humanoid.humanBones).map(bone => bone.node));
    if (!json.animations.some(animation => animation.channels?.some(channel => humanNodes.has(channel.target?.node)
      && ['rotation','translation'].includes(channel.target?.path)))) throw new Error('VRMA 没有可重定向的人形动画轨道。');
    const packaged = process.resourcesPath && path.join(process.resourcesPath,'gltf-validator','index.js');
    const validator = packaged && fs.existsSync(packaged) ? packaged : require.resolve('gltf-validator');
    const issues = await new Promise((resolve,reject) => {
      const worker = new Worker(path.join(__dirname,'asset-validation-worker.cjs'),{workerData:{bytes,validator}});
      this.workers.add(worker);
      const finish = () => { this.workers.delete(worker); void worker.terminate(); };
      worker.once('message', result => { finish(); result.ok ? resolve(result.issues) : reject(new Error(result.error)); });
      worker.once('error', error => { finish(); reject(error); });
      worker.once('exit', code => { this.workers.delete(worker); if(code) reject(new Error('动作检查已中止。')); });
    });
    if (epoch !== this.epoch) throw new Error('动作导入已取消。');
    if (issues.numErrors) throw new Error('VRMA 动画结构无效：'+issues.messages.filter(issue=>issue.severity===0).slice(0,3).map(issue=>issue.message).join('；'));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex'), items = this.list();
    const existing = items.find(item => item.sha256 === sha256); if (existing) return existing;
    const item = { id: crypto.randomUUID(), name: path.basename(filename, path.extname(filename)).slice(0, 100), sha256, importedAt: new Date().toISOString() };
    fs.mkdirSync(this.directory, { recursive: true }); fs.writeFileSync(this.file(item.id), bytes, { flag: 'wx' });
    try { writeJson(this.index, { version: 1, items: [...items.filter(item=>!item.builtin), item] }); }
    catch (error) { fs.rmSync(this.file(item.id), { force: true }); throw error; }
    return item;
  }
  dispose() { ++this.epoch; for (const worker of this.workers) void worker.terminate(); this.workers.clear(); }
  remove(id) { if(id==='builtin-airi-idle' && this.bundledDirectory)throw new Error('内置参考动作不能删除，可关闭自然待机。');const items = this.list().filter(item => item.id !== id); writeJson(this.index, { version: 1, items:items.filter(item=>!item.builtin) }); fs.rmSync(this.file(id), { force: true }); return items; }
}
module.exports = { MotionLibrary, readGlb };
