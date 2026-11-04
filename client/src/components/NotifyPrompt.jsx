// A slim banner at the top of the inbox offering notifications on this device, until they're on
// or the person says "Not now" (asked again after 30 days). iPhones are told to add Nextspace
// to the Home Screen first. Settings → Notifications has the full controls.
import { useEffect, useState } from 'react';
import { enable, installed, isIos, status, supported } from '../notifications.js';
import Icon from './Icon.jsx';

const DISMISSED = 'nextspace-notify-dismissed';
const ASK_AGAIN_MS = 30 * 86400e3;

const dismissedRecently = () => {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISSED) || 0) < ASK_AGAIN_MS;
  } catch {
    return false;
  }
};

export default function NotifyPrompt({ onOpenSettings }) {
  const [show, setShow] = useState(null); // null (checking) | 'offer' | 'ios' | false
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dismissedRecently()) return setShow(false);
    if (isIos() && !installed()) return setShow('ios');
    if (!supported() || Notification.permission === 'denied') return setShow(false);
    status()
      .then((s) => setShow(s.on ? false : 'offer'))
      .catch(() => setShow(false));
  }, []);

  const notNow = () => {
    try {
      localStorage.setItem(DISMISSED, String(Date.now()));
    } catch {
      /* private mode: just hide it */
    }
    setShow(false);
  };

  async function turnOn() {
    setBusy(true);
    setError('');
    try {
      await enable();
      setShow(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!show) return null;
  return (
    <div className="notify-prompt" role="region" aria-label="Notifications">
      <span className="notify-prompt-icon" aria-hidden="true"><Icon name="bell" size={20} /></span>
      <div className="notify-prompt-text">
        {show === 'ios' ? (
          <>
            <strong>Get notified about new mail</strong>
            <span className="muted small">On iPhone: tap Share → Add to Home Screen, open Nextspace from there, then turn notifications on.</span>
          </>
        ) : (
          <>
            <strong>Get notified about new mail and notes</strong>
            <span className="muted small">On this device, even when Nextspace is closed.{' '}
              <button type="button" className="link small" onClick={onOpenSettings}>Options</button>
            </span>
          </>
        )}
        {error && <span className="notify-prompt-error small">{error}</span>}
      </div>
      <div className="notify-prompt-actions">
        {show === 'offer' && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={turnOn}>{busy ? 'Turning on…' : 'Turn on'}</button>
        )}
        <button type="button" className="btn btn-ghost" onClick={notNow}>{show === 'ios' ? 'Got it' : 'Not now'}</button>
      </div>
    </div>
  );
}
