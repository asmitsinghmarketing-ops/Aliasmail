import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { displayName, formatDate, formatSize, timeAgo } from '../format.js';
import Avatar from './Avatar.jsx';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import MessageView from './MessageView.jsx';
import Pager from './Pager.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'aliases', label: 'Aliases', icon: 'people' },
  { id: 'roles', label: 'Roles', icon: 'shield' },
  { id: 'mail', label: 'All mail', icon: 'inbox' },
];

export default function Admin({ user, onLogout, onOpenMail, onRolesChanged }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  const reload = useCallback(
    () =>
      api('/admin/overview')
        .then((data) => {
          setOverview(data);
          setError('');
        })
        .catch((err) => setError(err.message)),
    [],
  );

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="app admin-app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <Wordmark /> <span className="badge">Admin</span>
        </div>
        <div className="account push-right">
          {onOpenMail && (
            <button className="btn btn-outline admin-switch" onClick={onOpenMail} title="Back to your mailbox">
              <Icon name="mail" size={18} /> <span className="hide-sm">Open mailbox</span>
            </button>
          )}
          <div className="account-text">
            <strong>Administrator</strong>
            <span className="muted small">{user.mailbox || user.email}</span>
          </div>
          <button className="icon-btn" title="Sign out" onClick={onLogout}>
            <Icon name="logout" />
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <nav>
            {TABS.map((t) => (
              <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} />
                <span>{t.label}</span>
                {t.id === 'aliases' && overview && <span className="count plain">{overview.totals.aliases}</span>}
                {t.id === 'mail' && overview && <span className="count plain">{overview.totals.messages}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <main className="content padded">
          {error && <div className="alert">{error}</div>}
          {!overview && !error && <div className="empty">Loading…</div>}
          {overview && (
            <div className="view-enter" key={tab}>
              {tab === 'overview' && <Overview overview={overview} onReload={reload} />}
              {tab === 'aliases' && <Aliases overview={overview} onChanged={reload} />}
              {tab === 'roles' && (
                <Roles
                  overview={overview}
                  onChanged={() => {
                    reload();
                    onRolesChanged?.();
                  }}
                  onOpenAliases={() => setTab('aliases')}
                />
              )}
              {tab === 'mail' && <AllMail overview={overview} onChanged={reload} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ---------------------------------- Overview ---------------------------------- */

/** " Workers: …" for the Test connection result, or '' when there is no PHP bridge. */
function workerSummary(w) {
  if (!w) return '';
  if (w.error) return ' Workers: status unavailable - update the PHP bridge to the version with workers.';
  if (!w.enabled) return ' Workers: turned off (MAIL_WORKER_ENABLED=false). Reads use the regular bridge.';
  const lanes = ['foreground', 'background'].map((lane) => {
    const s = w.workers?.[lane];
    return s?.running ? `${lane} running (${s.requests ?? 0} requests served)` : `${lane} not running`;
  });
  const anyDown = lanes.some((t) => t.endsWith('not running'));
  return ` Workers: ${lanes.join(', ')}.${anyDown ? ' Reads without a worker log in to the mail server each time and are slower - start worker.php on the PHP host.' : ''}`;
}

function Overview({ overview, onReload }) {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const { totals, sync, aliases } = overview;
  const max = Math.max(1, ...aliases.map((a) => a.total));

  async function run(action) {
    setBusy(action);
    setResult(null);
    try {
      if (action === 'sync') {
        await api('/admin/sync', { method: 'POST' });
        setResult({ ok: true, text: 'Mailbox synced.' });
      } else {
        const res = await api('/admin/test-connection', { method: 'POST' });
        setResult({ ok: true, text: `IMAP and SMTP connected. Folders: ${res.folders.join(', ')}.${workerSummary(res.workers)}` });
      }
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy('');
      onReload();
    }
  }

  const tiles = [
    { label: 'Messages in inbox', value: totals.messages, color: 'var(--teal)' },
    { label: 'Aliases', value: totals.aliases, color: 'var(--violet)' },
    { label: 'Unassigned mail', value: totals.unassigned, color: 'var(--orange)' },
    { label: 'Sent mail', value: totals.sent, color: 'var(--pink)' },
  ];

  return (
    <>
      <h1 className="page-title">Overview</h1>

      <section className="card status-card">
        <div>
          <div className="muted small">Connected mailbox</div>
          <div className="status-mailbox">{overview.mailbox || 'Not configured'}</div>
          <div className="small">
            <span className={`dot ${!overview.configured || sync.lastError ? 'bad' : 'good'}`} />
            {!overview.configured
              ? 'Set MAIL_USER and MAIL_PASSWORD in server/.env'
              : sync.lastError
                ? `Last sync failed: ${sync.lastError}`
                : `Last synced ${timeAgo(sync.lastSyncAt)}`}
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-outline" disabled={!!busy} onClick={() => run('test')}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn btn-primary" disabled={!!busy} onClick={() => run('sync')}>
            <Icon name="refresh" size={18} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {result && <div className={`alert ${result.ok ? 'ok' : ''} full`}>{result.text}</div>}
      </section>

      <section className="tiles">
        {tiles.map((t) => (
          <div key={t.label} className="tile" style={{ '--tile': t.color }}>
            <div className="tile-value">{t.value}</div>
            <div className="tile-label">{t.label}</div>
          </div>
        ))}
      </section>

      <SecurityCard />

      <section className="card">
        <h2 className="card-title">Mail per alias</h2>
        {aliases.length === 0 && <p className="muted">No aliases yet. Add one in the Aliases tab.</p>}
        <div className="bars">
          {aliases.map((a) => (
            <div key={a.id} className="bar-row">
              <span className="bar-label">
                <span className="swatch" style={{ background: a.color }} />
                {a.address}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(a.total / max) * 100}%`, background: a.color }} />
              </span>
              <span className="bar-value">
                {a.total}
                {a.unread > 0 && <span className="muted small"> · {a.unread} unread</span>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function SecurityCard() {
  const [security, setSecurity] = useState(null);
  const [message, setMessage] = useState('');
  const load = () => api('/admin/security').then(setSecurity).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  if (!security) return null;

  async function toggleRequire() {
    const requireMfa = !security.requireMfa;
    if (requireMfa && !(await ask({ title: 'Require 2-Step Verification?', message: 'People who haven’t set it up will be asked to scan a QR code with Google Authenticator the next time they sign in.', confirmLabel: 'Require it' }))) return;
    await api('/admin/security', { method: 'PATCH', body: { requireMfa } });
    setMessage(requireMfa ? 'Everyone must now use Google Authenticator.' : '2-Step Verification is optional again.');
    load();
  }

  async function signOutAll() {
    if (!(await ask({ title: 'Sign everyone out?', message: 'Every user is signed out of every device. You stay signed in.', confirmLabel: 'Sign everyone out', danger: true }))) return;
    const { ended } = await api('/admin/security/sign-out-all', { method: 'POST' });
    setMessage(`${ended} session${ended === 1 ? '' : 's'} signed out.`);
    load();
  }

  return (
    <section className="card">
      <h2 className="card-title">Sign-in security</h2>
      <div className="sec-row">
        <div className="grow">
          <strong>Require 2-Step Verification for everyone</strong>
          <div className="muted small">Every alias must sign in with a code from Google Authenticator on new devices.</div>
        </div>
        <button className={`switch ${security.requireMfa ? 'on' : ''}`} role="switch" aria-checked={security.requireMfa} onClick={toggleRequire}>
          <span />
        </button>
      </div>
      <div className="sec-row">
        <div className="grow">
          <strong>Your admin account</strong>
          <div className="muted small">
            {security.adminMfaEnabled ? '2-Step Verification is on.' : 'Turn on 2-Step Verification in Mailbox → Settings → Security. Strongly recommended for the admin.'}
          </div>
        </div>
        <span className={`pill ${security.adminMfaEnabled ? 'on' : 'warn'}`}>{security.adminMfaEnabled ? 'Protected' : 'Not protected'}</span>
      </div>
      <div className="sec-row">
        <div className="grow">
          <strong>Active sessions</strong>
          <div className="muted small">{security.activeSessions} signed-in browser{security.activeSessions === 1 ? '' : 's'} across all accounts.</div>
        </div>
        <button className="btn btn-outline" onClick={signOutAll}>
          Sign everyone out
        </button>
      </div>
      {message && <div className="alert ok">{message}</div>}
      <ActivityLog />
    </section>
  );
}

const EVENT_LABELS = {
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  'sign-in-failed': 'Sign-in failed',
  'locked-out': 'Locked out',
  'code-failed': 'Wrong 2-step code',
  'backup-code-used': 'Used a backup code',
  'device-trusted': 'Trusted a device',
  '2-step-turned-on': '2-step turned on',
  '2-step-turned-off': '2-step turned off',
  'backup-codes-renewed': 'New backup codes',
  'trusted-devices-forgotten': 'Forgot trusted devices',
  'password-check-failed': 'Wrong current password',
  'password-changed': 'Changed password',
  'device-signed-out': 'Signed out a device',
  'signed-out-other-devices': 'Signed out other devices',
  'admin-set-password': 'Admin set password',
  'admin-enabled-alias': 'Admin enabled alias',
  'admin-disabled-alias': 'Admin disabled alias',
  'admin-deleted-alias': 'Admin deleted alias',
  'admin-reset-2-step': 'Admin reset 2-step',
  'admin-required-2-step': 'Admin required 2-step',
  'admin-made-2-step-optional': 'Admin made 2-step optional',
  'admin-signed-everyone-out': 'Admin signed everyone out',
};

/** Recent sign-ins, failures, lockouts and security changes. */
function ActivityLog() {
  const [open, setOpen] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (open) api(`/admin/security/activity?limit=200${failuresOnly ? '&failures=1' : ''}`).then(setEntries).catch(() => {});
  }, [open, failuresOnly]);

  if (!open) {
    return (
      <button className="link activity-toggle" onClick={() => setOpen(true)}>
        Show sign-in activity
      </button>
    );
  }
  return (
    <div className="activity">
      <div className="activity-head">
        <strong>Sign-in activity</strong>
        <label className="check small">
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
          Failures and lockouts only
        </label>
        <button className="link push-right" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      <div className="activity-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Account</th>
              <th>What</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">Nothing yet.</td>
              </tr>
            )}
            {entries.map((e, i) => (
              <tr key={`${e.at}-${i}`} className={/failed|locked/.test(e.event) ? 'activity-bad' : ''}>
                <td className="nowrap">{formatDate(e.at, true)}</td>
                <td>{e.account || '—'}</td>
                <td>
                  {EVENT_LABELS[e.event] || e.event}
                  {e.detail && <div className="muted small">{e.detail}</div>}
                </td>
                <td>
                  {e.ip}
                  {e.location && <div className="small">{e.location}</div>}
                  <div className="muted small">{e.agent}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------- Aliases ---------------------------------- */

function Aliases({ overview, onChanged }) {
  const [editing, setEditing] = useState(null); // null | 'new' | alias | { address } of a detected alias
  const [detected, setDetected] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/admin/aliases/detected')
      .then(setDetected)
      .catch(() => {});
  }, [overview]);

  async function patch(alias, body) {
    try {
      await api(`/admin/aliases/${alias.id}`, { method: 'PATCH', body });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(alias) {
    if (!(await ask({ title: `Delete ${alias.address}?`, message: 'The person will lose access. Their mail stays in the mailbox.', confirmLabel: 'Delete alias', danger: true }))) return;
    try {
      await api(`/admin/aliases/${alias.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Aliases</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="add" size={18} /> Add alias
        </button>
      </div>
      <p className="muted intro">
        First create the alias in your GoDaddy email settings so mail to it lands in <strong>{overview.mailbox}</strong>. Then add it
        here and give the person the alias address and password. They sign in and only see mail sent to that alias.
      </p>
      {error && <div className="alert">{error}</div>}

      {detected.length > 0 && (
        <div className="card detected">
          <h2 className="card-title">Found in your mailbox — not set up yet</h2>
          <p className="muted small">These addresses are receiving mail (aliases already created at GoDaddy). Add one to give it a login.</p>
          <div className="detected-list">
            {detected.map((d) => (
              <div key={d.address} className="detected-item">
                <span>
                  <strong>{d.address}</strong>
                  <span className="muted small"> · {d.messages} message{d.messages === 1 ? '' : 's'}</span>
                </span>
                <button className="btn btn-outline" onClick={() => setEditing({ address: d.address })}>
                  <Icon name="add" size={18} /> Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Type</th>
              <th>Owner</th>
              <th className="num">Mail</th>
              <th className="num">Unread</th>
              <th>2-step</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overview.aliases.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">No aliases yet.</td>
              </tr>
            )}
            {overview.aliases.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="alias-cell">
                    <Avatar url={a.avatar ? `/api/avatars/${a.avatar}` : null} person={{ name: a.displayName, address: a.address }} color={a.color} size="sm" />
                    <div>
                      <strong>{a.address}</strong>
                      {a.displayName && <div className="muted small">{a.displayName}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`pill ${a.type === 'group' ? 'group' : ''}`}>{a.type === 'group' ? 'Group' : 'Personal'}</span>
                  {a.roles?.length > 0 && <div className="muted small role-names">{a.roles.join(', ')}</div>}
                </td>
                <td>{a.ownerName || <span className="muted">—</span>}</td>
                <td className="num">{a.total}</td>
                <td className="num">{a.unread}</td>
                <td>
                  {a.type === 'group' ? (
                    <span className="muted" title="Group mailboxes have no sign-in">—</span>
                  ) : a.mfaEnabled ? (
                    <span className="mfa-cell">
                      <span className="pill on">On</span>
                      <button
                        className="link small"
                        title="For someone who lost their phone"
                        onClick={async () => {
                          if (!(await ask({ title: `Reset 2-Step Verification for ${a.address}?`, message: 'They’ll be signed out, and can scan a new QR code with Google Authenticator to turn it back on.', confirmLabel: 'Reset', danger: true }))) return;
                          await api(`/admin/aliases/${a.id}/reset-mfa`, { method: 'POST' });
                          onChanged();
                        }}
                      >
                        Reset
                      </button>
                    </span>
                  ) : (
                    <span className="pill">Off</span>
                  )}
                </td>
                <td>
                  <button className={`toggle ${a.active ? 'on' : ''}`} onClick={() => patch(a, { active: !a.active })}>
                    {a.active ? 'Active' : 'Disabled'}
                  </button>
                </td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditing(a)}>
                    <Icon name="edit" size={18} />
                  </button>
                  <button className="icon-btn danger" title="Delete alias" onClick={() => remove(a)}>
                    <Icon name="trash" size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <AliasForm
          alias={editing.id ? editing : null}
          initialAddress={editing.address}
          palette={overview.palette}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function AliasForm({ alias, initialAddress, palette, onClose, onSaved }) {
  const [form, setForm] = useState({
    address: alias?.address || initialAddress || '',
    displayName: alias?.displayName || '',
    ownerName: alias?.ownerName || '',
    password: '',
    color: alias?.color || palette[Math.floor(Math.random() * palette.length)],
    type: alias?.type || 'personal',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const personal = form.type === 'personal';
  // A new personal mailbox, or a group mailbox turning personal, needs a password to sign in with.
  const needsPassword = personal && (!alias || alias.type === 'group');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (alias) {
        if (alias.type !== 'group' && !personal && !(await ask({
          title: `Make ${alias.address} a group mailbox?`,
          message: 'Its password and 2-Step Verification are removed and anyone signed in to it is signed out. People then open it through a role.',
          confirmLabel: 'Make it a group mailbox',
          danger: true,
        }))) {
          setBusy(false);
          return;
        }
        const { address, password, ...changes } = form;
        await api(`/admin/aliases/${alias.id}`, { method: 'PATCH', body: password && personal ? { ...changes, password } : changes });
      } else {
        const { password, ...fields } = form;
        await api('/admin/aliases', { method: 'POST', body: personal ? form : fields });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal form-dialog" role="dialog" aria-modal="true" aria-labelledby="alias-form-title" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="alias-form-title">{alias ? 'Edit alias' : 'Add alias'}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <label>
          <span>Alias address</span>
          <input type="email" required disabled={Boolean(alias)} placeholder="john@abc.com" autoFocus={!form.address} {...field('address')} />
        </label>

        <div className="type-choice" role="radiogroup" aria-label="Mailbox type">
          {[
            ['personal', 'Personal', 'people', 'One person signs in. Only they and you can see its mail.'],
            ['group', 'Group', 'inbox', 'Shared, no sign-in of its own. People open it through a role.'],
          ].map(([value, title, icon, text]) => (
            <button
              type="button"
              role="radio"
              aria-checked={form.type === value}
              key={value}
              className={`type-option ${form.type === value ? 'on' : ''}`}
              onClick={() => setForm({ ...form, type: value })}
            >
              <Icon name={icon} size={20} />
              <span>
                <strong>{title}</strong>
                <span className="muted small">{text}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="grid-2">
          <label>
            <span>Display name <span className="muted">· shown as sender</span></span>
            <input type="text" placeholder={personal ? 'John Smith' : 'Support team'} {...field('displayName')} />
          </label>
          <label>
            <span>{personal ? 'Owner / customer' : 'Team or purpose'}</span>
            <input type="text" placeholder={personal ? 'Who uses this alias' : 'e.g. Customer support'} {...field('ownerName')} />
          </label>
        </div>
        {personal && (
          <label>
            <span>{needsPassword ? 'Password' : 'New password'}</span>
            <input type="text" required={needsPassword} minLength={8} placeholder={needsPassword ? 'At least 8 characters' : 'Leave blank to keep the current one'} {...field('password')} />
          </label>
        )}
        <div className="label">Color</div>
        <div className="swatches">
          {palette.map((c) => (
            <button
              type="button"
              key={c}
              className={`swatch-btn ${form.color === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => setForm({ ...form, color: c })}
              aria-label={c}
            />
          ))}
        </div>

        {error && <div className="alert">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------- Roles ---------------------------------- */

const aliasLabel = (a) => a.displayName || a.address;

function Roles({ overview, onChanged, onOpenAliases }) {
  const [roles, setRoles] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | role
  const [error, setError] = useState('');
  const byId = Object.fromEntries(overview.aliases.map((a) => [a.id, a]));
  const groups = overview.aliases.filter((a) => a.type === 'group');

  const load = useCallback(() => api('/admin/roles').then(setRoles).catch((err) => setError(err.message)), []);
  useEffect(() => {
    load();
  }, [load, overview]);

  async function remove(role) {
    if (!(await ask({ title: `Delete the role "${role.name}"?`, message: 'Its members lose access to its group mailboxes. The mailboxes and their mail stay.', confirmLabel: 'Delete role', danger: true }))) return;
    try {
      await api(`/admin/roles/${role.id}`, { method: 'DELETE' });
      load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  const chips = (ids) =>
    ids.map((id) => byId[id]).filter(Boolean).map((a) => (
      <span key={a.id} className="chip" style={{ '--chip': a.color }} title={a.address}>
        {aliasLabel(a)}
      </span>
    ));

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Roles</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="add" size={18} /> Add role
        </button>
      </div>
      <p className="muted intro">
        A role gives people access to shared <strong>group</strong> mailboxes. Everyone with the role can switch to those mailboxes from their
        avatar, read and send mail there, but can’t change the mailbox’s settings. <strong>Personal</strong> mailboxes are never shared:
        only the person and you see them.
      </p>
      {error && <div className="alert">{error}</div>}
      {groups.length === 0 && (
        <div className="card detected">
          <h2 className="card-title">No group mailboxes yet</h2>
          <p className="muted small">
            Add an alias with the type <strong>Group</strong> (for example support@ or sales@), then put it in a role here.
          </p>
          <button className="btn btn-outline" onClick={onOpenAliases}>Go to Aliases</button>
        </div>
      )}

      {!roles && !error && <div className="empty">Loading…</div>}
      {roles?.length === 0 && <div className="card empty">No roles yet. Create one to share group mailboxes with people.</div>}
      <div className="role-list">
        {roles?.map((r) => (
          <div key={r.id} className="card role-card">
            <div className="role-head">
              <h2 className="card-title">{r.name}</h2>
              <span className="row-actions">
                <button className="icon-btn" title="Edit role" onClick={() => setEditing(r)}>
                  <Icon name="edit" size={18} />
                </button>
                <button className="icon-btn danger" title="Delete role" onClick={() => remove(r)}>
                  <Icon name="trash" size={18} />
                </button>
              </span>
            </div>
            <div className="role-row">
              <span className="role-label muted small">Group mailboxes</span>
              <span>{r.mailboxes.length ? chips(r.mailboxes) : <span className="muted small">None yet</span>}</span>
            </div>
            <div className="role-row">
              <span className="role-label muted small">People</span>
              <span>{r.members.length ? chips(r.members) : <span className="muted small">No one yet</span>}</span>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RoleForm
          role={editing === 'new' ? null : editing}
          aliases={overview.aliases}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function RoleForm({ role, aliases, onClose, onSaved }) {
  const [name, setName] = useState(role?.name || '');
  const [mailboxes, setMailboxes] = useState(new Set(role?.mailboxes || []));
  const [members, setMembers] = useState(new Set(role?.members || []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groups = aliases.filter((a) => a.type === 'group');
  const people = aliases.filter((a) => a.type !== 'group');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (set, setter, id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name, mailboxes: [...mailboxes], members: [...members] };
      if (role) await api(`/admin/roles/${role.id}`, { method: 'PATCH', body });
      else await api('/admin/roles', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const checklist = (list, set, setter, empty) =>
    list.length === 0 ? (
      <p className="muted small">{empty}</p>
    ) : (
      <div className="check-list">
        {list.map((a) => (
          <label key={a.id} className={`check-row ${set.has(a.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={set.has(a.id)} onChange={() => toggle(set, setter, a.id)} />
            <Avatar url={a.avatar ? `/api/avatars/${a.avatar}` : null} person={{ name: a.displayName, address: a.address }} color={a.color} size="sm" />
            <span className="check-text">
              <span>{aliasLabel(a)}</span>
              <span className="muted small">{a.address}{a.active ? '' : ' · disabled'}</span>
            </span>
          </label>
        ))}
      </div>
    );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal form-dialog role-form" role="dialog" aria-modal="true" aria-labelledby="role-form-title" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="role-form-title">{role ? 'Edit role' : 'Add role'}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <label>
          <span>Role name</span>
          <input type="text" required maxLength={40} placeholder="e.g. Support team" autoFocus={!role} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <div className="label">Group mailboxes <span className="muted">· what this role can open</span></div>
          {checklist(groups, mailboxes, setMailboxes, 'No group mailboxes yet. Add an alias with the type Group first.')}
        </div>
        <div>
          <div className="label">People <span className="muted">· personal accounts with this role</span></div>
          {checklist(people, members, setMembers, 'No personal accounts yet.')}
        </div>
        {error && <div className="alert">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------- All mail ---------------------------------- */

function AllMail({ overview, onChanged }) {
  const [box, setBox] = useState('inbox'); // inbox | sent
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  const [selected, setSelected] = useState(new Set());
  const [permanent, setPermanent] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setList(await api(`/admin/messages?${new URLSearchParams({ folder: box, alias: filter, q: search, page })}`));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [box, filter, search, page]);

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    load();
  }, [load]);

  async function remove(ids) {
    if (!ids.length) return;
    const count = `${ids.length} message${ids.length === 1 ? '' : 's'}`;
    if (!(await ask({
      title: permanent ? `Delete ${count} forever?` : `Move ${count} to Trash?`,
      message: `This affects every alias that received ${ids.length === 1 ? 'it' : 'them'}.${permanent ? ' This can’t be undone.' : ''}`,
      confirmLabel: permanent ? 'Delete forever' : 'Move to Trash',
      danger: true,
    }))) return;
    try {
      await api('/admin/messages/delete', { method: 'POST', body: { ids, permanent, folder: box } });
      setSelected(new Set());
      setOpenId(null);
      load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  if (openId) {
    const index = list.items.findIndex((m) => m.id === openId);
    return (
      <div className="card table-card">
        <MessageView
          url={`/admin/${box === 'sent' ? 'sent' : 'messages'}/${openId}`}
          preview={list.items[index]}
          actions={[{ icon: 'trash', title: 'Delete from mailbox', danger: true, onClick: () => remove([openId]) }]}
          position={index >= 0 ? { index, total: list.items.length } : null}
          onPrev={index > 0 ? () => setOpenId(list.items[index - 1].id) : null}
          onNext={index >= 0 && index < list.items.length - 1 ? () => setOpenId(list.items[index + 1].id) : null}
          onBack={() => setOpenId(null)}
        />
      </div>
    );
  }

  const allSelected = list.items.length > 0 && list.items.every((i) => selected.has(i.id));

  return (
    <>
      <h1 className="page-title">All mail</h1>

      <div className="segmented">
        {[
          ['inbox', 'Inbox', 'inbox'],
          ['sent', 'Sent', 'send'],
        ].map(([id, label, icon]) => (
          <button
            key={id}
            className={box === id ? 'on' : ''}
            onClick={() => {
              setBox(id);
              setFilter('');
              setPage(1);
            }}
          >
            <Icon name={icon} size={18} /> {label}
          </button>
        ))}
      </div>

      <div className="filters">
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All aliases</option>
          <option value="unassigned">{box === 'sent' ? 'Not sent from an alias' : 'Unassigned (no alias)'}</option>
          {overview.aliases.map((a) => (
            <option key={a.id} value={a.address}>
              {a.address}
            </option>
          ))}
        </select>
        <form
          className="search small-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
            setPage(1);
          }}
        >
          <Icon name="search" />
          <input placeholder="Search subject, sender, recipient" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="card table-card">
        <div className="toolbar">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(list.items.map((i) => i.id)))}
            title="Select all"
          />
          <button className="icon-btn" title="Reload" onClick={load}>
            <Icon name="refresh" />
          </button>
          {selected.size > 0 && (
            <>
              <button className="btn btn-danger" onClick={() => remove([...selected])}>
                <Icon name="trash" size={18} /> Delete {selected.size}
              </button>
              <label className="check small">
                <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
                Delete permanently (skip Trash)
              </label>
            </>
          )}
          <Pager list={list} onPage={setPage} />
        </div>

        <table className="table clickable">
          <thead>
            <tr>
              <th />
              <th>{box === 'sent' ? 'To' : 'From'}</th>
              <th>Subject</th>
              <th>{box === 'sent' ? 'Sent by alias' : 'Delivered to'}</th>
              <th className="num">Size</th>
              <th className="num">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="empty">Loading…</td>
              </tr>
            )}
            {!loading && list.items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">No messages.</td>
              </tr>
            )}
            {!loading &&
              list.items.map((m) => (
                <tr key={m.id} className={selected.has(m.id) ? 'selected' : ''} onClick={() => setOpenId(m.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => {
                        const next = new Set(selected);
                        next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td className="ellipsis">{box === 'sent' ? m.to.map(displayName).join(', ') || '—' : displayName(m.from)}</td>
                  <td className="ellipsis wide">
                    {m.hasAttachments && <Icon name="attach" size={14} className="muted" />} {m.subject || '(no subject)'}
                    {m.snippet && <span className="muted"> — {m.snippet}</span>}
                  </td>
                  <td>
                    {m.aliases.length === 0 && <span className="chip grey">{box === 'sent' ? m.from.address : 'Unassigned'}</span>}
                    {m.aliases.map((a) => (
                      <span key={a.address} className="chip" style={{ '--chip': a.color }}>
                        {a.address}
                      </span>
                    ))}
                  </td>
                  <td className="num muted">{formatSize(m.size)}</td>
                  <td className="num nowrap">{formatDate(m.date)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
