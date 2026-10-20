'use strict';

// Inspired by AIRI's privileged-window navigation boundary. Keep model/UI
// content inside this window separate from pages opened in the system browser.
function protectCompanionWindow(window, shell) {
  const contents = window.webContents;
  const openWebLink = raw => {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        Promise.resolve(shell.openExternal(url.href)).catch(() => {});
      }
    } catch { /* Malformed and local/executable URLs stay blocked. */ }
  };
  contents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url === contents.getURL()) return; // Preserve renderer reload/retry.
    event.preventDefault();
    openWebLink(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
  // Camera, microphone, geolocation and renderer notifications are not used
  // by this local companion. File dialogs and reminders belong to the main process.
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

module.exports = { protectCompanionWindow };
