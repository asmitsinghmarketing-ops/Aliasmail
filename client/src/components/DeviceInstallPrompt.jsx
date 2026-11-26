import { useEffect, useState } from 'react';
import { nativeCallsAvailable } from '../nativeCalls.js';
import Icon from './Icon.jsx';

const ASK_AGAIN_MS = 30 * 86400e3;
const SHOW_AFTER_MS = 1800;

function deviceOffer() {
  if (nativeCallsAvailable() || window.nextspaceDesktop?.isDesktop) return null;
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) return null;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) {
    return {
      key: 'android',
      title: 'Get the Nextspace Android app',
      detail: 'Use native calls, background updates and mobile screen sharing.',
      href: '/downloads/nextspace-android.apk',
      download: 'Nextspace-Android.apk',
      icon: 'phone',
    };
  }
  if (/Windows/i.test(ua)) {
    return {
      key: 'windows',
      title: 'Get the Nextspace Windows app',
      detail: 'Keep calls available in the system tray and receive native call alerts.',
      href: '/downloads/nextspace-desktop.exe',
      download: 'Nextspace-Desktop-Setup.exe',
      icon: 'computer',
    };
  }
  return null;
}

function dismissedRecently(key) {
  try {
    return Date.now() - Number(localStorage.getItem(`nextspace-install-dismissed:${key}`) || 0) < ASK_AGAIN_MS;
  } catch {
    return false;
  }
}

export default function DeviceInstallPrompt() {
  const [offer, setOffer] = useState(null);

  useEffect(() => {
    const candidate = deviceOffer();
    if (!candidate || dismissedRecently(candidate.key)) return undefined;
    const timer = window.setTimeout(() => setOffer(candidate), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(`nextspace-install-dismissed:${offer.key}`, String(Date.now()));
    } catch {
      /* Private browsing: hide it for this page only. */
    }
    setOffer(null);
  };

  if (!offer) return null;
  return (
    <aside className="device-install-prompt" role="region" aria-label={`${offer.key} app download`}>
      <span className="device-install-prompt-icon" aria-hidden="true"><Icon name={offer.icon} size={24} /></span>
      <div className="device-install-prompt-copy">
        <strong>{offer.title}</strong>
        <span>{offer.detail}</span>
      </div>
      <a className="btn btn-primary" href={offer.href} download={offer.download}>Download</a>
      <button type="button" className="icon-btn device-install-prompt-close" aria-label="Not now" title="Not now" onClick={dismiss}>
        <Icon name="close" size={18} />
      </button>
    </aside>
  );
}
