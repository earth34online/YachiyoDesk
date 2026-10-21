import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
const {AiConnections,CompanionData}=require('../electron/ai-store.cjs');
const {chatCompletion}=require('../electron/ai-transport.cjs');
const {AiService}=require('../electron/ai-service.cjs');
const {ConfigSnapshots}=require('../electron/config-snapshots.cjs');
const {ImportWorkflow}=require('../electron/import-workflow.cjs');
const {resolvePmxPhysicsAsset}=require('../electron/pmx-physics-assets.cjs');
const directories:string[]=[];
const directory=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'yachiyo-regression-'));directories.push(p);return p;};
afterEach(()=>{for(const p of directories.splice(0))fs.rmSync(p,{recursive:true,force:true});});
const deferred=()=>{let resolve!:(v?:unknown)=>void;return {promise:new Promise(r=>{resolve=r;}),resolve:(v?:unknown)=>resolve(v)};};

describe('independent lifecycle and data contracts',()=>{
  it('rejects a truncated stream while accepting either standard completion signal',async()=>{
    const connection={endpoint:'http://localhost/v1',model:'test'};
    const chunk='data: '+JSON.stringify({choices:[{index:0,delta:{content:'半句'}}]})+'\n\n';
    for(const suffix of ['', 'data: [DONE]\n\n', 'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n']){
      const options={fetcher:async()=>new Response(chunk+suffix,{headers:{'content-type':'text/event-stream'}})};
      if(!suffix)await expect(chatCompletion(connection,[],options)).rejects.toThrow('中断');
      else expect((await chatCompletion(connection,[],options)).content).toBe('半句');
    }
  });
  it('checks current memory permission again when a delayed tool arrives',async()=>{
    const data=new CompanionData(directory()),arrived=deferred(),release=deferred();data.preferences('test',{autoRemember:true});let count=0;
    const service=new AiService({data,connections:{get:()=>({endpoint:'http://localhost/v1',model:'test'})},emit:vi.fn(),character:()=>({id:'test',displayName:'Test'}),react:vi.fn(),focus:vi.fn(),
      fetcher:async()=>{if(count++===0){arrived.resolve();await release.promise;return Response.json({choices:[{message:{tool_calls:[{id:'memory',function:{name:'remember',arguments:'{"text":"late"}'}}]}}]});}return Response.json({choices:[{message:{content:'完成'}}]});}});
    service.start({text:'hello'});const done=service.active.get('test').completion;await arrived.promise;data.preferences('test',{autoRemember:false});release.resolve();await done;
    expect(data.get('test').memories).toEqual([]);expect(data.get('test').turns[0].status).toBe('complete');
  });
  it('keeps a corrupt optional AI vault intact at startup and backs it up before an explicit save',()=>{
    const dir=directory(),file=path.join(dir,'connections.json');fs.writeFileSync(file,'{broken');
    const vault=new AiConnections(dir,null,{recover:true});expect(vault.describe().every((v:any)=>!v.configured&&v.error)).toBe(true);
    expect(fs.readFileSync(file,'utf8')).toBe('{broken');expect(()=>vault.get('chat')).toThrow('原文件已保留');
    vault.save({capability:'chat',endpoint:'http://localhost/v1',model:'test'});
    expect(vault.get('chat').model).toBe('test');const backup=fs.readdirSync(dir).find(name=>name.endsWith('.bak'))!;expect(fs.readFileSync(path.join(dir,backup),'utf8')).toBe('{broken');
  });
  it('skips malformed snapshot metadata without hiding valid snapshots or deleting files',()=>{
    const dir=directory(),snapshots=new ConfigSnapshots(dir),valid=snapshots.capture({},'Valid');
    for(const id of ['bad1','bad2'])fs.writeFileSync(snapshots.file(id),JSON.stringify({format:valid.format,version:1,id,label:'bad',settings:{}}));
    expect(snapshots.list().map((v:any)=>v.id)).toEqual([valid.id]);expect(fs.readdirSync(dir)).toHaveLength(3);
  });
  it('does not create a repair ticket after disposal while native confirmation is pending',async()=>{
    const dir=directory(),choice=deferred(),workflow=new ImportWorkflow({directory:dir,charactersRoot:()=>path.join(dir,'characters'),window:()=>null,electron:{dialog:{showMessageBox:()=>choice.promise}}});
    const pending=workflow.offer(path.join(dir,'not-read.vrm'),Error('bad'));workflow.dispose();choice.resolve({response:0});
    expect(await pending).toEqual({canceled:true});expect(workflow.tickets.size).toBe(0);
  });
  it('refuses unproven PMX physics even when a physics file exists',()=>{
    const dir=directory();fs.writeFileSync(path.join(dir,'physics.pmx'),'unproven');const result=resolvePmxPhysicsAsset(dir,{motionProfile:{profileId:'generic-vrm',capabilities:['pmx-converted']}});
    expect(result.filename).toBeUndefined();expect(result.error).toContain('指纹');
  });
});
