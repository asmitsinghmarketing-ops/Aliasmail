import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { AuthenticatorSetup, BackupCodes, CodeField } from './TwoStep.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Field({ label, error, inputRef, trailing, ...input }) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <input ref={inputRef} placeholder=" " {...input} />
      <span className="field-label">{label}</span>
      {trailing}
      {error && (
        <div className="field-error">
          <Icon name="info" size={16} /> {error}
        </div>
      )}
    </div>
  );
}

const HEADINGS = {
  email: 'Sign in',
  password: 'Welcome',
  code: '2-Step Verification',
  setup: 'Set up 2-Step Verification',
  backup: 'Save your backup codes',
};

/**
 * Sign-in: email → password → (if 2-step verification is on and this device isn't trusted) the
 * code from Google Authenticator. If the administrator requires 2-step verification and the
 * account hasn't set it up, the setup happens here before signing in.
 */
export default function Login({ onLogin }) {
  const [domain, setDomain] = useState('');
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [remember, setRemember] = useState(true);
  const [result, setResult] = useState(null); // { user, backupCodes } after required setup
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const emailInput = useRef(null);
  const passwordInput = useRef(null);

  useEffect(() => {
    api('/auth/info', { signInFlow: true })
      .then((info) => setDomain(info.domain))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === 'email') emailInput.current?.focus();
    if (step === 'password') passwordInput.current?.focus();
  }, [step]);

  const go = (next) => {
    setError('');
    setHelp(false);
    setStep(next);
  };

  const startOver = (message = '') => {
    setPassword('');
    setCode('');
    setTicket(null);
    setUseBackup(false);
    go('email');
    setError(message);
  };

  // "john" means john@<domain>.
  const fullEmail = (value) => {
    const v = value.trim().toLowerCase();
    return domain && v && !v.includes('@') ? `${v}@${domain}` : v;
  };

  function next(e) {
    e.preventDefault();
    const address = fullEmail(email);
    if (!address) return setError('Enter an email address');
    if (!EMAIL_RE.test(address)) return setError('Enter a valid email address');
    setEmail(address);
    go('password');
  }

  async function signIn(e) {
    e.preventDefault();
    if (!password) return setError('Enter a password');
    setBusy(true);
    setError('');
    try {
      const res = await api('/auth/login', { method: 'POST', body: { email, password }, signInFlow: true });
      if (res.user) return onLogin(res);
      setTicket(res.ticket);
      setPassword('');
      go(res.mfa === 'setup' ? 'setup' : 'code');
    } catch (err) {
      setError(err.status === 401 ? 'Wrong password. Try again or ask your administrator to reset it.' : err.message);
      setPassword('');
      passwordInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function verify(value = code) {
    if (busy || !value) return;
    setBusy(true);
    setError('');
    try {
      onLogin(await api('/auth/mfa/verify', { method: 'POST', body: { ticket, code: value, remember }, signInFlow: true }));
    } catch (err) {
      if (err.status === 401) return startOver('That took too long. Sign in again.');
      setError(err.message);
      setCode('');
      setBusy(false);
    }
  }

  const watchCaps = (e) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);
  const wide = step === 'setup' || step === 'backup';

  return (
    <div className="login-page">
      <div className={`login-card ${busy ? 'busy' : ''} ${wide ? 'wide' : ''}`}>
        <div className="login-progress" aria-hidden="true" />

        <div className="login-side">
          <div className="brand brand-lg">
            <Logo size={46} />
            <Wordmark />
          </div>
          <div className="login-heading" key={step}>
            <h1>{HEADINGS[step]}</h1>
            {step === 'email' ? (
              <p>{domain ? <>Use your <strong>@{domain}</strong> account</> : 'Use your email account'}</p>
            ) : (
              <button type="button" className="account-chip" onClick={() => startOver()} title="Use a different account">
                <span className="account-chip-avatar">{email.charAt(0).toUpperCase()}</span>
                <span className="account-chip-email">{email}</span>
                <Icon name="expandMore" size={18} />
              </button>
            )}
            {step === 'code' && (
              <p className="login-sub">
                <Icon name="shield" size={18} /> To help keep your account safe, confirm it’s really you.
              </p>
            )}
            {step === 'setup' && <p className="login-sub">Your administrator requires 2-Step Verification. It takes about a minute.</p>}
          </div>
        </div>

        <div className="login-main">
          {step === 'email' && (
            <form className="login-step" key="email" onSubmit={next} noValidate>
              <Field
                label="Email"
                type="text"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                value={email}
                inputRef={emailInput}
                error={error}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError('');
                }}
                trailing={domain && email && !email.includes('@') ? <span className="field-suffix">@{domain}</span> : null}
              />
              <button type="button" className="link login-link" onClick={() => setHelp(!help)}>
                Forgot email?
              </button>
              {help && (
                <p className="login-help">
                  Your email is the alias address you were given, for example <strong>name@{domain || 'yourcompany.com'}</strong>. Ask your
                  administrator if you're not sure.
                </p>
              )}
              <div className="login-actions">
                <span />
                <button className="btn btn-primary login-next">Next</button>
              </div>
            </form>
          )}

          {step === 'password' && (
            <form className="login-step" key="password" onSubmit={signIn} noValidate>
              <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
              <Field
                label="Enter your password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                inputRef={passwordInput}
                error={error}
                disabled={busy}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
                onKeyDown={watchCaps}
                onKeyUp={watchCaps}
              />
              {capsLock && <div className="caps-warning">Caps Lock is on</div>}
              <label className="check login-check">
                <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
                Show password
              </label>
              <button type="button" className="link login-link" onClick={() => setHelp(!help)}>
                Forgot password?
              </button>
              {help && <p className="login-help">Passwords are managed by your administrator. Ask them to set a new one for {email}.</p>}
              <div className="login-actions">
                <button type="button" className="btn btn-ghost" onClick={() => startOver()}>
                  Back
                </button>
                <button className="btn btn-primary login-next" disabled={busy}>
                  {busy ? 'Signing in…' : 'Next'}
                </button>
              </div>
            </form>
          )}

          {step === 'code' && (
            <form
              className="login-step"
              key={`code-${useBackup}`}
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
              noValidate
            >
              <div className="code-intro">
                <span className="code-intro-icon"><Icon name={useBackup ? 'draft' : 'shield'} size={22} /></span>
                <p>
                  {useBackup ? (
                    <>Enter one of the 10-character backup codes you saved when you set up 2-Step Verification.</>
                  ) : (
                    <>
                      Open <strong>Google Authenticator</strong> on your phone and enter the 6-digit code shown for <strong>{email}</strong>.
                    </>
                  )}
                </p>
              </div>
              <CodeField value={code} onChange={(v) => { setCode(v); setError(''); }} onComplete={verify} backup={useBackup} disabled={busy} error={error} />
              <label className="check login-check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Don’t ask again on this device for 30 days
              </label>
              <button
                type="button"
                className="link login-link"
                onClick={() => {
                  setUseBackup(!useBackup);
                  setCode('');
                  setError('');
                }}
              >
                {useBackup ? 'Use Google Authenticator instead' : 'Don’t have your phone? Use a backup code'}
              </button>
              <div className="login-actions">
                <button type="button" className="btn btn-ghost" onClick={() => startOver()}>
                  Back
                </button>
                <button className="btn btn-primary login-next" disabled={busy || !code}>
                  {busy ? 'Checking…' : 'Verify'}
                </button>
              </div>
            </form>
          )}

          {step === 'setup' && (
            <div className="login-step" key="setup">
              <AuthenticatorSetup
                start={() => api('/auth/mfa/setup/start', { method: 'POST', body: { ticket }, signInFlow: true })}
                confirm={(value) => api('/auth/mfa/setup/confirm', { method: 'POST', body: { ticket, code: value }, signInFlow: true })}
                onDone={(res) => {
                  setResult(res);
                  go('backup');
                }}
                onCancel={() => startOver()}
              />
            </div>
          )}

          {step === 'backup' && result && (
            <div className="login-step" key="backup">
              <BackupCodes codes={result.backupCodes} account={email} doneLabel="I’ve saved them — continue" onDone={() => onLogin({ user: result.user })} />
            </div>
          )}
        </div>
      </div>

      <footer className="login-footer">
        <span>{domain ? `${domain} mail` : 'AliasMail'}</span>
        <span className="muted">Protected sign-in · 2-Step Verification with Google Authenticator</span>
      </footer>
    </div>
  );
}
