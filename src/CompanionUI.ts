import { AvatarRuntime } from './AvatarRuntime';
import type { ReactionName, CharacterImportResult, BootstrapData, AppSettings } from './types';
import { companionRequest as call, ConnectionRequired } from './companion-types';
import type { Capability, Connection, Conversation, ImageAttachment, MotionItem, Snapshot, CompanionEvent } from './companion-types';
import { CompanionVoice } from './CompanionVoice';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
const capabilities: [Capability, string][] = [['chat','文字对话'],['vision','图片理解'],['transcription','语音识别'],['speech','语音朗读'],['image','图像生成']];
const reactions: [ReactionName, string][] = [['greet','招手'],['think','思考'],['crouch','下蹲'],['tiptoe','踮脚'],['dance','轻舞'],['stretch','伸展'],['cheer','欢呼'],['bow','鞠躬']];
interface UiHost {
  bootstrap: BootstrapData;
  runtime: AvatarRuntime;
  characterId: string;
  toast(text: string): void;
  speech(text: string): void;
  rotate(radians: number): void;
  restoreView(): void;
  settingsPatch(patch: Partial<AppSettings>): Promise<void>;
}

export class CompanionUI {
  private readonly chat = element('div', '', 'companion-workspace');
  private readonly studio = element('div', '', 'companion-workspace');
  private readonly messages = element('div', '', 'chat-messages');
  private readonly draft = element('textarea', '', 'chat-draft');
  private readonly status = element('p', '', 'workspace-status');
  private readonly attachments = element('div', '', 'attachment-strip');
  private readonly voice: CompanionVoice;
  private images: ImageAttachment[] = [];
  private requestId = '';
  private lastRequestId = '';
  private reply: HTMLElement | null = null;
  private replyText = '';
  private readonly earlyEvents: CompanionEvent[] = [];
  private autoRead = false;
  private readGeneration = 0;
  private sessionRevision = 0;
  private sending = false;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private removeEvents: () => void;
  private initialized = false;
  private connectionPromptOpen = false;
  private playlistTimer = 0;
  private playlist = false;
  private sceneGeneration = 0;
  private sceneWake: (()=>void) | null = null;
  private reminderTimer = 0;
  private imageRequestId = '';
  private observations: {angle: number; action: string; result: string; time: string; physics: unknown}[] = [];
  private naturalToggle: HTMLInputElement | null = null;
  private physicsToggle: HTMLInputElement | null = null;

