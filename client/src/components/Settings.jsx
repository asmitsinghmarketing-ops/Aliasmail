import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar, { squareImage } from './Avatar.jsx';
import Icon from './Icon.jsx';
import SecurityPanel from './SecurityPanel.jsx';

const GOOGLE_SIGNUP = 'https://accounts.google.com/signup';

/** Phone only: how to open the Google sign-up page in a private tab, with the link to copy. */
function PrivateTabHelp({ onClose }) {
  const [copied, setCopied] = useState(false);
  const field = useRef(null);

  useEffect(() => {
    // Capture and stop Escape here, so it closes only this dialog, not Settings behind it.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(GOOGLE_SIGNUP);
    } catch {
      // No clipboard access: select the link so a long-press can copy it.
      field.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
  }

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog private-help" role="dialog" aria-modal="true" aria-labelledby="private-help-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="private-help-title">Open in a private tab</h2>
        <p className="dialog-text">
          So it doesn’t mix with a Google account you’re already signed in to on this phone, open the sign-up page in an incognito
          or private tab.
        </p>
        <ol className="private-steps">
          <li>Tap <strong>Copy link</strong>.</li>
          <li>In your browser menu (<strong>⋮</strong> or the tabs button), open a <strong>New incognito tab</strong> (Safari: <strong>Private</strong>).</li>
          <li>Paste the link into the address bar and go.</li>
        </ol>
        <input ref={field} type="text" readOnly value={GOOGLE_SIGNUP} aria-label="Google sign-up link" onFocus={(e) => e.target.select()} />
        <div className="dialog-actions">
          <a className="btn btn-ghost" href={GOOGLE_SIGNUP} target="_blank" rel="noreferrer" onClick={onClose}>
            Open normally
          </a>
          <button type="button" className="btn btn-primary" autoFocus onClick={copy}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings({ color, initialTab = 'profile', onClose, onSaved, onAvatarChange }) {
  const [privateHelp, setPrivateHelp] = useState(false);
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
              <a
                className="btn btn-outline"
                href={GOOGLE_SIGNUP}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  // On a phone, suggest a private tab so it doesn't mix with a Google account
                  // already signed in there. A website can't open a private tab itself.
                  // Touch screens too: a phone in landscape or in "Desktop site" mode is wider than 800px.
                  if (window.matchMedia('(max-width: 800px), (pointer: coarse)').matches) {
                    e.preventDefault();
                    setPrivateHelp(true);
                  }
                }}
              >
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
      {privateHelp && <PrivateTabHelp onClose={() => setPrivateHelp(false)} />}
    </section>
  );
}
