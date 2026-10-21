import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require=createRequire(import.meta.url);
const {AiConnections,CompanionData,endpointUrl}=require('../electron/ai-store.cjs');
const {chatCompletion,jsonRequest,generateImage}=require('../electron/ai-transport.cjs');
const {AiService}=require('../electron/ai-service.cjs');
const directories:string[]=[],servers:http.Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yachiyo-ai-'));directories.push(directory);
 const secure={isEncryptionAvailable:()=>true,encryptString:vi.fn((s:string)=>Buffer.from([...s].reverse().join(''))),decryptString:(b:Buffer)=>[...b.toString()].reverse().join('')};
 return{directory,secure,vault:new AiConnections(directory,secure),data:new CompanionData(path.join(directory,'sessions'))};}
async function server(handler:http.RequestListener){const s=http.createServer(handler);servers.push(s);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return{endpoint:`http://127.0.0.1:${(s.address() as any).port}/v1`,model:'local-model',apiKey:'private-key'};}

describe('local AI ownership',()=>{
 it('keeps encrypted credentials out of public settings and preserves them on model-only edits',()=>{const f=fixture();f.vault.save({capability:'chat',endpoint:'https://provider.example/v1',model:'model',apiKey:'secret-value'});
 expect(fs.readFileSync(path.join(f.directory,'connections.json'),'utf8')).not.toContain('secret-value');expect(JSON.stringify(f.vault.describe())).not.toContain('secret-value');
 f.vault.save({capability:'chat',endpoint:'https://provider.example/v1',model:'other'});expect(f.vault.get('chat').apiKey).toBe('secret-value');
 f.vault.save({capability:'chat',endpoint:'https://provider.example/v1',model:'other',clearKey:true});expect(f.vault.get('chat').apiKey).toBe('');});
 it('never falls back to plaintext when OS encryption is unavailable',()=>{const f=fixture();f.secure.isEncryptionAvailable=()=>false;
 expect(()=>f.vault.save({capability:'chat',endpoint:'https://example.com/v1',model:'m',apiKey:'secret'})).toThrow('加密');expect(fs.existsSync(path.join(f.directory,'connections.json'))).toBe(false);});
 it('never transfers a saved credential to a changed endpoint implicitly',()=>{const f=fixture();f.vault.save({capability:'chat',endpoint:'https://first.example/v1',model:'m',apiKey:'secret'});
 expect(()=>f.vault.save({capability:'chat',endpoint:'https://other.example/v1',model:'m'})).toThrow('地址已改变');expect(f.vault.get('chat').endpoint).toBe('https://first.example/v1');});
 it('accepts local model endpoints but rejects credentials in URLs and remote cleartext',()=>{expect(endpointUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
 for(const s of ['file:///C:/secret','https://key:secret@example.com/v1','https://example.com/v1?key=secret','http://example.com/v1'])expect(()=>endpointUrl(s)).toThrow();});
 it('keeps each capability and each character independent',()=>{const f=fixture();f.vault.save({capability:'chat',endpoint:'https://example.com/v1',model:'m'});expect(()=>f.vault.get('image')).toThrow('图像');
 f.data.remember('alpha','喜欢安静');expect(f.data.get('beta').memories).toEqual([]);expect(()=>f.data.get('../outside')).toThrow();});
 it('does not revive a cleared conversation with a late reply',()=>{const f=fixture();const s=f.data.begin('alpha','request','hello');f.data.clear('alpha');f.data.finish('alpha','request',s.generation,'late','complete');expect(f.data.get('alpha').turns).toEqual([]);});
 it('retains corrupt source data instead of silently replacing it',()=>{const f=fixture();fs.writeFileSync(path.join(f.directory,'connections.json'),'{broken');expect(()=>new AiConnections(f.directory,f.secure)).toThrow('原文件');expect(fs.readFileSync(path.join(f.directory,'connections.json'),'utf8')).toBe('{broken');});
});

describe('real HTTP streaming and cancellation',()=>{
 it('never executes a late character action after switching characters',async()=>{
  const f=fixture();let current='alpha',calls=0;const react=vi.fn();
  const c=await server((_req,res)=>{current='beta';res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:++calls===1?{tool_calls:[{id:'t',type:'function',function:{name:'react',arguments:'{"action":"joy"}'}}]}:{content:'已切换'}}]}));});
  f.vault.save({capability:'chat',...c});const service=new AiService({connections:f.vault,data:f.data,emit:vi.fn(),character:()=>({id:current,displayName:'角色'}),react,focus:vi.fn()});
  service.start({text:'你好'});await service.active.get('alpha').completion;expect(react).not.toHaveBeenCalled();expect(f.data.get('beta').turns).toEqual([]);expect(service.active.size).toBe(0);
 });
 it('offers named local motions and validates their ownership again before execution',async()=>{
  const f=fixture(),play=vi.fn();let calls=0,description='';
  const c=await server(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;description=JSON.parse(raw).tools?.find((item:any)=>item.function.name==='play_motion')?.function.description||description;
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:++calls===1?{tool_calls:[{id:'motion',type:'function',function:{name:'play_motion',arguments:'{"id":"local-wave"}'}}]}:{content:'向你招手'}}]}));});
  f.vault.save({capability:'chat',...c});const service=new AiService({connections:f.vault,data:f.data,emit:vi.fn(),character:()=>({id:'alpha',displayName:'角色'}),react:vi.fn(),focus:vi.fn(),motions:{list:()=>[{id:'local-wave',name:'轻轻招手'}],play}});
  service.start({text:'播放招手'});await service.active.get('alpha').completion;expect(description).toContain('轻轻招手');expect(play).toHaveBeenCalledWith('local-wave');
 });
 it('releases an image job when canceled, so the next request can run',async()=>{
  const f=fixture();let accepted!:()=>void;const arrived=new Promise<void>(resolve=>{accepted=resolve;});
  const c=await server((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');accepted();});
  f.vault.save({capability:'image',...c});const service=new AiService({connections:f.vault,data:f.data,emit:vi.fn(),character:()=>({id:'alpha'}),react:vi.fn(),focus:vi.fn()});
  const request=service.mediaRequest('image','garden','owned-image');const rejected=expect(request).rejects.toThrow();await arrived;service.cancel('owned-image');await rejected;expect(service.media.size).toBe(0);
 });
 it('accepts a local image result URL without forwarding the configured secret',async()=>{
  let auth:string|undefined;const c=await server((req,res)=>{if(req.url==='/result.png'){auth=req.headers.authorization;res.setHeader('Content-Type','image/png');res.end(Buffer.from('PNG-test'));return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{url:c.endpoint.replace('/v1','/result.png')}]}));});
  expect((await generateImage(c,'garden')).toString()).toBe('PNG-test');expect(auth).toBeUndefined();
 });
 it('reassembles split UTF-8, CRLF frames and tool arguments',async()=>{const received:any[]=[];const c=await server(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push({body:JSON.parse(raw),auth:req.headers.authorization,url:req.url});
 res.setHeader('Content-Type','text/event-stream');const frames=[{choices:[{delta:{content:'你好'}}]},{choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'react',arguments:'{"act'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'ion":"joy"}'}}]}}]}];
 const bytes=Buffer.from(frames.map(x=>'data: '+JSON.stringify(x)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');for(let i=0;i<bytes.length;i+=2)res.write(bytes.subarray(i,i+2));res.end();});
 const chunks:string[]=[];const result=await chatCompletion(c,[{role:'user',content:'hello'}],{onText:(s:string)=>chunks.push(s)});
 expect(chunks.join('')).toBe('你好');expect(JSON.parse(result.tool_calls[0].function.arguments)).toEqual({action:'joy'});expect(received[0].auth).toBe('Bearer private-key');expect(received[0].url).toBe('/v1/chat/completions');});
 it('supports compatible endpoints returning nonstream JSON',async()=>{const c=await server((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'reply'}}]}));});expect((await chatCompletion(c,[])).content).toBe('reply');});
 it('finishes at the SSE terminal marker even if the server keeps the socket open',async()=>{const c=await server((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n');});expect((await chatCompletion(c,[])).content).toBe('done');});
 it('does not expose provider error bodies or follow credential-bearing redirects',async()=>{const c=await server((_req,res)=>{res.writeHead(401);res.end('private-key user prompt');});await expect(jsonRequest(c,'/chat/completions',{})).rejects.toThrow('认证');
 const redirected=await server((_req,res)=>{res.writeHead(302,{Location:c.endpoint});res.end();});await expect(jsonRequest(redirected,'/chat/completions',{})).rejects.toThrow();});
 it('cancels an active stream without leaving a pending read',async()=>{const c=await server((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');});const controller=new AbortController();
 await expect(chatCompletion(c,[],{signal:controller.signal,onText:()=>controller.abort()})).rejects.toThrow();});
 it('executes only declared character tools and keeps the captured model for the whole reply',async()=>{const f=fixture();let calls=0;const requestModels:string[]=[];const c=await server(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requestModels.push(JSON.parse(raw).model);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:++calls===1?{tool_calls:[{id:'t1',type:'function',function:{name:'react',arguments:'{"action":"joy"}'}}]}:{content:'很高兴见到你'}}]}));});
 f.vault.save({capability:'chat',...c});const events:any[]=[],react=vi.fn();const service=new AiService({connections:f.vault,data:f.data,emit:(e:any)=>events.push(e),character:()=>({id:'alpha',displayName:'角色'}),react,focus:vi.fn()});
 service.start({text:'你好'});await service.active.get('alpha').completion;expect(react).toHaveBeenCalledWith('joy');expect(events.at(-1).type).toBe('done');expect(f.data.get('alpha').turns[0].assistant).toBe('很高兴见到你');expect(requestModels).toEqual(['local-model','local-model']);expect(service.active.size).toBe(0);});
});
