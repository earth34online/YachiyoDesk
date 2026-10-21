'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AiConnections, CompanionData, writeJson } = require('./ai-store.cjs');
const { AiService } = require('./ai-service.cjs');
const { MotionLibrary } = require('./motion-library.cjs');
const { ConfigSnapshots } = require('./config-snapshots.cjs');
const { ImportWorkflow } = require('./import-workflow.cjs');
const { hashFileSha256 } = require('./recommended-model.cjs');

class CompanionHost {
  constructor(options) {
    Object.assign(this, options);
    this.connections = new AiConnections(path.join(this.directory, 'ai'), this.electron.safeStorage, {recover:true});
    this.data = new CompanionData(path.join(this.directory, 'conversations'));
    const bundledMotions = process.resourcesPath && path.join(process.resourcesPath,'motions');
    this.motions = new MotionLibrary(path.join(this.directory, 'motions'),bundledMotions && fs.existsSync(bundledMotions)?bundledMotions:path.join(__dirname,'..','assets','motions'));
    this.snapshots = new ConfigSnapshots(path.join(this.directory, 'snapshots'));
    this.microphoneUntil = 0;
    this.microphoneGeneration = 0;
    this.imports = new ImportWorkflow(this);
    this.ai = new AiService({ connections: this.connections, data: this.data, character: () => this.character().manifest,
      emit: event => this.window()?.webContents.send('companion:event', event),
      react: action => this.command('reaction', action), focus: this.focus,
      motions:{list:()=>this.motions.list(),play:id=>this.command('play-motion',{id})} });
  }
  image(bytes) {
    if (bytes.length > 16 * 1024 * 1024) throw new Error('图片超过 16 MB。');
    const image = this.electron.nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 16000000) throw new Error('图片无效或像素过大。');
    const resized = size.width > 2048 || size.height > 2048 ? image.resize(size.width > size.height ? { width: 2048 } : { height: 2048 }) : image;
    return { mime: 'image/png', base64: resized.toPNG().toString('base64') };
  }
  async chooseImage() {
    const result = await this.electron.dialog.showOpenDialog(this.window(), { title: '附加图片（发送前可移除）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp'] }] });
    if (result.canceled) return null;
    if (fs.statSync(result.filePaths[0]).size > 16 * 1024 * 1024) throw new Error('图片超过 16 MB。');
    return this.image(fs.readFileSync(result.filePaths[0]));
  }
  async captureSources() {
    const sources=await this.electron.desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:400,height:250}});
    return sources.filter(item=>!item.thumbnail.isEmpty()).slice(0,40).map(item=>({id:item.id,name:item.name.slice(0,100),thumbnail:item.thumbnail.toDataURL()}));
  }
  async capture(sourceId) {
    if(typeof sourceId!=='string'||sourceId.length>200)throw new Error('请先选择要附加的画面。');
    const sources = await this.electron.desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: { width: 1600, height: 1000 } });
    const selected=sources.find(item=>item.id===sourceId&&!item.thumbnail.isEmpty());
    if(!selected)throw new Error('该画面已经关闭，请重新选择。');
    return this.image(selected.thumbnail.toPNG());
  }
  async saveFile(title, data, extension = 'json') {
    const result = await this.electron.dialog.showSaveDialog(this.window(), { title, defaultPath: `YachiyoDesk-${new Date().toISOString().slice(0, 10)}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, data); return path.basename(result.filePath);
  }
  async request(action, input = {}) {
    const id = this.character().manifest.id;
    const needed = {microphone:'transcription','image.attach':'vision','image.sources':'vision','image.capture':'vision','repair.plan':'chat'}[action];
    if (needed) this.connections.get(needed);
    switch (action) {
      case 'connections': return this.connections.describe();
      case 'connection.require': this.connections.get(input.capability); return true;
      case 'import.discard': this.imports.discard(input.token); return true;
      case 'import.loaded': this.imports.ticket(input.token).loaded = true; return true;
      case 'import.accept': return this.imports.accept(input.token);
      case 'import.contact.plan': return this.imports.contactPlan(input.token,input.diagnosis,input.consent);
      case 'import.contact.apply': return this.imports.applyContactPlan(input.token);
      case 'import.contact.cancel': this.imports.cancelContactPlan(input.token); return true;
      case 'repair.plan': return this.imports.plan(input.token, input.generatedAllowed === true);
      case 'repair.apply': return this.imports.apply(input.token, input.generatedAllowed === true);
      case 'connection.save': return this.connections.save(input);
      case 'connection.remove': return this.connections.remove(input.capability);
      case 'connection.test': {
        const packaged=process.resourcesPath && path.join(process.resourcesPath,'app-icons','icon.png');
        const image=input.capability==='vision'?this.image(fs.readFileSync(packaged&&fs.existsSync(packaged)?packaged:path.join(__dirname,'..','build','icon.png'))):undefined;
        return this.ai.test(input.capability,image);
      }
      case 'session': return this.data.get(id);
      case 'session.preferences': return this.data.preferences(id, input);
      case 'session.remember': return this.data.remember(id, input.text);
      case 'session.forget': return this.data.forget(id, input.id);
      case 'session.clear': this.ai.cancel(); return this.data.clear(id);
      case 'session.export': return this.saveFile('导出当前角色对话', JSON.stringify(this.data.get(id), null, 2));
      case 'chat': return this.ai.start(input);
      case 'cancel': this.ai.cancel(input.requestId); return true;
      case 'speech': return this.ai.mediaRequest('speech', input.text, input.requestId);
      case 'transcribe': return this.ai.mediaRequest('transcription', input.audio, input.requestId);
      case 'microphone': {
        const generation=++this.microphoneGeneration;
        const result = await this.electron.dialog.showMessageBox(this.window(), { type: 'question', message: '开始一次语音输入？', detail: '麦克风仅用于本次录音；停止后录音会发给你配置的语音识别接口。识别结果可编辑，再手动发送。', buttons: ['开始录音','取消'], defaultId: 1, cancelId: 1 });
        if(generation!==this.microphoneGeneration)return false;
        this.microphoneUntil = result.response === 0 ? Date.now() + 10000 : 0; return result.response === 0;
      }
      case 'microphone.revoke': ++this.microphoneGeneration;this.microphoneUntil = 0; return true;
      case 'image.attach': return this.chooseImage();
      case 'image.sources': return this.captureSources();
      case 'image.capture': return this.capture(input.sourceId);
      case 'image.generate': {
        const bytes = await this.ai.mediaRequest('image',input.prompt,input.requestId);
        return this.image(bytes);
      }
      case 'image.save': {
        const image = this.image(Buffer.from(input.base64 || '', 'base64'));
        return this.saveFile('保存图片', Buffer.from(image.base64, 'base64'), 'png');
      }
      case 'motions': return this.motions.list();
      case 'motion.import': {
        const selected = await this.electron.dialog.showOpenDialog(this.window(), { title: '导入 VRMA 动作', properties: ['openFile'], filters: [{ name: 'VRM Animation', extensions: ['vrma'] }] });
        return selected.canceled ? null : this.motions.import(selected.filePaths[0]);
      }
      case 'motion.remove': return this.motions.remove(input.id);
      case 'motion.load': {
        const file = this.motions.file(input.id);
        if (!this.motions.list().some(item => item.id === input.id)) throw new Error('动作不存在。');
        // VRMA is bounded on import; binary IPC avoids arbitrary filesystem URLs.
        const bytes = fs.readFileSync(file);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case 'snapshots': return this.snapshots.list();
      case 'snapshot.create': return this.snapshots.capture(this.settings(), input.label);
      case 'snapshot.preview': return this.snapshots.preview(input.id, this.settings());
      case 'snapshot.restore': {
        const item = this.snapshots.preview(input.id, this.settings());
        const target = this.characters().find(character => character.id === item.settings.activeCharacterId);
        if (!target) throw new Error('快照中的角色已不存在，请先导入该角色。');
        this.snapshots.capture(this.settings(), '恢复前自动备份');
        if (target.id !== id) {
          const switched = await this.switchCharacter(target.id);
          if (!switched.ok) throw new Error(switched.error);
        }
        const restored=this.patch(item.settings);this.restoreWindow?.(restored.window);return this.settings();
      }
      case 'snapshot.export': return this.saveFile('导出设置快照', JSON.stringify(this.snapshots.read(this.snapshots.file(input.id)), null, 2));
      case 'snapshot.import': {
        const selected = await this.electron.dialog.showOpenDialog(this.window(), { title: '导入设置快照', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (selected.canceled) return null;
        const item = this.snapshots.read(selected.filePaths[0]); return this.snapshots.capture(item.settings, item.label || '导入的快照');
      }
      case 'observation.export': {
        if(!Array.isArray(input.observations)||input.observations.length>1000||JSON.stringify(input).length>2*1024*1024)throw new Error('观察记录无效或过大。');
        const character=this.character();
        const modelSha256=hashFileSha256(path.join(character.directory,character.manifest.model));
        return this.saveFile('导出模型观察记录', JSON.stringify({ version: 1, character: character.manifest,modelSha256,environment:input.environment, observedAt: new Date().toISOString(), observations: input.observations }, null, 2));
      }
      default: throw new Error('未知操作。');
    }
  }
  bind(ipcMain) {
    ipcMain.handle('companion:request', async (event, action, input) => {
      if (event.sender !== this.window()?.webContents || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) return { ok: false, error: '请求来源无效。' };
      try { return { ok: true, data: await this.request(action, input) }; }
      catch (error) { return { ok: false, error: this.ai.publicError(error), code: error.code === 'AI_CONNECTION_REQUIRED' ? error.code : undefined, capability: error.capability }; }
    });
  }
  dispose() { this.ai.dispose(); this.imports.dispose(); this.motions.dispose(); ++this.microphoneGeneration; this.microphoneUntil = 0; }
}
module.exports = { CompanionHost };
