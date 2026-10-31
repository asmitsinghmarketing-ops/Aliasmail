// Settings → Security: 2-step verification, signed-in devices and password.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, timeAgo } from '../format.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { AuthenticatorSetup, BackupCodes, CodeField } from './TwoStep.jsx';

const METHOD = {
  password: 'password',
  authenticator: 'Google Authenticator',
  'backup-code': 'backup code',
  'trusted-device': 'trusted device',
};

/** Password (+ authenticator code when 2-step is on) before a sensitive change. */
function ConfirmIdentity({ needsCode, submitLabel, danger, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit({ password, code });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="confirm-identity" onSubmit={submit}>
      <p className="muted small">Confirm it’s you{needsCode ? ' with your password and a code from Google Authenticator' : ''}.</p>
      <input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      {needsCode && <CodeField value={code} onChange={setCode} autoFocus={false} />}
      {error && <div className="alert">{error}</div>}
      <div className="setup-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !password || (needsCode && code.length !== 6)}>
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default function SecurityPanel({ account, owner }) {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState(null); // 'setup' | 'codes' | 'disable' | 'regenerate'
  const [codes, setCodes] = useState(null);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);

  // Locations from the IP can name the internet provider's hub city. With permission, use the
  // device's own location instead; the server keeps only the town/city name.
  function shareDeviceLocation() {
    setLocating(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          await api('/auth/sessions/current/location', { method: 'POST', body: { lat: coords.latitude, lon: coords.longitude } });
          await load();
        } catch (err) {
          setError(err.message);
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setError(err.code === err.PERMISSION_DENIED ? 'Location permission was not given, so the approximate location stays.' : 'Couldn’t get this device’s location. Try again.');
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60e3 },
    );
  }

  const load = () =>
    Promise.all([api('/auth/mfa'), api('/auth/sessions')])
      .then(([s, list]) => {
        setStatus(s);
        setSessions(list);
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const done = (text) => {
    setMode(null);
    setMessage(text);
    setError('');
    load();
  };

  async function changePassword(e) {
    e.preventDefault();
    if (passwords.newPassword !== passwords.confirmPassword) return setError('The new passwords do not match');
    try {
      await api('/mail/settings', { method: 'PATCH', body: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword } });
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      done('Password changed. You were signed out on your other devices.');
    } catch (err) {
      setError(err.message);
    }
  }

  if (!status) return <div className="muted">{error || 'Loading…'}</div>;
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="security">
      {message && <div className="alert ok">{message}</div>}
      {error && <div className="alert">{error}</div>}

      {/* ----- 2-step verification ----- */}
      <section className="sec-card">
        <div className="sec-head">
          <span className={`sec-icon ${status.enabled ? 'on' : ''}`}>
            <Icon name="shield" size={22} />
          </span>
          <div className="grow">
            <h3>2-Step Verification</h3>
            <p className="muted small">
              {status.enabled
                ? `On since ${formatDate(status.enabledAt, true)} · ${status.backupCodesLeft} backup code${status.backupCodesLeft === 1 ? '' : 's'} left`
                : 'Ask for a code from Google Authenticator when signing in on a new device.'}
            </p>
          </div>
          <span className={`pill ${status.enabled ? 'on' : ''}`}>{status.enabled ? 'On' : 'Off'}</span>
        </div>

        {mode === 'setup' && (
          <AuthenticatorSetup
            start={() => api('/auth/mfa/setup/start', { method: 'POST', body: {} })}
            confirm={(code) => api('/auth/mfa/setup/confirm', { method: 'POST', body: { code } })}
            onDone={(res) => {
              setCodes(res.backupCodes);
              setMode('codes');
            }}
            onCancel={() => setMode(null)}
          />
        )}
        {mode === 'codes' && codes && (
          <BackupCodes codes={codes} account={account} onDone={() => done(status.enabled ? 'New backup codes saved. The old ones no longer work.' : '2-Step Verification is on. Other devices were signed out.')} />
        )}
        {mode === 'disable' && (
          <ConfirmIdentity
            needsCode
            danger
            submitLabel="Turn off"
            onCancel={() => setMode(null)}
            onSubmit={async (body) => {
              await api('/auth/mfa/disable', { method: 'POST', body });
              done('2-Step Verification is off. Other devices were signed out.');
            }}
          />
        )}
        {mode === 'regenerate' && (
          <ConfirmIdentity
            needsCode
            submitLabel="Get new codes"
            onCancel={() => setMode(null)}
            onSubmit={async (body) => {
              const res = await api('/auth/mfa/backup-codes', { method: 'POST', body });
              setCodes(res.backupCodes);
              setMode('codes');
            }}
          />
        )}

        {!mode && (
          <div className="sec-actions">
            {!status.enabled ? (
              <button type="button" className="btn btn-primary" onClick={() => setMode('setup')}>
                Set up Google Authenticator
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-outline" onClick={() => setMode('regenerate')}>
                  New backup codes
                </button>
                {status.required ? (
                  <span className="muted small">Required by your administrator</span>
                ) : (
                  <button type="button" className="btn btn-ghost danger-text" onClick={() => setMode('disable')}>
                    Turn off
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {status.enabled && status.trustedDevices.length > 0 && !mode && (
          <div className="sec-sub">
            <div className="sec-sub-head">
              <span>
                <strong>Devices that skip the code</strong>
                <span className="muted small"> · until 30 days after you ticked “Don’t ask again”</span>
              </span>
              <button
                type="button"
                className="link"
                onClick={async () => {
                  await api('/auth/mfa/forget-devices', { method: 'POST' });
                  done('Every device will ask for a code next time.');
                }}
              >
                Forget all
              </button>
            </div>
            <ul className="device-list">
              {status.trustedDevices.map((d) => (
                <li key={d.id}>
                  {d.agent} <span className="muted small">· until {formatDate(d.expiresAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ----- sign in with Google ----- */}
      {status.googleEnabled && (
        <section className="sec-card">
          <div className="sec-head">
            <span className={`sec-icon ${status.google ? 'on' : ''}`}><Icon name="people" size={22} /></span>
            <div className="grow">
              <h3>Sign in with Google</h3>
              <p className="muted small">
                {status.google
                  ? <>Connected to <strong>{status.google.email || 'your Google account'}</strong> since {formatDate(status.google.linkedAt)}. You can sign in with Google instead of your password{status.enabled ? ' (2-Step Verification still applies)' : ''}.</>
                  : 'Connect your Google account to sign in with it instead of typing your password. Only the Google account you connect here can sign in.'}
              </p>
            </div>
            {status.google && <span className="pill on">On</span>}
          </div>
          <div className="sec-actions">
            {status.google ? (
              <button
                type="button"
                className="btn btn-outline"
                onClick={async () => {
                  if (!(await ask({ title: 'Disconnect Google?', message: 'You’ll sign in with your password again. You can reconnect any time.', confirmLabel: 'Disconnect' }))) return;
                  await api('/auth/google/disconnect', { method: 'POST' });
                  load();
                }}
              >
                Disconnect
              </button>
            ) : (
              <a className="btn btn-outline" href="/api/auth/google/start?mode=link">
                Connect Google account
              </a>
            )}
          </div>

          {status.google && (status.driveEnabled || status.meetEnabled) && (
            <p className="muted small sec-sub">Google Drive and Google Meet are in <strong>Settings → Google apps</strong>.</p>
          )}
        </section>
      )}

      {/* ----- signed-in devices ----- */}
      <section className="sec-card">
        <div className="sec-head">
          <span className="sec-icon"><Icon name="devices" size={22} /></span>
          <div className="grow">
            <h3>Where you’re signed in</h3>
            <p className="muted small">Sign out anything you don’t recognise, then change your password.</p>
          </div>
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="device-icon" aria-hidden="true">
                <Icon name={{ phone: 'phone', tablet: 'tablet' }[s.kind] || 'computer'} size={22} />
              </span>
              <div className="grow device-text">
                <div className="device-name">
                  <strong>{s.agent}</strong> {s.current && <span className="pill on">This device</span>}
                </div>
                <div className="small">
                  {[
                    s.location && `${s.location} ${s.locationSource === 'device' ? '(from this device)' : '(approximate)'}`,
                    s.locationSource !== 'device' && s.isp,
                    s.ip || 'unknown IP',
                  ].filter(Boolean).join(' · ')}
                </div>
                {s.current && s.locationSource !== 'device' && navigator.geolocation && (
                  <button type="button" className="link small device-locate" disabled={locating} onClick={shareDeviceLocation}>
                    {locating ? 'Finding your location…' : s.location ? 'Not right? Use this device’s location' : 'Show this device’s location'}
                  </button>
                )}
                <div className="muted small">
                  Signed in {formatDate(s.createdAt, true)} with {METHOD[s.method] || s.method} · active {timeAgo(s.lastSeenAt)}
                </div>
              </div>
              {!s.current && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={async () => {
                    await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
                    load();
                  }}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
        {others.length > 0 && (
          <div className="sec-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={async () => {
                await api('/auth/sessions/sign-out-others', { method: 'POST' });
                done('Signed out on all other devices.');
              }}
            >
              Sign out all other devices
            </button>
          </div>
        )}
      </section>

      {/* ----- password ----- */}
      <section className="sec-card">
        <div className="sec-head">
          <span className="sec-icon"><Icon name="settings" size={22} /></span>
          <div className="grow">
            <h3>Password</h3>
            <p className="muted small">{owner ? 'The admin password is set in server/.env (ADMIN_PASSWORD).' : 'At least 8 characters. Changing it signs you out everywhere else.'}</p>
          </div>
        </div>
        {!owner && (
          <form className="grid-3" onSubmit={changePassword}>
            <input type="password" placeholder="Current password" autoComplete="current-password" required value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} />
            <input type="password" placeholder="New password" autoComplete="new-password" minLength={8} required value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} />
            <input type="password" placeholder="Confirm new" autoComplete="new-password" minLength={8} required value={passwords.confirmPassword} onChange={(e) => setPasswords({ ...passwords, confirmPassword: e.target.value })} />
            <button className="btn btn-primary password-save">Change password</button>
          </form>
        )}
      </section>
    </div>
  );
}
