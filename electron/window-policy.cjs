'use strict';

// Inspired by AIRI's privileged-window navigation boundary. Keep model/UI
// content inside this window separate from pages opened in the system browser.
function protectCompanionWindow(window, shell, microphoneAllowed = () => false) {
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
  // A short-lived grant is created only after the user's recording consent.
  // Camera/screen capture and unrelated permissions remain denied.
  contents.session.setPermissionCheckHandler((requester, permission, _origin, details) =>
    requester === contents && permission === 'media' && details?.mediaType === 'audio' && microphoneAllowed());
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => callback(Boolean(
    requester === contents && permission === 'media' && details?.mediaTypes?.length
    && details.mediaTypes.every(type => type === 'audio') && microphoneAllowed())));
}

module.exports = { protectCompanionWindow };
