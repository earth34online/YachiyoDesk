'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CAPABILITIES = Object.freeze(['chat', 'vision', 'transcription', 'speech', 'image']);
const isId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readJson(filename, fallback, maximum = 5 * 1024 * 1024) {
  if (!fs.existsSync(filename)) return structuredClone(fallback);
  if (fs.statSync(filename).size > maximum) throw new Error('本地数据过大，请先备份并整理。');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('本地数据无法读取，原文件已保留，请从备份恢复。'); }
}

function endpointUrl(value) {
  let url;
  try { url = new URL(text(value, 2048)); } catch { throw new Error('请填写完整的 API 基础地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('远程接口请使用 HTTPS；本机服务可使用 localhost 的 HTTP 地址。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密钥、查询参数或片段。');
  return url.href.replace(/\/+$/, '');
}

/** Credentials never leave the main process. Each installation owns its vault. */
class AiConnections {
  constructor(directory, secureStorage, { recover = false } = {}) {
    this.filename = path.join(directory, 'connections.json');
    this.secureStorage = secureStorage;
    try {
      this.data = readJson(this.filename, { version: 1, connections: {} });
      if (this.data.version !== 1 || !this.data.connections || typeof this.data.connections !== 'object' || Array.isArray(this.data.connections)) throw new Error('AI 连接配置版本无法识别，原文件已保留。');
    } catch (error) {
      if (!recover) throw error;
      this.loadError = error.message;
      this.data = { version: 1, connections: {} };
    }
  }
  preserveUnreadable() {
    if (!this.loadError) return;
    // An explicit save/remove repairs the vault; preserve its exact old bytes.
    fs.copyFileSync(this.filename, `${this.filename}.unreadable-${crypto.randomUUID()}.bak`, fs.constants.COPYFILE_EXCL);
  }
  describe() {
    return CAPABILITIES.map(capability => {
      const item = this.data.connections[capability];
      return { capability, endpoint: item?.endpoint || '', model: item?.model || '',
        voice: item?.voice || 'alloy', tools: item?.tools !== false,
        configured: Boolean(item?.endpoint && item?.model), hasKey: Boolean(item?.encryptedKey), ...(this.loadError ? {error: this.loadError} : {}) };
    });
  }
  save(request) {
    if (!CAPABILITIES.includes(request?.capability)) throw new Error('未知 AI 能力。');
    const endpoint = endpointUrl(request.endpoint), model = text(request.model, 200);
    if (!model) throw new Error('请填写模型名称。');
    const previous = this.data.connections[request.capability];
    if (previous?.encryptedKey && previous.endpoint !== endpoint && !request.clearKey && !request.apiKey) {
      throw new Error('接口地址已改变，请重新填写密钥，或明确清除旧密钥。');
    }
    let encryptedKey = request.clearKey ? undefined : previous?.encryptedKey;
    if (typeof request.apiKey === 'string' && request.apiKey.length) {
      if (request.apiKey.length > 4096 || /[\r\n]/.test(request.apiKey)) throw new Error('密钥格式无效。');
      if (!this.secureStorage?.isEncryptionAvailable()) throw new Error('系统加密存储不可用，未将密钥保存为明文。');
      encryptedKey = this.secureStorage.encryptString(request.apiKey).toString('base64');
    }
    const next = { endpoint, model, voice: text(request.voice, 100) || 'alloy', tools: request.tools !== false,
      ...(encryptedKey ? { encryptedKey } : {}) };
    const data = { ...this.data, connections: { ...this.data.connections, [request.capability]: next } };
    this.preserveUnreadable(); writeJson(this.filename, data); this.data = data; this.loadError = null;
    return this.describe();
  }
  remove(capability) {
    if (!CAPABILITIES.includes(capability)) throw new Error('未知 AI 能力。');
    const data = structuredClone(this.data); delete data.connections[capability];
    this.preserveUnreadable(); writeJson(this.filename, data); this.data = data; this.loadError = null; return this.describe();
  }
  get(capability) {
    if (this.loadError) throw Object.assign(new Error(`${this.loadError} 请在 AI 连接中重新保存配置；本地角色功能仍可使用。`), {code:'AI_CONNECTION_REQUIRED', capability});
    const item = this.data.connections[capability];
    if (!item) throw Object.assign(new Error(`尚未接入${({chat:'对话',vision:'视觉',transcription:'语音识别',speech:'语音合成',image:'图像生成'})[capability] || ''} API，请先配置你自己的 AI 连接。`), {code:'AI_CONNECTION_REQUIRED', capability});
    let apiKey = '';
    if (item.encryptedKey) {
      try { apiKey = this.secureStorage.decryptString(Buffer.from(item.encryptedKey, 'base64')); }
      catch { throw new Error('系统无法解密密钥，请在本机重新填写。'); }
    }
    return { ...item, endpoint: endpointUrl(item.endpoint), apiKey };
  }
}

class CompanionData {
  constructor(directory) { this.directory = directory; this.sessions = new Map(); }
  get(id) {
    if (!isId(id)) throw new Error('角色标识无效。');
    if (!this.sessions.has(id)) {
      const data = readJson(path.join(this.directory, `${id}.json`),
        { version: 1, generation: 0, persona: '', autoRemember: false, memories: [], turns: [] });
      if (data.version !== 1 || !Array.isArray(data.turns) || !Array.isArray(data.memories)) throw new Error('会话数据无法识别，原文件已保留。');
      this.sessions.set(id, data);
    }
    const cached=this.sessions.get(id);this.sessions.delete(id);this.sessions.set(id,cached);
    while(this.sessions.size>4)this.sessions.delete(this.sessions.keys().next().value);
    return structuredClone(cached);
  }
  update(id, operation) {
    const data = this.get(id); operation(data);
    if (JSON.stringify(data).length > 4 * 1024 * 1024 || data.turns.length > 2000) {
      throw new Error('会话已满，请导出或清空历史后继续。');
    }
    writeJson(path.join(this.directory, `${id}.json`), data); this.sessions.set(id, data); return this.get(id);
  }
  preferences(id, request) {
    return this.update(id, data => {
      if (typeof request?.persona === 'string') data.persona = text(request.persona, 6000);
      if (typeof request?.autoRemember === 'boolean') data.autoRemember = request.autoRemember;
    });
  }
  remember(id, content) {
    const value = text(content, 1000); if (!value) throw new Error('记忆不能为空。');
    return this.update(id, data => {
      if (data.memories.some(item => item.text === value)) return;
      if (data.memories.length >= 100) throw new Error('记忆已满，请先整理。');
      data.memories.push({ id: crypto.randomUUID(), text: value, createdAt: new Date().toISOString() });
    });
  }
  forget(id, memoryId) { return this.update(id, data => { data.memories = data.memories.filter(item => item.id !== memoryId); }); }
  clear(id) { return this.update(id, data => { data.turns = []; data.generation++; }); }
  begin(id, requestId, message, imageCount = 0) {
    return this.update(id, data => {
      if (data.turns.some(turn => turn.id === requestId)) throw new Error('这条消息已经发送，请勿重复提交。');
      data.turns.push({ id: requestId, user: text(message, 12000), imageCount, assistant: '', status: 'pending', createdAt: new Date().toISOString() });
    });
  }
  finish(id, requestId, generation, response, status, actions = []) {
    return this.update(id, data => {
      if (data.generation !== generation) return;
      const turn = data.turns.find(item => item.id === requestId);
      if (turn) Object.assign(turn, { assistant: response.slice(0, 60000), status, actions });
    });
  }
}

module.exports = { AiConnections, CompanionData, CAPABILITIES, endpointUrl, writeJson, readJson, isId };
