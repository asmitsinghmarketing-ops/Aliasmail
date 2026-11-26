'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let pendingOpen = null;

ipcRenderer.on('desktop:open-call', (_event, url) => {
  pendingOpen = typeof url === 'string' ? url : null;
  window.dispatchEvent(new CustomEvent('nextspace:desktop-open', { detail: pendingOpen }));
});

contextBridge.exposeInMainWorld('nextspaceDesktop', Object.freeze({
  isDesktop: true,
  showIncomingCall(call) {
    ipcRenderer.send('desktop:incoming-call', call);
  },
  dismissIncomingCall(callId) {
    ipcRenderer.send('desktop:dismiss-call', callId);
  },
  consumeOpen() {
    const value = pendingOpen;
    pendingOpen = null;
    return value;
  },
}));
