'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readGlb } = require('./motion-library.cjs');
const { pmxTextures, rewritePmxTextures, safeRelative } = require('./pmx-assets.cjs');
const { jsonRequest, generateImage } = require('./ai-transport.cjs');
const { REQUIRED_BONES, inspectVrmFile } = require('./vrm-file.cjs');
const { writeJson, isId } = require('./ai-store.cjs');
const { Worker } = require('node:worker_threads');
const { BONES, validateContactConfiguration, inspectContactConfiguration } = require('./contact-configuration.cjs');

function rewriteGlbJson(bytes, operation) {
  const json = readGlb(bytes), oldLength = bytes.readUInt32LE(12); operation(json);
  const source = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(source.length/4)*4, 0x20); source.copy(padded);
  const header = Buffer.from(bytes.subarray(0,20)), result = Buffer.concat([header,padded,bytes.subarray(20+oldLength)]);
  result.writeUInt32LE(result.length,8); result.writeUInt32LE(padded.length,12); return result;
}
function stageSource(source, target) {
  const sourceRoot = fs.realpathSync(path.dirname(source)), basename = path.basename(source), format = path.extname(source).toLowerCase();
  if (!['.pmx','.vrm'].includes(format) || fs.lstatSync(source).isSymbolicLink()) throw new Error('源模型格式不受支持。');
  fs.mkdirSync(target,{recursive:true}); let bytes = 0, count = 0; const images = [];
  const copy = (filename,relative) => {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    bytes += stat.size; count++; if (bytes > 768*1024*1024 || count > 2048) throw new Error('角色资源超过修复暂存上限（768 MB / 2048 文件），请先整理角色文件夹。');
    const destination = path.join(target,relative); fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.copyFileSync(filename,destination);
  };
  copy(source,basename);
  const walk = (directory,relative='',depth=0) => {
    if (depth > 8) throw new Error('角色资源目录层级过深。');
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory,entry.name),rel,depth+1);
      else if (/\.(png|jpe?g|webp|bmp|tga|dds|sph|spa)$/i.test(entry.name)) { safeRelative(rel); copy(path.join(directory,entry.name),rel); images.push(rel); }
    }
  };
  if (format === '.pmx') walk(sourceRoot);
  return { source: path.join(target,basename), images, bytes, count, format: format.slice(1) };
}
function diagnoseSource(source, images, error) {
  const bytes = fs.readFileSync(source), format = path.extname(source).slice(1).toLowerCase();
  const publicError = String(error).replace(/[A-Za-z]:[\\/][^\r\n"<>|]*/g,'[本机路径]').replace(/\\\\[^\s"<>]+/g,'[本机路径]');
  const diagnosis = { format, filename: path.basename(source), error: publicError.slice(0,1500), images };
  try {
    if (format === 'pmx') { const info = pmxTextures(bytes); diagnosis.textures = info.textures.map((reference,index) => ({index,reference:/^[a-z]:[\\/]|^\\\\/i.test(reference)?path.win32.basename(reference):reference.startsWith('/')?path.posix.basename(reference):reference})); diagnosis.vertices = info.vertices; }
    else {
      const json = readGlb(bytes), joints = new Set((json.skins || []).flatMap(skin => skin.joints || []));
      diagnosis.nodes = (json.nodes || []).map((node,index) => ({index,name:String(node.name || '').slice(0,100),children:node.children || [],joint:joints.has(index)}));
      diagnosis.humanoid = json.extensions?.VRMC_vrm?.humanoid || json.extensions?.VRM?.humanoid || null;
    }
  } catch (parseError) { diagnosis.parseError = parseError.message; }
  if (JSON.stringify(diagnosis).length > 128000) throw new Error('模型诊断超过 AI 发送上限，请整理角色资源或更换完整来源。');
  return diagnosis;
}
function validateRepairPlan(plan, diagnosis, generatedAllowed) {
  if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.actions) || plan.actions.length > 32 || !Array.isArray(plan.unresolved)) throw new Error('AI 没有返回有效修复方案。');
  if (plan.unresolved.length || !plan.actions.length) throw new Error(`需要补齐角色源文件：${plan.unresolved.map(String).join('；').slice(0,1500) || plan.summary.slice(0,1000)}`);
  const seen = new Set();
  for (const action of plan.actions) {
    if (typeof action.reason !== 'string' || action.reason.length > 1000) throw new Error('修复方案缺少具体依据。');
    if (diagnosis.format === 'pmx' && ['remap_texture','generate_texture'].includes(action.type)) {
      if (!Number.isInteger(action.index) || !diagnosis.textures?.[action.index] || seen.has(action.index)) throw new Error('修复贴图索引无效或重复。');
      seen.add(action.index);
      if (action.type === 'remap_texture' && !diagnosis.images.includes(safeRelative(action.path))) throw new Error('方案引用了暂存清单以外的图片。');
      if (action.type === 'generate_texture' && (!generatedAllowed || typeof action.prompt !== 'string' || !action.prompt.trim() || action.prompt.length > 2000)) throw new Error('尚未授权生成图片，或生成描述无效。');
    } else if (diagnosis.format === 'vrm' && action.type === 'map_humanoid_bone') {
      if (!REQUIRED_BONES.includes(action.bone) || !Number.isInteger(action.node) || !diagnosis.nodes?.[action.node]?.joint || seen.has(action.bone)) throw new Error('方案的人形骨骼映射无效。');
      seen.add(action.bone);
    } else throw new Error('方案包含不支持的操作，未修改模型。');
  }
  if(diagnosis.format==='vrm'){
    const source=diagnosis.humanoid?.humanBones;
    const bones=Array.isArray(source)?Object.fromEntries(source.map(item=>[item.bone,{node:item.node}])):{...source};
    for(const action of plan.actions)bones[action.bone]={node:action.node};
    const assigned=new Set();
    for(const bone of REQUIRED_BONES){const index=bones[bone]?.node;if(!Number.isInteger(index)||!diagnosis.nodes[index]||assigned.has(index))throw new Error('修复后仍有缺失或重复的人形骨骼映射。');assigned.add(index);}
    const descends=(parent,child)=>{const pending=[parent],seen=new Set();while(pending.length){const node=pending.pop();if(node===child)return true;if(seen.has(node))continue;seen.add(node);pending.push(...(diagnosis.nodes[node]?.children||[]));}return false;};
    const chains=[['hips','spine','head'],['spine','leftUpperArm','leftLowerArm','leftHand'],['spine','rightUpperArm','rightLowerArm','rightHand'],['hips','leftUpperLeg','leftLowerLeg','leftFoot'],['hips','rightUpperLeg','rightLowerLeg','rightFoot']];
    for(const chain of chains)for(let i=1;i<chain.length;i++)if(!descends(bones[chain[i-1]].node,bones[chain[i]].node))throw new Error('修复方案与现有骨架父子关系不符，未修改模型。');
  }
  return plan;
}
class ImportWorkflow {
  constructor(host) {
    this.host = host; this.tickets = new Map(); this.root = path.join(host.directory,'import-staging'); this.epoch=0;this.workers=new Set();this.lifecycle=new AbortController();
    for(const [directory,pattern,marker,owner] of [[this.root,/^[a-f0-9-]{36}$/,'stage.json','yachiyodesk-import'],[host.charactersRoot(),/^\.pending-[a-z0-9_-]+$/,'import-transaction.json','yachiyodesk-import']]){
      if(!fs.existsSync(directory))continue;
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        if(!entry.isDirectory()||entry.isSymbolicLink()||!pattern.test(entry.name))continue;
        const candidate=path.join(directory,entry.name);
        try {if(JSON.parse(fs.readFileSync(path.join(candidate,marker),'utf8')).owner===owner)fs.rmSync(candidate,{recursive:true,force:true});}catch{/* Unknown files are preserved. */}
      }
    }
  }
  ticket(token) { const item = this.tickets.get(token); if (!item) throw new Error('导入会话已结束，请重新选择角色。'); return item; }
  create() {
    if (this.tickets.size >= 4) throw new Error('请先关闭已有导入预览。');
    const token = crypto.randomUUID(), directory = path.join(this.root,token); fs.mkdirSync(directory,{recursive:true});
    writeJson(path.join(directory,'stage.json'),{owner:'yachiyodesk-import',version:1});
    const item = {token,directory,loaded:false,controller:new AbortController()}; this.tickets.set(token,item); return item;
  }
  discard(token) { const item = this.tickets.get(token); if (!item) return;
    if (path.dirname(item.directory) !== this.root || !isId(token)) throw new Error('暂存路径无效。');
    item.controller.abort();
    try{fs.rmSync(item.directory,{recursive:true,force:true,maxRetries:6,retryDelay:50});}
    catch{console.warn('导入暂存文件仍被释放中的进程占用，将在下次启动清理。');}
    finally{this.tickets.delete(token);}
  }
  async stage(directory, manifest, result, signal) {
    const canceled=()=>Object.assign(new Error('导入已取消。'),{code:'IMPORT_CANCELED'});
    if(signal?.aborted)throw canceled();
    inspectVrmFile(path.join(directory,'model.vrm'));
    const packagedValidator = process.resourcesPath && path.join(process.resourcesPath,'gltf-validator','index.js');
    const validator = packagedValidator && fs.existsSync(packagedValidator) ? packagedValidator : require.resolve('gltf-validator');
    const epoch=this.epoch;
    const issues=await new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'asset-validation-worker.cjs'),{workerData:{filename:path.join(directory,'model.vrm'),validator}});this.workers.add(worker);
      const finish=()=>{signal?.removeEventListener('abort',abort);this.workers.delete(worker);void worker.terminate();};
      const abort=()=>{finish();reject(canceled());};
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      worker.once('message',result=>{finish();result.ok?resolve(result.issues):reject(new Error(result.error));});
      worker.once('error',error=>{finish();reject(error);});
      worker.once('exit',code=>{signal?.removeEventListener('abort',abort);this.workers.delete(worker);if(code)reject(new Error('模型检查被中止。'));});
    });
    if(epoch!==this.epoch||signal?.aborted)throw canceled();
    if (issues.numErrors) throw new Error(`模型结构检查未通过：${issues.messages.filter(item=>item.severity===0).slice(0,5).map(item=>item.message).join('；')}`);
    const contact = inspectContactConfiguration(path.join(directory,'model.vrm'),fs.existsSync(path.join(directory,'physics.pmx')));
    if(contact.status==='automatic')manifest.contactConfiguration={mode:'automatic'};
    manifest.contactInspection=contact;
    writeJson(path.join(directory,'character.json'),manifest);
    const item = this.create();
    try {
      item.modelDirectory = path.join(item.directory,'character'); fs.renameSync(directory,item.modelDirectory); item.manifest = manifest; item.result = result;
      return {canceled:false, preview:{token:item.token, manifest, modelUrl:`appasset://import-preview/${item.token}/model.vrm`,
        pmxPhysicsUrl: fs.existsSync(path.join(item.modelDirectory,'physics.pmx')) ? `appasset://import-preview/${item.token}/physics.pmx` : undefined,
        warnings: [...(result.warnings || []),contact.message], quality:{errors:issues.numErrors,warnings:issues.numWarnings}}};
    } catch (error) { this.discard(item.token); throw error; }
  }
  asset(url) {
    const parsed = new URL(url), parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'import-preview' || parts.length !== 2 || !['model.vrm','physics.pmx'].includes(parts[1])) throw new Error('预览资源无效。');
    return path.join(this.ticket(parts[0]).modelDirectory,parts[1]);
  }
  async contactPlan(token, diagnosis, consent) {
    const item=this.ticket(token);
    if(consent!==true || item.manifest?.contactInspection?.status!=='automatic')throw new Error('请先确认发送碰撞诊断；已有配置不进入自动重写。');
    if(diagnosis?.status!=='generated'||!Number.isInteger(diagnosis.bodyMesh)||!Array.isArray(diagnosis.colliders)||diagnosis.colliders.length>BONES.length)throw new Error('当前模型尚无可验证的身体碰撞预览，请使用完整物理来源。');
    const colliders=diagnosis.colliders.map(({bone,radius})=>{
      if(!BONES.includes(bone)||!Number.isFinite(radius)||radius<=0||radius>10)throw new Error('碰撞诊断无效。');
      return {bone,radius};
    });
    const publicDiagnosis={bodyMesh:diagnosis.bodyMesh,colliders};
    this.cancelContactPlan(token);
    const revision=item.contactRevision;item.contactController=new AbortController();
    const connection=this.host.connections.get('chat');
    const response=await jsonRequest(connection,'/chat/completions',{model:connection.model,stream:false,messages:[
      {role:'system',content:'你配置用户桌面角色的身体内接碰撞。只返回 JSON {summary:string,configuration:{mode:"automatic",bodyMesh:number,radiusScale?:{骨骼名:number},disabledBones?:string[]}}。只能使用诊断中的 bodyMesh 和骨骼；radiusScale 只能 0.25 到 1，表示相对实测身体内接半径。禁止扩大身体、添加骨骼、变形网格、命令、路径或代码。不确定则保持原配置。需要用户在真实预览确认。'},
      {role:'user',content:JSON.stringify(publicDiagnosis)},
    ]},{signal:AbortSignal.any([item.controller.signal,item.contactController.signal])});
    item.controller.signal.throwIfAborted();if(this.tickets.get(token)!==item||revision!==item.contactRevision)throw new Error('配置已取消或已被更新。');
    const text=response.choices?.[0]?.message?.content;
    if(typeof text!=='string'||text.length>16000)throw new Error('碰撞方案为空或过长。');
    const plan=JSON.parse(text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
    if(typeof plan.summary!=='string'||plan.summary.length>1000||Object.keys(plan).some(key=>!['summary','configuration'].includes(key)))throw new Error('碰撞方案格式无效。');
    const configuration=validateContactConfiguration(plan.configuration);
    if(configuration.bodyMesh!==diagnosis.bodyMesh||Object.keys(configuration.radiusScale||{}).some(bone=>!colliders.some(c=>c.bone===bone))||(configuration.disabledBones||[]).some(bone=>!colliders.some(c=>c.bone===bone)))throw new Error('方案引用了预览以外的网格或碰撞。');
    item.contactPlan={summary:plan.summary,configuration};return item.contactPlan;
  }
  cancelContactPlan(token) {
    const item=this.ticket(token);item.contactRevision=(item.contactRevision||0)+1;
    item.contactController?.abort();item.contactController=null;item.contactPlan=null;
  }
  applyContactPlan(token) {
    const item=this.ticket(token);if(!item.contactPlan)throw new Error('请先生成并确认碰撞方案。');
    item.manifest.contactConfiguration=validateContactConfiguration(item.contactPlan.configuration);
    writeJson(path.join(item.modelDirectory,'character.json'),item.manifest);
    item.loaded=false;item.contactPlan=null;
    return item.manifest;
  }
  async offer(source,error) {
    const epoch = this.epoch;
    const choice = await this.host.electron.dialog.showMessageBox(this.host.window(),{type:'question',title:'角色导入失败',message:'要用你自己的 AI 尝试修复吗？',detail:`${String(error?.message||error).slice(0,1000)}\n\nAI 使用你在本机配置的接口；先展示发送内容，再由你确认。原文件不会覆盖。不修复则停止导入，请更换完整角色源文件。`,buttons:['尝试 AI 修复','不导入'],defaultId:1,cancelId:1});
    if (epoch !== this.epoch) return {canceled:true};
    if (choice.response !== 0) return {canceled:false,error:'已停止导入，请更换完整角色源文件。'};
    const item = this.create();
    try {
      const staged = stageSource(source,path.join(item.directory,'source')); Object.assign(item,staged);
      item.diagnosis = diagnoseSource(item.source,item.images,error?.message||error);
      return {canceled:false,repair:{token:item.token,diagnosis:item.diagnosis}};
    } catch (failure) { this.discard(item.token); throw failure; }
  }
  async plan(token, generatedAllowed) {
    const item = this.ticket(token);
    if (!item.diagnosis) throw new Error('没有待修复的诊断。');
    const skillDirectory = path.join(__dirname,'..','skills','avatar-import-repair');
    const instructions = fs.readFileSync(path.join(skillDirectory,'SKILL.md'),'utf8')+'\n'+fs.readFileSync(path.join(skillDirectory,'references','repair-contract.md'),'utf8');
    const connection = this.host.connections.get('chat');
    const result = await jsonRequest(connection,'/chat/completions',{model:connection.model,stream:false,
      messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({diagnosis:item.diagnosis,generatedAllowed:Boolean(generatedAllowed)})}]},{signal:item.controller.signal});
    item.controller.signal.throwIfAborted();
    if(this.tickets.get(token)!==item)throw new Error('修复已取消。');
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length > 64000) throw new Error('AI 修复方案为空或过长。');
    const plan = validateRepairPlan(JSON.parse(text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')),item.diagnosis,generatedAllowed);
    item.plan = plan; item.generatedAllowed = generatedAllowed; return plan;
  }
  async apply(token, generatedAllowed = false) {
    const item = this.ticket(token), plan = validateRepairPlan(item.plan,item.diagnosis,item.generatedAllowed && generatedAllowed);
    const bytes = fs.readFileSync(item.source), replacements = {}, generated = [];
    for (const action of plan.actions) {
      if (action.type === 'remap_texture') replacements[action.index] = action.path;
      else if (action.type === 'generate_texture') {
        const image = this.host.image(await generateImage(this.host.connections.get('image'),action.prompt,{signal:item.controller.signal}));
        item.controller.signal.throwIfAborted();
        const filename = `ai-generated/texture-${action.index}.png`; fs.mkdirSync(path.join(path.dirname(item.source),'ai-generated'),{recursive:true});
        fs.writeFileSync(path.join(path.dirname(item.source),filename),Buffer.from(image.base64,'base64')); replacements[action.index] = filename; generated.push(filename);
      }
    }
    const repaired = item.format === 'pmx' ? rewritePmxTextures(bytes,replacements) : rewriteGlbJson(bytes,json=>{
      const vrm1 = json.extensions?.VRMC_vrm;
      for (const action of plan.actions) {
        if (vrm1) { vrm1.humanoid ||= {}; vrm1.humanoid.humanBones ||= {}; vrm1.humanoid.humanBones[action.bone] = {node:action.node}; }
        else if (json.extensions?.VRM) {
          const extension = json.extensions.VRM; extension.humanoid ||= {}; extension.humanoid.humanBones ||= [];
          extension.humanoid.humanBones = extension.humanoid.humanBones.filter(bone=>bone.bone!==action.bone);
          extension.humanoid.humanBones.push({bone:action.bone,node:action.node,useDefaultValues:true});
        } else throw new Error('缺少真实 VRM 扩展，不能虚构模型。');
      }
    });
    fs.writeFileSync(item.source,repaired);
    try {
      const result = await this.host.importSource(item.source,item.format,false,item.controller.signal);
      if(item.controller.signal.aborted){if(result.preview)this.discard(result.preview.token);throw new Error('修复已取消。');}
      if (!result.preview) throw new Error('修复副本没有通过重新导入检查。');
      const preview = this.ticket(result.preview.token);
      preview.manifest.aiRepair = {generated,operations:plan.actions.map(({type,index,path:filename,bone,node})=>({type,index,path:filename,bone,node})), repairedAt:new Date().toISOString()};
      writeJson(path.join(preview.modelDirectory,'character.json'),preview.manifest);
      return result;
    } finally { this.discard(token); }
  }
  async accept(token) {
    const item = this.ticket(token);
    if (!item.loaded || !item.manifest || !item.modelDirectory) throw new Error('请先等待真实模型预览加载完成。');
    inspectVrmFile(path.join(item.modelDirectory,'model.vrm'));
    if(!isId(item.manifest.id))throw new Error('角色标识无效。');
    const destination = path.join(this.host.charactersRoot(),item.manifest.id);
    if (fs.existsSync(destination)) throw new Error('角色目录已存在，请重新导入。');
    fs.rmSync(path.join(item.modelDirectory,'import-transaction.json'),{force:true});
    fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.renameSync(item.modelDirectory,destination);
    this.discard(token); this.host.refreshCharacters();
    return {...item.result,canceled:false,character:this.host.characters().find(character=>character.id===item.manifest.id)};
  }
  dispose() {this.epoch++;this.lifecycle.abort();this.lifecycle=new AbortController();for(const worker of this.workers)void worker.terminate();this.workers.clear(); for (const token of [...this.tickets.keys()]) this.discard(token); }
}
module.exports = { ImportWorkflow, stageSource, diagnoseSource, validateRepairPlan, rewriteGlbJson };
