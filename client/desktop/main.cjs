'use strict';

const path = require('node:path');
const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog,
  ipcMain, nativeImage, session, shell,
} = require('electron');

const APP_URL = 'https://mail.nexternconsultancy.com';
const APP_ORIGIN = new URL(APP_URL).origin;
const PARTITION = 'persist:nextspace';
const hiddenAtLaunch = process.argv.includes('--hidden');

let mainWindow = null;
let tray = null;
let quitting = false;
const callNotifications = new Map();

app.setName('Nextspace');
app.setAppUserModelId('com.nexternconsultancy.nextspace.desktop');

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => showMain());

const iconPath = () => path.join(__dirname, 'assets', 'nextspace.png');

function trustedUrl(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function trustedSender(event) {
  return trustedUrl(event.senderFrame?.url || event.sender?.getURL());
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.flashFrame(false);
}

function openCall(callId, action = '') {
  if (!callId || !mainWindow || mainWindow.isDestroyed()) return;
  showMain();
  const query = new URLSearchParams({ call: callId });
  if (action === 'answer') query.set('answer', '1');
  if (action === 'decline') query.set('decline', '1');
  mainWindow.webContents.send('desktop:open-call', `/?${query}`);
}

function dismissCall(callId) {
  const notification = callNotifications.get(callId);
  if (notification) notification.close();
  callNotifications.delete(callId);
}

function notifyIncomingCall(raw) {
  const callId = String(raw?.id || '').slice(0, 200);
  const fromName = String(raw?.fromName || 'Someone').slice(0, 100);
  if (!callId) return;
  dismissCall(callId);
  mainWindow?.flashFrame(true);

  if (!Notification.isSupported()) {
    tray?.displayBalloon({
      title: `Incoming call from ${fromName}`,
      content: 'Open Nextspace to answer the call.',
      icon: nativeImage.createFromPath(iconPath()),
      noSound: false,
      respectQuietTime: false,
    });
    tray?.once('balloon-click', () => openCall(callId));
    return;
  }

  const notification = new Notification({
    title: `Incoming call from ${fromName}`,
    body: raw?.video ? 'Incoming Nextspace video call' : 'Incoming Nextspace voice call',
    icon: iconPath(),
    silent: false,
    timeoutType: 'never',
    urgency: 'critical',
    actions: [
      { type: 'button', text: 'Accept' },
      { type: 'button', text: 'Decline' },
    ],
  });
  callNotifications.set(callId, notification);
  notification.on('click', () => openCall(callId));
  notification.on('action', (event) => {
    const index = Number(event?.actionIndex ?? -1);
    if (index === 0) openCall(callId, 'answer');
    else if (index === 1) openCall(callId, 'decline');
    dismissCall(callId);
  });
  notification.on('close', () => {
    if (callNotifications.get(callId) === notification) callNotifications.delete(callId);
  });
  notification.show();
}

function configurePermissions() {
  const appSession = session.fromPartition(PARTITION);
  const allowed = new Set(['media', 'notifications', 'geolocation', 'display-capture', 'clipboard-sanitized-write']);
  appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => trustedUrl(requestingOrigin) && allowed.has(permission));
  appSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(trustedUrl(details.requestingUrl) && allowed.has(permission));
  });
  appSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trustedUrl(request.securityOrigin) || !request.userGesture) {
      callback(null);
      return;
    }
    try {
      const sources = (await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })).slice(0, 12);
      if (!sources.length) return callback(null);
      const cancelId = sources.length;
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Share your screen',
        message: 'Choose a screen or window to present',
        detail: 'Only the selected source will be visible to call participants.',
        buttons: [...sources.map((source) => source.name || 'Screen'), 'Cancel'],
        cancelId,
        defaultId: 0,
        noLink: true,
      });
      callback(choice.response === cancelId ? null : { video: sources[choice.response] });
    } catch {
      callback(null);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    show: !hiddenAtLaunch,
    title: 'Nextspace',
    icon: iconPath(),
    backgroundColor: '#f8f9fc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (trustedUrl(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (trustedUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  void mainWindow.loadURL(APP_URL);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Nextspace', click: showMain },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: openAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Nextspace',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath()));
  tray.setToolTip('Nextspace ? running in the background');
  tray.on('click', showMain);
  tray.on('double-click', showMain);
  rebuildTrayMenu();
}

ipcMain.on('desktop:incoming-call', (event, call) => {
  if (trustedSender(event)) notifyIncomingCall(call);
});
ipcMain.on('desktop:dismiss-call', (event, callId) => {
  if (trustedSender(event)) dismissCall(String(callId || ''));
});

app.whenReady().then(() => {
  configurePermissions();
  createWindow();
  createTray();
});
app.on('activate', showMain);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {});
