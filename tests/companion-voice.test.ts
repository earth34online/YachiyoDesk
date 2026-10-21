import {afterEach,describe,expect,it,vi} from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('../src/companion-types',()=>({companionRequest:rpc}));
import {CompanionVoice} from '../src/CompanionVoice';
const voices:CompanionVoice[]=[];
afterEach(()=>{for(const voice of voices.splice(0))voice.dispose();vi.unstubAllGlobals();rpc.mockReset();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function setup(){
 rpc.mockImplementation(async()=>true);
 const track={stop:vi.fn()},stream={getTracks:()=>[track]},getUserMedia=vi.fn(async()=>stream);
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});vi.stubGlobal('window',{setTimeout,clearTimeout});
 vi.stubGlobal('cancelAnimationFrame',vi.fn());
 class Recorder{
  static instances:Recorder[]=[];static isTypeSupported(){return true;}
  state='inactive';mimeType='audio/webm';onstop:(()=>void)|null=null;ondataavailable:unknown;onerror:unknown;
  constructor(){Recorder.instances.push(this);}start(){this.state='recording';}stop(){this.state='inactive';}
 }
 vi.stubGlobal('MediaRecorder',Recorder);
 const voice=new CompanionVoice(vi.fn());voices.push(voice);return{voice,track,stream,getUserMedia,Recorder};
}
describe('voice resource ownership under asynchronous cancellation',()=>{
 it('does not open the microphone when a native authorization arrives after cancellation',async()=>{
  const f=setup(),permission=deferred<boolean>();rpc.mockImplementation((action:string)=>action==='microphone'?permission.promise:Promise.resolve(true));
  const started=f.voice.record(vi.fn(),vi.fn());f.voice.cancelRecording();permission.resolve(true);await started;
  expect(f.getUserMedia).not.toHaveBeenCalled();expect(f.voice.recording).toBe(false);
 });
 it('stops a stream that arrives after cancellation without retaining its device',async()=>{
  const f=setup(),device=deferred<any>();f.getUserMedia.mockReturnValue(device.promise);
  const started=f.voice.record(vi.fn(),vi.fn());await Promise.resolve();f.voice.cancelRecording();device.resolve(f.stream);await started;
  expect(f.track.stop).toHaveBeenCalled();expect(f.voice.recording).toBe(false);
 });
 it('an old stop event cannot release a newer recording',async()=>{
  const f=setup();await f.voice.record(vi.fn(),vi.fn());const first=f.Recorder.instances[0];f.voice.cancelRecording();
  const newerTrack={stop:vi.fn()};f.getUserMedia.mockResolvedValue({getTracks:()=>[newerTrack]});
  await f.voice.record(vi.fn(),vi.fn());first.onstop?.();
  expect(newerTrack.stop).not.toHaveBeenCalled();expect(f.voice.recording).toBe(true);
 });
 it('releases its audio URL when audio context creation fails',async()=>{
  const f=setup(),revoke=vi.fn();rpc.mockResolvedValue({mime:'audio/wav',base64:'YQ=='});
  vi.stubGlobal('URL',{createObjectURL:()=> 'blob:owned-audio',revokeObjectURL:revoke});
  vi.stubGlobal('Audio',class{pause(){}removeAttribute(){}load(){}});
  vi.stubGlobal('AudioContext',class{constructor(){throw new Error('Audio device unavailable');}});
  await expect(f.voice.speak('hello')).rejects.toThrow('Audio device unavailable');expect(revoke).toHaveBeenCalledWith('blob:owned-audio');
 });
});
