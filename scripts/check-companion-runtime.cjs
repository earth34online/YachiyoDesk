'use strict';
// Runs under Electron with isolated settings and a loopback provider. No user key.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const output = path.resolve(process.env.YACHIYO_COMPANION_TEST_DIR || path.join(root,'artifacts','2.0-development-20261020','runtime'));
process.env.YACHIYO_DESK_SMOKE_DIR = output;
if (!process.argv.includes('--visual-review')) process.argv.push('--visual-review');
const electron = require('electron');
if (!electron.app) throw new Error('请用 Electron 运行此检查脚本。');
const {app,dialog,BrowserWindow} = electron;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.getVersion = () => require('../package.json').version;
const profile = path.join(output,'test-profile'); fs.mkdirSync(profile,{recursive:true});
for(const name of ['result.json','failure.json'])fs.rmSync(path.join(output,name),{force:true});
// These paths belong exclusively to this script's isolated test profile.
for(const relative of ['companion/ai/connections.json','companion/conversations/review-companion.json'])fs.rmSync(path.join(profile,relative),{force:true});
const {SettingsStore,DEFAULT_SETTINGS} = require('../electron/settings.cjs');
const {PMX_CONVERTED_MOTION_PROFILE} = require('../electron/motion-profile.cjs');
const fixture = process.env.YACHIYO_COMPANION_TEST_MODEL || path.join(root,'characters','marin-dress','model.vrm');
const sourceManifest = path.join(path.dirname(fixture),'character.json'), physics = path.join(path.dirname(fixture),'physics.pmx');
const characterRoot = path.join(profile,'characters','review-companion');fs.mkdirSync(characterRoot,{recursive:true});
if (!fs.existsSync(fixture)) throw new Error('请通过 YACHIYO_COMPANION_TEST_MODEL 指定合法的本地 VRM 测试模型。');
fs.copyFileSync(fixture,path.join(characterRoot,'model.vrm'));
const source = fs.existsSync(sourceManifest) ? JSON.parse(fs.readFileSync(sourceManifest,'utf8')) : {};
const crypto = require('node:crypto');
if (fs.existsSync(physics)) fs.copyFileSync(physics,path.join(characterRoot,'physics.pmx'));
fs.writeFileSync(path.join(characterRoot,'character.json'),JSON.stringify({...source,id:'review-companion',displayName:'2.0 验收角色',model:'model.vrm',
  ...(fs.existsSync(physics)?{sourceFormat:'pmx',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(physics)).digest('hex'),motionProfile:PMX_CONVERTED_MOTION_PROFILE}:{})}));
