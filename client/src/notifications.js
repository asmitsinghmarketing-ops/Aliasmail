// Notifications on this device (Web Push): registers the service worker (public/sw.js), asks the
// browser for permission, and hands the subscription to the server (server/src/push.js).
import { api } from './api.js';
import { nativeCallsAvailable, nativeCallStatus, requestNativeCallPermission } from './nativeCalls.js';

export const supported = () => nativeCallsAvailable() || ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/** Start the service worker (notifications are shown by it). Safe to call more than once. */
export function registerWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js').then((registration) => {
    registration.update().catch(() => {});
    return registration;
  }).catch(() => null);
}

async function currentSubscription() {
  const reg = await registerWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : isIos() ? 'iPhone/iPad' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Device';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
};

// The server's public key comes as base64url; the browser wants bytes.
function keyBytes(base64url) {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** This device: { permission, on, mail, notes } (on = it gets notifications). */
export async function status() {
  if (nativeCallsAvailable()) {
    const native = await nativeCallStatus();
    if (!native.token) return { permission: native.permission || 'prompt', on: false, native: true, configured: native.configured !== false };
    const info = await api('/push/native/status', { method: 'POST', body: { token: native.token } });
    return { permission: native.permission || 'granted', on: Boolean(info.device), native: true, configured: native.configured !== false, ...(info.device || { mail: true, notes: true, tasks: true, calls: true }) };
  }
  if (!supported()) return { permission: 'unsupported', on: false };
  const sub = await currentSubscription();
  const info = await api('/push/status', { method: 'POST', body: { endpoint: sub?.endpoint || '' } });
  return { permission: Notification.permission, on: Boolean(sub && info.device), ...(info.device || { mail: true, notes: true }), publicKey: info.publicKey };
}

/** Ask permission (needs a click) and subscribe this device. */
export async function enable() {
  if (nativeCallsAvailable()) {
    const native = await requestNativeCallPermission();
    if (native.permission !== 'granted') throw new Error('Notifications were not allowed. Allow them in Android Settings, then try again.');
    if (!native.configured || !native.token) throw new Error('Android calling is not connected to Firebase yet. Add google-services.json to the app and rebuild it.');
    await api('/push/native/subscribe', { method: 'POST', body: { token: native.token, device: deviceName() } });
    return;
  }
  if (!supported()) throw new Error('This browser can’t show notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.' : 'Notifications weren’t allowed.');
  const reg = await registerWorker();
  if (!reg) throw new Error('Couldn’t start notifications in this browser.');
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/status', { method: 'POST', body: {} });
  let sub = await reg.pushManager.getSubscription();
  // Made with an older key (the server's keys changed): start again.
  if (sub && sub.options?.applicationServerKey) {
    const old = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (old !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
}

export async function disable() {
  if (nativeCallsAvailable()) {
    const native = await nativeCallStatus();
    if (native.token) await api('/push/native/unsubscribe', { method: 'POST', body: { token: native.token } }).catch(() => {});
    return;
  }
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function setKinds(prefs) {
  if (nativeCallsAvailable()) {
    const native = await nativeCallStatus();
    if (native.token) await api('/push/native/device', { method: 'PATCH', body: { token: native.token, ...prefs } });
    return;
  }
  const sub = await currentSubscription();
  if (sub) await api('/push/device', { method: 'PATCH', body: { endpoint: sub.endpoint, ...prefs } });
}

export const test = () => api('/push/test', { method: 'POST' });
