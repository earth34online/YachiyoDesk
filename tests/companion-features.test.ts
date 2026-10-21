import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const {MotionLibrary,readGlb}=require('../electron/motion-library.cjs');
const {ConfigSnapshots}=require('../electron/config-snapshots.cjs');
const {DEFAULT_SETTINGS}=require('../electron/settings.cjs');
const {pmxTextures,rewritePmxTextures,safeRelative}=require('../electron/pmx-assets.cjs');
const {stageSource,validateRepairPlan,rewriteGlbJson,ImportWorkflow}=require('../electron/import-workflow.cjs');
const {CompanionHost}=require('../electron/companion-host.cjs');
const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function dir(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yachiyo-companion-'));directories.push(directory);return directory;}
function glb(json:object,bin=Buffer.alloc(0)){
 const text=Buffer.from(JSON.stringify(json));const padded=Buffer.alloc(Math.ceil(text.length/4)*4,0x20);text.copy(padded);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+padded.length+(bin.length?8+bin.length:0),8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const chunk=Buffer.alloc(8);chunk.writeUInt32LE(bin.length);chunk.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,padded,...(bin.length?[chunk,bin]:[])]);
}
function pmx(encoding:'utf8'|'utf16le'='utf8',weight=0){
 const int=(n:number)=>{const b=Buffer.alloc(4);b.writeInt32LE(n);return b;};
 const str=(s:string)=>{const b=Buffer.from(s,encoding);return Buffer.concat([int(b.length),b]);};
 const header=Buffer.alloc(17);header.write('PMX ');header.writeFloatLE(2.1,4);header[8]=8;header.set([encoding==='utf8'?1:0,0,1,1,1,1,1,1],9);
 const vertex=Buffer.alloc(32+1+[1,6,20,42,20][weight]+4);vertex[32]=weight;
 return Buffer.concat([header,str('角色'),str('model'),str('license'),str(''),int(1),vertex,int(3),Buffer.from([0,0,0]),int(2),str('missing.png'),str('textures/衣服.png'),Buffer.from('material-and-bone-tail')]);
}
function host(){
 const directory=dir(),window={webContents:{send:vi.fn()}},patch=vi.fn();
 return new CompanionHost({directory,electron:{safeStorage:{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()},dialog:{showMessageBox:vi.fn()},nativeImage:{}},
 window:()=>window,character:()=>({manifest:{id:'test',displayName:'角色'}}),characters:()=>[{id:'test'}],settings:()=>DEFAULT_SETTINGS,patch,command:vi.fn(),focus:vi.fn(),charactersRoot:()=>path.join(directory,'characters'),refreshCharacters:vi.fn()});
}

