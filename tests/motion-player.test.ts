import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { MotionPlayer } from '../src/MotionPlayer';
const {REQUIRED_BONES}=require('../electron/vrm-file.cjs');
function glb(json:object,bin?:Float32Array):ArrayBuffer{
 const source=Buffer.from(JSON.stringify(json)),text=Buffer.alloc(Math.ceil(source.length/4)*4,32);source.copy(text);const bytes=bin?Buffer.from(bin.buffer):Buffer.alloc(0);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+text.length+(bytes.length?8+bytes.length:0),8);header.writeUInt32LE(text.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const chunk=Buffer.alloc(8);chunk.writeUInt32LE(bytes.length);chunk.writeUInt32LE(0x004e4942,4);const result=Buffer.concat([header,text,...(bytes.length?[chunk,bytes]:[])]);return result.buffer.slice(result.byteOffset,result.byteOffset+result.length);
}
async function target(){
 const bones=Object.fromEntries(REQUIRED_BONES.map((name:string,node:number)=>[name,{node}]));
 const file=glb({asset:{version:'2.0'},scene:0,scenes:[{nodes:REQUIRED_BONES.map((_n:string,i:number)=>i)}],nodes:REQUIRED_BONES.map((name:string)=>({name,translation:name==='hips'?[0,1,0]:[.1,0,0]})),extensionsUsed:['VRMC_vrm'],extensions:{VRMC_vrm:{specVersion:'1.0',meta:{name:'Contract',authors:['Test'],licenseUrl:'https://vrm.dev/licenses/1.0/'},humanoid:{humanBones:bones}}}});
 const loaded=await new GLTFLoader().register(parser=>new VRMLoaderPlugin(parser)).parseAsync(file,'');return loaded.userData.vrm as VRM;
}
function animation(){
 const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.8);
 return glb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'hips',translation:[0,1,0],children:[1]},{name:'rightUpperArm'}],extensionsUsed:['VRMC_vrm_animation'],extensions:{VRMC_vrm_animation:{specVersion:'1.0',humanoid:{humanBones:{hips:{node:0},rightUpperArm:{node:1}}}}},buffers:[{byteLength:60}],bufferViews:[{buffer:0,byteOffset:0,byteLength:12},{buffer:0,byteOffset:12,byteLength:48}],accessors:[{bufferView:0,componentType:5126,count:3,type:'SCALAR',min:[0],max:[2]},{bufferView:1,componentType:5126,count:3,type:'VEC4'}],animations:[{samplers:[{input:0,output:1,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:1,path:'rotation'}}]}]},new Float32Array([0,1,2,0,0,0,1,...q.toArray(),0,0,0,1]));
}
function seatedAnimation(){
 return glb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'hips',translation:[0,1,0]}],extensionsUsed:['VRMC_vrm_animation'],extensions:{VRMC_vrm_animation:{specVersion:'1.0',humanoid:{humanBones:{hips:{node:0}}}}},buffers:[{byteLength:32}],bufferViews:[{buffer:0,byteOffset:0,byteLength:8},{buffer:0,byteOffset:8,byteLength:24}],accessors:[{bufferView:0,componentType:5126,count:2,type:'SCALAR',min:[0],max:[1]},{bufferView:1,componentType:5126,count:2,type:'VEC3'}],animations:[{samplers:[{input:0,output:1,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]},new Float32Array([0,1,.2,.55,.1,.2,.55,.1]));
}
describe('real VRMA retargeting and transition contract',()=>{
 it('loads through the official plugin, enters continuously, loops and exits to the live procedural pose',async()=>{
  const vrm=await target(),player=new MotionPlayer(vrm),arm=vrm.humanoid.getNormalizedBoneNode('rightUpperArm')!;
  const visible=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.3);arm.quaternion.copy(visible);
  await player.play(animation(),'test',true);arm.quaternion.identity();player.update(0);expect(arm.quaternion.angleTo(visible)).toBeLessThan(1e-6);
  let peak=0;for(let i=0;i<180;i++){arm.quaternion.identity();player.update(1/60);peak=Math.max(peak,arm.quaternion.angleTo(new THREE.Quaternion()));}
  expect(peak).toBeGreaterThan(.6);expect(player.playing).toBe(true);
  const stopped=arm.quaternion.clone();player.stop();arm.quaternion.identity();player.update(0);expect(arm.quaternion.angleTo(stopped)).toBeLessThan(1e-6);
  for(let i=0;i<30;i++){arm.quaternion.identity();player.update(1/60);}expect(player.playing).toBe(false);expect(arm.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);player.dispose();
 });
 it('keeps an interrupted clip continuous when a new clip replaces it and honors an immediate reset',async()=>{
  const vrm=await target(),player=new MotionPlayer(vrm),arm=vrm.humanoid.getNormalizedBoneNode('rightUpperArm')!;
  await player.play(animation(),'one',true);for(let i=0;i<48;i++){arm.quaternion.identity();player.update(1/60);}
  const current=arm.quaternion.clone();await player.play(animation(),'two',false);arm.quaternion.identity();player.update(0);expect(arm.quaternion.angleTo(current)).toBeLessThan(1e-6);
  player.stop(true);expect(player.playing).toBe(false);arm.quaternion.identity();player.update(.1);expect(arm.quaternion.w).toBe(1);player.dispose();
 });
 it('preserves calibrated sitting height only when requested, while retaining legacy first-frame anchoring',async()=>{
  for(const preserveHipsHeight of [false,true]){
   const vrm=await target(),player=new MotionPlayer(vrm),hips=vrm.humanoid.getNormalizedBoneNode('hips')!;
   const rest=vrm.humanoid.normalizedRestPose.hips!.position!;
   await player.play(seatedAnimation(),'seat',true,{preserveHipsHeight});
   for(let i=0;i<30;i++){hips.position.fromArray(rest);player.update(1/60);}
   expect(hips.position.y).toBeCloseTo(preserveHipsHeight?.55:1,5);
   expect(hips.position.x).toBeCloseTo(rest[0],5);expect(hips.position.z).toBeCloseTo(rest[2],5);
   player.dispose();
  }
 });
 it('holds and reapplies the authored last frame until the next segment or an explicit stop',async()=>{
  const vrm=await target(),player=new MotionPlayer(vrm),hips=vrm.humanoid.getNormalizedBoneNode('hips')!;
  const rest=vrm.humanoid.normalizedRestPose.hips!.position!;
  await player.play(seatedAnimation(),'seat entry',false,{preserveHipsHeight:true,hold:true});
  for(let i=0;i<120;i++){hips.position.fromArray(rest);player.update(1/60);}
  expect(player.finished).toBe(true);expect(player.playing).toBe(true);expect(hips.position.y).toBeCloseTo(.55,5);
  hips.position.fromArray(rest);player.update(.1);expect(hips.position.y).toBeCloseTo(.55,5);
  await player.play(seatedAnimation(),'seat idle',true,{preserveHipsHeight:true});
  expect(player.finished).toBe(false);hips.position.fromArray(rest);player.update(0);expect(hips.position.y).toBeCloseTo(.55,5);
  player.stop();for(let i=0;i<30;i++){hips.position.fromArray(rest);player.update(1/60);}
  expect(player.playing).toBe(false);expect(player.finished).toBe(false);expect(hips.position.y).toBeCloseTo(rest[1],5);player.dispose();
 });
 it('does not resurrect a pending parsed action after an immediate cancel',async()=>{
  const vrm=await target(),player=new MotionPlayer(vrm);
  const pending=player.play(seatedAnimation(),'late',false,{hold:true});player.stop(true);await pending;
  expect(player.playing).toBe(false);expect(player.finished).toBe(false);player.dispose();
 });
 it('restores bones without a procedural owner after an authored clip, even when nobody resets them each frame',async()=>{
  const vrm=await target(),arm=vrm.humanoid.getNormalizedBoneNode('rightUpperArm')!;
  const rest=arm.quaternion.clone(),player=new MotionPlayer(vrm,[]);
  await player.play(animation(),'unowned joint',true);
  for(let i=0;i<60;i++)player.update(1/60);
  expect(arm.quaternion.angleTo(rest)).toBeGreaterThan(.6);
  player.stop();for(let i=0;i<30;i++)player.update(1/60);
  expect(player.playing).toBe(false);expect(arm.quaternion.angleTo(rest)).toBeLessThan(1e-6);
  player.dispose();
 });
});
