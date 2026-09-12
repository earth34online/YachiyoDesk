'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('yachiyoDesk', {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setClickThrough: (ignore) => ipcRenderer.send('window:set-click-through', Boolean(ignore)),
  beginWindowDrag: (screenX, screenY) => ipcRenderer.send('window:drag-start', { screenX, screenY }),
  updateWindowDrag: (screenX, screenY) => ipcRenderer.send('window:drag-move', { screenX, screenY }),
  endWindowDrag: (screenX, screenY) => ipcRenderer.send('window:drag-end', { screenX, screenY }),
  noteUserActivity: () => ipcRenderer.send('autonomy:activity'),
  setInteractionPanelOpen: (open) => ipcRenderer.send('autonomy:panel', Boolean(open)),
  showContextMenu: (point) => ipcRenderer.send('window:context-menu', point),
  resetWindow: () => ipcRenderer.invoke('window:reset'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  createDesktopShortcut: () => ipcRenderer.invoke('app:create-desktop-shortcut'),
  getFocusStatus: () => ipcRenderer.invoke('focus:get'),
  startFocus: (mode, minutes) => ipcRenderer.invoke('focus:start', { mode, minutes }),
  stopFocus: () => ipcRenderer.invoke('focus:stop'),
  getPetStatus: () => ipcRenderer.invoke('pet:get-status'),
  petInteract: (action) => ipcRenderer.invoke('pet:interact', action),
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  importCharacter: () => ipcRenderer.invoke('characters:import'),
  importPmxCharacter: () => ipcRenderer.invoke('characters:import-pmx'),
  switchCharacter: (id) => ipcRenderer.invoke('characters:switch', id),
  removeCharacter: (id) => ipcRenderer.invoke('characters:remove', id),
  runtimeReady: (details) => ipcRenderer.send('runtime:ready', details),
  runtimeViewportBounds: (details) => ipcRenderer.send('runtime:viewport-bounds', details),
  runtimeTelemetry: (details) => ipcRenderer.send('runtime:telemetry', details),
  runtimeError: (details) => ipcRenderer.send('runtime:error', details),
  onCommand: (callback) => subscribe('app:command', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onFocusChanged: (callback) => subscribe('focus:changed', callback),
  onPetStatusChanged: (callback) => subscribe('pet:status-changed', callback),
});
