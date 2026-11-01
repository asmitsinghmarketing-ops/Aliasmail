// Instant notes: quick private messages between teammates, with files, delivered at once over
// the live connection (live.js), with who is online and typing. Never sent by email.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatSize } from '../format.js';
import { notify, onlineNow, request, subscribe } from '../live.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const TYPING_EVERY_MS = 2500; // how often "typing" is sent while someone types
const TYPING_SHOWN_MS = 4000; // how long "typing…" stays after the last one arrives

/** Over the socket when it's open; through the plain API when it couldn't be sent. */
async function viaLive(message, path, body) {
  try {
    return await request(message);
  } catch (err) {
    if (!err.offline) throw err;
    return { http: await api(path, { method: 'POST', body }) };
  }
}

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
  const [online, setOnline] = useState(onlineNow); // addresses online; null when unknown
  const [typing, setTyping] = useState({}); // address -> when "typing" last arrived
  const [, setTick] = useState(0);
  const bottom = useRef(null);
  const picker = useRef(null);
  const lastTyping = useRef(0);
  const current = useRef(null);
  current.current = person;

  const loadThreads = () => api('/notes/threads').then(setThreads).catch((err) => setError(err.message));
  useEffect(() => { loadThreads(); }, []);

  // Who is online and typing, and "Seen" the moment a note is read.
  useEffect(() => subscribe((message) => {
    if (['hello', 'closed', 'presence'].includes(message.type)) setOnline(onlineNow());
    else if (message.type === 'typing') {
      setTyping((t) => ({ ...t, [message.from]: Date.now() }));
    } else if (message.type === 'note') {
      setTyping((t) => ({ ...t, [message.note.from]: 0 }));
    } else if (message.type === 'note-read' && current.current?.address === message.by) {
      setNotes((list) => list.map((n) => (n.to === message.by ? { ...n, read: true } : n)));
    }
  }), []);

  // "typing…" fades by itself when no more arrive.
  const typingNow = (address) => Date.now() - (typing[address] || 0) < TYPING_SHOWN_MS;
  const anyTyping = Object.keys(typing).some(typingNow);
  useEffect(() => {
    if (!anyTyping) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [anyTyping]);

  const isOnline = (t) => (online ? online.has(t.address) : Boolean(t.online));

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
    const answer = await viaLive({ type: 'read', with: address }, '/notes/read', { with: address }).catch(() => ({}));
    const changed = answer.http ? answer.http.changed : answer.changed;
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
      const answer = await viaLive({ type: 'note', ...body }, '/notes', body);
      const note = answer.http || answer.note;
      lastTyping.current = 0;
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
            <span className="presence-wrap">
              <Avatar url={person.avatarUrl} person={person} color={person.color} size="sm" />
              {isOnline(person) && <span className="presence-dot" title="Online" />}
            </span>
            <div className="notes-who">
              <strong>{nameOf(person)}</strong>
              <span className={`small ${typingNow(person.address) ? 'notes-typing' : 'muted'}`}>
                {typingNow(person.address) ? 'typing…' : isOnline(person) ? 'Online now' : person.address}
              </span>
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
              <span className="presence-wrap">
                <Avatar url={t.avatarUrl} person={t} color={t.color} />
                {isOnline(t) && <span className="presence-dot" title="Online" />}
              </span>
              <span className="notes-thread-text">
                <span className="notes-thread-top">
                  <strong>{nameOf(t)}</strong>
                  {t.last && <span className="muted small">{formatDate(t.last.at)}</span>}
                </span>
                <span className={`small notes-preview ${typingNow(t.address) ? 'notes-typing' : 'muted'}`}>
                  {typingNow(t.address) ? 'typing…' : t.last
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
                onChange={(e) => {
                  setText(e.target.value);
                  if (e.target.value && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
                    lastTyping.current = Date.now();
                    notify({ type: 'typing', to: person.address });
                  }
                }}
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
