'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let pendingOpen = null;
const versionArg = process.argv.find((arg) => arg.startsWith('--nextspace-version='));
const appVersion = versionArg ? versionArg.slice('--nextspace-version='.length) : null;

ipcRenderer.on('desktop:open-call', (_event, url) => {
  pendingOpen = typeof url === 'string' ? url : null;
  window.dispatchEvent(new CustomEvent('nextspace:desktop-open', { detail: pendingOpen }));
});

contextBridge.exposeInMainWorld('nextspaceDesktop', Object.freeze({
  isDesktop: true,
  // Builds before 1.1 have no version here (and no self-updater): the site offers them a download.
  appVersion,
  /** Ask the desktop app to look for a newer build now (it shows the result itself). */
  checkForUpdates() {
    return ipcRenderer.invoke('desktop:check-updates');
  },
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