describe('independent PMX texture-table repair contract',()=>{
 it.each(['utf8','utf16le'] as const)('changes only string-table bytes in %s and preserves geometry, weights and trailing data',encoding=>{
  for(let weight=0;weight<5;weight++){const source=pmx(encoding,weight),before=pmxTextures(source),repaired=rewritePmxTextures(source,{0:'textures/衣服.png'}),after=pmxTextures(repaired);
   expect(after.textures).toEqual(['textures/衣服.png','textures/衣服.png']);expect(repaired.subarray(0,after.start)).toEqual(source.subarray(0,before.start));expect(repaired.subarray(after.end)).toEqual(source.subarray(before.end));}
 });
 it.each(['../outside.png','C:/secret.png','\\\\server\\a.png','a/../../b.png','a:stream','./a.png','a\u0000.png'])('rejects unsafe destination %s',value=>expect(()=>safeRelative(value)).toThrow());
 it('rejects truncation and unsupported weights without producing a replacement',()=>{expect(()=>pmxTextures(pmx().subarray(0,55))).toThrow();const b=pmx();b[17+4+Buffer.byteLength('角色')+4+5+4+7+4+4+32]=9;expect(()=>pmxTextures(b)).toThrow();});
 it('stages only model/images, preserves originals, and excludes executables and neighboring models',()=>{
  const source=dir(),target=dir();fs.writeFileSync(path.join(source,'avatar.pmx'),pmx());fs.writeFileSync(path.join(source,'image.png'),'image');fs.writeFileSync(path.join(source,'bad.exe'),'exe');fs.writeFileSync(path.join(source,'other.pmx'),pmx());
  const staged=stageSource(path.join(source,'avatar.pmx'),target);expect(staged.images).toEqual(['image.png']);expect(fs.readdirSync(target).sort()).toEqual(['avatar.pmx','image.png']);expect(fs.readFileSync(staged.source)).toEqual(fs.readFileSync(path.join(source,'avatar.pmx')));
 });
 it('rejects invented operations, missing inventory assets and unapproved generated replacements',()=>{
  const diagnosis={format:'pmx',textures:['missing.png'],images:['good.png']};
  const plan=(action:object)=>({summary:'missing reference',actions:[{reason:'same image',...action}],unresolved:[]});
  expect(validateRepairPlan(plan({type:'remap_texture',index:0,path:'good.png'}),diagnosis,false).actions).toHaveLength(1);
  for(const action of [{type:'shell',command:'delete'},{type:'remap_texture',index:0,path:'other.png'},{type:'generate_texture',index:0,prompt:'cloth'}])expect(()=>validateRepairPlan(plan(action),diagnosis,false)).toThrow();
  expect(()=>validateRepairPlan({...plan({}),unresolved:['missing mesh']},diagnosis,true)).toThrow('missing mesh');
 });
 it('preserves GLB binary chunk exactly when changing a humanoid mapping',()=>{
  const source=glb({asset:{version:'2.0'},nodes:[{name:'hip'}],extensions:{VRMC_vrm:{humanoid:{humanBones:{}}}}},Buffer.from([1,2,3,4]));
  const after=rewriteGlbJson(source,(json:any)=>json.extensions.VRMC_vrm.humanoid.humanBones.hips={node:0});
  expect(readGlb(after).extensions.VRMC_vrm.humanoid.humanBones.hips.node).toBe(0);expect(after.subarray(-12)).toEqual(source.subarray(-12));
 });
});
describe('motion library and snapshots',()=>{
 it('deduplicates owned playable VRMA copies and rejects external resources and fabricated extension declarations',async()=>{
  const root=dir(),library=new MotionLibrary(path.join(root,'library')),file=path.join(root,'wave.vrma');
  const json={asset:{version:'2.0'},nodes:[{}],animations:[{channels:[{}]}],extensions:{VRMC_vrm_animation:{humanoid:{humanBones:{hips:{node:0}}}}}};
  fs.writeFileSync(file,glb(json));await expect(library.import(file)).rejects.toThrow('VRMA');
  fs.copyFileSync(path.resolve('assets/motions/airi-idle.vrma'),file);const item=await library.import(file);expect((await library.import(file)).id).toBe(item.id);expect(library.list()).toHaveLength(1);
  fs.writeFileSync(file,glb({...json,buffers:[{uri:'https://example.com/file'}]}));await expect(library.import(file)).rejects.toThrow('外部');
  fs.writeFileSync(file,glb({asset:{version:'2.0'},extensionsUsed:['VRMC_vrm_animation']}));await expect(library.import(file)).rejects.toThrow('VRMA');
  expect(()=>library.file('../outside')).toThrow();library.remove(item.id);expect(library.list()).toEqual([]);expect(fs.existsSync(file)).toBe(true);
 });
 it('exports only sanitized settings and previews actual differences without mutating current settings',()=>{
  const root=dir(),snapshots=new ConfigSnapshots(root),current={...DEFAULT_SETTINGS,zoom:.5};const item=snapshots.capture({...current,zoom:.9,apiKey:'must-not-export'},'工作');
  const preview=snapshots.preview(item.id,current);expect(preview.changes).toEqual([{key:'zoom',before:.5,after:.9}]);expect(current.zoom).toBe(.5);expect(fs.readFileSync(snapshots.file(item.id),'utf8')).not.toContain('must-not-export');expect(snapshots.list()).toHaveLength(1);
  expect(()=>snapshots.read(path.join(root,'absent.json'))).toThrow('快照');
 });
});
describe('missing APIs and explicit import ownership',()=>{
 it('invalidates the previous import lifecycle on reload and rejects an already canceled preview before reading files',async()=>{
  const h=host(),old=h.imports.lifecycle.signal;h.imports.dispose();expect(old.aborted).toBe(true);expect(h.imports.lifecycle.signal.aborted).toBe(false);
  const controller=new AbortController();controller.abort();await expect(h.imports.stage('not-a-directory',{}, {},controller.signal)).rejects.toMatchObject({code:'IMPORT_CANCELED'});h.dispose();
 });
 it('does not revive microphone authorization after a late native dialog response',async()=>{
  const h=host();h.connections.save({capability:'transcription',endpoint:'http://127.0.0.1:9999/v1',model:'local'});
  let finish!:(value:{response:number})=>void;h.electron.dialog.showMessageBox.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const pending=h.request('microphone');await h.request('microphone.revoke');finish({response:0});
  expect(await pending).toBe(false);expect(h.microphoneUntil).toBe(0);h.dispose();
 });
 it.each(['chat','speech','transcribe','microphone','image.attach','image.sources','image.capture','image.generate','repair.plan'])('reports the missing capability before %s can perform work',async action=>{
  const h=host();await expect(h.request(action,{text:'hello',audio:{mime:'audio/webm',base64:'YQ=='},prompt:'garden'})).rejects.toMatchObject({code:'AI_CONNECTION_REQUIRED'});
  expect(h.electron.dialog.showMessageBox).not.toHaveBeenCalled();h.dispose();
 });
 it('refuses publishing a model before a successful renderer preview and keeps the source',async()=>{
  const h=host(),workflow=new ImportWorkflow(h),item=workflow.create();item.modelDirectory=path.join(item.directory,'character');fs.mkdirSync(item.modelDirectory);item.manifest={id:'candidate'};
  await expect(workflow.accept(item.token)).rejects.toThrow('真实模型预览');expect(fs.existsSync(item.modelDirectory)).toBe(true);workflow.discard(item.token);expect(fs.existsSync(item.directory)).toBe(false);
 });
 it('does not stage or call any API when the owner declines AI repair',async()=>{
  const h=host();h.electron.dialog.showMessageBox.mockResolvedValue({response:1});const result=await h.imports.offer('nonexistent.pmx',Error('broken'));
  expect(result.error).toContain('已停止导入');expect(h.imports.tickets.size).toBe(0);h.dispose();
 });
});
