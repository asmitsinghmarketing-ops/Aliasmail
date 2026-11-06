// Settings → Remote desktop: computers this person connects to. Each opens in the device's own
// Remote Desktop app, which asks for the password itself, so Nextspace never sees it.
import { useEffect, useState } from 'react';
import { api, fetchRemembered, lastSeen } from '../api.js';
import { openRemoteDesktop } from '../rdpFile.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { TextSkeleton } from './Loading.jsx';

const BLANK = { name: '', host: '', port: '', username: '', domain: '', gateway: '' };

export default function RemoteDesktops() {
  const [list, setList] = useState(() => lastSeen('/remote-desktops'));
  const [form, setForm] = useState(null); // null, or the computer being added or changed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => fetchRemembered('/remote-desktops').then(setList).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const field = (key) => ({ value: form[key] ?? '', onChange: (event) => setForm({ ...form, [key]: event.target.value }) });

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(form.id ? `/remote-desktops/${form.id}` : '/remote-desktops', { method: form.id ? 'PUT' : 'POST', body: form });
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    if (!(await ask({ title: `Remove “${item.name}”?`, message: 'This only removes it from your list. The computer itself isn’t changed.', confirmLabel: 'Remove' }))) return;
    try {
      await api(`/remote-desktops/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function open(item) {
    try {
      openRemoteDesktop(item);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!list && !error) return <TextSkeleton lines={4} />;

  return (
    <div className="remote-desktops">
      <p className="muted">
        Connect to a computer with Remote Desktop (RDP). Nextspace downloads a small file; open it to start the Remote Desktop
        app on this device, which asks for the password. The computer must have Remote Desktop turned on and be reachable from
        your network, directly, over a VPN or through a gateway.
      </p>
      {error && <div className="alert"><span>{error}</span><button type="button" className="link" onClick={() => setError('')}>Dismiss</button></div>}

      {form ? (
        <form className="remote-desktop-form" onSubmit={save}>
          <label><span>Name</span><input {...field('name')} placeholder="Office PC" maxLength={80} /></label>
          <label><span>Computer name or IP address</span><input {...field('host')} required placeholder="office-pc.example.com" maxLength={253} autoCapitalize="none" spellCheck={false} /></label>
          <label><span>Port</span><input {...field('port')} type="number" min="1" max="65535" placeholder="3389" /></label>
          <label><span>User name (optional)</span><input {...field('username')} maxLength={120} autoCapitalize="none" autoComplete="off" spellCheck={false} /></label>
          <label><span>Domain (optional)</span><input {...field('domain')} maxLength={120} autoCapitalize="none" spellCheck={false} /></label>
          <label><span>RD Gateway (optional)</span><input {...field('gateway')} placeholder="gateway.example.com" maxLength={253} autoCapitalize="none" spellCheck={false} /></label>
          <div className="remote-desktop-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setForm(null); setError(''); }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <>
          {list?.length > 0 && (
            <ul className="remote-desktop-list">
              {list.map((item) => (
                <li key={item.id}>
                  <Icon name="computer" />
                  <span className="remote-desktop-name">
                    <strong>{item.name}</strong>
                    <small className="muted">{item.host}{item.port !== 3389 ? `:${item.port}` : ''}{item.gateway ? ` via ${item.gateway}` : ''}</small>
                  </span>
                  <button type="button" className="btn btn-primary" onClick={() => open(item)}>Connect</button>
                  <button type="button" className="icon-btn" aria-label={`Change ${item.name}`} title="Change" onClick={() => setForm(item)}><Icon name="edit" size={20} /></button>
                  <button type="button" className="icon-btn danger" aria-label={`Remove ${item.name}`} title="Remove" onClick={() => remove(item)}><Icon name="trash" size={20} /></button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-outline" onClick={() => { setForm(BLANK); setError(''); }}><Icon name="add" size={18} /> Add a computer</button>
        </>
      )}
    </div>
  );
}
