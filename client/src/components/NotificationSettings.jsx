// Settings → Notifications: new mail and instant notes on this device, even when Nextspace is
// closed. Per device: each phone or computer is turned on separately.
import { useEffect, useState } from 'react';
import { fetchRemembered, lastSeen } from '../api.js';
import { disable, enable, installed, isIos, setKinds, status, supported, test } from '../notifications.js';
import Icon from './Icon.jsx';
import { TextSkeleton } from './Loading.jsx';

export default function NotificationSettings() {
  const [state, setState] = useState(() => lastSeen('push-status'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text }

  const load = () => fetchRemembered('push-status', status).then(setState).catch((err) => setMessage({ tone: 'error', text: err.message }));
  useEffect(() => { load(); }, []);

  const run = async (fn, done) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ tone: 'ok', text: done });
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  // iPhone: Apple only allows notifications for sites added to the Home Screen.
  if (isIos() && !installed()) {
    return (
      <div className="settings-section notify-settings">
        <h3>Notifications</h3>
        <div className="notify-steps">
          <p>To get notifications on an iPhone or iPad, add Nextspace to your Home Screen first (an Apple rule):</p>
          <ol>
            <li>Tap the <strong>Share</strong> button in Safari (the square with an arrow).</li>
            <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
            <li>Open Nextspace from the new icon, come back here and turn notifications on.</li>
          </ol>
        </div>
      </div>
    );
  }

  if (!supported()) {
    return (
      <div className="settings-section notify-settings">
        <h3>Notifications</h3>
        <p className="muted">This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari.</p>
      </div>
    );
  }

  return (
    <div className="settings-section notify-settings">
      <h3>Notifications on this device</h3>
      <p className="muted">Get notifications for mail, tasks, notes and incoming calls, even when Nextspace is closed. Turn it on separately on each phone or computer.</p>

      {!state ? (
        <TextSkeleton />
      ) : (
        <>
          <div className="notify-row">
            <span className={`notify-state ${state.on ? 'on' : ''}`}>
              <Icon name={state.on ? 'checkCircle' : 'info'} size={18} />
              {state.on ? 'On for this device' : state.permission === 'denied' ? 'Blocked in this browser' : 'Off for this device'}
            </span>
            {state.on ? (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run(disable, 'Notifications are off for this device.')}>Turn off</button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy || state.permission === 'denied'} onClick={() => run(enable, 'Notifications are on. Try “Send a test”.')}>
                <Icon name="checkCircle" size={18} /> Turn on notifications
              </button>
            )}
          </div>

          {state.permission === 'denied' && (
            <p className="muted small">
              Notifications are blocked for this site. Click the lock icon next to the address, set <strong>Notifications</strong> to Allow, then reload.
            </p>
          )}

          {state.on && (
            <>
              <label className="notify-check">
                <input type="checkbox" checked={state.mail !== false} disabled={busy} onChange={(e) => run(() => setKinds({ mail: e.target.checked }))} />
                New mail <span className="muted small">(not Promotions, and not mail you sent)</span>
              </label>
              <label className="notify-check">
                <input type="checkbox" checked={state.notes !== false} disabled={busy} onChange={(e) => run(() => setKinds({ notes: e.target.checked }))} />
                Instant notes from your team
              </label>
              <label className="notify-check">
                <input type="checkbox" checked={state.tasks !== false} disabled={busy} onChange={(e) => run(() => setKinds({ tasks: e.target.checked }))} />
                Task assignments and updates
              </label>
              <label className="notify-check">
                <input type="checkbox" checked={state.calls !== false} disabled={busy} onChange={(e) => run(() => setKinds({ calls: e.target.checked }))} />
                Incoming team calls
              </label>
              <button type="button" className="btn btn-outline notify-test" disabled={busy} onClick={() => run(test, 'Test sent. It should appear in a moment.')}>
                <Icon name="send" size={18} /> Send a test
              </button>
            </>
          )}
        </>
      )}
      {message && <div className={message.tone === 'ok' ? 'notify-ok' : 'alert'}>{message.text}</div>}
    </div>
  );
}
