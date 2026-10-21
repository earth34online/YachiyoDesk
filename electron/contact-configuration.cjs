'use strict';
const fs=require('node:fs');
const {readGlb}=require('./motion-library.cjs');
const BONES=['leftUpperArm','leftLowerArm','rightUpperArm','rightLowerArm','leftUpperLeg','leftLowerLeg','rightUpperLeg','rightLowerLeg','hips','spine','chest'];

function validateContactConfiguration(value) {
  if(!value || value.mode!=='automatic' || Object.keys(value).some(key=>!['mode','bodyMesh','disabledBones','radiusScale'].includes(key)))throw new Error('碰撞方案包含不支持的配置。');
  if(value.bodyMesh!==undefined && (!Number.isInteger(value.bodyMesh)||value.bodyMesh<0||value.bodyMesh>65535))throw new Error('身体网格索引无效。');
  if(value.disabledBones!==undefined && (!Array.isArray(value.disabledBones)||value.disabledBones.length>BONES.length||new Set(value.disabledBones).size!==value.disabledBones.length||value.disabledBones.some(name=>!BONES.includes(name))))throw new Error('碰撞骨骼配置无效。');
  if(value.radiusScale!==undefined && (!value.radiusScale||typeof value.radiusScale!=='object'||Array.isArray(value.radiusScale)||Object.entries(value.radiusScale).some(([name,scale])=>!BONES.includes(name)||!Number.isFinite(scale)||scale<.25||scale>1)))throw new Error('碰撞半径须为身体内接半径的 0.25–1 倍。');
  return {mode:'automatic',...(value.bodyMesh!==undefined?{bodyMesh:value.bodyMesh}:{}),...(value.disabledBones?{disabledBones:[...value.disabledBones]}:{}),...(value.radiusScale?{radiusScale:{...value.radiusScale}}:{})};
}
function inspectContactConfiguration(filename,originalPhysics=false) {
  const json=readGlb(fs.readFileSync(filename)), v1=json.extensions?.VRMC_springBone,v0=json.extensions?.VRM?.secondaryAnimation;
  const colliders=v1?.colliders?.length ?? (v0?.colliderGroups||[]).reduce((sum,group)=>sum+(group.colliders?.length||0),0);
  const joints=v1?.springs?.reduce((sum,spring)=>sum+(spring.joints?.length||0),0) ?? (v0?.boneGroups||[]).reduce((sum,group)=>sum+(group.bones?.length||0),0);
  if(originalPhysics)return {status:'native',colliders,joints,message:'保留原始 PMX 刚体、关节和碰撞分组。'};
  if(colliders)return {status:'authored',colliders,joints,message:'保留模型自带的碰撞形状与摇摆设置。'};
  if(!joints)return {status:'no-springs',colliders,joints,message:'模型没有摇摆骨骼；静态衣物无法仅靠补碰撞体获得布料模拟，请使用带完整骨架与物理的来源。'};
  return {status:'automatic',colliders,joints,message:'缺少碰撞配置：预览时尝试按身体网格与通用骨骼生成内接碰撞形状；无法识别时会明确提示。'};
}
module.exports={BONES,validateContactConfiguration,inspectContactConfiguration};
