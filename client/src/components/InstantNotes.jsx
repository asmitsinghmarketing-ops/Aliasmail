// Instant notes: quick private messages between teammates, one to one or in groups, with files,
// delivered at once over the live connection (live.js), with who is online and typing. Never
// sent by email.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { startCall, startMeeting } from '../calls.js';
import { formatDate, formatSize } from '../format.js';
import { notify, onlineNow, request, subscribe } from '../live.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import { PeopleSkeleton } from './Loading.jsx';

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
const firstName = (person) => nameOf(person).split(' ')[0];
const fileUrl = (f, download) => `/api/notes/files/${encodeURIComponent(f.id)}${download ? '?download=1' : ''}`;
const isGroup = (t) => t?.kind === 'group';
/** One key per conversation: a teammate's address, or "group:<id>". */
const keyOf = (t) => (isGroup(t) ? `group:${t.id}` : t?.address);
const preview = (note) => (note.deleted ? 'Note deleted' : note.text || (note.files.length ? `Attachment: ${note.files.map((f) => f.name).join(', ')}` : ''));
const REACTIONS = ['👍', '❤️', '😂', '🎉', '✅'];
/** "Today", "Yesterday", or the date, for the line between days in a conversation. */
function dayLine(iso) {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(day.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}

/** A group's picture: two other members' initials, in their colours. */
function GroupAvatar({ group, me, size = '' }) {
  const shown = (group.members || []).filter((m) => m.address !== me).slice(0, 2);
  return (
    <span className={`group-avatar ${size}`} aria-hidden="true">
      {shown.length ? shown.map((m) => <span key={m.address} style={{ background: m.color || '#5f6b7a' }}>{nameOf(m).charAt(0).toUpperCase()}</span>) : <Icon name="people" size={18} />}
    </span>
  );
}

/**
 * The notes panel. `incoming` is the latest note pushed over the live connection; `startWith`
 * opens a conversation straight away (an address or "group:<id>", from a pop-up or a
 * notification). `onRead` lowers the unread badge.
 */
export default function InstantNotes({ me, incoming, startWith, onClose, onRead }) {
  const [threads, setThreads] = useState(null);
  const [thread, setThread] = useState(null); // the open conversation
  const [view, setView] = useState('list'); // 'list' | 'chat' | 'new-group' | 'group-info'
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(onlineNow); // addresses online; null when unknown
  const [typing, setTyping] = useState({}); // "<conversation key>|<address>" -> when "typing" arrived
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(''); // filters the conversation list
  const [filter, setFilter] = useState('all'); // all | unread | groups
  const [replyTo, setReplyTo] = useState(null); // the note being answered
  const [picked, setPicked] = useState(null); // the note whose actions are showing (tap on phones)
  const bottom = useRef(null);
  const textBox = useRef(null);
  const picker = useRef(null);
  const lastTyping = useRef(0);
  const current = useRef(null);
  current.current = thread;

  const loadThreads = () =>
    api('/notes/threads')
      .then((list) => {
        setThreads(list);
        // Keep the open group's name and members up to date (or close it if I'm no longer in it).
        const open = current.current;
        if (isGroup(open)) {
          const fresh = list.find((t) => keyOf(t) === keyOf(open));
          if (fresh) setThread(fresh);
          else {
            setThread(null);
            setView('list');
          }
        }
      })
      .catch((err) => setError(err.message));
  useEffect(() => { loadThreads(); }, []);

  const people = (threads || []).filter((t) => !isGroup(t));
  const needle = query.trim().toLowerCase();
  const shownThreads = (threads || []).filter((t) => (filter !== 'unread' || t.unread) && (filter !== 'groups' || isGroup(t))
    && (!needle || `${isGroup(t) ? t.name : nameOf(t)} ${t.address || ''}`.toLowerCase().includes(needle)));

  // Who is online and typing, "Seen" the moment a note is read, and group changes.
  useEffect(() => subscribe((message) => {
    if (['hello', 'closed', 'presence'].includes(message.type)) setOnline(onlineNow());
    else if (message.type === 'typing') {
      const conversation = message.group ? `group:${message.group}` : message.from;
      setTyping((t) => ({ ...t, [`${conversation}|${message.from}`]: Date.now() }));
    } else if (message.type === 'note') {
      const n = message.note;
      setTyping((t) => ({ ...t, [`${n.group ? `group:${n.group}` : n.from}|${n.from}`]: 0 }));
    } else if (message.type === 'note-read') {
      const open = current.current;
      if (message.group && isGroup(open) && open.id === message.group) {
        setNotes((list) => list.map((n) => (n.from !== message.by && !(n.readBy || []).includes(message.by) ? { ...n, readBy: [...(n.readBy || []), message.by], read: true } : n)));
      } else if (!message.group && open?.address === message.by) {
        setNotes((list) => list.map((n) => (n.to === message.by ? { ...n, read: true } : n)));
      }
    } else if (message.type === 'note-update') {
      // A reaction or a deletion, from me in another window or from someone in the conversation.
      setNotes((list) => list.map((n) => (n.id === message.note.id ? { ...n, ...message.note } : n)));
      if (message.note.deleted) loadThreads();
    } else if (message.type === 'group') {
      loadThreads();
    }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceNote = (note) => setNotes((list) => list.map((n) => (n.id === note.id ? { ...n, ...note } : n)));
  async function react(note, emoji) {
    setPicked(null);
    try { replaceNote(await api(`/notes/${note.id}/react`, { method: 'POST', body: { emoji } })); }
    catch (err) { setError(err.message); }
  }
  async function removeNote(note) {
    setPicked(null);
    try {
      replaceNote(await api(`/notes/${note.id}`, { method: 'DELETE' }));
      loadThreads();
    } catch (err) { setError(err.message); }
  }
  function answer(note) {
    setPicked(null);
    setReplyTo(note);
    textBox.current?.focus();
  }
  const jumpTo = (id) => {
    const node = document.getElementById(`note-${id}`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  };

  // "typing…" fades by itself when no more arrive.
  const typers = (t) => {
    const prefix = `${keyOf(t)}|`;
    return Object.entries(typing)
      .filter(([k, at]) => k.startsWith(prefix) && Date.now() - at < TYPING_SHOWN_MS)
      .map(([k]) => k.slice(prefix.length));
  };
  const anyTyping = Object.values(typing).some((at) => Date.now() - at < TYPING_SHOWN_MS);
  useEffect(() => {
    if (!anyTyping) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [anyTyping]);
  const typingText = (t) => {
    const who = typers(t);
    if (!who.length) return '';
    if (!isGroup(t)) return 'typing…';
    const names = who.map((a) => firstName(t.members.find((m) => m.address === a) || { address: a }));
    return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`;
  };

  const isOnline = (t) => (online ? online.has(t.address) : Boolean(t.online));
  const onlineCount = (g) => g.members.filter((m) => m.address !== me && isOnline(m)).length;

  useEffect(() => {
    if (startWith && threads) {
      const found = threads.find((t) => keyOf(t) === startWith);
      if (found) open(found);
    }
  }, [startWith, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (picked) setPicked(null);
      else if (replyTo) setReplyTo(null);
      else if (view === 'group-info') setView('chat');
      else if (view !== 'list') backToList();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, onClose, picked, replyTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // A note pushed while the panel is open: into the open conversation, or the list's preview.
  useEffect(() => {
    if (!incoming) return;
    const conversation = incoming.group ? `group:${incoming.group}` : incoming.from === me ? incoming.to : incoming.from;
    if (keyOf(thread) === conversation && view !== 'list') {
      setNotes((list) => (list.some((n) => n.id === incoming.id) ? list : [...list, incoming]));
      if (incoming.from !== me) markRead(thread);
    }
    loadThreads();
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [notes]);

  async function markRead(t) {
    const target = isGroup(t) ? { group: t.id } : { with: t.address };
    const answer = await viaLive({ type: 'read', ...target }, '/notes/read', target).catch(() => ({}));
    const changed = answer.http ? answer.http.changed : answer.changed;
    if (changed) onRead(changed);
  }

  async function open(t) {
    setThread(t);
    setView('chat');
    setError('');
    setReplyTo(null);
    setPicked(null);
    setNotes(await api(isGroup(t) ? `/notes?group=${encodeURIComponent(t.id)}` : `/notes?with=${encodeURIComponent(t.address)}`).catch((err) => { setError(err.message); return []; }));
    if (t.unread) {
      await markRead(t);
      loadThreads();
    }
  }

  function backToList() {
    setThread(null);
    setView('list');
    setError('');
    loadThreads();
  }

  function addFiles(list) {
    setError('');
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than 10 MB`);
    setFiles((existing) => {
      const next = [...existing, ...picked].slice(0, MAX_FILES);
      if (existing.length + picked.length > MAX_FILES) setError(`Up to ${MAX_FILES} files in one note`);
      return next;
    });
  }

  async function send(e) {
    e?.preventDefault();
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    setError('');
    try {
      const target = isGroup(thread) ? { group: thread.id } : { to: thread.address };
      const body = { ...target, text, ...(replyTo && { replyTo: replyTo.id }), files: await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await readBase64(f) }))) };
      const answer = await viaLive({ type: 'note', ...body }, '/notes', body);
      const note = answer.http || answer.note;
      lastTyping.current = 0;
      setNotes((list) => (list.some((n) => n.id === note.id) ? list : [...list, note]));
      setText('');
      setFiles([]);
      setReplyTo(null);
      loadThreads();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A group rings everyone else in it, up to what a call can hold.
  function callThread(video) {
    if (!thread) return;
    const to = isGroup(thread) ? thread.members.map((m) => m.address).filter((a) => a !== me).slice(0, 5) : [thread.address];
    setError('');
    startCall({ to, video }).catch((err) => setError(err.message));
  }

  const memberOf = (address) => (isGroup(thread) ? thread.members.find((m) => m.address === address) : null) || { address };
  const seenBy = (n) => (n.readBy || []).map((a) => nameOf(memberOf(a)));

  return (
    <aside className="notes-panel" role="dialog" aria-label="Instant notes">
      <header className="notes-head">
        {view === 'chat' && thread ? (
          <>
            <button type="button" className="icon-btn" aria-label="All notes" onClick={backToList}>
              <Icon name="back" />
            </button>
            {isGroup(thread) ? (
              <button type="button" className="notes-who-btn" title="Group info" onClick={() => setView('group-info')}>
                <GroupAvatar group={thread} me={me} size="sm" />
                <span className="notes-who">
                  <strong>{thread.name}</strong>
                  <span className={`small ${typingText(thread) ? 'notes-typing' : 'muted'}`}>
                    {typingText(thread) || `${thread.members.length} people${onlineCount(thread) ? ` · ${onlineCount(thread)} online` : ''}`}
                  </span>
                </span>
              </button>
            ) : (
              <>
                <span className="presence-wrap">
                  <Avatar url={thread.avatarUrl} person={thread} color={thread.color} size="sm" />
                  {isOnline(thread) && <span className="presence-dot" title="Online" />}
                </span>
                <div className="notes-who">
                  <strong>{nameOf(thread)}</strong>
                  <span className={`small ${typingText(thread) ? 'notes-typing' : 'muted'}`}>
                    {typingText(thread) || (isOnline(thread) ? 'Online now' : thread.address)}
                  </span>
                </div>
              </>
            )}
            {isGroup(thread) && (
              <button type="button" className="icon-btn" aria-label="Group info" title="Group info" onClick={() => setView('group-info')}>
                <Icon name="info" />
              </button>
            )}
            <button type="button" className="icon-btn notes-call" aria-label={`Voice call ${nameOf(thread)}`} title="Voice call" onClick={() => callThread(false)}>
              <Icon name="call" />
            </button>
            <button type="button" className="icon-btn notes-call" aria-label={`Video call ${nameOf(thread)}`} title="Video call" onClick={() => callThread(true)}>
              <Icon name="videocam" />
            </button>
          </>
        ) : view === 'new-group' || view === 'group-info' ? (
          <>
            <button type="button" className="icon-btn" aria-label="Back" onClick={() => (view === 'group-info' ? setView('chat') : backToList())}>
              <Icon name="back" />
            </button>
            <div className="notes-who">
              <strong>{view === 'new-group' ? 'New group' : 'Group info'}</strong>
              <span className="muted small">{view === 'new-group' ? 'A private group for notes with several teammates.' : thread?.name}</span>
            </div>
          </>
        ) : (
          <>
            <div className="notes-who notes-title">
              <strong>Notes</strong>
              <span className="muted small">Private to your team · never emailed</span>
            </div>
            {people.length >= 2 && (
              <button type="button" className="icon-btn notes-call" aria-label="New group" title="New group" onClick={() => { setView('new-group'); setError(''); }}>
                <Icon name="personAdd" />
              </button>
            )}
            <button type="button" className="icon-btn notes-call" aria-label="New meeting with a link" title="New meeting with a link to share" onClick={() => startMeeting({ video: true }).catch((err) => setError(err.message))}>
              <Icon name="videocam" />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {view === 'list' && (
        <div className="notes-threads">
          {threads?.length > 0 && (
            <div className="notes-tools">
              <label className="notes-search">
                <Icon name="search" size={17} />
                <input type="search" placeholder="Search people and groups" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <div className="notes-filters" role="group" aria-label="Show">
                {[['all', 'All'], ['unread', `Unread${threads.some((t) => t.unread) ? ` · ${threads.filter((t) => t.unread).length}` : ''}`], ['groups', 'Groups']].map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {!threads && <PeopleSkeleton />}
          {threads?.length === 0 && <div className="muted notes-empty">Nobody else on your team yet. The admin adds people in the Admin console.</div>}
          {threads?.length > 0 && !shownThreads.length && (
            <div className="muted notes-empty">{query.trim() ? `Nobody matches “${query.trim()}”.` : filter === 'unread' ? 'You’re all caught up.' : 'No groups yet. Start one with the people button above.'}</div>
          )}
          {shownThreads.map((t) => (
            <button key={keyOf(t)} type="button" className={`notes-thread ${t.unread ? 'unread' : ''}`} onClick={() => open(t)}>
              {isGroup(t) ? (
                <GroupAvatar group={t} me={me} />
              ) : (
                <span className="presence-wrap">
                  <Avatar url={t.avatarUrl} person={t} color={t.color} />
                  {isOnline(t) && <span className="presence-dot" title="Online" />}
                </span>
              )}
              <span className="notes-thread-text">
                <span className="notes-thread-top">
                  <strong>{isGroup(t) ? t.name : nameOf(t)}</strong>
                  {t.last && <span className="muted small">{formatDate(t.last.at)}</span>}
                </span>
                <span className={`small notes-preview ${typingText(t) ? 'notes-typing' : 'muted'}`}>
                  {typingText(t) || (t.last
                    ? `${t.last.from === me ? 'You: ' : isGroup(t) ? `${firstName(t.members.find((m) => m.address === t.last.from) || { address: t.last.from })}: ` : ''}${preview(t.last)}`
                    : isGroup(t) ? `${t.members.length} people · say hello` : 'Send the first note')}
                </span>
              </span>
              {t.unread > 0 && <span className="notes-badge">{t.unread}</span>}
            </button>
          ))}
        </div>
      )}

      {view === 'new-group' && (
        <GroupForm
          people={people}
          onCancel={backToList}
          onSaved={async (group) => {
            const list = await api('/notes/threads');
            setThreads(list);
            const fresh = list.find((t) => isGroup(t) && t.id === group.id);
            if (fresh) open(fresh);
          }}
        />
      )}

      {view === 'group-info' && thread && (
        <GroupInfo
          group={thread}
          me={me}
          people={people}
          onChanged={loadThreads}
          onLeft={backToList}
        />
      )}

      {view === 'chat' && thread && (
        <>
          <div className="notes-list">
            {notes.length === 0 && (
              <div className="notes-hello">
                {isGroup(thread) ? <GroupAvatar group={thread} me={me} size="lg" /> : <Avatar url={thread.avatarUrl} person={thread} color={thread.color} size="lg" />}
                <strong>{isGroup(thread) ? thread.name : nameOf(thread)}</strong>
                <span className="muted small">{isGroup(thread) ? `No notes yet. Say hello to all ${thread.members.length}.` : `No notes yet. Say hello to ${firstName(thread)}.`}</span>
                <div className="notes-starters">
                  {['👋 Hi!', 'Got a minute?', 'Thanks!', 'Can we talk today?'].map((starter) => (
                    <button key={starter} type="button" onClick={() => { setText(starter); textBox.current?.focus(); }}>{starter}</button>
                  ))}
                </div>
              </div>
            )}
            {notes.map((n, i) => {
              const mine = n.from === me;
              const newDay = !notes[i - 1] || new Date(notes[i - 1].at).toDateString() !== new Date(n.at).toDateString();
              const showName = isGroup(thread) && !mine && (newDay || notes[i - 1]?.from !== n.from);
              // Back-to-back notes from the same person sit closer together, like one message.
              const follows = !newDay && notes[i - 1]?.from === n.from && new Date(n.at) - new Date(notes[i - 1].at) < 5 * 60_000;
              const sender = memberOf(n.from);
              const reactions = Object.entries(n.reactions || {}).filter(([, who]) => who.length);
              const quotedFrom = n.replyTo && (n.replyTo.from === me ? 'You' : nameOf(isGroup(thread) ? memberOf(n.replyTo.from) : thread));
              return (
                <div key={n.id} className={`note-wrap ${follows ? 'follows' : ''}`}>
                {newDay && <div className="note-day"><span>{dayLine(n.at)}</span></div>}
                <div
                  id={`note-${n.id}`}
                  className={`note ${mine ? 'mine' : 'theirs'} ${n.deleted ? 'deleted' : ''} ${picked === n.id ? 'picked' : ''}`}
                  onClick={(e) => { if (!n.deleted && !e.target.closest('a, button')) setPicked((id) => (id === n.id ? null : n.id)); }}
                >
                  {showName && <span className="note-sender" style={{ color: sender.color || 'var(--brand)' }}>{nameOf(sender)}</span>}
                  {n.replyTo && !n.deleted && (
                    <button type="button" className="note-quote" onClick={() => jumpTo(n.replyTo.id)}>
                      <strong>{quotedFrom}</strong>
                      <span>{n.replyTo.text || 'A note'}</span>
                    </button>
                  )}
                  {n.deleted && <p className="note-deleted"><Icon name="trash" size={14} /> {mine ? 'You deleted this note' : 'This note was deleted'}</p>}
                  {!n.deleted && (
                    <div className="note-actions" role="toolbar" aria-label="Note actions">
                      {REACTIONS.map((emoji) => (
                        <button key={emoji} type="button" className={(n.reactions?.[emoji] || []).includes(me) ? 'on' : ''} aria-label={`React ${emoji}`} title={`React ${emoji}`} onClick={() => react(n, emoji)}>{emoji}</button>
                      ))}
                      <span className="note-actions-sep" />
                      <button type="button" aria-label="Reply" title="Reply" onClick={() => answer(n)}><Icon name="reply" size={16} /></button>
                      {mine && <button type="button" className="danger" aria-label="Delete for everyone" title="Delete for everyone" onClick={() => removeNote(n)}><Icon name="trash" size={16} /></button>}
                    </div>
                  )}
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
                  <span className="note-time" title={mine && isGroup(thread) && seenBy(n).length ? `Seen by ${seenBy(n).join(', ')}` : undefined}>
                    {formatDate(n.at)}
                    {mine && !isGroup(thread) && n.read && ' · Seen'}
                    {mine && isGroup(thread) && seenBy(n).length > 0 && ` · Seen by ${seenBy(n).length === thread.members.length - 1 ? 'everyone' : seenBy(n).length}`}
                  </span>
                  {reactions.length > 0 && (
                    <span className="note-reactions">
                      {reactions.map(([emoji, who]) => (
                        <button
                          key={emoji}
                          type="button"
                          className={who.includes(me) ? 'on' : ''}
                          title={who.map((a) => (a === me ? 'You' : nameOf(isGroup(thread) ? memberOf(a) : thread))).join(', ')}
                          onClick={() => react(n, emoji)}
                        >{emoji}<b>{who.length}</b></button>
                      ))}
                    </span>
                  )}
                </div>
                </div>
              );
            })}
            <div ref={bottom} />
          </div>

          <form className="notes-compose" onSubmit={send}>
            {replyTo && (
              <div className="notes-replying">
                <Icon name="reply" size={16} />
                <span>
                  <strong>Replying to {replyTo.from === me ? 'yourself' : nameOf(isGroup(thread) ? memberOf(replyTo.from) : thread)}</strong>
                  <small>{preview(replyTo)}</small>
                </span>
                <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><Icon name="close" size={16} /></button>
              </div>
            )}
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
              <label className="sr-only" htmlFor="note-text">Note to {isGroup(thread) ? thread.name : nameOf(thread)}</label>
              <textarea
                ref={textBox}
                id="note-text"
                rows={1}
                maxLength={4000}
                placeholder={`Note to ${isGroup(thread) ? thread.name : nameOf(thread)}…`}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (e.target.value && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
                    lastTyping.current = Date.now();
                    notify(isGroup(thread) ? { type: 'typing', group: thread.id } : { type: 'typing', to: thread.address });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e);
                }}
              />
              <button className="notes-send" disabled={busy || (!text.trim() && !files.length)} aria-label={busy ? 'Sending' : 'Send'} title="Send (Enter)">
                <Icon name={busy ? 'refresh' : 'send'} size={19} className={busy ? 'spin' : ''} />
              </button>
            </div>
          </form>
        </>
      )}
      {error && <div className="alert notes-error">{error}</div>}
    </aside>
  );
}

/** Choose teammates with ticks. */
function PeoplePicker({ people, chosen, onToggle, disabled = () => false }) {
  return (
    <div className="people-picker">
      {people.map((p) => (
        <label key={p.address} className={`people-pick ${chosen.includes(p.address) ? 'on' : ''}`}>
          <input type="checkbox" checked={chosen.includes(p.address)} disabled={disabled(p)} onChange={() => onToggle(p.address)} />
          <Avatar url={p.avatarUrl} person={p} color={p.color} size="sm" />
          <span className="people-pick-text">
            <strong>{nameOf(p)}</strong>
            <span className="muted small">{p.address}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function GroupForm({ people, onCancel, onSaved }) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = (a) => setChosen((list) => (list.includes(a) ? list.filter((x) => x !== a) : [...list, a]));

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await api('/notes/groups', { method: 'POST', body: { name, members: chosen } }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="group-form" onSubmit={create}>
      <label className="field">
        <span>Group name</span>
        <input autoFocus maxLength={60} placeholder="e.g. Sales team" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="group-form-label">
        <strong>People</strong> <span className="muted small">{chosen.length} chosen · at least 2</span>
      </div>
      <PeoplePicker people={people} chosen={chosen} onToggle={toggle} />
      {error && <div className="alert">{error}</div>}
      <div className="group-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !name.trim() || chosen.length < 2}>{busy ? 'Creating…' : 'Create group'}</button>
      </div>
    </form>
  );
}

function GroupInfo({ group, me, people, onChanged, onLeft }) {
  const owner = group.createdBy === me;
  const [name, setName] = useState(group.name);
  const [chosen, setChosen] = useState(group.members.map((m) => m.address).filter((a) => a !== me));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const original = group.members.map((m) => m.address).filter((a) => a !== me);
  // Everyone can add people; only whoever made the group can take them out.
  const toggle = (a) => setChosen((list) => (list.includes(a) ? list.filter((x) => x !== a) : [...list, a]));
  const changed = name.trim() !== group.name || chosen.length !== original.length || chosen.some((a) => !original.includes(a));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (name.trim() !== group.name) await api(`/notes/groups/${group.id}`, { method: 'PATCH', body: { name } });
      if (chosen.length !== original.length || chosen.some((a) => !original.includes(a))) await api(`/notes/groups/${group.id}`, { method: 'PATCH', body: { members: chosen } });
      setMessage({ ok: true, text: 'Saved.' });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      await api(`/notes/groups/${group.id}/leave`, { method: 'POST' });
      onLeft();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
      setBusy(false);
    }
  }

  const creator = group.members.find((m) => m.address === group.createdBy);
  return (
    <form className="group-form" onSubmit={save}>
      <label className="field">
        <span>Group name</span>
        <input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="group-form-label">
        <strong>People</strong>{' '}
        <span className="muted small">
          {chosen.length + 1} in the group · made by {group.createdBy === me ? 'you' : nameOf(creator || { address: group.createdBy })}
          {!owner && ' · you can add people'}
        </span>
      </div>
      <PeoplePicker people={people} chosen={chosen} onToggle={toggle} disabled={(p) => !owner && original.includes(p.address)} />
      {message && <div className={message.ok ? 'notify-ok' : 'alert'}>{message.text}</div>}
      <div className="group-form-actions">
        <button type="button" className="btn btn-ghost group-leave" disabled={busy} onClick={leave}>
          <Icon name="logout" size={18} /> Leave group
        </button>
        <button className="btn btn-primary" disabled={busy || !changed || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