new SettingsStore(path.join(profile,'settings.json')).patch({...DEFAULT_SETTINGS,autoStart:false,autonomousBehavior:false,activeCharacterId:'review-companion',zoom:.78});
const requests = [], failures = [], checks = [];let selectedFile = '', exportedFile = '', window;
dialog.showOpenDialog = async()=>({canceled:!selectedFile,filePaths:selectedFile?[selectedFile]:[]});
dialog.showSaveDialog = async()=>({canceled:!exportedFile,filePath:exportedFile});
dialog.showMessageBox = async(_parent,options)=>({response:options.message?.includes('自己的 AI')?0:options.message?.includes('语音输入')?0:1});
app.on('web-contents-created',(_event,contents)=>{
  contents.on('console-message',(_event,level,message)=>{if(level>=3)failures.push(message);});
});
const png = fs.readFileSync(path.join(root,'build','icon.png')).toString('base64');
const wav = Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
const server = http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=req.headers['content-type']?.includes('application/json')?JSON.parse(raw):null;requests.push({url:req.url,body});
  if(req.url==='/v1/audio/transcriptions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'这是语音识别测试'}));return;}
  if(req.url==='/v1/audio/speech'){res.setHeader('content-type','audio/wav');res.end(wav);return;}
  if(req.url==='/v1/images/generations'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:png}]}));return;}
  const repair=body?.messages?.[0]?.content?.includes('# Character import repair');
  if(!body?.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:repair?JSON.stringify(globalThis.repairPlan):'OK'}}]}));return;}
  res.setHeader('content-type','text/event-stream');
  for(const text of ['你好，','我们一起','把今天过好。'])res.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');res.end('data: [DONE]\n\n');
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function evaluate(code){return window.webContents.executeJavaScript(code,true);}
async function waitFor(code,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(code))return;await sleep(150);}throw new Error('等待超时：'+code);}
async function click(text){await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled&&!b.hidden);if(!button)throw Error('找不到按钮 '+${JSON.stringify(text)});button.click();})()`);await sleep(120);}
async function api(action,input){return evaluate(`(async()=>{const r=await window.yachiyoDesk.companionRequest(${JSON.stringify(action)},${JSON.stringify(input||{})});if(!r.ok)throw Error(r.error);return r.data;})()`);}
async function capture(name){fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());}
async function run(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
 require('../electron/main.cjs');
 await app.whenReady();
 const started=Date.now();while(!(window=BrowserWindow.getAllWindows()[0])&&Date.now()-started<15000)await sleep(50);
 assert(window,'主窗口应创建');await waitFor(`Boolean(document.querySelector('#loading')?.hidden)`);await sleep(1200);
 await evaluate(`window.__desktopPetTriggerReaction('greet')`);await sleep(1650);await capture('00-greeting-palm');
 await click('♡ 与角色聊天');
 await evaluate(`document.querySelector('.chat-draft').value='未配置测试'`);await click('发送 ↗');
 await waitFor(`Boolean([...document.querySelectorAll('dialog[open] h2')].find(e=>e.textContent.includes('需要文字对话连接')))`);
 await capture('01-missing-api');await click('暂不配置');
 assert((await evaluate(`document.querySelector('.workspace-status').textContent`)).includes('尚未接入'));checks.push('无 API 明确提示与取消结果');
 for(const capability of ['chat','vision','speech','transcription','image'])await api('connection.save',{capability,endpoint,model:capability==='image'?'test-image':'test-model',apiKey:'loopback-test-key'});
 await click('当前画面');await waitFor(`Boolean(document.querySelector('dialog[open] .capture-choice'))`);
 await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.capture-choice')];(buttons.find(button=>button.textContent.includes('YachiyoDesk'))||buttons[0]).click();})()`);
 await waitFor(`Boolean(document.querySelector('.attachment-strip img'))`);await click('移除');checks.push('实际屏幕来源缩略图选择 → 单次截取 → 附件预览与移除');
 await click('发送 ↗');await waitFor(`document.querySelector('.workspace-status').textContent==='回复完成'`);
 assert((await api('session')).turns.at(-1).assistant.includes('把今天过好'));checks.push('真实 IPC + HTTP 流式对话与持久化');
 await click('语音输入');await waitFor(`document.querySelector('.workspace-status').textContent.includes('录音中')`);await sleep(600);await click('结束录音');
 await waitFor(`document.querySelector('.chat-draft').value==='这是语音识别测试'`);checks.push('实际 MediaRecorder → 录音停止/释放 → HTTP 识别 → 可编辑草稿');
 await evaluate(`(()=>{const label=[...document.querySelectorAll('label')].find(e=>e.textContent==='自动朗读回复');label.querySelector('input').click();})()`);await sleep(100);await click('发送 ↗');
 await waitFor(`document.querySelector('.workspace-status').textContent==='朗读结束'`);checks.push('实际语音合成 → AudioContext/Audio 播放与结束释放');
 await click('AI 连接');await capture('02-connections');await click('关闭 ×');
 await evaluate(`document.querySelector('.control-tab[data-page="studio"]').click()`);await sleep(100);
 assert((await evaluate(`document.querySelector('.companion-workspace h2')?.textContent`))==='角色创作室');
 const idleAsset=path.join(root,'artifacts','2.0-development-20261020','airi-idle.vrma');
 if(fs.existsSync(idleAsset)){
  const idleBytes=[...fs.readFileSync(idleAsset)];
  await evaluate(`window.__desktopPetPlayMotion(${JSON.stringify(idleBytes)},true)`);await sleep(1000);
  assert(await evaluate('window.__desktopPetMotionPlaying()'));await evaluate(`document.querySelector('#settings-close').click()`);await sleep(250);await capture('00-airi-idle');
  await evaluate(`window.__desktopPetTriggerReaction('greet')`);await sleep(700);assert.equal(await evaluate('window.__desktopPetMotionPlaying()'),false);checks.push('AIRI VRMA 实际重定向播放、循环与手动动作中断');
  await click('♡ 与角色聊天');await evaluate(`document.querySelector('.control-tab[data-page="studio"]').click()`);await sleep(100);
 }
 await evaluate(`document.querySelectorAll('.companion-workspace details')[1].open=true`);await click('90°');await sleep(1000);
 const rightView=await evaluate('window.__desktopPetPoseSnapshot()');await click('270°');await sleep(1000);const leftView=await evaluate('window.__desktopPetPoseSnapshot()');
 assert((rightView.rightHand.z-rightView.hips.z)*(leftView.rightHand.z-leftView.hips.z)<0,'90° 与 270° 应看到相反侧面');
 await evaluate(`(()=>{const label=[...document.querySelectorAll('.workspace-field')].find(node=>node.querySelector('span')?.textContent==='观察记录');label.querySelector('input').value='测试视角记录，未作自动视觉合格结论';})()`);await click('记录当前视角');
 exportedFile=path.join(output,'model-observation.json');await click('导出记录');const observation=JSON.parse(fs.readFileSync(exportedFile));assert.equal(observation.observations[0].angle,270);assert.equal(observation.environment.appVersion,app.getVersion());assert.equal(observation.environment.physics.engine,'pmx-ammo');
 await click('恢复视角');checks.push('实际 90° / 270° 相反侧面、人工观察记录和带版本/物理路径的报告导出');
 await evaluate(`document.querySelectorAll('.companion-workspace details')[0].open=true`);selectedFile=path.join(root,'assets','motions','airi-idle.vrma');await click('导入 VRMA');
 await click('播放');await sleep(600);assert(await evaluate('window.__desktopPetMotionPlaying()'));await click('停止动作');await sleep(450);assert.equal(await evaluate('window.__desktopPetMotionPlaying()'),false);checks.push('实际动作库导入、播放和停止恢复');
 if(process.argv.includes('--extended-ui')){
  const toggle=label=>evaluate(`(()=>{const label=[...document.querySelectorAll('.workspace-field')].find(node=>node.querySelector('span')?.textContent===${JSON.stringify(label)});label.querySelector('input').click();})()`);
  await toggle('自然待机 · AIRI 动画');await waitFor('window.__desktopPetMotionPlaying()',8000);await toggle('自然待机 · AIRI 动画');await waitFor('!window.__desktopPetMotionPlaying()',8000);
  await toggle('循环播放');await toggle('随机动作播放列表');await sleep(12800);assert(await evaluate('window.__desktopPetMotionPlaying()'));
  await click('停止动作');await sleep(500);assert.equal(await evaluate('window.__desktopPetMotionPlaying()'),false);await sleep(12300);assert.equal(await evaluate('window.__desktopPetMotionPlaying()'),false);
  checks.push('自然待机开启/关闭、真实随机动作计时、循环与停止后不再重启');
  await evaluate(`document.querySelectorAll('.companion-workspace details')[4].open=true`);await click('欢迎回来');await sleep(350);await click('停止小剧场');await sleep(4100);
  assert(!(await evaluate(`document.querySelector('#speech').textContent`)).includes('今天想一起做些什么'));
  await evaluate(`(()=>{const fields=[...document.querySelectorAll('.workspace-field')];fields.find(node=>node.querySelector('span')?.textContent==='角色说的话').querySelector('input').value='实测休息提醒';fields.find(node=>node.querySelector('span')?.textContent==='休息提醒（分钟）').querySelector('input').value='1';})()`);
  await click('开启休息提醒');await sleep(61000);assert((await evaluate(`document.querySelector('#speech').textContent`)).includes('实测休息提醒'));await click('关闭提醒');
  checks.push('真实小剧场中断与一分钟提醒触发、关闭');
 }
 await evaluate(`document.querySelectorAll('.companion-workspace details')[2].open=true`);await sleep(150);await click('保存快照');
 const snapshots=await api('snapshots'),savedSettings=(await evaluate('window.yachiyoDesk.getBootstrap()')).settings;assert(snapshots.length);
 await evaluate(`window.yachiyoDesk.updateSettings({zoom:.91,rotationY:.4})`);await click('查看 / 恢复');await capture('03-snapshot');await click('确认恢复');
 const restored=(await evaluate('window.yachiyoDesk.getBootstrap()')).settings;
 assert.equal(restored.zoom,savedSettings.zoom);assert.equal(restored.rotationY,savedSettings.rotationY);assert.deepEqual(restored.characterZooms,savedSettings.characterZooms);assert((await api('snapshots')).some(item=>item.label==='恢复前自动备份'));
 checks.push('快照创建 → 实际差异 → 恢复缩放、朝向与角色比例 → 自动保留回滚快照');
 await evaluate(`document.querySelectorAll('.companion-workspace details')[3].open=true`);await sleep(100);await click('拍一张');
 await waitFor(`Boolean(document.querySelector('.postcard-preview').src)`);exportedFile=path.join(output,'postcard-export.png');await click('保存 PNG');assert(fs.statSync(exportedFile).size>10000);checks.push('真实渲染明信片导出');
 await capture('04-studio');
 // A real damaged copy: remove only an existing required mapping, preserve binary bytes.
 const {readGlb}=require('../electron/motion-library.cjs'),{rewriteGlbJson}=require('../electron/import-workflow.cjs');
 const original=fs.readFileSync(fixture),json=readGlb(original),mapping=json.extensions?.VRMC_vrm?.humanoid?.humanBones?.hips;
 if(mapping&&!process.argv.includes('--ui-only')){
  selectedFile=path.join(output,'broken-copy.vrm');fs.writeFileSync(selectedFile,rewriteGlbJson(original,j=>{delete j.extensions.VRMC_vrm.humanoid.humanBones.hips;}));
  globalThis.repairPlan={summary:'恢复被移除的 hips 映射，现有关节节点与原始骨架一致。',actions:[{type:'map_humanoid_bone',bone:'hips',node:mapping.node,reason:'源模型已有 hips 蒙皮关节，无需改变节点或几何。'}],unresolved:[]};
  await evaluate(`document.querySelector('.control-tab[data-page="characters"]').click()`);await sleep(100);await click('＋ 导入 VRM 角色');
  await waitFor(`Boolean([...document.querySelectorAll('dialog[open] h2')].find(e=>e.textContent==='AI 导入修复'))`);
  await click('同意发送以上诊断，生成方案');await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='接受方案并修复副本'&&!b.hidden))`);
  await capture('05-repair-plan');await click('接受方案并修复副本');
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='确认导入角色库'&&!b.disabled))`,60000);
  await capture('06-import-preview');await click('确认导入角色库');
  const characters=await evaluate('window.yachiyoDesk.listCharacters()');assert(characters.some(item=>item.id!=='yachiyo'&&item.id!=='review-companion'));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),crypto.createHash('sha256').update(original).digest('hex'));
  await waitFor(`document.querySelectorAll('.character-card').length===${characters.length}`);
  checks.push('真实损坏 VRM → 本地 AI 方案 → 副本修复 → 实际加载预览 → 确认入库，原文件不变');
 }
 if(process.argv.includes('--pmx-repair')){
  const {pmxTextures,rewritePmxTextures}=require('../electron/pmx-assets.cjs');
  const sourceRoot=path.join(root,'artifacts','airi-review-20261020','assets','TDA Marin Kitagawa');
  const sourcePath=path.join(sourceRoot,'TDA Marin Shizuku.pmx'),sourceBytes=fs.readFileSync(sourcePath),textures=pmxTextures(sourceBytes).textures;
  const owned=path.join(output,'pmx-repair-source');fs.mkdirSync(owned,{recursive:true});
  for(const reference of textures){const relative=reference.replaceAll('\\','/'),destination=path.join(owned,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});if(!fs.existsSync(destination))fs.copyFileSync(path.join(sourceRoot,relative),destination);}
  selectedFile=path.join(owned,'repair-verification.pmx');const damaged=rewritePmxTextures(sourceBytes,{0:'TEX/missing-body.png',3:'TEX/missing-decoration.png'});fs.writeFileSync(selectedFile,damaged);
  globalThis.repairPlan={summary:'使用副本内现有身体贴图，并按明确授权生成缺失装饰贴图。',actions:[
   {type:'remap_texture',index:0,path:textures[0].replaceAll('\\','/'),reason:'测试副本中的原身体贴图完好，路径被故意改错。'},
   {type:'generate_texture',index:3,prompt:'A small green leaf pattern on white.',reason:'缺失装饰贴图，只有在用户勾选授权后才生成替代品。'}],unresolved:[]};
  await evaluate(`document.querySelector('.control-tab[data-page="characters"]').click()`);await click('＋ 导入 PMX（自动转换）');
  await waitFor(`Boolean([...document.querySelectorAll('dialog[open] h2')].find(e=>e.textContent==='AI 导入修复'))`,90000);
  await evaluate(`document.querySelector('dialog[open] input[type=checkbox]').click()`);await click('同意发送以上诊断，生成方案');
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='接受方案并修复副本'&&!b.hidden))`);await click('接受方案并修复副本');
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='确认导入角色库'&&!b.disabled))`,180000);await capture('07-pmx-repaired-preview');
  await click('确认导入角色库');assert(fs.readFileSync(selectedFile).equals(damaged));assert(fs.readFileSync(sourcePath).equals(sourceBytes));
  const characters=await evaluate('window.yachiyoDesk.listCharacters()');await waitFor(`document.querySelectorAll('.character-card').length===${characters.length}`);
  const repaired=fs.readdirSync(path.join(profile,'characters')).filter(name=>name.startsWith('repair-verification-')).map(name=>JSON.parse(fs.readFileSync(path.join(profile,'characters',name,'character.json')))).at(-1);
  assert.equal(repaired?.aiRepair.generated.length,1);assert.equal(repaired?.sourceFormat,'pmx');
  checks.push('真实 PMX 缺失贴图 → 显式允许生成 → 原贴图重映射与图像 API → Blender 重新转换 → 加载预览 → 入库，两个源文件均未改变');
 }
 await api('speech',{text:'语音测试'});await api('transcribe',{audio:{mime:'audio/webm',base64:Buffer.from('test-audio').toString('base64')}});await api('image.generate',{prompt:'garden'});checks.push('语音与图像端点实际 HTTP 协议');
 const result={ok:true,checks,requests:requests.map(item=>item.url),consoleErrors:failures,completedAt:new Date().toISOString()};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 server.closeAllConnections();server.close();app.exit(0);
}
run().catch(async error=>{
 let state;try{state=await evaluate(`({loading:document.querySelector('#loading')?.hidden,detail:document.querySelector('#loading-detail')?.textContent,fatal:document.querySelector('#fatal-message')?.textContent,ready:document.readyState})`);await capture('failure-state');}catch{}
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack),checks,state,consoleErrors:failures},null,2));console.error(error);server.closeAllConnections();server.close();app.exit(1);
});
