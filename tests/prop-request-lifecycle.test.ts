import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionUI } from '../src/CompanionUI';

afterEach(()=>vi.unstubAllGlobals());
describe('prop UI asynchronous cancellation',()=>{
  it.each(['motions','motion.load'])('does not resurrect a closed prop request while %s is pending',async pendingAction=>{
    let finish!:(value:unknown)=>void;
    const item={id:'builtin-consume',name:'饮用动作',builtin:true};
    const ipc=vi.fn(async(action:string)=>action===pendingAction?await new Promise(resolve=>{finish=resolve;}):{ok:true,data:[item]});
    const playMotion=vi.fn(),closeWorkspace=vi.fn();
    vi.stubGlobal('window',{yachiyoDesk:{companionRequest:ipc,noteUserActivity:vi.fn()}});
    const ui=Object.create(CompanionUI.prototype) as any;
    Object.assign(ui,{motionRequest:0,sceneGeneration:0,sceneWake:null,disposed:false,host:{runtime:{playMotion},closeWorkspace,toast:vi.fn(),bootstrap:{character:{motionProfile:{profileId:'generic-vrm'}}}}});
    const request=ui.playSavedMotion(item.id);
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    ui.interruptScene();
    finish({ok:true,data:pendingAction==='motions'?[item]:new ArrayBuffer(8)});
    await request;
    expect(playMotion).not.toHaveBeenCalled();expect(closeWorkspace).not.toHaveBeenCalled();
  });
});