  constructor(private readonly host: UiHost) {
    this.voice = new CompanionVoice(value => host.runtime.setVoiceMouth(value));
    this.removeEvents = window.yachiyoDesk.onCompanionEvent(event => this.onEvent(event));
    this.buildChat(); this.buildStudio();
    if(host.bootstrap.character.motionProfile.profileId==='generic-vrm')void call<ArrayBuffer>('motion.load',{id:'builtin-airi-idle'}).then(bytes=>host.runtime.configureNaturalIdle(bytes)).catch(error=>this.report(error));
  }
  updateSettings(settings: AppSettings): void {
    if(this.naturalToggle)this.naturalToggle.checked=settings.naturalIdle;
    if(this.physicsToggle)this.physicsToggle.checked=settings.physics;
  }
  interruptScene(): void {++this.sceneGeneration;this.sceneWake?.();this.sceneWake=null;}
  async playSavedMotion(id: string): Promise<void>{const item=(await call<MotionItem[]>('motions')).find(item=>item.id===id);if(!item)throw new Error('动作已不存在。');return this.playMotion(item);}
  private async generateImage(prompt: string): Promise<ImageAttachment>{
    if(this.imageRequestId)throw new Error('已有图像生成任务，请先停止或等待完成。');
    const requestId=this.imageRequestId=crypto.randomUUID();
    try{return await call<ImageAttachment>('image.generate',{prompt,requestId});}finally{if(this.imageRequestId===requestId)this.imageRequestId='';}
  }
  private async stopImage(): Promise<void>{if(this.imageRequestId)await call('cancel',{requestId:this.imageRequestId});}
  attach(page: 'chat' | 'studio', container: HTMLElement): void {
    container.append(page === 'chat' ? this.chat : this.studio);
    if (!this.initialized) { this.initialized = true; void this.loadSession().catch(error => this.report(error)); }
  }
  private report(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error); this.status.textContent = text; this.host.toast(text);
    const feedback=[...document.querySelectorAll('dialog[open] .dialog-feedback')].at(-1);if(feedback)feedback.textContent=text;
    if (error instanceof ConnectionRequired && !this.connectionPromptOpen) {
      this.connectionPromptOpen = true;
      const name = capabilities.find(([cap]) => cap === error.capability)?.[1] || 'AI';
      const modal = this.modal(`需要${name}连接`);let configuring=false;
      modal.content.append(element('p', `请接入你自己的${name} API 后使用此功能。本机模型服务也可以；本地功能无需配置 AI。`),
        this.row(this.button('去配置', async () => { configuring=true;modal.close(); await this.showConnections(error.capability); }),
          this.button('暂不配置', modal.close)));
      modal.dialog.addEventListener('close', () => { this.connectionPromptOpen = false;if(!configuring){this.status.textContent=`尚未接入${name}，暂时无法使用此功能。`;this.host.toast(this.status.textContent);} }, {once:true});
    }
  }
  private button(label: string, run: () => unknown, className = 'secondary-button'): HTMLButtonElement {
    const button = element('button', label, className); button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      void Promise.resolve().then(run).catch(error => this.report(error)).finally(() => { button.disabled = button === this.sendButton && this.sending; button.removeAttribute('aria-busy'); });
    }); return button;
  }
  private row(...children: Node[]): HTMLElement { const row = element('div', '', 'workspace-row'); row.append(...children); return row; }
  private details(title: string, ...children: Node[]): HTMLDetailsElement { const box = element('details', '', 'workspace-card'); box.append(element('summary', title), ...children); return box; }
  private input(label: string, value = '', type = 'text'): { field: HTMLInputElement; node: HTMLLabelElement } {
    const node = element('label', '', 'workspace-field'), field = element('input'); field.type = type; field.value = value; field.autocomplete = 'off';
    node.append(element('span', label), field); return { field, node };
  }
  private buildChat(): void {
    const toolbar = this.row(element('strong', '与你的角色聊聊'), this.button('AI 连接', () => this.showConnections()));
    this.messages.setAttribute('aria-label', '对话记录'); this.messages.setAttribute('role', 'log');
    this.draft.placeholder = '说点什么…'; this.draft.rows = 3; this.draft.maxLength = 12000; this.draft.setAttribute('aria-label', '消息');
    this.draft.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!this.requestId) void this.send().catch(error => this.report(error)); } });
    this.sendButton = this.button('发送 ↗', () => this.send(), 'primary-button');
    this.stopButton = this.button('停止', () => call('cancel', { requestId: this.requestId })); this.stopButton.hidden = true;
    const record = this.button('语音输入', () => this.voice.record(text => { this.draft.value = text; this.draft.focus(); }, text => { this.status.textContent = text; record.textContent = this.voice.recording ? '结束录音' : '语音输入'; }));
    const read = this.input('自动朗读回复', '', 'checkbox'); read.field.addEventListener('change', () => {
      const generation = ++this.readGeneration;
      if (!read.field.checked) { this.autoRead = false; this.voice.stopSpeech(); return; }
      void call('connection.require', {capability:'speech'}).then(()=>{if(generation===this.readGeneration && read.field.checked)this.autoRead=true;}).catch(error=>{if(generation!==this.readGeneration)return;read.field.checked=false;this.autoRead=false;this.report(error);});
    });
    const settings = this.details('角色设定与记忆', this.button('编辑设定', () => this.showPersona()), this.button('管理记忆', () => this.showMemories()),
      this.button('导出对话', async () => { if (await call('session.export')) this.host.toast('对话已导出'); }),
      this.button('清空对话', async () => { if (!confirm('清空当前角色的对话？保存的记忆和设定仍会保留。')) return; await call('session.clear'); this.requestId = ''; this.setBusy(false); await this.loadSession(); }));
    this.status.setAttribute('role', 'status');
    this.chat.append(toolbar, this.messages, this.attachments, this.draft,
      this.row(this.button('＋ 图片', () => this.addAttachment('image.attach')), this.button('当前画面', () => this.addAttachment('image.capture')), record),
      this.row(read.node, this.button('停止朗读', () => this.voice.stopSpeech())), this.row(this.stopButton, this.sendButton), this.status, settings);
  }
  private async loadSession(): Promise<void> {
    const revision = ++this.sessionRevision;
    const session = await call<Conversation>('session');
    if (revision !== this.sessionRevision || this.sending || this.requestId) return;
    this.messages.replaceChildren();
    for (const turn of session.turns) {
      this.addMessage('user', turn.user || `[图片 × ${turn.imageCount}]`);
      this.addMessage('assistant', turn.assistant || ({pending:'上次回复已中断',error:'回复失败，可重新发送',canceled:'已停止回复'}[turn.status] || ''));
    }
    if (!session.turns.length) this.messages.append(element('p', '连接你自己的 AI，让角色陪你聊天。', 'chat-empty'));
    this.scrollMessages();
  }
  private addMessage(role: string, text: string): HTMLElement {
    this.messages.querySelector('.chat-empty')?.remove();
    const node = element('div', text, `chat-message ${role}`); this.messages.append(node); return node;
  }
  private scrollMessages(): void { this.messages.scrollTop = this.messages.scrollHeight; }
  private setBusy(busy: boolean): void { this.sending = busy; this.sendButton.disabled = busy; this.stopButton.hidden = !busy; }
  private async send(): Promise<void> {
    const text = this.draft.value.trim(); if (this.requestId || this.sending || (!text && !this.images.length)) return;
    ++this.sessionRevision;
    this.voice.stopSpeech(); this.voice.cancelRecording(); this.setBusy(true); this.status.textContent = '正在连接…';
    this.replyText = ''; this.reply = null; this.lastRequestId = ''; this.earlyEvents.length = 0;
    try {
      const started = await call<{requestId: string}>('chat', { text, images: this.images });
      this.requestId = started.requestId;
      this.addMessage('user', text || `[图片 × ${this.images.length}]`); this.reply = this.addMessage('assistant', '…');
      this.draft.value = ''; this.images = []; this.renderAttachments();
      for (const event of this.earlyEvents.splice(0)) this.onEvent(event);
    } catch (error) { this.setBusy(false); throw error; }
  }
  private onEvent(event: CompanionEvent): void {
    if (event.characterId !== this.host.characterId || event.requestId === this.lastRequestId) return;
    // IPC events can beat invoke's response by one task; never lose the first chunk.
    if (!this.requestId) { if (this.sendButton.disabled && this.earlyEvents.length < 1000) this.earlyEvents.push(event); return; }
    if (event.requestId !== this.requestId) return;
    if (event.type === 'text') {
      this.replyText += event.delta || ''; if (this.reply) this.reply.textContent = this.replyText; this.status.textContent = '正在回复…'; this.scrollMessages();
    } else if (['done','error','canceled'].includes(event.type)) {
      this.lastRequestId = this.requestId; this.requestId = ''; this.setBusy(false);
      this.status.textContent = event.type === 'done' ? '回复完成' : event.error || '已停止';
      if (event.type === 'done') { this.host.speech(event.text || this.replyText); if (this.autoRead) void this.voice.speak(event.text || this.replyText,text=>{this.status.textContent=text;}).catch(error => this.report(error)); }
      if (this.reply && !this.replyText) this.reply.textContent = this.status.textContent;
    }
  }
  private async addAttachment(action: string): Promise<void> {
    if (this.images.length >= 3) throw new Error('每条消息最多附加三张图片。');
    const image = action==='image.capture'?await this.chooseCapture():await call<ImageAttachment | null>(action);
    if (image) { if(this.images.length >= 3) throw new Error('每条消息最多附加三张图片。'); this.images.push(image); this.renderAttachments(); }
  }
  private async chooseCapture(): Promise<ImageAttachment|null>{
    const sources=await call<{id:string;name:string;thumbnail:string}[]>('image.sources');
    const modal=this.modal('选择一次画面'),grid=element('div','','capture-grid');
    modal.content.append(element('p','先选择并预览，按发送后才交给你配置的视觉服务。','workspace-hint'),grid);
    if(!sources.length)grid.append(element('p','没有可截取的画面。'));
    return new Promise(resolve=>{
      let result:ImageAttachment|null=null;
      modal.dialog.addEventListener('close',()=>resolve(result),{once:true});
      for(const source of sources){
        const button=this.button('',async()=>{const image=await call<ImageAttachment>('image.capture',{sourceId:source.id});if(!modal.dialog.open)return;result=image;modal.close();},'secondary-button capture-choice');
        const preview=element('img');preview.src=source.thumbnail;preview.alt=source.name;
        button.append(preview,element('span',source.name));grid.append(button);
      }
    });
  }
  private renderAttachments(): void {
    this.attachments.replaceChildren();
    this.images.forEach((image, index) => {
      const preview = element('img'); preview.src = `data:${image.mime};base64,${image.base64}`; preview.alt = `附件 ${index + 1}`;
      const item = this.row(preview, this.button('移除', () => { this.images.splice(index, 1); this.renderAttachments(); })); this.attachments.append(item);
    });
  }
  private modal(title: string): { dialog: HTMLDialogElement; content: HTMLElement; close: () => void } {
    const dialog = element('dialog', '', 'workspace-dialog'), content = element('div', '', 'dialog-content');
    const feedback=element('p','','workspace-status dialog-feedback');feedback.setAttribute('role','status');content.append(feedback);
    const close = (): void => dialog.close();
    dialog.append(this.row(element('h2', title), this.button('关闭 ×', close)), content);
    dialog.addEventListener('close', () => { dialog.remove(); if (!document.querySelector('dialog[open]')) delete document.body.dataset.nativeDialog; this.draft.focus(); }, { once: true });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog); document.body.dataset.nativeDialog = 'true'; dialog.showModal(); return { dialog, content, close };
  }
  private async showConnections(initialCapability: Capability = 'chat'): Promise<void> {
    const connections = await call<Connection[]>('connections');
    const modal = this.modal('你自己的 AI 连接');
    modal.content.append(element('p', '云服务或本机服务均可。密钥仅加密保存在这台电脑；调用费用由所填服务收取。', 'workspace-hint'));
    const select = element('select'); for (const [id, name] of capabilities) { const option = element('option', name); option.value = id; select.append(option); }
    select.setAttribute('aria-label', '能力'); const fields = element('div'); modal.content.append(select, fields);
    select.value = initialCapability;
    const render = (): void => {
      const capability = select.value as Capability, saved = connections.find(item => item.capability === capability)!;
      const endpoint = this.input('基础地址（含 /v1 等前缀）', saved.endpoint || 'https://api.openai.com/v1');
      const model = this.input('模型名称', saved.model), key = this.input(saved.hasKey ? '新密钥（留空保留）' : 'API 密钥（本机免密服务可留空）', '', 'password'); key.field.autocomplete = 'new-password';
      const voice = this.input('音色', saved.voice), tools = this.input('允许角色动作与专注工具', '', 'checkbox'); tools.field.checked = saved.tools;
      const clear = this.input('清除已存密钥', '', 'checkbox'), message = element('p', '', 'workspace-status'); message.setAttribute('role','status');
      if(saved.error)message.textContent=`${saved.error} 重新保存时会先备份原配置。本地角色功能可继续使用。`;
      const save = async (): Promise<void> => {
        const updated = await call<Connection[]>('connection.save', { capability, endpoint: endpoint.field.value, model: model.field.value, apiKey: key.field.value, clearKey: clear.field.checked, voice: voice.field.value, tools: tools.field.checked });
        connections.splice(0, connections.length, ...updated); key.field.value = ''; clear.field.checked = false; message.textContent = '连接已保存';
      };
      fields.replaceChildren(endpoint.node, model.node, key.node, clear.node);
      if (capability === 'speech') fields.append(voice.node);
      if (['chat','vision'].includes(capability)) fields.append(tools.node);
      const testLabel=capability==='speech'?'保存并试听':capability==='transcription'?'保存并录音测试':capability==='image'?'保存并生成测试图':'保存并验证';
      const imagePreview=element('img');imagePreview.className='postcard-preview';imagePreview.alt='接口生成测试';
      const test=this.button(testLabel,async()=>{
        await save();
        if(capability==='speech') await this.voice.speak('你好，我是你的桌面伙伴。',text=>{message.textContent=text;});
        else if(capability==='transcription')await this.voice.record(text=>{message.textContent=`识别结果：${text}`;},text=>{message.textContent=text;test.textContent=this.voice.recording?'停止测试录音':testLabel;});
        else if(capability==='image'){message.textContent='正在生成测试图…';const image=await this.generateImage('A small green leaf on a plain white background, simple illustration.');imagePreview.src=`data:${image.mime};base64,${image.base64}`;message.textContent='图像生成成功';}
        else {const result=await call<{message:string}>('connection.test',{capability});message.textContent=result.message;}
      });
      fields.append(this.row(this.button('保存连接', save, 'primary-button'), test,
        this.button('移除', async () => { if (!confirm('移除这项能力的连接与本机密钥？')) return; const updated = await call<Connection[]>('connection.remove', {capability}); connections.splice(0, connections.length, ...updated); render(); })), message);
      fields.append(element('p','测试会调用你配置的服务并使用相应额度。','workspace-hint'),imagePreview);
      if(capability==='image')fields.append(this.button('停止生成',()=>this.stopImage()));
    };
    select.addEventListener('change', render); render();
  }
  async handleImport(result: CharacterImportResult): Promise<boolean> {
    if (result.preview) { await this.previewImport(result.preview); return true; }
    if (result.repair) { await this.repairImport(result.repair); return true; }
    return false;
  }
  private previewImport(preview: NonNullable<CharacterImportResult['preview']>): Promise<void> {
    return new Promise(resolve => {
      const modal = this.modal(`预览 · ${preview.manifest.displayName}`), canvas = element('canvas'), progress = element('p', '正在加载真实角色…', 'workspace-status');
      canvas.className = 'import-preview-canvas'; canvas.setAttribute('aria-label','导入角色预览');
      let accepted = false, viewer: AvatarRuntime | null = null, generation = 0;
      let manifest=preview.manifest;
      const accept = this.button('确认导入角色库', async () => { const result = await call<CharacterImportResult>('import.accept',{token:preview.token}); accepted = true; modal.close(); this.host.toast(`已导入 ${result.character?.displayName || preview.manifest.displayName}`); }, 'primary-button'); accept.disabled = true;
      const contactStatus=element('p','','workspace-hint');
      const configure=this.button('用自己的 AI 调整碰撞',()=>{
        const diagnosis=viewer?.springContactConfigurationSnapshot();if(diagnosis?.status!=='generated')return;
        const dialog=this.modal('AI 碰撞配置'),description=element('pre',JSON.stringify({bodyMesh:diagnosis.bodyMesh,colliders:diagnosis.colliders},null,2),'repair-diagnosis');
        const output=element('pre','','repair-diagnosis');let revision=0;
        const apply=this.button('采用方案并重新预览',async()=>{
          if(!modal.dialog.open)return;
          const updated=await call<typeof manifest>('import.contact.apply',{token:preview.token});
          if(!modal.dialog.open)return;
          manifest=updated;dialog.close();startViewer();
        },'primary-button');apply.hidden=true;
        const analyze=this.button('同意发送以上诊断，生成方案',async()=>{
          const current=++revision;apply.hidden=true;
          let plan:{summary:string;configuration:unknown};
          try{plan=await call('import.contact.plan',{token:preview.token,diagnosis,consent:true});}
          catch(error){if(current===revision&&dialog.dialog.open&&modal.dialog.open)throw error;return;}
          if(current!==revision||!dialog.dialog.open||!modal.dialog.open)return;
          output.textContent=JSON.stringify(plan,null,2);apply.hidden=false;
        },'primary-button');
        dialog.content.append(element('p','只发送下方骨骼名、网格索引与碰撞半径，调用你自己的文字 API。方案只调整身体以内的碰撞范围，不上传模型、不改原文件；采用后必须重新加载预览。','workspace-hint'),description,analyze,output,apply,this.button('取消',dialog.close));
        dialog.dialog.addEventListener('close',()=>{++revision;void call('import.contact.cancel',{token:preview.token}).catch(()=>{});},{once:true});
        modal.dialog.addEventListener('close',dialog.close,{once:true});
      });configure.hidden=true;
      const actionSelect=element('select');actionSelect.setAttribute('aria-label','预览动作');
      const previewActions:[ReactionName,string][]=[...reactions,['joy','开心'],['surprised','惊讶'],['angry','生气'],['sleepy','困倦'],['poke','轻碰'],['lookAround','环顾'],['nod','点头'],['shakeHead','摇头'],['shy','害羞'],['sway','摇摆']];
      for(const [value,label]of previewActions){const option=element('option',label);option.value=value;actionSelect.append(option);}
      modal.content.append(canvas, progress, element('p', `结构错误 ${preview.quality.errors} · 提醒 ${preview.quality.warnings}；请旋转并试动作，确认外观。`, 'workspace-hint'),
        this.row(...[0,90,180,270].map(angle=>this.button(`${angle}°`,()=>viewer?.setRotation((angle>180?angle-360:angle)*Math.PI/180)))),
        this.row(actionSelect,this.button('试动作',()=>viewer?.triggerReaction(actionSelect.value as ReactionName)),this.button('行走',()=>viewer?.setAutonomy({action:'walk',direction:1})),this.button('恢复待机',()=>{viewer?.setAutonomy({action:'idle',direction:1});viewer?.resetPose();})),contactStatus,configure,this.row(accept,this.button('取消导入',modal.close)));
      if(preview.warnings?.length)modal.content.append(this.details('转换检查提醒',element('p',preview.warnings.join('\n'),'workspace-hint')));
      this.host.runtime.setSuspended(true);
      const startViewer=()=>{
      const current=++generation;viewer?.dispose();accept.disabled=true;configure.hidden=true;contactStatus.textContent='';
      viewer = new AvatarRuntime(canvas,{...this.host.bootstrap, modelUrl:preview.modelUrl, character:manifest, pmxPhysicsUrl:preview.pmxPhysicsUrl,pmxPhysicsError:undefined,setupRequired:false,stageSuspended:false,
        settings:{...this.host.bootstrap.settings,zoom:0.95,rotationY:0,activeCharacterId:manifest.id,autonomousBehavior:false}}, {
        onProgress: (_value,detail)=>{progress.textContent=detail;}, onReady:()=>{
          if(current!==generation||!modal.dialog.open)return;
          const contact=viewer?.springContactConfigurationSnapshot();
          if(manifest.contactConfiguration)contactStatus.textContent=contact?.status==='generated'
            ?`已生成 ${contact.colliders.length} 个身体内接碰撞体，关联 ${contact.joints} 个摇摆关节；请检查所有方向与动作。`
            :contact?.status==='no-springs'?'没有可用摇摆骨骼，未生成布料物理。':'未能可靠识别身体网格，保留原模型；请使用带完整物理配置的来源。';
          configure.hidden=contact?.status!=='generated';
          void call('import.loaded',{token:preview.token}).then(()=>{if(current!==generation||!modal.dialog.open)return;accept.disabled=false;progress.textContent='模型已载入，检查外观后确认导入。';}).catch(error=>{if(modal.dialog.open)this.report(error);});
        }, onFatal:error=>{progress.textContent=error.message;accept.disabled=true;},
      });
      void viewer.load();
      };
      const resize = new ResizeObserver(()=>viewer?.resize()); resize.observe(canvas);
      modal.dialog.addEventListener('close',()=>{++generation;resize.disconnect();viewer?.dispose();viewer=null;this.host.runtime.setSuspended(false);if(!accepted)void call('import.discard',{token:preview.token});resolve();},{once:true});
      startViewer();
    });
  }
  private repairImport(repair: NonNullable<CharacterImportResult['repair']>): Promise<void> {
    return new Promise(resolve=>{
      const modal = this.modal('AI 导入修复'), diagnosis = element('pre', JSON.stringify(repair.diagnosis,null,2),'repair-diagnosis');
      const generated = this.input('允许使用图像 API 生成缺失贴图（会产生额外调用）','','checkbox');
      const planView = element('pre','','repair-diagnosis'); let continued = false, revision = 0;
      const apply = this.button('接受方案并修复副本',async()=>{
        const result = await call<CharacterImportResult>('repair.apply',{token:repair.token,generatedAllowed:generated.field.checked});
        if(!modal.dialog.open){if(result.preview)await call('import.discard',{token:result.preview.token});return;}
        continued=true;modal.close();try{await this.handleImport(result);}finally{resolve();}
      },'primary-button'); apply.hidden=true;
      const analyze = this.button('同意发送以上诊断，生成方案',async()=>{
        const current = ++revision;
        apply.hidden=true;
        const plan = await call<{summary:string;actions:unknown[];unresolved:string[]}>('repair.plan',{token:repair.token,generatedAllowed:generated.field.checked});
        if(current!==revision || !modal.dialog.open)return;
        planView.textContent=JSON.stringify(plan,null,2);apply.hidden=false;
      },'primary-button');
      generated.field.addEventListener('change',()=>{++revision;apply.hidden=true;planView.textContent='';});
      modal.content.append(element('p','仅发送下方文件名、节点与错误信息，使用你自己的文字 API。原始模型不上传、不覆盖。接受方案后在副本中修复，重新验证并预览。','workspace-hint'),diagnosis,generated.node,
        this.row(this.button('配置 AI 连接',()=>this.showConnections()),analyze),planView,apply,this.button('不修复，不导入',modal.close));
      modal.dialog.addEventListener('close',()=>{if(!continued){void call('import.discard',{token:repair.token});this.host.toast('已停止修复和导入；请更换完整角色源文件。');resolve();}},{once:true});
    });
  }
  private async showPersona(): Promise<void> {
    const session = await call<Conversation>('session'), modal = this.modal('角色设定');
    const persona = element('textarea'); persona.rows = 9; persona.maxLength = 6000; persona.value = session.persona; persona.placeholder = '性格、说话方式、与你的关系…'; persona.setAttribute('aria-label', '角色设定');
    const memory = this.input('允许 AI 记住对话中的偏好', '', 'checkbox'); memory.field.checked = session.autoRemember;
    modal.content.append(persona, memory.node, this.button('保存', async () => { await call('session.preferences', { persona: persona.value, autoRemember: memory.field.checked }); modal.close(); this.host.toast('角色设定已保存'); }, 'primary-button'));
  }
  private async showMemories(): Promise<void> {
    const modal = this.modal('角色记忆'), list = element('div'), text = this.input('添加一条记忆');
    const render = async (): Promise<void> => {
      const session = await call<Conversation>('session'); list.replaceChildren();
      for (const memory of session.memories) list.append(this.row(element('p', memory.text), this.button('忘记', async () => { await call('session.forget', { id: memory.id }); await render(); })));
      if (!session.memories.length) list.append(element('p', '还没有记忆。', 'workspace-hint'));
    };
    modal.content.append(list, text.node, this.button('记住', async () => { await call('session.remember', { text: text.field.value }); text.field.value = ''; await render(); })); await render();
  }
  private buildStudio(): void {
    this.studio.append(element('h2', '角色创作室'), element('p', '收藏动作、观察模型，记录属于你的桌面时刻。', 'workspace-hint'));
    const motionList = element('div'), loop = this.input('循环播放', '', 'checkbox');
    const natural=this.input('自然待机 · AIRI 动画','','checkbox');this.naturalToggle=natural.field;natural.field.checked=this.host.bootstrap.settings.naturalIdle;
    natural.field.disabled=this.host.bootstrap.character.motionProfile.profileId!=='generic-vrm';
    natural.field.addEventListener('change',()=>{void this.host.settingsPatch({naturalIdle:natural.field.checked}).catch(error=>{natural.field.checked=!natural.field.checked;this.report(error);});});
    const refresh = async (): Promise<void> => {
      const items = await call<MotionItem[]>('motions'); motionList.replaceChildren();
      for (const motion of items) motionList.append(this.row(element('span', motion.name), this.button('播放', () => this.playMotion(motion, loop.field.checked)), ...(motion.builtin?[]:[this.button('删除', async () => { if (confirm(`删除动作“${motion.name}”？`)) { await call('motion.remove', {id: motion.id}); await refresh(); } })])));
      if (!items.length) motionList.append(element('p', '导入本地 .vrma 动作，即可在当前角色上播放。', 'workspace-hint'));
    };
    const random = this.input('随机动作播放列表', '', 'checkbox');
    random.field.addEventListener('change', () => { this.playlist = random.field.checked; if (this.playlist) this.schedulePlaylist(); else clearTimeout(this.playlistTimer); });
    const motions = this.details('✦ 动作收藏', natural.node, this.row(this.button('导入 VRMA', async () => { if (await call('motion.import')) await refresh(); }), this.button('刷新', refresh), this.button('停止动作', () => {this.playlist=false;random.field.checked=false;clearTimeout(this.playlistTimer);this.host.runtime.stopMotion();})), loop.node, random.node, motionList);
    motions.addEventListener('toggle', () => { if (motions.open) void refresh().catch(error => this.report(error)); });
    this.studio.append(motions, this.observationPanel(), this.snapshotPanel(), this.postcardPanel(), this.scenePanel());
  }
  private async playMotion(motion: MotionItem, loop = false): Promise<void> {this.interruptScene();window.yachiyoDesk.noteUserActivity(); const bytes = await call<ArrayBuffer>('motion.load', { id: motion.id }); await this.host.runtime.playMotion(bytes, motion.name, loop); this.host.toast(`正在播放：${motion.name}`); }
  private localReaction(action:ReactionName):void{window.yachiyoDesk.noteUserActivity();this.host.runtime.triggerReaction(action);}
  private schedulePlaylist(): void {
    clearTimeout(this.playlistTimer);
    this.playlistTimer = window.setTimeout(() => {
      void (async () => { if (!this.playlist || document.hidden) return; if (this.host.runtime.canPlayLibraryMotion) {
        const items = await call<MotionItem[]>('motions'); if (items.length) await this.playMotion(items[Math.floor(Math.random() * items.length)]);
      } })().catch(error => { this.playlist = false; this.report(error); }).finally(() => { if (this.playlist) this.schedulePlaylist(); });
    }, 12000);
  }
  private observationPanel(): HTMLElement {
    let angle = 0, action = '待机';
    const angles = this.row(...[0,90,180,270].map(value => this.button(`${value}°`, () => { angle = value; this.host.rotate((value>180?value-360:value) * Math.PI / 180); })));
    const actions = this.row(...reactions.map(([id, name]) => this.button(name, () => {this.interruptScene(); action = name; this.localReaction(id); })));
    const note = this.input('观察记录'), log = element('p', '', 'workspace-hint');note.field.placeholder='填写你实际看到的结果';
    const physics=this.input('头发与衣物物理','','checkbox');this.physicsToggle=physics.field;physics.field.checked=this.host.bootstrap.settings.physics;
    physics.field.addEventListener('change',()=>{void this.host.settingsPatch({physics:physics.field.checked}).catch(error=>this.report(error));});
    return this.details('◇ 模型观察', angles, actions, physics.node,note.node, this.row(this.button('记录当前视角', () => {
      if(!note.field.value.trim())throw new Error('请填写实际观察结果。');
      if(this.observations.length>=1000)throw new Error('已达到 1000 条观察记录，请先导出。');
      this.observations.push({angle, action, result: note.field.value.trim().slice(0, 1000), time: new Date().toISOString(),physics:this.host.runtime.garmentContactSnapshot()}); log.textContent = `已记录 ${this.observations.length} 项观察`;
    }),this.button('保存观察截图',()=>call('image.save',{base64:this.host.runtime.captureImage().split(',')[1]})),
      this.button('导出记录', () => call('observation.export', { observations: this.observations,environment:{appVersion:this.host.bootstrap.appVersion,platform:this.host.bootstrap.platform,physics:this.host.runtime.garmentContactSnapshot(),anatomy:this.host.runtime.anatomySnapshot(),performance:this.host.runtime.getPerformanceStats()} })), this.button('恢复视角', () => {this.interruptScene();this.host.runtime.resetPose(); this.host.restoreView(); })), log);
  }
  private snapshotPanel(): HTMLElement {
    const list = element('div'), label = this.input('快照名称', '我的桌面');
    const refresh = async (): Promise<void> => {
      const items = await call<Snapshot[]>('snapshots'); list.replaceChildren();
      for (const item of items) list.append(this.row(element('span', `${item.label} · ${new Date(item.createdAt).toLocaleDateString()}`),
        this.button('查看 / 恢复', async () => {
          const preview = await call<Snapshot>('snapshot.preview', {id:item.id}), modal = this.modal('恢复预览');
          const changes = preview.changes || [];
          modal.content.append(element('p', changes.length ? `将修改 ${changes.length} 项设置，恢复前自动保留回滚快照。` : '当前设置与快照相同。'));
          for (const change of changes) modal.content.append(element('p', `${change.key}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`, 'snapshot-diff'));
          modal.content.append(this.button('确认恢复', async () => { await call('snapshot.restore', {id:item.id}); modal.close(); this.host.toast('设置已恢复'); await refresh(); }, 'primary-button'));
        }), this.button('导出', () => call('snapshot.export', {id:item.id}))));
      if (!items.length) list.append(element('p', '保存一份喜欢的设置，随时回来。', 'workspace-hint'));
    };
    const box = this.details('◷ 设置时光机', label.node, this.row(this.button('保存快照', async () => { await call('snapshot.create', {label: label.field.value}); await refresh(); }), this.button('导入快照', async () => { if (await call('snapshot.import')) await refresh(); })), list);
    box.addEventListener('toggle', () => { if (box.open) void refresh().catch(error => this.report(error)); }); return box;
  }
  private postcardPanel(): HTMLElement {
    const caption = this.input('明信片寄语', '今天也一起度过'), preview = element('img'); preview.alt = '明信片预览'; preview.className = 'postcard-preview';
    const theme = element('select'); for (const [value,name] of [['dawn','晨光'],['night','月夜'],['paper','奶油纸']]) { const option = element('option', name); option.value = value; theme.append(option); } theme.setAttribute('aria-label', '明信片背景');
    const capture = async (): Promise<void> => {
      const avatar = new Image(); avatar.src = this.host.runtime.captureImage(); await avatar.decode();
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1200;
      const context = canvas.getContext('2d')!;
      const colors = theme.value === 'night' ? ['#27243f','#6a638a'] : theme.value === 'paper' ? ['#faf1dc','#e6d7b8'] : ['#ffe8d6','#c9deee'];
      const gradient = context.createLinearGradient(0,0,900,1200); gradient.addColorStop(0,colors[0]); gradient.addColorStop(1,colors[1]); context.fillStyle = gradient; context.fillRect(0,0,900,1200);
      // Fit the visible character rather than the desktop window's transparent
      // padding, which otherwise makes the exported postcard mostly empty.
      const sample = document.createElement('canvas');sample.width=avatar.width;sample.height=avatar.height;
      const sampleContext=sample.getContext('2d')!;sampleContext.drawImage(avatar,0,0);
      const pixels=sampleContext.getImageData(0,0,sample.width,sample.height).data;
      let left=sample.width,top=sample.height,right=-1,bottom=-1;
      for(let y=0;y<sample.height;y++)for(let x=0;x<sample.width;x++)if(pixels[(y*sample.width+x)*4+3]>8){
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
      if(right<left)throw new Error('角色画面尚未就绪，请稍后再拍。');
      const width=right-left+1,height=bottom-top+1,scale = Math.min(850 / width, 1000 / height);
      context.drawImage(avatar,left,top,width,height,(900-width*scale)/2,50+(1000-height*scale)/2,width*scale,height*scale);
      sample.width=sample.height=0;
      context.fillStyle = theme.value === 'night' ? '#fff7e9' : '#47394d'; context.textAlign = 'center'; context.font = '32px "Microsoft YaHei"'; context.fillText(caption.field.value.slice(0, 28),450,1090,800);
      context.font = '18px "Segoe UI"'; context.fillText(new Date().toLocaleDateString() + '  ·  YachiyoDesk',450,1140);
      preview.src = canvas.toDataURL('image/png');
    };
    const prompt = this.input('请 AI 画一幅画', '柔和月光下的花园，插画风格');
    return this.details('▧ 桌面明信片', caption.node, theme, this.row(this.button('拍一张', capture), this.button('保存 PNG', async () => { if (!preview.src) await capture(); await call('image.save', {base64: preview.src.split(',')[1]}); })), preview,
      prompt.node, this.row(this.button('用自己的图像 API 生成', async () => { const image = await this.generateImage(prompt.field.value); preview.src = `data:${image.mime};base64,${image.base64}`; }),this.button('停止生成',()=>this.stopImage())));
  }
  private scenePanel(): HTMLElement {
    const custom = this.input('角色说的话', '喝口水，休息一下吧。'), minutes = this.input('休息提醒（分钟）', '30', 'number'); minutes.field.min = '1'; minutes.field.max = '180';
    const perform = async (scene: 'welcome'|'stretch'|'night'): Promise<void> => {
      this.interruptScene();
      const generation = ++this.sceneGeneration;
      const steps: [ReactionName,string,number][] = scene === 'welcome' ? [['greet','欢迎回来！',3600],['joy','今天想一起做些什么？',3000]]
        : scene === 'night' ? [['bow','今天也辛苦了。',3200],['sleepy','晚安，明天再见。',3600]]
          : [['stretch','和我一起伸个懒腰吧。',4500],['sway','转转肩膀，活动一下。',6200],['joy','舒服多了！',3000]];
      for (const [action, text, duration] of steps) {
        if (generation !== this.sceneGeneration) return; this.localReaction(action); this.host.speech(text);
        await new Promise<void>(resolve => {const timer=window.setTimeout(()=>{this.sceneWake=null;resolve();},duration);this.sceneWake=()=>{window.clearTimeout(timer);resolve();};});
      }
    };
    const state = element('p', '', 'workspace-status');
    const box = this.details('♡ 生活小剧场', this.row(this.button('欢迎回来', () => perform('welcome')), this.button('一起舒展', () => perform('stretch')), this.button('晚安', () => perform('night')), this.button('停止小剧场', () => { this.interruptScene(); this.host.runtime.resetPose(); })),
      custom.node, this.button('让角色说出来', () => {this.interruptScene(); this.localReaction('greet'); this.host.speech(custom.field.value); }), minutes.node,
      this.row(this.button('开启休息提醒', () => {
        const value = Number(minutes.field.value); if (!Number.isInteger(value) || value < 1 || value > 180) throw new Error('请填 1–180 分钟。');
        clearInterval(this.reminderTimer); this.reminderTimer = window.setInterval(() => {this.interruptScene(); this.localReaction('stretch'); this.host.speech(custom.field.value || '起来活动一下吧。'); }, value * 60000); state.textContent = `每 ${value} 分钟提醒一次（本次运行）`;
      }), this.button('关闭提醒', () => { clearInterval(this.reminderTimer); this.reminderTimer = 0; state.textContent = '提醒已关闭'; })), state);
    return box;
  }
  dispose(): void { ++this.readGeneration; ++this.sessionRevision; this.autoRead=false; this.removeEvents(); this.voice.dispose(); this.playlist = false; clearTimeout(this.playlistTimer); clearInterval(this.reminderTimer);this.interruptScene(); void call('cancel'); }
}
