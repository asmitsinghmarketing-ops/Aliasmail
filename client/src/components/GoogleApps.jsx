// Settings → Google apps: connect Drive and Meet together in one Google screen, or one at a time.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate } from '../format.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';

const START = '/api/auth/google/start?mode=';

const APPS = [
  {
    id: 'drive',
    name: 'Google Drive',
    icon: 'drive',
    color: '#1a73e8',
    about: 'Insert Drive files in your emails; they’re shared with the recipients when you send. AliasMail only sees the files you pick.',
    open: ['https://drive.google.com/', 'Open Drive'],
    leaving: 'Files you already shared stay shared. You can reconnect any time.',
  },
  {
    id: 'meet',
    name: 'Google Meet',
    icon: 'videocam',
    color: '#00897b',
    about: 'Start or schedule video meetings and add Meet links to emails. Meetings go into your Google Calendar, and Google sends the invitations.',
    open: ['https://calendar.google.com/', 'Open Calendar'],
    leaving: 'Meetings you already created stay in your calendar. You can reconnect any time.',
  },
  {
    id: 'chat',
    name: 'Google Chat',
    icon: 'chat',
    color: '#188038',
    trial: true,
    about: 'On trial: Google documents Chat for Workspace accounts only. Connect, then run the test to see whether Google allows it for your account.',
    open: ['https://chat.google.com/', 'Open Chat'],
    leaving: 'Nothing changes in Google Chat itself. You can reconnect any time.',
  },
];

/** Asks Google for a few of this account's Chat conversations and shows what it answered. */
function ChatTest() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      setResult(await api('/mail/chat/test'));
    } catch (err) {
      setResult({ ok: false, reason: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat-test">
      <button type="button" className="btn btn-outline" disabled={busy} onClick={run}>
        {busy ? 'Testing…' : result ? 'Test again' : 'Run the test'}
      </button>
      {result?.ok && (
        <div className="chat-test-result ok">
          <strong>It works: Google allows Chat for this account.</strong>
          <span>{result.spaces.length ? `Found ${result.spaces.map((s) => s.name).join(', ')}.` : 'No conversations yet, but access was allowed.'}</span>
        </div>
      )}
      {result && !result.ok && (
        <div className="chat-test-result">
          <strong>Google refused{result.status ? ` (${result.status})` : ''}.</strong>
          <span>{result.reason}</span>
        </div>
      )}
    </div>
  );
}

export default function GoogleApps() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api('/auth/mfa')
      .then(setStatus)
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  if (error) return <div className="alert">{error}</div>;
  if (!status) return <div className="muted">Loading…</div>;
  if (!status.googleEnabled) return <p className="muted">Google apps aren’t set up for this AliasMail. Ask your administrator.</p>;

  const apps = APPS.filter((a) => status[`${a.id}Enabled`]);
  const connected = (id) => Boolean(status.google?.[id]);
  const missing = apps.filter((a) => !a.trial && !connected(a.id));
  const regular = apps.filter((a) => !a.trial);

  async function disconnect(app) {
    if (!(await ask({ title: `Disconnect ${app.name}?`, message: app.leaving, confirmLabel: 'Disconnect' }))) return;
    await api(`/auth/google/${app.id}/disconnect`, { method: 'POST' });
    load();
  }

  return (
    <div className="gapps">
      <section className="gapps-hero">
        <span className="gapps-mark" aria-hidden="true">
          <Icon name="apps" size={26} />
        </span>
        <div className="grow">
          <h3>Google apps</h3>
          <p className="muted small">
            {status.google
              ? <>Using <strong>{status.google.email || 'your Google account'}</strong>. {missing.length ? 'Connect the rest in one step, or one at a time below.' : 'Everything is connected.'}</>
              : 'Use Drive and Meet from AliasMail with your Google account. Connect them all at once, or one at a time.'}
          </p>
        </div>
        {missing.length > 0 && (
          <a className="btn btn-primary gapps-all" href={`${START}${missing.length === 1 ? missing[0].id : 'all'}`}>
            <Icon name="link" size={18} /> {missing.length === regular.length && regular.length > 1 ? 'Connect all' : `Connect ${missing.length === 1 ? missing[0].name : 'the rest'}`}
          </a>
        )}
        {regular.length > 0 && !missing.length && <span className="pill on">All connected</span>}
      </section>

      <div className="gapps-grid">
        {apps.map((app) => {
          const on = connected(app.id);
          return (
            <section key={app.id} className={`gapps-card ${on ? 'on' : ''}`} style={{ '--app': app.color }}>
              <div className="gapps-card-head">
                <span className="gapps-icon"><Icon name={app.icon} size={22} /></span>
                <strong className="grow">{app.name}</strong>
                {app.trial && <span className="pill warn">Trial</span>}
                <span className={`pill ${on ? 'on' : ''}`}>{on ? 'Connected' : 'Off'}</span>
              </div>
              <p className="muted small">{app.about}</p>
              {on && app.trial && <ChatTest />}
              {on && <p className="muted small gapps-since">Connected {formatDate(status.google[`${app.id}ConnectedAt`])}</p>}
              <div className="gapps-actions">
                {on ? (
                  <>
                    <a className="link" href={app.open[0]} target="_blank" rel="noreferrer">{app.open[1]}</a>
                    <button type="button" className="link danger-link" onClick={() => disconnect(app)}>Disconnect</button>
                  </>
                ) : (
                  <a className="btn btn-outline" href={`${START}${app.id}`}>Connect {app.name.replace('Google ', '')}</a>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="muted small">
        Google may show “Google hasn’t verified this app” the first time: choose <strong>Advanced → Go to AliasMail</strong>, and keep the boxes ticked.
      </p>
    </div>
  );
}
