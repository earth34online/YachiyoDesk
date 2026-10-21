import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopContacts, exposedPlatforms, contactGeometry, selectSupport } = require('../electron/desktop-contacts.cjs');
const { clampDragPosition } = require('../electron/window-drag.cjs');
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
  let bounds = {x:150,y:100,width:560,height:840}, active = true;
  const settings = {desktopContacts:true,windowContacts:true,lockPosition:false};
  const viewport = {left:230,right:330,canvasWidth:560,canvasHeight:840,footY:838,footLeft:265,footRight:295,avatarHeight:280};
  const area = {x:0,y:0,width:1920,height:1080};
  const command = vi.fn(), settled = vi.fn();
  const contact = new DesktopContacts({bounds:()=>({...bounds}),viewport:()=>viewport,settings:()=>settings,
    now:()=>Date.now(),active:()=>active,area:()=>area,command,settled,
    move:(x:number,y:number)=>{bounds={...bounds,x:Math.round(x),y:Math.round(y)};}});
  return {contact,settings,command,settled,area,viewport,get bounds(){return bounds;},setBounds:(next:any)=>{bounds={...bounds,...next};},pause:(value:boolean)=>{active=!value;}};
}
describe('desktop contact contracts',()=>{
  it('lands on the first exposed top crossed by both feet, even across a long frame',()=>{
    const h=harness();h.setBounds({y:-400});
    h.contact.updateWindows([{id:'lower',x:200,y:750,width:900,height:200},{id:'upper',x:200,y:600,width:900,height:100}]);
    h.contact.drop(1500);vi.advanceTimersByTime(240);
    expect(h.bounds.y+838).toBe(600);expect(h.contact.support.id).toBe('upper');
    expect(h.command).toHaveBeenLastCalledWith(expect.objectContaining({phase:'land',impact:expect.any(Number)}));
    expect(h.settled).toHaveBeenCalledOnce();
  });
  it('does not land on a hidden edge or on a sliver under just one foot',()=>{
    const area={x:0,y:0,width:1200,height:1000};
    const surfaces=exposedPlatforms([{id:'front',x:400,y:100,width:200,height:500},
      {id:'back',x:100,y:300,width:900,height:500}],area);
    expect(surfaces.filter((s:any)=>s.id==='back')).toEqual([
      {id:'back',left:100,right:400,y:300},{id:'back',left:600,right:1000,y:300}]);
    expect(selectSupport(surfaces,{x:0},{footLeft:390,footRight:420},250,350)).toBeNull();
  });
  it('keeps normal drop physics when window contacts are disabled and lands exactly at the desktop',()=>{
    const h=harness();h.settings.windowContacts=false;h.setBounds({y:-500});
    h.contact.updateWindows([{id:'app',x:100,y:600,width:1000,height:500}]);h.contact.drop();
    vi.advanceTimersByTime(2000);expect(h.bounds.y+838).toBe(1080);expect(h.contact.support.id).toBe('screen');
    expect(h.contact.timer).toBeNull();
  });
  it('follows a supporting window translation and falls when it closes or is occluded',()=>{
    const h=harness();h.setBounds({y:-400});
    h.contact.updateWindows([{id:'app',x:100,y:600,width:1000,height:400}]);h.contact.drop();vi.advanceTimersByTime(1200);
    h.contact.updateWindows([{id:'app',x:160,y:680,width:1000,height:300}]);
    expect(h.bounds.x).toBe(210);expect(h.bounds.y+838).toBe(680);
    h.contact.updateWindows([{id:'cover',x:100,y:200,width:1000,height:700},{id:'app',x:160,y:680,width:1000,height:300}]);
    expect(h.contact.fall).not.toBeNull();vi.advanceTimersByTime(2000);expect(h.bounds.y+838).toBe(1080);
  });
  it('uses foot span rather than transparent window width for platform patrol range',()=>{
    const h=harness();h.setBounds({y:-400});h.contact.updateWindows([{id:'app',x:400,y:600,width:100,height:300}]);
    h.contact.drop();vi.advanceTimersByTime(1000);
    expect(h.contact.range()).toEqual({minimumX:135,maximumX:205});
    expect(h.contact.floorY()).toBe(-238);
  });
  it('pauses for UI without accumulating elapsed fall time; new drag/disposal cancels all timers',()=>{
    const h=harness();h.contact.drop();h.pause(true);const before=h.bounds;
    vi.advanceTimersByTime(30000);expect(h.bounds).toEqual(before);
    h.pause(false);vi.advanceTimersByTime(16);expect(h.bounds.y-before.y).toBeLessThan(2);
    h.contact.cancel();expect(vi.getTimerCount()).toBe(0);expect(h.command).toHaveBeenLastCalledWith({phase:'idle'});
  });
  it('an already grounded drop is finite and settled once; position lock prevents motion',()=>{
    const h=harness();h.setBounds({y:242});h.contact.drop();vi.advanceTimersByTime(500);
    expect(h.bounds.y).toBe(242);expect(h.settled).toHaveBeenCalledOnce();
    h.settings.lockPosition=true;expect(h.contact.drop()).toBe(false);expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps negative-monitor DIP geometry and permits transparent host margins above the screen',()=>{
    const viewport={left:230,right:330,canvasWidth:560,canvasHeight:840,footY:838,footLeft:265,footRight:295,avatarHeight:280};
    const geometry=contactGeometry({width:560,height:840},viewport);
    expect(geometry.footY).toBe(838);
    const position=clampDragPosition({x:-1000,y:-400},{x:-1920,y:0,width:1920,height:1080},{width:560,height:840},viewport);
    expect(position).toEqual({x:-1000,y:-400});
    expect(clampDragPosition({x:-1000,y:-999},{x:-1920,y:0,width:1920,height:1080},{width:560,height:840},viewport).y).toBe(-558);
  });
  it('interrupts edge gestures while preserving the support contract',()=>{
    const h=harness();h.contact.edge(-1);expect(h.contact.busy()).toBe(true);
    expect(h.command).toHaveBeenLastCalledWith({phase:'edge',direction:-1,wall:true});
    h.contact.interruptReaction();expect(h.contact.busy()).toBe(false);
  });
  it('releases a platform moved so high the avatar would be clipped above the display',()=>{
    const h=harness();h.setBounds({y:-400});h.contact.updateWindows([{id:'app',x:100,y:600,width:1000,height:400}]);
    h.contact.drop();vi.advanceTimersByTime(1200);
    h.contact.updateWindows([{id:'app',x:100,y:100,width:1000,height:400}]);
    expect(h.contact.support).toBeNull();expect(h.contact.fall).not.toBeNull();
    expect(h.bounds.y+838).toBe(600);vi.advanceTimersByTime(2000);expect(h.bounds.y+838).toBe(1080);
  });
});
