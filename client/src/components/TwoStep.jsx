// 2-step verification pieces shared by sign-in and Settings: the code field, Google
// Authenticator setup (QR code) and the backup codes list.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import Icon from './Icon.jsx';

const APP_STORE = 'https://apps.apple.com/app/google-authenticator/id388497605';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2';

/** 6-digit code input (or a backup code when `backup`). Calls onComplete when 6 digits are typed. */
export function CodeField({ value, onChange, onComplete, backup = false, autoFocus = true, disabled, error }) {
  const input = useRef(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus, backup]);

  return (
    <div className={`field code-field ${error ? 'has-error' : ''}`}>
      <input
        ref={input}
        placeholder=" "
        inputMode={backup ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck="false"
        maxLength={backup ? 11 : 6}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const next = backup ? e.target.value.toLowerCase().replace(/[^0-9a-f-]/g, '') : e.target.value.replace(/\D/g, '');
          onChange(next);
          if (!backup && next.length === 6) onComplete?.(next);
        }}
      />
      <span className="field-label">{backup ? 'Enter a backup code' : 'Enter code'}</span>
      {error && (
        <div className="field-error">
          <Icon name="info" size={16} /> {error}
        </div>
      )}
    </div>
  );
}

/**
 * Google Authenticator setup. `start()` resolves to { secret, otpauthUrl }; `confirm(code)`
 * resolves to the server's answer, which is passed to `onDone`.
 */
export function AuthenticatorSetup({ start, confirm, onDone, onCancel }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    start()
      .then(async (data) => {
        setSetup(data);
        setQr(await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 200, errorCorrectionLevel: 'M', color: { dark: '#1f1d1a', light: '#ffffff' } }));
      })
      .catch((err) => setError(err.message));
  }, []);

  async function verify(value = code) {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    try {
      onDone(await confirm(value));
    } catch (err) {
      setError(err.message);
      setCode('');
      setBusy(false);
    }
  }

  const groupedKey = setup?.secret.match(/.{1,4}/g).join(' ');

  return (
    <div className="authenticator-setup">
      <ol className="setup-steps">
        <li>
          <strong>Install Google Authenticator</strong> on your phone — free from the{' '}
          <a href={APP_STORE} target="_blank" rel="noreferrer">App Store</a> or{' '}
          <a href={PLAY_STORE} target="_blank" rel="noreferrer">Google Play</a>.
        </li>
        <li>
          In the app, tap <strong>+</strong> then <strong>Scan a QR code</strong>, and scan this code:
        </li>
      </ol>

      <div className="qr-box">
        {qr ? <img src={qr} alt="QR code for Google Authenticator" width="200" height="200" /> : <div className="qr-placeholder">{error ? '' : 'Loading…'}</div>}
        <div className="qr-side">
          {!showKey ? (
            <button type="button" className="link" onClick={() => setShowKey(true)} disabled={!setup}>
              Can’t scan it?
            </button>
          ) : (
            <div className="setup-key">
              <div className="muted small">In the app choose <strong>Enter a setup key</strong>, type your email as the account name, and this key (time based):</div>
              <code className="key">{groupedKey}</code>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => navigator.clipboard?.writeText(setup.secret).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy key'}
              </button>
            </div>
          )}
        </div>
      </div>

      <ol className="setup-steps" start={3}>
        <li>
          Enter the <strong>6-digit code</strong> the app shows for this account:
        </li>
      </ol>
      <CodeField value={code} onChange={setCode} onComplete={verify} disabled={busy || !setup} error={error} autoFocus={false} />

      <div className="setup-actions">
        {onCancel ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn btn-primary" disabled={busy || code.length !== 6} onClick={() => verify()}>
          {busy ? 'Checking…' : 'Verify and turn on'}
        </button>
      </div>
    </div>
  );
}

/** One-time backup codes, with copy and download. */
export function BackupCodes({ codes, account, onDone, doneLabel = 'I’ve saved them' }) {
  const [copied, setCopied] = useState(false);
  const text = `Nextspace backup codes for ${account}\nEach code works once.\n\n${codes.join('\n')}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: 'aliasmail-backup-codes.txt' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="backup-codes">
      <p className="muted">
        Use one of these if you don’t have your phone. <strong>Each code works once.</strong> Keep them somewhere safe — they won’t be shown again.
      </p>
      <ul className="code-grid">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="setup-actions">
        <span className="code-tools">
          <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true))}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={download}>
            <Icon name="download" size={18} /> Download
          </button>
        </span>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </div>
  );
}
