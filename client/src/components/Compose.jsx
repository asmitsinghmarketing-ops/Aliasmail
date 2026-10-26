import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatSize } from '../format.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { Popover, TimeMenu, scheduleOptions } from './Menus.jsx';
import RichEditor, { htmlFromText, sanitizeHtml } from './RichEditor.jsx';

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

// On phones the system back button/gesture closes compose (saving the draft), like Gmail.
// A history entry is added while compose is open; leaving another way removes it again.
// The removal waits a tick so React's development double-mount doesn't undo its own entry.
let pendingHistoryBack = null;

/** The ⋮ menu of the phone compose screen: schedule send, or discard. */
function MoreMenu({ close, onSchedule, onDiscard }) {
  const [scheduling, setScheduling] = useState(false);
  if (scheduling) return <TimeMenu title="Schedule send" options={scheduleOptions()} close={close} onPick={onSchedule} />;
  return (
    <div className="menu">
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

/**
 * Compose window. Sending is handed to `onSend(payload)` so the mailbox can offer "Undo send";
 * `payload.sendAt` is set for a scheduled send. `draft.unsaved` marks content (e.g. an undone
 * send) that must be kept as a draft on close even if untouched.
 */
export default function Compose({ from, draft, onClose, onSend }) {
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
  const changed = files.length > 0 || textChanged;

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
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) {
      setError('Attachments are larger than 20 MB in total');
      return;
    }
    if (!form.subject.trim() && !(await ask({ title: 'Send without a subject?', message: 'This message has no subject line.', confirmLabel: 'Send anyway' }))) return;

    clearTimeout(saveTimer.current);
    sending.current = true;
    onSend({
      ...form,
      html: sanitizeHtml(form.html),
      draftId: id,
      inReplyTo: draft.inReplyTo || undefined,
      references: draft.references,
      files,
      sendAt: sendAt?.toISOString(),
    });
  }

  const attachments = files.length > 0 && (
    <div className="compose-files">
      {files.map((f, i) => (
        <span key={i} className="file-pill">
          {f.filename} <span className="muted">({formatSize(f.size)})</span>
          <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.filename}`}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
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
            {(closeMenu) => <MoreMenu close={closeMenu} onSchedule={(date) => send(null, date)} onDiscard={discard} />}
          </Popover>
        </div>

        <div className="cm-scroll">
          <div className="cm-row">
            <span className="cm-label">From</span>
            <span className="cm-from">{from}</span>
          </div>
          <div className="cm-row">
            <span className="cm-label">To</span>
            <input
              type="text"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="To"
              autoFocus={!draft.to}
              {...field('to')}
            />
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
          </div>
          {showCc && (
            <div className="cm-row">
              <span className="cm-label">Cc</span>
              <input type="text" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Cc" {...field('cc')} />
            </div>
          )}
          {(showCc || showBcc) && (
            <div className="cm-row">
              <span className="cm-label">Bcc</span>
              <input type="text" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Bcc" {...field('bcc')} />
            </div>
          )}
          <div className="cm-row">
            <input type="text" placeholder="Subject" aria-label="Subject" autoCapitalize="sentences" {...field('subject')} />
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
