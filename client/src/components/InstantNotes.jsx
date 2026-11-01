// Instant notes: quick private messages between teammates, with files, delivered at once over
// the mailbox's live connection. Never sent by email.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatSize } from '../format.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
    reader.readAsDataURL(file);
  });

const nameOf = (person) => person?.name || person?.address?.split('@')[0] || '';
const fileUrl = (f, download) => `/api/notes/files/${encodeURIComponent(f.id)}${download ? '?download=1' : ''}`;

/**
 * The notes panel. `incoming` is the latest note pushed over the live connection; `startWith`
 * opens a person's notes straight away (from a pop-up). `onRead` lowers the unread badge.
 */
export default function InstantNotes({ me, incoming, startWith, onClose, onRead }) {
  const [threads, setThreads] = useState(null);
  const [person, setPerson] = useState(null);
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef(null);
  const picker = useRef(null);

  const loadThreads = () => api('/notes/threads').then(setThreads).catch((err) => setError(err.message));
  useEffect(() => { loadThreads(); }, []);

  useEffect(() => {
    if (startWith && threads) {
      const found = threads.find((t) => t.address === startWith);
      if (found) open(found);
    }
  }, [startWith, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && (person ? setPerson(null) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [person, onClose]);

  // A note pushed while the panel is open: into the open conversation, or the list's preview.
  useEffect(() => {
    if (!incoming) return;
    const other = incoming.from === me ? incoming.to : incoming.from;
    if (person?.address === other) {
      setNotes((list) => (list.some((n) => n.id === incoming.id) ? list : [...list, incoming]));
      if (incoming.from !== me) markRead(other);
    }
    loadThreads();
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [notes]);

  async function markRead(address) {
    const { changed } = await api('/notes/read', { method: 'POST', body: { with: address } }).catch(() => ({ changed: 0 }));
    if (changed) onRead(changed);
  }

  async function open(thread) {
    setPerson(thread);
    setError('');
    setNotes(await api(`/notes?with=${encodeURIComponent(thread.address)}`).catch((err) => { setError(err.message); return []; }));
    if (thread.unread) {
      await markRead(thread.address);
      loadThreads();
    }
  }

  function addFiles(list) {
    setError('');
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than 10 MB`);
    setFiles((current) => {
      const next = [...current, ...picked].slice(0, MAX_FILES);
      if (current.length + picked.length > MAX_FILES) setError(`Up to ${MAX_FILES} files in one note`);
      return next;
    });
  }

  async function send(e) {
    e?.preventDefault();
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    setError('');
    try {
      const body = { to: person.address, text, files: await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await readBase64(f) }))) };
      const note = await api('/notes', { method: 'POST', body });
      setNotes((list) => (list.some((n) => n.id === note.id) ? list : [...list, note]));
      setText('');
      setFiles([]);
      loadThreads();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="notes-panel" role="dialog" aria-label="Instant notes">
      <header className="notes-head">
        {person ? (
          <>
            <button type="button" className="icon-btn" aria-label="All notes" onClick={() => { setPerson(null); loadThreads(); }}>
              <Icon name="back" />
            </button>
            <Avatar url={person.avatarUrl} person={person} color={person.color} size="sm" />
            <div className="notes-who">
              <strong>{nameOf(person)}</strong>
              <span className="muted small">{person.address}</span>
            </div>
          </>
        ) : (
          <div className="notes-who">
            <strong>Instant notes</strong>
            <span className="muted small">Private notes to your team, delivered instantly. Never sent by email.</span>
          </div>
        )}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {!person && (
        <div className="notes-threads">
          {!threads && <div className="muted notes-empty">Loading…</div>}
          {threads?.length === 0 && <div className="muted notes-empty">Nobody else on your team yet. The admin adds people in the Admin console.</div>}
          {threads?.map((t) => (
            <button key={t.address} type="button" className={`notes-thread ${t.unread ? 'unread' : ''}`} onClick={() => open(t)}>
              <Avatar url={t.avatarUrl} person={t} color={t.color} />
              <span className="notes-thread-text">
                <span className="notes-thread-top">
                  <strong>{nameOf(t)}</strong>
                  {t.last && <span className="muted small">{formatDate(t.last.at)}</span>}
                </span>
                <span className="muted small notes-preview">
                  {t.last
                    ? `${t.last.from === me ? 'You: ' : ''}${t.last.text || (t.last.files.length ? `Attachment: ${t.last.files.map((f) => f.name).join(', ')}` : '')}`
                    : 'Send the first note'}
                </span>
              </span>
              {t.unread > 0 && <span className="notes-badge">{t.unread}</span>}
            </button>
          ))}
        </div>
      )}

      {person && (
        <>
          <div className="notes-list">
            {notes.length === 0 && <div className="muted notes-empty">No notes with {nameOf(person)} yet. Say hello.</div>}
            {notes.map((n) => (
              <div key={n.id} className={`note ${n.from === me ? 'mine' : 'theirs'}`}>
                {n.text && <p>{n.text}</p>}
                {n.files.map((f) =>
                  IMAGE.test(f.type) ? (
                    <a key={f.id} className="note-image" href={fileUrl(f)} target="_blank" rel="noreferrer">
                      <img src={fileUrl(f)} alt={f.name} loading="lazy" />
                    </a>
                  ) : (
                    <a key={f.id} className="note-file" href={fileUrl(f, true)} download={f.name}>
                      <Icon name="attach" size={18} />
                      <span className="note-file-name">{f.name}</span>
                      <span className="note-file-size">{formatSize(f.size)}</span>
                    </a>
                  ),
                )}
                <span className="note-time">
                  {formatDate(n.at)}
                  {n.from === me && n.read && ' · Seen'}
                </span>
              </div>
            ))}
            <div ref={bottom} />
          </div>

          <form className="notes-compose" onSubmit={send}>
            {files.length > 0 && (
              <div className="notes-files">
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="file-pill">
                    {f.name} <span className="muted">({formatSize(f.size)})</span>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="notes-compose-row">
              <button type="button" className="icon-btn" title="Attach files (up to 5, 10 MB each)" aria-label="Attach files" onClick={() => picker.current.click()}>
                <Icon name="attach" />
              </button>
              <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
              <label className="sr-only" htmlFor="note-text">Note to {nameOf(person)}</label>
              <textarea
                id="note-text"
                rows={1}
                maxLength={4000}
                placeholder={`Note to ${nameOf(person)}…`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e);
                }}
              />
              <button className="btn btn-primary" disabled={busy || (!text.trim() && !files.length)}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </>
      )}
      {error && <div className="alert notes-error">{error}</div>}
    </aside>
  );
}
