import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const { protectCompanionWindow } = createRequire(import.meta.url)('../electron/window-policy.cjs');
function harness() {
  const events = new Map<string, (...args:any[])=>any>();
  const contents = { getURL:()=> 'file:///app/dist/index.html', on:(name:string,fn:any)=>events.set(name,fn),
    setWindowOpenHandler:vi.fn(), session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn()} };
  const shell={openExternal:vi.fn().mockResolvedValue(undefined)};protectCompanionWindow({webContents:contents},shell);
  return { contents, shell, events, popup:contents.setWindowOpenHandler.mock.lastCall![0] };
}
describe('companion window boundary',()=>{
  it('preserves same-page reload while opening a web link outside the privileged renderer',()=>{
    const h=harness(),event={preventDefault:vi.fn()};
    h.events.get('will-navigate')!(event,'file:///app/dist/index.html');expect(event.preventDefault).not.toHaveBeenCalled();
    h.events.get('will-navigate')!(event,'https://example.com/guide');expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.shell.openExternal).toHaveBeenCalledWith('https://example.com/guide');
  });
  it.each(['file:///C:/Windows/notepad.exe','javascript:alert(1)','data:text/html,test','ms-settings:privacy','invalid url'])(
    'blocks %s in navigation, popups and redirects without invoking the shell',url=>{
      const h=harness(),event={preventDefault:vi.fn()};h.events.get('will-navigate')!(event,url);
      expect(h.popup({url})).toEqual({action:'deny'});h.events.get('will-redirect')!(event,url);
      expect(event.preventDefault).toHaveBeenCalledTimes(2);expect(h.shell.openExternal).not.toHaveBeenCalled();
    });
  it('denies renderer hardware permissions without changing native file-dialog or notification APIs',()=>{
    const h=harness(),reply=vi.fn();expect(h.contents.session.setPermissionCheckHandler.mock.lastCall![0]()).toBe(false);
    h.contents.session.setPermissionRequestHandler.mock.lastCall![0]({},'media',reply);expect(reply).toHaveBeenCalledWith(false);
  });
  it('handles the browser refusing an external link without an unhandled rejection',async()=>{
    const h=harness();h.shell.openExternal.mockRejectedValueOnce(Error('No handler'));
    expect(h.popup({url:'https://example.com'})).toEqual({action:'deny'});await Promise.resolve();
  });
});
