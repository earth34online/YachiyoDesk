'use strict';

// Electron's native window region clips drawing AND input. All coordinates are
// DIP, matching screenToDipRect and BrowserWindow.getBounds. Windows setShape
// forwards physical pixel regions; the host scales at that final boundary.
function nativeRegion(rects,scale) {
  return rects.map(r=>{const x=Math.ceil(r.x*scale),y=Math.ceil(r.y*scale);
    return {x,y,width:Math.max(1,Math.floor((r.x+r.width)*scale)-x),height:Math.max(1,Math.floor((r.y+r.height)*scale)-y)};});
}
function subtractRect(rect, cover) {
  const x=Math.max(rect.x,cover.x), y=Math.max(rect.y,cover.y);
  const right=Math.min(rect.x+rect.width,cover.x+cover.width), bottom=Math.min(rect.y+rect.height,cover.y+cover.height);
  if (right<=x || bottom<=y) return [rect];
  return [
    {x:rect.x,y:rect.y,width:rect.width,height:y-rect.y},
    {x:rect.x,y:bottom,width:rect.width,height:rect.y+rect.height-bottom},
    {x:rect.x,y,width:x-rect.x,height:bottom-y},
    {x:right,y,width:rect.x+rect.width-right,height:bottom-y},
  ].filter(r=>r.width>0 && r.height>0);
}
function occlusionRegion(bounds, windows) {
  let regions=[{x:0,y:0,width:bounds.width,height:bounds.height}];
  for (const window of windows) regions=regions.flatMap(rect=>subtractRect(rect,
    {x:Math.floor(window.x-bounds.x),y:Math.floor(window.y-bounds.y),width:Math.ceil(window.width),height:Math.ceil(window.height)}));
  // [] restores the rectangular window in Electron; a region outside the
  // client area represents full occlusion without hiding/suspending the app.
  return regions.length ? regions : [{x:bounds.width+1,y:bounds.height+1,width:1,height:1}];
}
function planPeek(windows,bounds,viewport,areas,required) {
  if (!viewport || !['left','right','footY','avatarHeight','canvasWidth','canvasHeight'].every(k=>Number.isFinite(viewport[k]))) return null;
  const sx=bounds.width/viewport.canvasWidth, sy=bounds.height/viewport.canvasHeight;
  const left=viewport.left*sx,right=viewport.right*sx, width=right-left;
  const top=(viewport.footY-viewport.avatarHeight)*sy, height=viewport.avatarHeight*sy;
  if(width<=0 || height<=0) return null;
  const candidates=[];
  for(let index=0;index<windows.length;index++) {
    const target=windows[index];
    if(required && target.id!==required.id)continue;
    if(target.width<width*1.5+24 || target.height<height+40) continue;
    for(const side of [-1,1]) {
      if(required && side!==required.side)continue;
      const edge=target.x+(side===1?target.width:0);
      const hiddenX=side===-1 ? edge-left+width*.15 : edge-right-width*.15;
      const peekX=side===-1 ? edge-left-width*.55 : edge-right+width*.55;
      // Preserve the pet's current height whenever the target can contain it;
      // do not fly to the target's top edge simply to begin a side peek.
      const y=Math.max(target.y+20-top,Math.min(bounds.y,target.y+target.height-20-viewport.footY*sy));
      const visible={x:peekX+left,y:y+top,width,height};
      const area=areas.find(a=>visible.x>=a.x && visible.x+width<=a.x+a.width && visible.y>=a.y && visible.y+height<=a.y+a.height);
      if(!area) continue;
      const strip={x:side===-1?edge-width*.55:edge,y:visible.y,width:width*.55,height};
      const exposed=windows.slice(0,index).reduce((r,w)=>r.flatMap(part=>subtractRect(part,w)),[strip]);
      if(exposed.reduce((sum,r)=>sum+r.width*r.height,0)<strip.width*strip.height*.8) continue;
      candidates.push({id:target.id,side,hiddenX,peekX,y,target:{...target},distance:Math.hypot(bounds.x-peekX,bounds.y-y)});
    }
  }
  return candidates.sort((a,b)=>a.distance-b.distance)[0] || null;
}
const smooth=t=>t*t*(3-2*t);
class WindowPeek {
  constructor(host) {this.host=host;this.windows=[];this.session=null;this.timer=null;}
  busy(){return Boolean(this.session);}
  updateWindows(windows) {
    this.windows=windows;
    if(!this.session)return;
    const target=windows.find(w=>w.id===this.session.plan.id);
    if(!target){this.cancel('window-gone');return;}
    const next=planPeek(windows,this.session.original,this.host.viewport(),this.host.areas(),this.session.plan);
    if(!next){this.cancel('window-changed');return;}
    const p=this.session.plan, dx=target.x-p.target.x,dy=target.y-p.target.y;
    // Resizing changes the hidden body containment; recompute on the same side.
    if(target.width!==p.target.width || target.height!==p.target.height){this.cancel('window-resized');return;}
    p.hiddenX+=dx;p.peekX+=dx;p.y+=dy;p.target={...target};
    this.step();
  }
  start() {
    this.cancel('restart');
    if(!this.host.allowed())return {ok:false,error:'请先关闭面板、解除位置锁定，并开启桌面接触和窗口边缘互动。'};
    const original=this.host.bounds(),plan=planPeek(this.windows,original,this.host.viewport(),this.host.areas());
    if(!plan)return {ok:false,error:'附近没有足够大且侧边可见的窗口。请打开一个普通窗口后重试。'};
    this.session={original,plan,started:this.host.now(),lastRead:this.host.now()};
    this.host.begin?.();
    this.step();this.timer=setInterval(()=>{try{this.step();}catch{this.cancel('native-region-error');}},16);
    return {ok:true};
  }
  step() {
    const s=this.session;if(!s)return;
    if(!this.host.allowed()){this.cancel('interrupted');return;}
    // A stalled geometry helper must never leave an invisible, unrecoverable pet.
    if(this.host.now()-s.lastRead>1800){this.cancel('tracking-timeout');return;}
    const elapsed=this.host.now()-s.started,p=s.plan;
    let phase='enter',progress=0,x=p.hiddenX,y=p.y;
    if(elapsed<650){progress=smooth(elapsed/650);x=s.original.x+(p.hiddenX-s.original.x)*progress;y=s.original.y+(p.y-s.original.y)*progress;}
    else if(elapsed<1250){phase='hidden';}
    else if(elapsed<1950){phase='peek';progress=smooth((elapsed-1250)/700);x=p.hiddenX+(p.peekX-p.hiddenX)*progress;}
    else if(elapsed<3050){phase='peek';progress=1;x=p.peekX;}
    else if(elapsed<3750){phase='peek';progress=1-smooth((elapsed-3050)/700);x=p.hiddenX+(p.peekX-p.hiddenX)*progress;}
    else if(elapsed<4250){phase='hidden';}
    else if(elapsed<4950){phase='peek';progress=smooth((elapsed-4250)/700);x=p.hiddenX+(p.peekX-p.hiddenX)*progress;}
    else if(elapsed<5650){phase='peek';progress=1;x=p.peekX;}
    else if(elapsed<6500){phase='return';progress=smooth((elapsed-5650)/850);x=p.peekX+(s.original.x-p.peekX)*progress;y=p.y+(s.original.y-p.y)*progress;}
    else {this.cancel('complete');return;}
    const bounds={...s.original,x:Math.round(x),y:Math.round(y)};
    // The pet sits just behind the chosen window, above its background apps.
    // A maximized background app must not swallow every exposed peek pixel.
    const occluders=this.windows.slice(0,this.windows.findIndex(window=>window.id===p.id)+1);
    // Keep pixels valid at BOTH positions across WM_MOVE. Fully blanking the
    // window before every move can flash at compositor boundaries; the
    // intersection preserves all continuously exposed pixels instead.
    const previous=this.host.bounds();
    const atNextPosition=occluders.map(window=>({...window,x:window.x+previous.x-bounds.x,y:window.y+previous.y-bounds.y}));
    this.host.shape(occlusionRegion(previous,[...occluders,...atNextPosition]));
    this.host.move(bounds);
    this.host.shape(occlusionRegion(bounds,occluders));
    this.host.command({phase,side:p.side,progress});
  }
  tracked(windows){if(this.session)this.session.lastRead=this.host.now();this.updateWindows(windows);}
  cancel(reason='cancel') {
    clearInterval(this.timer);this.timer=null;
    const s=this.session;this.session=null;
    if(!s)return;
    // A pointer press must grab the pet where it is now, not teleport it to
    // the pre-game position before the drag offset is captured.
    try{if(reason!=='activity' && reason!=='drag')this.host.move(s.original);}finally{this.host.shape([]);this.host.command({phase:'idle',side:s.plan.side,progress:0});this.host.end?.(reason);}
  }
}
module.exports={subtractRect,occlusionRegion,planPeek,nativeRegion,WindowPeek};
