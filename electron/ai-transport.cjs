'use strict';

const MAX_JSON = 24 * 1024 * 1024;
function parseJson(value) { try { return JSON.parse(value); } catch { throw new Error('接口返回的数据格式无效，请检查兼容接口路径。'); } }

async function responseBytes(response, maximum = MAX_JSON) {
  if (!response.body) throw new Error('接口返回了空响应。');
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > maximum) throw new Error('接口响应过大，已停止读取。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function request(connection, route, { signal, body, form, fetcher = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('接口响应超时。')), 120000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetcher(`${connection.endpoint}${route}`, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        ...(!form ? { 'Content-Type': 'application/json' } : {}) },
      body: form || JSON.stringify(body),
    });
    if (!response.ok) {
      // Do not echo provider bodies: proxies can include credentials or request data.
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403 ? '接口拒绝认证，请检查使用者自己的密钥和权限。'
        : response.status === 429 ? '接口额度或速率受限，请稍后重试。'
          : `接口请求失败（HTTP ${response.status}），请检查模型与接口能力。`);
    }
    return { response, dispose: () => clearTimeout(timeout) };
  } catch (error) { clearTimeout(timeout); throw error; }
}

async function jsonRequest(connection, route, body, options = {}) {
  const { response, dispose } = await request(connection, route, { ...options, body });
  try { return parseJson((await responseBytes(response)).toString('utf8')); }
  finally { dispose(); }
}

/** Stream framing survives UTF-8 splits, CRLF, multiple data lines and tool fragments. */
async function chatCompletion(connection, messages, { signal, tools, onText = () => {}, fetcher } = {}) {
  const { response, dispose } = await request(connection, '/chat/completions', { signal, fetcher,
    body: { model: connection.model, messages, stream: true, ...(tools?.length ? { tools } : {}) } });
  let text = '', size = 0, completed = false, finishedStream = false; const calls = new Map();
  const consume = data => {
    for (const choice of data.choices || []) {
      if (choice.index && choice.index !== 0) continue;
      if (choice.finish_reason != null) completed = true;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string') { text += delta.content; if (text.length > 60000) throw new Error('回复过长，已停止接收。'); onText(delta.content); }
      for (const item of delta.tool_calls || []) {
        const index = item.index ?? calls.size;
        const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id = item.id;
        if (item.function?.name) call.function.name += item.function.name;
        if (item.function?.arguments) call.function.arguments += item.function.arguments;
        if ((!calls.has(index) && calls.size >= 8) || call.function.arguments.length > 16000) throw new Error('接口工具请求过大。');
        calls.set(index, call);
      }
    }
  };
  try {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      consume(parseJson((await responseBytes(response, 2 * 1024 * 1024)).toString('utf8')));
    } else {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', data = [], finished = false;
      const line = value => {
        if (!value) {
          if (data.length) { const payload = data.join('\n'); data = []; if (payload === '[DONE]') finished = true; else consume(parseJson(payload)); }
        } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
      };
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { buffer += decoder.decode(); if (buffer) line(buffer.replace(/\r$/, '')); line(''); finishedStream = finished; break; }
          size += chunk.value.length; if (size > 2 * 1024 * 1024) throw new Error('接口响应过大。');
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline; while ((newline = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, newline).replace(/\r$/, '')); buffer = buffer.slice(newline + 1); }
          if (finished) { finishedStream = true; break; }
          if (buffer.length > 256000) throw new Error('接口流格式无效。');
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (response.headers.get('content-type')?.includes('text/event-stream') && !completed && !finishedStream) throw new Error('接口流在回复完成前中断，请重新发送。');
    return { role: 'assistant', content: text || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
  } finally { dispose(); }
}

async function speech(connection, input, options) {
  const { response, dispose } = await request(connection, '/audio/speech', { ...options,
    body: { model: connection.model, voice: connection.voice || 'alloy', input: String(input).slice(0, 4000), response_format: 'mp3' } });
  try {
    if (!/^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '')) throw new Error('语音接口未返回可播放的音频。');
    const bytes = await responseBytes(response, 16 * 1024 * 1024);
    if (!bytes.length) throw new Error('语音接口返回了空音频。');
    return { mime: 'audio/mpeg', base64: bytes.toString('base64') };
  } finally { dispose(); }
}

async function transcribe(connection, audio, options) {
  if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4'].includes(audio?.mime)
    || typeof audio.base64 !== 'string' || audio.base64.length > 28 * 1024 * 1024) throw new Error('录音格式或大小不受支持。');
  const form = new FormData();
  const extension = ({'audio/webm':'webm','audio/ogg':'ogg','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'})[audio.mime];
  form.set('model', connection.model); form.set('file', new Blob([Buffer.from(audio.base64, 'base64')], { type: audio.mime }), `recording.${extension}`);
  const { response, dispose } = await request(connection, '/audio/transcriptions', { ...options, form });
  try {
    const result = parseJson((await responseBytes(response, 1024 * 1024)).toString('utf8'));
    if (typeof result.text !== 'string') throw new Error('接口未返回识别文本。');
    return result.text.slice(0, 12000);
  } finally { dispose(); }
}

async function generateImage(connection, prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('图像描述需为 1–4000 字。');
  const result = await jsonRequest(connection, '/images/generations', {
    model: connection.model, prompt, n: 1, size: '1024x1024',
    ...(/^gpt-image/i.test(connection.model) ? {} : { response_format: 'b64_json' }),
  }, options);
  const item = result.data?.[0];
  if (typeof item?.b64_json === 'string' && item.b64_json.length <= 22 * 1024 * 1024) return Buffer.from(item.b64_json, 'base64');
  if (typeof item?.url === 'string') {
    const url = new URL(item.url);
    const local=hostname=>['localhost','127.0.0.1','[::1]'].includes(hostname);
    const localProvider=local(new URL(connection.endpoint).hostname);
    if ((url.protocol !== 'https:' && !(url.protocol==='http:' && localProvider && local(url.hostname)))
      || url.username || url.password || (local(url.hostname) && !localProvider)) throw new Error('接口返回了不受支持的图片地址。');
    // Download without API credentials. Redirects cannot forward them to another host.
    const response = await (options.fetcher || fetch)(url.href, { redirect: 'error', signal: options.signal || AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('无法下载接口生成的图片。');
    return responseBytes(response, 16 * 1024 * 1024);
  }
  throw new Error('接口没有返回图片，请检查图像模型配置。');
}
module.exports = { responseBytes, request, jsonRequest, chatCompletion, speech, transcribe, generateImage };
