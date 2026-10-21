import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {preservePmxPhysics,resolvePmxPhysicsAsset}=require('../electron/pmx-physics-assets.cjs');
const {hashFileSha256}=require('../electron/recommended-model.cjs');
const roots:string[]=[];
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yachiyo-pmx-source-'));roots.push(root);
  const source=path.join(root,'original.pmx'),directory=path.join(root,'imported');fs.mkdirSync(directory);
  fs.writeFileSync(source,Buffer.concat([Buffer.from('PMX '),Buffer.alloc(64)]));
  const digest=hashFileSha256(source);
  const manifest={sourceSha256:digest,motionProfile:{profileId:'generic-vrm',capabilities:['pmx-converted']}};
  return{root,source,directory,digest,manifest};
}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('original PMX source and physics consistency',()=>{
  it('preserves the source bytes and rejects a changed source without retaining the wrong sidecar',()=>{
    const {source,directory,digest}=fixture();const bytes=fs.readFileSync(source);
    preservePmxPhysics(source,directory,digest);
    expect(fs.readFileSync(source)).toEqual(bytes);expect(fs.readFileSync(path.join(directory,'physics.pmx'))).toEqual(bytes);
    const other=path.join(directory,'second');fs.mkdirSync(other);fs.appendFileSync(source,'changed');
    expect(()=>preservePmxPhysics(source,other,digest)).toThrow('发生变化');
    expect(fs.existsSync(path.join(other,'physics.pmx'))).toBe(false);
  });
  it('upgrades an old import only when its saved source fingerprint matches',()=>{
    const {source,directory,manifest}=fixture();fs.writeFileSync(path.join(directory,'conversion-report.json'),JSON.stringify({result:'PASS',input:source}));
    expect(resolvePmxPhysicsAsset(directory,manifest)).toEqual({filename:path.join(directory,'physics.pmx')});
    expect(fs.existsSync(source)).toBe(true);
  });
  it('does not guess an old source without a fingerprint and rejects a tampered sidecar',()=>{
    const {source,directory,digest,manifest}=fixture();fs.writeFileSync(path.join(directory,'conversion-report.json'),JSON.stringify({result:'PASS',input:source}));
    expect(resolvePmxPhysicsAsset(directory,{...manifest,sourceSha256:undefined}).error).toContain('重新导入');
    expect(fs.existsSync(path.join(directory,'physics.pmx'))).toBe(false);
    preservePmxPhysics(source,directory,digest);fs.appendFileSync(path.join(directory,'physics.pmx'),'changed');
    expect(resolvePmxPhysicsAsset(directory,manifest).error).toContain('不一致');
  });
  it('keeps the authored Yachiyo and direct VRM paths outside the migration',()=>{
    const {source,directory,manifest}=fixture();fs.writeFileSync(path.join(directory,'conversion-report.json'),JSON.stringify({result:'PASS',input:source}));
    for(const profile of [{profileId:'yachiyo-long-garment-v1',capabilities:['pmx-converted']},{profileId:'generic-vrm',capabilities:[]}]){
      expect(resolvePmxPhysicsAsset(directory,{...manifest,motionProfile:profile})).toEqual({});
      expect(fs.existsSync(path.join(directory,'physics.pmx'))).toBe(false);
    }
  });
  it('accepts an explicitly verified source/model pair without fabricating an import fingerprint',()=>{
    const {source,directory,digest,manifest}=fixture();
    fs.writeFileSync(path.join(directory,'model.vrm'),'unchanged model');
    preservePmxPhysics(source,directory,digest);
    const association={version:1,method:'verified-pmx-correspondence',sourceSha256:digest,
      modelSha256:hashFileSha256(path.join(directory,'model.vrm')),verifiedAt:'2026-10-21T10:20:00Z'};
    const current={...manifest,model:'model.vrm',sourceSha256:undefined,physicsAssociation:association};
    expect(resolvePmxPhysicsAsset(directory,current)).toEqual({filename:path.join(directory,'physics.pmx')});
    expect(current.sourceSha256).toBeUndefined();
    fs.appendFileSync(path.join(directory,'model.vrm'),'changed');
    expect(resolvePmxPhysicsAsset(directory,current).error).toContain('验证已失效');
    fs.writeFileSync(path.join(directory,'model.vrm'),'unchanged model');
    fs.appendFileSync(path.join(directory,'physics.pmx'),'changed');
    expect(resolvePmxPhysicsAsset(directory,current).error).toContain('不一致');
  });
  it('does not treat incomplete associations as proof or override an existing import fingerprint',()=>{
    const {source,directory,digest,manifest}=fixture();preservePmxPhysics(source,directory,digest);
    fs.writeFileSync(path.join(directory,'model.vrm'),'model');
    const association={version:1,method:'verified-pmx-correspondence',sourceSha256:digest,
      modelSha256:hashFileSha256(path.join(directory,'model.vrm')),verifiedAt:'2026-10-21T10:20:00Z'};
    for(const invalid of [{...association,method:'filename-match'},{...association,modelSha256:undefined},{...association,verifiedAt:'invalid'},{...association,version:2}]){
      expect(resolvePmxPhysicsAsset(directory,{...manifest,model:'model.vrm',sourceSha256:undefined,physicsAssociation:invalid}).error).toContain('缺少原始');
    }
    expect(resolvePmxPhysicsAsset(directory,{...manifest,sourceSha256:'a'.repeat(64),physicsAssociation:association}).error).toContain('不一致');
  });
});
