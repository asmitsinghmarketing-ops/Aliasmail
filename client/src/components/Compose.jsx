import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatSize } from '../format.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { Popover, TimeMenu, scheduleOptions } from './Menus.jsx';
import RichEditor, { htmlFromText, sanitizeHtml } from './RichEditor.jsx';
import { pickDriveFiles } from '../drivePicker.js';
import RecipientField, { parseAddresses } from './RecipientField.jsx';

// Address suggestions, loaded once per page and shared by every compose window.
let contactsCache = null;
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { preuploadAttachment } from '../attachmentUpload.js';

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const readFile = (file) => ({ filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, _file: file });

/**
 * The subject wraps onto more lines instead of being cut off; it stays one paragraph (Enter
 * doesn't add a line break, Ctrl+Enter still sends).
 */
function SubjectField({ value, onChange, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="subject-field"
      value={value}
      onChange={(e) => onChange({ target: { value: e.target.value.replace(/\s*\n\s*/g, ' ') } })}
      onKeyDown={(e) => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && e.preventDefault()}
      {...props}
    />
  );
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}${Math.random().toString(36).slice(2)}`);

// On phones the system back button/gesture closes compose (saving the draft), like Gmail.
// A history entry is added while compose is open; leaving another way removes it again.
// The removal waits a tick so React's development double-mount doesn't undo its own entry.
let pendingHistoryBack = null;

/** The ⋮ menu of the phone compose screen: Drive, schedule send, or discard. */
function MoreMenu({ close, onSchedule, onDiscard, onDrive }) {
  const [scheduling, setScheduling] = useState(false);
  if (scheduling) return <TimeMenu title="Schedule send" options={scheduleOptions()} close={close} onPick={onSchedule} />;
  return (
    <div className="menu">
      {onDrive && (
        <button
          type="button"
          className="menu-item check-item"
          onClick={() => {
            close();
            onDrive();
          }}
        >
          <Icon name="drive" size={20} /> Insert from Drive
        </button>
      )}
      <button type="button" className="menu-item check-item" onClick={() => setScheduling(true)}>
        <Icon name="scheduleSend" size={20} /> Schedule send
      </button>
      <button
        type="button"
        className="menu-item check-item"
        onClick={() => {
          close();
          onDiscard();
        }}
      >
        <Icon name="trash" size={20} /> Discard
      </button>
    </div>
  );
}

// What recipients get on the Drive files in an email (shared when it is sent).
const DRIVE_ACCESS = [
  ['view', 'Recipients can view'],
  ['comment', 'Recipients can comment'],
  ['edit', 'Recipients can edit'],
  ['none', 'Don’t change sharing'],
];

/**
 * Compose window. Sending is handed to `onSend(payload)` so the mailbox can offer "Undo send";
 * `payload.sendAt` is set for a scheduled send. `draft.unsaved` marks content (e.g. an undone
 * send) that must be kept as a draft on close even if untouched. `payload.drive` lists Drive
 * files to share with the recipients.
 */

export default function Compose({ from, draft, onClose, onSend, driveOn = false }) {
  const initial = {
    to: draft.to || '', cc: draft.cc || '', bcc: draft.bcc || '', subject: draft.subject || '', text: draft.text || '',
    html: draft.html || htmlFromText(draft.text || ''),
  };
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
  // Drive files picked with Google's picker: linked in the message and shared with recipients on send.
  const [driveFiles, setDriveFiles] = useState(draft.driveFiles || []);
  const [driveAccess, setDriveAccess] = useState(draft.driveAccess || 'view');
  const [drivePicking, setDrivePicking] = useState(false);
  // Phones get a full-screen compose screen like the Gmail app; larger screens a floating window.
  const [phone] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  const [mode, setMode] = useState('normal'); // normal | min | full
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const body = useRef(null);
  // The window can be dragged by its title bar. null = docked bottom-right; else { left, top } in px.
  const [pos, setPos] = useState(null);
  const win = useRef(null);
  const drag = useRef(null); // { dx, dy, x, y, moved } while the pointer is down
  const justDragged = useRef(false); // swallow the click that ends a drag (a click minimizes)

  // Keep the title bar on screen: the whole width inside the window, the top above the bottom edge.
  const clamp = (left, top) => ({
    left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - win.current.offsetWidth)),
    top: Math.min(Math.max(0, top), window.innerHeight - 44),
  });

  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos((p) => p && clamp(p.left, p.top));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [Boolean(pos)]);

  const dragHandlers = {
    onPointerDown(e) {
      if (mode === 'full' || e.button !== 0 || e.target.closest('.compose-head-actions')) return;
      const rect = win.current.getBoundingClientRect();
      drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: e.clientX, y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e) {
      const d = drag.current;
      if (!d || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4)) return;
      d.moved = true;
      setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
    },
    onPointerUp() {
      justDragged.current = Boolean(drag.current?.moved);
      drag.current = null;
    },
    // Double-click the title bar to dock the window back in the corner.
    onDoubleClick: () => setPos(null),
  };
  const floating = pos && mode !== 'full';

  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const [contacts, setContacts] = useState(contactsCache || []);
  useEffect(() => {
    if (contactsCache) return;
    api('/mail/contacts')
      .then((list) => {
        contactsCache = list;
        setContacts(list);
      })
      .catch(() => {});
  }, []);
  const recipients = (key, label, props = {}) => (
    <RecipientField
      fieldKey={key}
      label={label}
      value={form[key]}
      onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
      contacts={contacts}
      {...props}
    />
  );
  const onBody = ({ html, text }) => setForm((f) => ({ ...f, html, text }));
  // Replies and forwards open with the cursor above the quoted text and signature.
  const editor = (props) => (
    <RichEditor
      initialHtml={initial.html}
      onChange={onBody}
      placeholder="Compose email"
      autoFocus={Boolean(draft.to)}
      caretAtStart={Boolean(draft.to)}
      editorRef={body}
      {...props}
    />
  );
  const textChanged = Boolean(draft.unsaved) || Object.keys(initial).some((k) => form[k] !== initial[k]);
  const changed = files.length > 0 || driveFiles.length > 0 || textChanged;

  async function saveDraft() {
    clearTimeout(saveTimer.current);
    if (sending.current) return;
    setSaveState('Saving…');
    try {
      await api(`/mail/drafts/${id}`, {
        method: 'PUT',
        body: { ...form, html: sanitizeHtml(form.html), inReplyTo: draft.inReplyTo || '', references: draft.references || [] },
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
      const added = [...list].map(readFile);
      setFiles((current) => [...current, ...added]);
      added.forEach(preuploadAttachment);
    } catch (err) {
      setError(err.message);
    }
  }

  // Insert from Drive: Google's picker on the person's own Drive. The first time, Drive has to be
  // connected (a Google screen), so the draft is saved before leaving the page.
  async function insertFromDrive() {
    if (drivePicking) return;
    setError('');
    let access;
    try {
      access = await api('/mail/drive/token', { method: 'POST' });
    } catch (err) {
      if (err.status !== 409) return setError(err.message);
      const go = await ask({
        title: 'Connect Google Drive?',
        message: 'To insert Drive files, connect your Google Drive once. Your draft is saved first; open it again from Drafts afterwards.',
        confirmLabel: 'Connect Drive',
      });
      if (!go) return;
      await saveDraft();
      window.location.href = '/api/auth/google/start?mode=drive';
      return;
    }
    setDrivePicking(true);
    try {
      const picked = await pickDriveFiles(access);
      setDriveFiles((current) => [...current, ...picked.filter((f) => !current.some((c) => c.id === f.id))]);
    } catch (err) {
      setError(err.message);
    } finally {
      setDrivePicking(false);
    }
  }

  // Closing keeps the draft (like Gmail); the trash button throws it away.
  async function close() {
    if (textChanged) {
      await saveDraft();
      onClose(files.length || driveFiles.length ? 'Draft saved (attachments and Drive files are not kept in drafts).' : 'Draft saved.');
    } else {
      onClose();
    }
  }

  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!phone) return undefined;
    clearTimeout(pendingHistoryBack);
    if (history.state?.aliasmailCompose !== id) history.pushState({ ...history.state, aliasmailCompose: id }, '');
    let popped = false;
    const onPop = () => {
      popped = true;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped) {
        pendingHistoryBack = setTimeout(() => {
          if (history.state?.aliasmailCompose === id) history.back();
        }, 0);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function discard() {
    if (changed && !(await ask({ title: 'Discard this draft?', message: 'What you wrote will be deleted.', confirmLabel: 'Discard', danger: true }))) return;
    clearTimeout(saveTimer.current);
    sending.current = true; // stop any pending autosave
    if (onServer.current) await api('/mail/drafts/delete', { method: 'POST', body: { ids: [id] } }).catch(() => {});
    onClose(onServer.current || changed ? 'Draft discarded.' : undefined);
  }

  async function send(e, sendAt) {
    e?.preventDefault();
    if (sending.current) return;
    if (!form.to.trim() && !form.cc.trim() && !form.bcc.trim()) {
      setError('Add at least one recipient');
      return;
    }
    const bad = ['to', 'cc', 'bcc'].flatMap((k) => parseAddresses(form[k])).find((r) => !VALID_EMAIL.test(r.address));
    if (bad) {
      setError(`“${bad.address}” isn’t a valid email address. Click it to fix it, or remove it.`);
      return;
    }
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) {
      setError('Attachments are larger than 20 MB in total');
      return;
    }
    if (!form.subject.trim() && !(await ask({ title: 'Send without a subject?', message: 'This message has no subject line.', confirmLabel: 'Send anyway' }))) return;

    clearTimeout(saveTimer.current);
    sending.current = true;
    // Attachments still uploading finish in the background (the mailbox waits for them before
    // sending), so the window closes at once, like Gmail.
    // The Drive links are added to the body by the mailbox (see driveLinks) so an undone send
    // reopens without them doubled.
    onSend({
      ...form,
      html: sanitizeHtml(form.html),
      draftId: id,
      inReplyTo: draft.inReplyTo || undefined,
      references: draft.references,
      files,
      driveFiles,
      driveAccess,
      drive: driveFiles.length ? { files: driveFiles.map(({ id: fileId, name }) => ({ id: fileId, name })), access: driveAccess } : undefined,
      sendAt: sendAt?.toISOString(),
    });
  }

  const attachments = (files.length > 0 || driveFiles.length > 0) && (
    <div className="compose-files">
      {files.map((f, i) => (
        <span key={i} className="file-pill">
          {f.filename} <span className="muted">({formatSize(f.size)})</span>
          <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.filename}`}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      {driveFiles.map((f) => (
        <span key={f.id} className="file-pill drive-pill">
          <Icon name="drive" size={16} />
          <a href={f.url} target="_blank" rel="noreferrer">
            {f.name}
          </a>
          <button type="button" onClick={() => setDriveFiles(driveFiles.filter((d) => d.id !== f.id))} aria-label={`Remove ${f.name}`}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      {driveFiles.length > 0 && (
        <select className="drive-access" aria-label="Drive sharing" value={driveAccess} onChange={(e) => setDriveAccess(e.target.value)}>
          {DRIVE_ACCESS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  if (phone) {
    return (
      <form className="compose-mobile" onSubmit={send} aria-label="Compose email">
        <div className="cm-bar">
          <button type="button" className="icon-btn" aria-label="Back (saves the draft)" title="Back" onClick={close}>
            <Icon name="back" />
          </button>
          <span className="cm-title">Compose</span>
          <label className="icon-btn" aria-label="Attach files" title="Attach files">
            <Icon name="attach" />
            <input type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
          </label>
          <button className="icon-btn cm-send" aria-label="Send" title="Send">
            <Icon name="send" />
          </button>
          <Popover icon="moreVert" title="More options" align="right">
            {(closeMenu) => (
              <MoreMenu close={closeMenu} onSchedule={(date) => send(null, date)} onDiscard={discard} onDrive={driveOn ? insertFromDrive : undefined} />
            )}
          </Popover>
        </div>

        <div className="cm-scroll">
          <div className="cm-row">
            <span className="cm-label">From</span>
            <span className="cm-from">{from}</span>
          </div>
          {recipients('to', 'To', {
            className: 'cm-row',
            autoFocus: !draft.to,
            after: (
            <button
              type="button"
              className="icon-btn cm-expand"
              aria-label={showCc ? 'Hide Cc and Bcc' : 'Add Cc and Bcc'}
              aria-expanded={showCc}
              onClick={() => {
                setShowCc(!showCc);
                setShowBcc(!showCc);
              }}
            >
              <Icon name="expandMore" />
            </button>
            ),
          })}
          {showCc && recipients('cc', 'Cc', { className: 'cm-row' })}
          {(showCc || showBcc) && recipients('bcc', 'Bcc', { className: 'cm-row' })}
          <div className="cm-row">
            <SubjectField placeholder="Subject" aria-label="Subject" autoCapitalize="sentences" {...field('subject')} />
          </div>
          {error && <div className="alert m">{error}</div>}
          {editor({ className: 'cm-body', toolbarClassName: 'cm-format' })}
          {attachments}
          {saveState && <div className="cm-save muted small">{saveState}</div>}
        </div>
      </form>
    );
  }

  const compose = (
    <form
      ref={win}
      className={`compose ${mode} ${floating ? 'floating' : ''}`}
      style={floating ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto', maxHeight: `calc(100vh - ${pos.top + 8}px)` } : undefined}
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
      <div
        className="compose-head"
        title={mode === 'full' ? undefined : 'Drag to move · double-click to dock'}
        {...dragHandlers}
        onClick={() => {
          if (justDragged.current) {
            justDragged.current = false;
            return;
          }
          setMode(mode === 'min' ? 'normal' : 'min');
        }}
      >
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
          {recipients('to', 'To', {
            className: 'compose-line',
            placeholder: 'Recipients',
            autoFocus: !draft.to,
            after: (!showCc || !showBcc) && (
              <span className="cc-links">
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
              </span>
            ),
          })}
          {showCc && recipients('cc', 'Cc', { className: 'compose-line', autoFocus: !draft.cc })}
          {showBcc && recipients('bcc', 'Bcc', { className: 'compose-line', autoFocus: !draft.bcc })}
          <div className="compose-line">
            <SubjectField placeholder="Subject" aria-label="Subject" {...field('subject')} />
          </div>
          {editor({ className: 'compose-body' })}

          {dragging && <div className="drop-hint">Drop files to attach</div>}
          {attachments}
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
            {driveOn && (
              <button type="button" className="icon-btn" title="Insert files using Drive" disabled={drivePicking} onClick={insertFromDrive}>
                <Icon name="drive" />
              </button>
            )}
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
