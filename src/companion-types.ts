export type Capability = 'chat' | 'vision' | 'transcription' | 'speech' | 'image';
export interface Connection { capability: Capability; endpoint: string; model: string; voice: string; tools: boolean; configured: boolean; hasKey: boolean; error?: string }
export interface ImageAttachment { mime: string; base64: string }
export interface CompanionEvent { requestId: string; characterId: string; type: 'text' | 'done' | 'canceled' | 'error' | 'action'; delta?: string; text?: string; error?: string; action?: string }
export interface Conversation { persona: string; autoRemember: boolean; memories: {id: string; text: string}[]; turns: {id: string; user: string; assistant: string; imageCount: number; status: string}[] }
export interface MotionItem { id: string; name: string; sha256: string; importedAt: string; builtin?: boolean }
export interface Snapshot { id: string; label: string; createdAt: string; changes?: {key: string; before: unknown; after: unknown}[] }

const nativeDialogs = new Set(['image.attach','image.capture','microphone','session.export','image.save','motion.import','snapshot.import','snapshot.export','observation.export']);
export class ConnectionRequired extends Error {
  constructor(message: string, readonly capability: Capability) { super(message); }
}
let dialogDepth = 0;
export async function companionRequest<T = unknown>(action: string, input?: unknown): Promise<T> {
  const native = nativeDialogs.has(action);
  if (native) { dialogDepth++; document.body.dataset.nativeDialog = 'true'; }
  try {
    const result = await window.yachiyoDesk.companionRequest<T>(action, input);
    if (!result.ok) {
      if (result.code === 'AI_CONNECTION_REQUIRED' && result.capability) throw new ConnectionRequired(result.error || '请先接入 AI。', result.capability);
      throw new Error(result.error || '操作失败，请重试。');
    }
    return result.data;
  } finally { if (native && --dialogDepth === 0 && !document.querySelector('dialog[open]')) delete document.body.dataset.nativeDialog; }
}
