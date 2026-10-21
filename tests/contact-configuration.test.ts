import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {inspectContactConfiguration,validateContactConfiguration}=require('../electron/contact-configuration.cjs');
const {ImportWorkflow}=require('../electron/import-workflow.cjs');
const directories:string[]=[];
const dir=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'yachiyo-contact-'));directories.push(p);return p;};
afterEach(()=>{vi.unstubAllGlobals();for(const p of directories.splice(0))fs.rmSync(p,{recursive:true,force:true});});
function glb(json:object){const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(padded);const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+padded.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);return Buffer.concat([header,padded]);}
describe('import contact configuration contract',()=>{
  it('distinguishes original PMX, authored VRM 0/1, missing colliders and missing spring rigs without writing the source',()=>{
    const root=dir(),file=path.join(root,'model.vrm');
    for(const [extension,status]of [
      [{VRMC_springBone:{colliders:[{}],springs:[{joints:[{},{}]}]}},'authored'],
      [{VRM:{secondaryAnimation:{colliderGroups:[{colliders:[{}]}],boneGroups:[]}}},'authored'],
      [{VRMC_springBone:{springs:[{joints:[{},{}]}]}},'automatic'],[{},'no-springs'],
    ] as const){const bytes=glb({asset:{version:'2.0'},extensions:extension});fs.writeFileSync(file,bytes);expect(inspectContactConfiguration(file).status).toBe(status);expect(inspectContactConfiguration(file,true).status).toBe('native');expect(fs.readFileSync(file)).toEqual(bytes);}
  });
  it.each([{mode:'automatic',path:'C:/outside'}, {mode:'automatic',radiusScale:{head:1}}, {mode:'automatic',radiusScale:{hips:NaN}}, {mode:'automatic',radiusScale:{hips:1.01}}, {mode:'automatic',radiusScale:{hips:.24}}, {mode:'automatic',bodyMesh:-1}, {mode:'automatic',disabledBones:['hips','hips']}])('rejects unsafe or unbounded configuration %j',config=>expect(()=>validateContactConfiguration(config)).toThrow());
  it('requires consent, validates API output, and forces a fresh loaded preview before accepting a changed plan',async()=>{
    const root=dir(),workflow=new ImportWorkflow({directory:root,charactersRoot:()=>path.join(root,'characters'),connections:{get:()=>({endpoint:'http://localhost/v1',model:'own-model'})}}),item=workflow.create();
    item.modelDirectory=path.join(item.directory,'character');fs.mkdirSync(item.modelDirectory);item.manifest={id:'test',contactInspection:{status:'automatic'}};item.loaded=true;
    const diagnosis={status:'generated',bodyMesh:0,colliders:[{bone:'leftUpperArm',radius:.035}]};
    const fetcher=vi.fn(async(_url:string,options:any)=>{const request=JSON.parse(options.body),sent=JSON.parse(request.messages[1].content);expect(sent).toEqual({bodyMesh:0,colliders:diagnosis.colliders});return Response.json({choices:[{message:{content:JSON.stringify({summary:'减小袖口接触范围，重新预览',configuration:{mode:'automatic',bodyMesh:0,radiusScale:{leftUpperArm:.8}}})}}]});});vi.stubGlobal('fetch',fetcher);
    await expect(workflow.contactPlan(item.token,diagnosis,false)).rejects.toThrow('确认发送');expect(fetcher).not.toHaveBeenCalled();
    await workflow.contactPlan(item.token,diagnosis,true);const manifest=workflow.applyContactPlan(item.token);expect(manifest.contactConfiguration.radiusScale.leftUpperArm).toBe(.8);expect(item.loaded).toBe(false);await expect(workflow.accept(item.token)).rejects.toThrow('真实模型预览');
    vi.stubGlobal('fetch',async()=>Response.json({choices:[{message:{content:JSON.stringify({summary:'invalid',configuration:{mode:'automatic',bodyMesh:4}})}}]}));
    await expect(workflow.contactPlan(item.token,diagnosis,true)).rejects.toThrow('预览以外');expect(()=>workflow.applyContactPlan(item.token)).toThrow('先生成');workflow.dispose();
  });
  it('cancels an in-flight configuration without discarding the original preview',async()=>{
    const root=dir(),workflow=new ImportWorkflow({directory:root,charactersRoot:()=>path.join(root,'characters'),connections:{get:()=>({endpoint:'http://localhost/v1',model:'own-model'})}}),item=workflow.create();item.manifest={contactInspection:{status:'automatic'}};
    let sent!:()=>void;const arrived=new Promise<void>(r=>{sent=r;});vi.stubGlobal('fetch',(_url:string,{signal}:any)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')));sent();}));
    const pending=workflow.contactPlan(item.token,{status:'generated',bodyMesh:0,colliders:[]},true);const rejection=expect(pending).rejects.toThrow('aborted');await arrived;workflow.cancelContactPlan(item.token);await rejection;expect(workflow.ticket(item.token)).toBe(item);expect(item.controller.signal.aborted).toBe(false);expect(()=>workflow.applyContactPlan(item.token)).toThrow('先生成');workflow.dispose();
  });
});
