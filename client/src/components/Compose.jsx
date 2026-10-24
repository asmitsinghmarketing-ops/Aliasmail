import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatSize } from '../format.js';
import Icon from './Icon.jsx';
import { Popover, TimeMenu, scheduleOptions } from './Menus.jsx';

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        content: String(reader.result).split(',')[1] ?? '',
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}${Math.random().toString(36).slice(2)}`);

/**
 * Compose window. Sending is handed to `onSend(payload)` so the mailbox can offer "Undo send";
 * `payload.sendAt` is set for a scheduled send. `draft.unsaved` marks content (e.g. an undone
 * send) that must be kept as a draft on close even if untouched.
 */
export default function Compose({ from, draft, onClose, onSend }) {
  const initial = { to: draft.to || '', cc: draft.cc || '', bcc: draft.bcc || '', subject: draft.subject || '', text: draft.text || '' };
  const [form, setForm] = useState(initial);
  const [showCc, setShowCc] = useState(Boolean(draft.cc));
  const [showBcc, setShowBcc] = useState(Boolean(draft.bcc));
  // Drafts autosave to the server under this id (a reopened draft keeps its own).
  const [id] = useState(() => draft.id || newId());
  const [saveState, setSaveState] = useState(draft.id ? 'Draft saved' : '');
  const onServer = useRef(Boolean(draft.id));
  const saveTimer = useRef(null);
  const sending = useRef(false);
  const [files, setFiles] = useState(draft.files || []);
  const [mode, setMode] = useState('normal'); // normal | min | full
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const body = useRef(null);

  // Replies open with the cursor above the quoted text and signature.
  useEffect(() => {
    if (draft.to && body.current) {
      body.current.setSelectionRange(0, 0);
      body.current.scrollTop = 0;
    }
  }, []);

  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const textChanged = Boolean(draft.unsaved) || Object.keys(initial).some((k) => form[k] !== initial[k]);
  const changed = files.length > 0 || textChanged;

  async function saveDraft() {
    clearTimeout(saveTimer.current);
    if (sending.current) return;
    setSaveState('Saving…');
    try {
      await api(`/mail/drafts/${id}`, {
        method: 'PUT',
        body: { ...form, inReplyTo: draft.inReplyTo || '', references: draft.references || [] },
      });
      onServer.current = true;
      setSaveState('Draft saved');
    } catch {
      setSaveState('Couldn’t save draft');
    }
  }

  useEffect(() => {
    if (!textChanged) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveDraft, 1500);
    return () => clearTimeout(saveTimer.current);
  }, [form]);

  async function addFiles(list) {
    try {
      const added = await Promise.all([...list].map(readFile));
      setFiles((current) => [...current, ...added]);
    } catch (err) {
      setError(err.message);
    }
  }

  // Closing keeps the draft (like Gmail); the trash button throws it away.
  async function close() {
    if (textChanged) {
      await saveDraft();
      onClose(files.length ? 'Draft saved (attachments are not kept in drafts).' : 'Draft saved.');
    } else {
      onClose();
    }
  }

  async function discard() {
    if (changed && !confirm('Discard this draft?')) return;
    clearTimeout(saveTimer.current);
    sending.current = true; // stop any pending autosave
    if (onServer.current) await api('/mail/drafts/delete', { method: 'POST', body: { ids: [id] } }).catch(() => {});
    onClose(onServer.current || changed ? 'Draft discarded.' : undefined);
  }

  function send(e, sendAt) {
    e?.preventDefault();
    if (sending.current) return;
    if (!form.to.trim() && !form.cc.trim() && !form.bcc.trim()) {
      setError('Add at least one recipient');
      return;
    }
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) {
      setError('Attachments are larger than 20 MB in total');
      return;
    }
    if (!form.subject.trim() && !confirm('Send this message without a subject?')) return;

    clearTimeout(saveTimer.current);
    sending.current = true;
    onSend({
      ...form,
      draftId: id,
      inReplyTo: draft.inReplyTo || undefined,
      references: draft.references,
      files,
      sendAt: sendAt?.toISOString(),
    });
  }

  const compose = (
    <form
      className={`compose ${mode}`}
      onSubmit={send}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e);
        if (e.key === 'Escape') close();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="compose-head" onClick={() => setMode(mode === 'min' ? 'normal' : 'min')}>
        <span>{form.subject || 'New message'}</span>
        <span className="compose-head-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn light" title="Minimize" onClick={() => setMode(mode === 'min' ? 'normal' : 'min')}>
            <Icon name="minimize" size={16} />
          </button>
          <button type="button" className="icon-btn light" title={mode === 'full' ? 'Exit full screen' : 'Full screen'} onClick={() => setMode(mode === 'full' ? 'normal' : 'full')}>
            <Icon name="expand" size={16} />
          </button>
          <button type="button" className="icon-btn light" title="Close" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </span>
      </div>

      {mode !== 'min' && (
        <>
          <div className="compose-line muted">From: {from}</div>
          <div className="compose-line">
            <span className="compose-label">To</span>
            <input placeholder="Recipients (separate with commas)" autoFocus={!draft.to} {...field('to')} />
            {!showCc && (
              <button type="button" className="link" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" className="link" onClick={() => setShowBcc(true)}>
                Bcc
              </button>
            )}
          </div>
          {showCc && (
            <div className="compose-line">
              <span className="compose-label">Cc</span>
              <input {...field('cc')} />
            </div>
          )}
          {showBcc && (
            <div className="compose-line">
              <span className="compose-label">Bcc</span>
              <input {...field('bcc')} />
            </div>
          )}
          <div className="compose-line">
            <input placeholder="Subject" {...field('subject')} />
          </div>
          <textarea
            className="compose-body"
            autoFocus={Boolean(draft.to)}
            ref={body}
            {...field('text')}
          />

          {dragging && <div className="drop-hint">Drop files to attach</div>}
          {files.length > 0 && (
            <div className="compose-files">
              {files.map((f, i) => (
                <span key={i} className="file-pill">
                  {f.filename} <span className="muted">({formatSize(f.size)})</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove">
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <div className="alert m">{error}</div>}

          <div className="compose-foot">
            <span className="split-btn">
              <button className="btn btn-primary" title="Send (Ctrl+Enter)">
                Send <Icon name="send" size={16} />
              </button>
              <Popover icon="arrowDrop" title="Schedule send" className="btn btn-primary split-arrow" align="up">
                {(close) => <TimeMenu title="Schedule send" options={scheduleOptions()} close={close} onPick={(date) => send(null, date)} />}
              </Popover>
            </span>
            <label className="icon-btn" title="Attach files">
              <Icon name="attach" />
              <input type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
            </label>
            <span className="muted small hide-sm save-state">{saveState || 'Ctrl+Enter to send'}</span>
            <button type="button" className="icon-btn push-right" title="Discard draft" onClick={discard}>
              <Icon name="trash" />
            </button>
          </div>
        </>
      )}
    </form>
  );

  return mode === 'full' ? <div className="compose-backdrop">{compose}</div> : compose;
}
