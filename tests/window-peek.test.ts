import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {subtractRect,occlusionRegion,planPeek,nativeRegion,WindowPeek}=require('../electron/window-peek.cjs');
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
const viewport={left:220,right:340,footY:838,avatarHeight:300,canvasWidth:560,canvasHeight:840};
const target={id:'10',x:700,y:200,width:800,height:650};
const areas=[{x:0,y:0,width:1920,height:1080}];
function harness(){
  let bounds={x:100,y:100,width:560,height:840},allowed=true;
  const original={...bounds},shape=vi.fn(),command=vi.fn(),end=vi.fn();
  const peek=new WindowPeek({bounds:()=>({...bounds}),viewport:()=>viewport,areas:()=>areas,allowed:()=>allowed,
    now:()=>Date.now(),shape,command,end,move:(next:any)=>{bounds={...next};}});
  peek.tracked([target]);
  return {peek,original,shape,command,end,get bounds(){return bounds;},interrupt:()=>{allowed=false;}};
}
describe('native window peek geometry and lifecycle',()=>{
  it('converts local DIP regions to physical pixels at the Windows boundary',()=>{
    expect(nativeRegion([{x:80,y:20,width:120,height:300}],2.25)).toEqual([{x:180,y:45,width:270,height:675}]);
    expect(nativeRegion([],1.5)).toEqual([]);
    expect(nativeRegion([{x:561,y:841,width:1,height:1}],2.25)[0].x).toBeGreaterThan(560*2.25);
  });
  it('subtracts the entire covered body and input region, including two overlapping windows',()=>{
    const bounds={x:100,y:100,width:560,height:840};
    const covers=[{x:300,y:100,width:500,height:900},{x:100,y:300,width:300,height:700}];
    const regions=occlusionRegion(bounds,covers);
    expect(regions).toEqual([{x:0,y:0,width:200,height:200}]);
    for(const rect of regions)for(const cover of covers)
      expect(subtractRect({...rect,x:rect.x+bounds.x,y:rect.y+bounds.y},cover)).toHaveLength(1);
    expect(occlusionRegion(bounds,[{x:0,y:0,width:2000,height:2000}])).toEqual([{x:561,y:841,width:1,height:1}]);
  });
  it('rejects fullscreen edges, small windows, unknown model geometry and fully covered edges',()=>{
    const bounds={x:100,y:100,width:560,height:840};
    expect(planPeek([{id:'full',...areas[0]}],bounds,viewport,areas)).toBeNull();
    expect(planPeek([{...target,height:250}],bounds,viewport,areas)).toBeNull();
    expect(planPeek([target],bounds,null,areas)).toBeNull();
    expect(planPeek([{id:'front',x:0,y:0,width:1920,height:1080},target],bounds,viewport,areas)).toBeNull();
  });
  it('uses DIP geometry on negative-coordinate monitors and never chooses an offscreen reveal',()=>{
    const bounds={x:-1400,y:0,width:560,height:840};
    const plan=planPeek([{...target,x:-1100}],bounds,viewport,[{x:-1920,y:0,width:1920,height:1080}]);
    expect(plan).toMatchObject({side:-1});
    expect(plan.peekX+viewport.left).toBeGreaterThanOrEqual(-1920);
    expect(plan.peekX+viewport.right).toBeLessThanOrEqual(0);
  });
  it('fully hides the model, peeks twice, and restores exact placement and rectangular region',()=>{
    const h=harness();expect(h.peek.start()).toEqual({ok:true});
    const tracking=setInterval(()=>h.peek.tracked([target]),50);
    vi.advanceTimersByTime(900);
    expect(h.command).toHaveBeenLastCalledWith(expect.objectContaining({phase:'hidden'}));
    const avatar={x:h.bounds.x+viewport.left,y:h.bounds.y+viewport.footY-viewport.avatarHeight,width:120,height:300};
    expect(subtractRect(avatar,target)).toEqual([]);
    vi.advanceTimersByTime(1300);
    expect(h.command).toHaveBeenLastCalledWith({phase:'peek',side:-1,progress:1});
    expect(h.bounds.x+viewport.left).toBeLessThan(target.x);
    expect(h.bounds.x+viewport.right).toBeGreaterThan(target.x);
    vi.advanceTimersByTime(4500);clearInterval(tracking);
    expect(h.peek.busy()).toBe(false);expect(h.bounds).toEqual(h.original);
    expect(h.shape).toHaveBeenLastCalledWith([]);expect(h.end).toHaveBeenLastCalledWith('complete');
  });
  it('follows a moving target and restores when that window disappears or resizes',()=>{
    const h=harness();h.peek.start();vi.advanceTimersByTime(800);
    const before={...h.bounds};h.peek.tracked([{...target,x:target.x+60,y:target.y+40}]);
    expect(h.bounds.x).toBe(before.x+60);expect(h.bounds.y).toBe(before.y+40);
    h.peek.tracked([]);expect(h.bounds).toEqual(h.original);expect(h.shape).toHaveBeenLastCalledWith([]);
    h.peek.tracked([target]);h.peek.start();h.peek.tracked([{...target,width:target.width-50}]);
    expect(h.peek.busy()).toBe(false);expect(h.end).toHaveBeenLastCalledWith('window-resized');
  });
  it('cancels on modal/drag/lock lifecycle interruption and when geometry polling stalls',()=>{
    const h=harness();h.peek.start();h.interrupt();vi.advanceTimersByTime(16);
    expect(h.peek.busy()).toBe(false);expect(h.bounds).toEqual(h.original);expect(h.shape).toHaveBeenLastCalledWith([]);
    const stalled=harness();stalled.peek.start();vi.advanceTimersByTime(1900);
    expect(stalled.peek.busy()).toBe(false);expect(stalled.end).toHaveBeenLastCalledWith('tracking-timeout');
  });
  it('cancels if the original reveal side becomes covered instead of silently switching sides',()=>{
    const h=harness();h.peek.start();vi.advanceTimersByTime(800);
    expect(h.peek.session.plan.side).toBe(-1);
    h.peek.tracked([{id:'new-front',x:target.x-200,y:target.y,width:250,height:target.height},target]);
    expect(h.peek.busy()).toBe(false);expect(h.bounds).toEqual(h.original);expect(h.shape).toHaveBeenLastCalledWith([]);
  });
  it('keeps the current pointer-grab position on activity rather than jumping back before a drag',()=>{
    const h=harness();h.peek.start();vi.advanceTimersByTime(800);const grabbed={...h.bounds};
    h.peek.cancel('activity');expect(h.bounds).toEqual(grabbed);expect(h.shape).toHaveBeenLastCalledWith([]);expect(h.peek.busy()).toBe(false);
  });
  it('reveals in front of background apps while remaining hidden behind the selected foreground window',()=>{
    const h=harness(),windows=[target,{id:'background',...areas[0]}];h.peek.tracked(windows);h.peek.start();
    const tracking=setInterval(()=>h.peek.tracked(windows),50);vi.advanceTimersByTime(2200);clearInterval(tracking);
    expect(h.command).toHaveBeenLastCalledWith({phase:'peek',side:-1,progress:1});
    expect(h.shape).toHaveBeenLastCalledWith(occlusionRegion(h.bounds,[target]));
    expect(h.shape.mock.lastCall![0]).not.toEqual(occlusionRegion(h.bounds,windows));
  });
});
