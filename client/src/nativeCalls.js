// Native Android notifications and call actions. Browsers continue to use Web Push; this bridge
// exists only so Android can wake the installed app after its WebView has been stopped.
import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeCalls = registerPlugin('NativeCalls');
export const nativeCallsAvailable = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const nativeCallStatus = () => NativeCalls.getStatus();
export const requestNativeCallPermission = () => NativeCalls.requestPermission();
export const dismissNativeCall = (callId) => (nativeCallsAvailable() ? NativeCalls.dismiss({ callId }).catch(() => {}) : Promise.resolve());
export const showNativeOngoingCall = ({ callId, title, video, startedAt }) => (
  nativeCallsAvailable()
    ? NativeCalls.showOngoing({ callId, title, video: Boolean(video), startedAt: startedAt || Date.now() }).catch(() => {})
    : Promise.resolve()
);

export const setNativeActiveCall = ({ callId, title, video }) => (
  nativeCallsAvailable()
    ? NativeCalls.setActiveCall({ callId, title, video: Boolean(video) }).catch(() => ({ supported: false, active: false }))
    : Promise.resolve({ supported: false, active: false })
);

export const clearNativeActiveCall = (callId) => (
  nativeCallsAvailable() ? NativeCalls.clearActiveCall({ callId }).catch(() => {}) : Promise.resolve()
);

export const enterNativePictureInPicture = () => (
  nativeCallsAvailable() ? NativeCalls.enterPictureInPicture().catch(() => ({ entered: false })) : Promise.resolve({ entered: false })
);

export const installedNativeAppInfo = () => (
  nativeCallsAvailable() ? NativeCalls.getInstalledAppInfo() : Promise.resolve(null)
);

export const startNativeAppUpdate = ({ url, sha256 }) => NativeCalls.startAppUpdate({ url, sha256 });
export const nativeAppUpdateDownloadStatus = (sha256) => NativeCalls.getAppUpdateDownloadStatus({ sha256 });
export const installNativeAppUpdate = () => NativeCalls.installAppUpdate();

export async function watchNativePictureInPicture(listener) {
  if (!nativeCallsAvailable()) return () => {};
  const handle = await NativeCalls.addListener('pictureInPictureChanged', listener);
  listener(await NativeCalls.getPictureInPictureStatus().catch(() => ({ supported: false, active: false })));
  return () => handle.remove();
}

export async function watchNativeCallActions(listener) {
  if (!nativeCallsAvailable()) return () => {};
  const seen = new Set();
  const deliver = (event) => {
    if (!event?.action || !event?.callId) return;
    const key = `${event.action}:${event.callId}`;
    // Answer/decline are one-shot. Resume may legitimately happen repeatedly when someone hides
    // the floating call, reopens it from Android, then hides it again.
    if (event.action !== 'resume') {
      if (seen.has(key)) return;
      seen.add(key);
    }
    listener(event);
  };
  const handle = await NativeCalls.addListener('callAction', async () => {
    deliver(await NativeCalls.consumeAction().catch(() => null));
  });
  deliver(await NativeCalls.consumeAction().catch(() => null));
  return () => handle.remove();
}
