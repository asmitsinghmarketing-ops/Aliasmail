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
