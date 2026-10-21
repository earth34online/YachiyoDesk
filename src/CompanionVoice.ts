import { companionRequest } from './companion-types';
import type { ImageAttachment } from './companion-types';

export class CompanionVoice {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timeout = 0;
  private generation = 0;
  private recordGeneration = 0;
  private recordRequestId = '';
  private startingRecording = false;
  private recordingStatus: ((text: string)=>void) | null = null;
  private audio: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private url = '';
  private frame = 0;
  private requestId = '';
  constructor(private readonly mouth: (value: number) => void) {}
  get recording(): boolean { return this.recorder?.state === 'recording'; }
  async record(onText: (text: string) => void, onStatus: (text: string) => void): Promise<void> {
    if (this.recording) { this.recorder?.stop(); return; }
    if(this.startingRecording){onStatus('正在等待麦克风授权…');return;}
    this.startingRecording=true;
    const generation = ++this.recordGeneration;this.recordingStatus=onStatus;
    if(this.recordRequestId)void companionRequest('cancel',{requestId:this.recordRequestId});this.recordRequestId='';
    try {
      if (!await companionRequest<boolean>('microphone') || generation !== this.recordGeneration) return;
      const stream=await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.recordGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream=stream;
      const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder=this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = []; let size = 0;
      recorder.ondataavailable = event => { size += event.data.size; chunks.push(event.data); if (size > 16 * 1024 * 1024 && recorder.state==='recording') recorder.stop(); };
      recorder.onerror=()=>{if(generation===this.recordGeneration){this.cancelRecording();onStatus('录音失败，请检查麦克风后重试。');}};
      recorder.onstop = () => {
        stream.getTracks().forEach(track=>track.stop());
        if(this.recorder===recorder){this.releaseRecording();this.recorder=null;}
        if (generation !== this.recordGeneration || !size) return;
        if(size>16*1024*1024){onStatus('录音超过 16 MB，请缩短后重试。');return;}
        onStatus('正在识别…'); this.recordRequestId = crypto.randomUUID();
        const requestId=this.recordRequestId;
        void blobAttachment(new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })).then(async audio => {
          if(generation!==this.recordGeneration)return;
          const text = await companionRequest<string>('transcribe', { audio: { ...audio, mime: audio.mime.split(';')[0] }, requestId });
          if (generation === this.recordGeneration) { onText(text); onStatus('识别完成，可编辑后发送'); }
        }).catch(error => { if (generation === this.recordGeneration) onStatus(error.message); }).finally(()=>{if(this.recordRequestId===requestId)this.recordRequestId='';});
      };
      recorder.start(250); onStatus('录音中 · 再按一次停止');
      this.timeout = window.setTimeout(() => {if(recorder.state==='recording')recorder.stop();}, 60000);
    } catch (error) { if(generation===this.recordGeneration)this.releaseRecording();throw error; }
    finally { if(generation===this.recordGeneration){this.startingRecording=false;await companionRequest('microphone.revoke');} }
  }
  private releaseRecording(): void {
    clearTimeout(this.timeout); this.timeout = 0;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
  }
  async speak(text: string, onStatus: (text: string)=>void = ()=>{}): Promise<void> {
    this.stopSpeech(); const generation = this.generation;
    onStatus('正在生成语音…');
    this.requestId = crypto.randomUUID();
    const response = await companionRequest<ImageAttachment>('speech', { text, requestId: this.requestId });
    if (generation !== this.generation) return;
    this.url = URL.createObjectURL(new Blob([Uint8Array.from(atob(response.base64), value => value.charCodeAt(0))], { type: response.mime }));
    try {
    const audio=this.audio = new Audio(this.url), context=this.context = new AudioContext();
    const source = context.createMediaElementSource(audio), analyser = context.createAnalyser(); analyser.fftSize = 256;
    source.connect(analyser); analyser.connect(context.destination);
    const samples = new Uint8Array(analyser.fftSize);
    const animate = (): void => {
      if(generation!==this.generation)return;
      analyser.getByteTimeDomainData(samples); let energy = 0;
      for (const value of samples) energy += ((value - 128) / 128) ** 2;
      this.mouth(Math.min(0.85, Math.sqrt(energy / samples.length) * 4));
      this.frame = requestAnimationFrame(animate);
    };
    audio.onended = () => {this.stopSpeech();onStatus('朗读结束');}; audio.onerror = () => {this.stopSpeech();onStatus('音频无法播放，请检查语音模型的输出格式。');};
    await context.resume();if(generation!==this.generation)return;
    await audio.play();if(generation===this.generation){onStatus('正在朗读…');animate();}
    } catch (error) { if(generation===this.generation)this.stopSpeech();throw error; }
  }
  stopSpeech(): void {
    ++this.generation; cancelAnimationFrame(this.frame); this.frame = 0;
    if(this.audio){this.audio.onended=null;this.audio.onerror=null;this.audio.pause();this.audio.removeAttribute('src');this.audio.load();this.audio=null;}
    void this.context?.close().catch(()=>{}); this.context = null;
    if (this.url) URL.revokeObjectURL(this.url); this.url = ''; this.mouth(0);
    if (this.requestId) void companionRequest('cancel', { requestId: this.requestId }); this.requestId = '';
  }
  cancelRecording(): void {
    ++this.recordGeneration;this.startingRecording=false;this.releaseRecording();if(this.recorder?.state==='recording')this.recorder.stop();this.recorder=null;
    void companionRequest('microphone.revoke');
    if(this.recordRequestId)void companionRequest('cancel',{requestId:this.recordRequestId});this.recordRequestId='';this.recordingStatus?.('录音已停止');
  }
  dispose(): void { this.stopSpeech(); this.cancelRecording(); }
}
export function blobAttachment(blob: Blob): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('媒体读取失败。'));
    reader.onload = () => resolve({ mime: blob.type, base64: String(reader.result).split(',')[1] }); reader.readAsDataURL(blob);
  });
}
