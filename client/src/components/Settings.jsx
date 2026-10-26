import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar, { squareImage } from './Avatar.jsx';
import Icon from './Icon.jsx';
import SecurityPanel from './SecurityPanel.jsx';

export default function Settings({ color, initialTab = 'profile', onClose, onSaved, onAvatarChange }) {
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/mail/settings')
      .then(setForm)
      .catch((err) => setError(err.message));
  }, []);

  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });

  // The picture is saved straight away, separately from the Save button.
  async function changeAvatar(file) {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const image = await squareImage(file);
      const saved = await api('/mail/settings/avatar', { method: 'POST', body: { image } });
      setForm((f) => ({ ...f, avatarUrl: saved.avatarUrl }));
      onAvatarChange(saved.avatarUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setUploading(true);
    try {
      await api('/mail/settings/avatar', { method: 'DELETE' });
      setForm((f) => ({ ...f, avatarUrl: null }));
      onAvatarChange(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { displayName, signature } = form;
      onSaved(await api('/mail/settings', { method: 'PATCH', body: { displayName, signature } }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function profileTab() {
    return (
      <form className="settings-form" onSubmit={save}>
        {!form && !error && <div className="muted">Loading…</div>}
        {form && (
          <>
            <div
              className={`avatar-edit ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                changeAvatar(e.dataTransfer.files[0]);
              }}
            >
              <label className={`avatar-picker ${uploading ? 'uploading' : ''}`} title="Change profile picture">
                <Avatar url={form.avatarUrl} person={{ name: form.displayName, address: form.address }} color={color} size="xl" />
                <span className="avatar-picker-overlay">
                  <Icon name="edit" size={20} />
                </span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden disabled={uploading} onChange={(e) => changeAvatar(e.target.files[0])} />
              </label>
              <div className="avatar-edit-text">
                <div className="label">Profile picture</div>
                <p className="muted small">
                  Shown in your mailbox and beside your messages to other people using this mail system. Drag a photo here or choose one.
                </p>
                <div className="avatar-edit-actions">
                  <label className={`btn btn-outline ${uploading ? 'disabled' : ''}`}>
                    {uploading ? 'Saving…' : form.avatarUrl ? 'Change photo' : 'Upload photo'}
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden disabled={uploading} onChange={(e) => changeAvatar(e.target.files[0])} />
                  </label>
                  {form.avatarUrl && (
                    <button type="button" className="btn btn-ghost" disabled={uploading} onClick={removeAvatar}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <label>
              <span>Your name <span className="muted">· shown to people you email</span></span>
              <input type="text" {...field('displayName')} placeholder={form.address} />
            </label>
            <label>
              <span>Signature <span className="muted">· added to new messages and replies</span></span>
              <textarea className="textarea" rows={4} {...field('signature')} placeholder={'Best regards,\nJohn'} />
            </label>
            <section className="sec-card google-account-card">
              <div>
                <h3>Use this address with Google</h3>
                <p className="muted small">
                  Create a Google Account with <strong>{form.address}</strong>. Choose “Use your existing email”
                  during signup; Google will send a verification code to this mailbox. This does not create a Gmail inbox.
                </p>
              </div>
              <a className="btn btn-outline" href="https://accounts.google.com/signup" target="_blank" rel="noreferrer">
                Set up Google Account
              </a>
            </section>
          </>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="settings-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    );
  }

  // A page in the mail area, like Gmail's settings, rather than a pop-up over it.
  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <div className="toolbar settings-bar">
        <button type="button" className="icon-btn" aria-label="Close settings" title="Back to mail" onClick={onClose}>
          <Icon name="back" />
        </button>
        <h2 id="settings-title">Settings</h2>
      </div>
      <div className="settings-tabs" role="tablist">
        {[
          ['profile', 'Profile', 'people'],
          ['security', 'Security', 'shield'],
        ].map(([id, label, icon]) => (
          <button type="button" role="tab" aria-selected={tab === id} key={id} className={`settings-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /> {label}
          </button>
        ))}
      </div>
      <div className="view-enter settings-body" key={tab}>
        {tab === 'profile' ? profileTab() : form ? <SecurityPanel account={form.address} owner={form.owner} /> : <div className="muted">Loading…</div>}
      </div>
    </section>
  );
}
