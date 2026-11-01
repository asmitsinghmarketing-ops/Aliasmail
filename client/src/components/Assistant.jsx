// The Assistant: a chat with Claude about the person's mail and team. Answers stream in; emails,
// meetings and notes it prepares appear as cards, and only go out when the person presses the
// card's button (through the mailbox's normal sending). See server/src/assistant.js.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatDate } from '../format.js';
import Icon from './Icon.jsx';

const POLL_MS = 700; // how often the answer being written is read

const SUGGESTIONS = [
  { text: 'Summarise my unread mail', icon: 'inbox' },
  { text: 'What needs a reply from me today?', icon: 'reply' },
  { text: 'Draft a polite follow-up to the last email I sent', icon: 'edit' },
  { text: 'Schedule a 30-minute Google Meet tomorrow at 11 with ', icon: 'videocam', meet: true, fill: true },
  { text: 'Send my team a note: ', icon: 'chat', fill: true },
];

// The person's local date and time, given to Claude with each message.
function localNow() {
  const d = new Date();
  const pretty = d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const offset = -d.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
  return `${pretty} (${iso})`;
}

/* ----- a small, safe Markdown subset: paragraphs, bullet and numbered lists, **bold**, `code` ----- */

function inline(text, key) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, i) => {
    if (/^\*\*[^*]+\*\*$/.test(piece)) return <strong key={`${key}-${i}`}>{piece.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(piece)) return <code key={`${key}-${i}`}>{piece.slice(1, -1)}</code>;
    return piece;
  });
}

function Markdown({ text }) {
  const blocks = [];
  let list = null;
  let para = [];
  const endPara = () => {
    if (para.length) blocks.push({ type: 'p', lines: para });
    para = [];
  };
  for (const line of String(text).split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || number) {
      endPara();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) blocks.push((list = { type, items: [] }));
      list.items.push((bullet || number)[1]);
    } else if (!line.trim()) {
      endPara();
      list = null;
    } else {
      list = null;
      para.push(line.replace(/^#+\s*/, ''));
    }
  }
  endPara();
  return blocks.map((b, i) => {
    if (b.type === 'p') return <p key={i}>{b.lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l, `${i}-${j}`)] : inline(l, `${i}-${j}`)))}</p>;
    const List = b.type;
    return <List key={i}>{b.items.map((t, j) => <li key={j}>{inline(t, `${i}-${j}`)}</li>)}</List>;
  });
}

/* ----- cards: what the Assistant prepared, waiting for the person ----- */

function Card({ card, onAct }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = card.data;
  const act = async (what) => {
    setBusy(true);
    setError('');
    try {
      await onAct(card, what);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const settled = card.status !== 'pending';
  const head = {
    email: { icon: 'mail', label: d.replyToId ? 'Reply' : 'Email' },
    meeting: { icon: 'videocam', label: 'Google Meet' },
    note: { icon: 'chat', label: 'Instant note' },
  }[card.kind];
  const doneLabel = card.kind === 'meeting' ? 'Created' : 'Sent';

  return (
    <div className={`ai-card ${settled ? `ai-card-${card.status}` : ''}`}>
      <div className="ai-card-head">
        <span className="ai-card-icon"><Icon name={head.icon} size={18} /></span>
        <strong>{head.label}</strong>
        {settled && <span className={`ai-card-state ${card.status}`}>{card.status === 'done' ? doneLabel : 'Not sent'}</span>}
      </div>

      {card.kind === 'email' && (
        <dl className="ai-card-fields">
          <dt>To</dt><dd>{d.to.join(', ')}</dd>
          {d.cc.length > 0 && <><dt>Cc</dt><dd>{d.cc.join(', ')}</dd></>}
          <dt>Subject</dt><dd>{d.subject || '(no subject)'}</dd>
        </dl>
      )}
      {card.kind === 'email' && <div className="ai-card-body">{d.body}</div>}

      {card.kind === 'meeting' && (
        <dl className="ai-card-fields">
          <dt>Title</dt><dd>{d.title}</dd>
          <dt>When</dt>
          <dd>
            {new Date(d.start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {d.minutes} min
          </dd>
          <dt>Guests</dt><dd>{d.guests.length ? d.guests.join(', ') : 'Just you'}</dd>
          {d.description && <><dt>Notes</dt><dd>{d.description}</dd></>}
        </dl>
      )}

      {card.kind === 'note' && (
        <>
          <dl className="ai-card-fields"><dt>To</dt><dd>{d.toName ? `${d.toName} · ${d.to}` : d.to}</dd></dl>
          <div className="ai-card-body">{d.text}</div>
        </>
      )}

      {settled && card.detail && <p className="ai-card-detail">{/^https?:\/\//.test(card.detail) ? <a href={card.detail} target="_blank" rel="noreferrer">{card.detail}</a> : card.detail}</p>}
      {error && <div className="alert">{error}</div>}
      {!settled && (
        <div className="ai-card-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('go')}>
            <Icon name={card.kind === 'meeting' ? 'videocam' : 'send'} size={18} />
            {busy ? 'Working…' : card.kind === 'meeting' ? 'Create meeting' : 'Send'}
          </button>
          {card.kind === 'email' && (
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => act('edit')}>
              <Icon name="edit" size={18} /> Edit
            </button>
          )}
          <button type="button" className="link" disabled={busy} onClick={() => act('cancel')}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/* ----- the chat ----- */

function Reply({ item, live }) {
  const parts = item.parts || [];
  const lastStep = parts.map((p) => p.type).lastIndexOf('step');
  const thinking = live && !parts.some((p) => p.type === 'text' || p.type === 'card') && lastStep === -1;
  return (
    <div className="ai-reply">
      <span className="ai-avatar" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
      <div className="ai-reply-body">
        {thinking && <div className="ai-thinking"><span /><span /><span /></div>}
        {parts.map((p, i) => {
          if (p.type === 'text') return <div key={i} className="ai-text"><Markdown text={p.text} /></div>;
          if (p.type === 'step') {
            const working = live && i === lastStep && i === parts.length - 1;
            return (
              <div key={i} className={`ai-step ${working ? 'working' : ''}`}>
                <Icon name={working ? 'refresh' : 'checkCircle'} size={15} /> {p.text}
              </div>
            );
          }
          if (p.type === 'card') return <CardSlot key={p.card.id} card={p.card} />;
          if (p.type === 'error') return <div key={i} className="ai-error">{p.text}</div>;
          return null;
        })}
      </div>
    </div>
  );
}

// A card's buttons are handled by the chat (it knows which chat the card belongs to).
const CardContext = createContext(null);
function CardSlot({ card }) {
  const onAct = useContext(CardContext);
  return <Card card={card} onAct={onAct} />;
}

export default function Assistant({ status, onClose, actions }) {
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [spent, setSpent] = useState(status?.spentUsd || 0);
  const [showChats, setShowChats] = useState(false);
  const bottom = useRef(null);
  const box = useRef(null);
  const enabled = Boolean(status?.enabled);

  const loadChats = () => api('/assistant/chats').then(setChats).catch(() => {});
  useEffect(() => { if (enabled) loadChats(); }, [enabled]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function openChat(id) {
    setShowChats(false);
    setError('');
    setChatId(id);
    try {
      const chat = await api(`/assistant/chats/${id}`);
      setItems(chat.items);
      if (chat.running) follow(id);
      else {
        polling.current += 1;
        setBusy(false);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function newChat() {
    polling.current += 1;
    setBusy(false);
    setShowChats(false);
    setChatId(null);
    setItems([]);
    setError('');
    setTimeout(() => box.current?.focus(), 0);
  }

  async function removeChat(id) {
    await api(`/assistant/chats/${id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    if (id === chatId) newChat();
    loadChats();
  }

  // The answer being written: the server keeps it in the chat, and this reads it every moment
  // until it's done (plain short requests, which every hosting proxy passes straight through).
  const polling = useRef(0);
  async function follow(id) {
    const run = ++polling.current;
    setBusy(true);
    try {
      for (let errors = 0; run === polling.current; ) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (run !== polling.current) return;
        let chat;
        try {
          chat = await api(`/assistant/chats/${id}`);
          errors = 0;
        } catch (err) {
          if (++errors >= 5) throw err;
          continue;
        }
        if (run !== polling.current) return;
        setSpent(chat.spentUsd ?? 0);
        setItems(chat.running ? chat.items.map((item, i) => (i === chat.items.length - 1 && item.role === 'assistant' ? { ...item, live: true } : item)) : chat.items);
        if (!chat.running) break;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      if (run === polling.current) {
        setBusy(false);
        loadChats();
      }
    }
  }
  useEffect(() => () => { polling.current += 1; }, []);

  async function stop() {
    if (chatId) await api(`/assistant/chats/${chatId}/stop`, { method: 'POST' }).catch(() => {});
  }

  async function ask(text) {
    const message = text.trim();
    if (!message || busy || !enabled) return;
    setError('');
    setInput('');
    let id = chatId;
    try {
      if (!id) {
        id = (await api('/assistant/chats', { method: 'POST' })).id;
        setChatId(id);
      }
      setItems((list) => [...list, { role: 'user', text: message }, { role: 'assistant', parts: [], live: true }]);
      setBusy(true);
      await api(`/assistant/chats/${id}/messages`, {
        method: 'POST',
        body: { message, now: localNow(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      follow(id);
    } catch (err) {
      setError(err.message);
      setItems((list) => (list.at(-1)?.role === 'assistant' && !(list.at(-1).parts || []).length ? list.slice(0, -1) : list));
      setBusy(false);
    }
  }

  // A card's button: Send / Create ('go'), Edit, or Cancel. Remembered on the server, so Claude
  // knows what happened on the next message.
  async function onAct(card, what) {
    let status = 'cancelled';
    let detail = '';
    if (what === 'go') {
      if (card.kind === 'email') detail = (await actions.sendEmail(card)) || '';
      else if (card.kind === 'meeting') detail = (await actions.createMeeting(card)) || '';
      else detail = (await actions.sendNote(card)) || '';
      status = 'done';
    } else if (what === 'edit') {
      actions.editEmail(card);
      detail = 'Opened in Compose to edit and send from there.';
    }
    const saved = await api(`/assistant/chats/${chatId}/cards/${card.id}`, { method: 'POST', body: { status, detail } }).catch(() => ({ ...card, status, detail }));
    setItems((list) =>
      list.map((item) => (item.role !== 'assistant' ? item : {
        ...item,
        parts: (item.parts || []).map((p) => (p.type === 'card' && p.card.id === card.id ? { ...p, card: { ...p.card, status: saved.status, detail: saved.detail } } : p)),
      })),
    );
  }

  const firstName = (status?.name || '').split(' ')[0];
  const empty = !items.length;

  return (
    <section className={`assistant ${showChats ? 'show-chats' : ''}`} aria-label="Assistant">
      <aside className="ai-chats">
        <button type="button" className="btn btn-primary ai-new" onClick={newChat}>
          <Icon name="add" size={18} /> New chat
        </button>
        <div className="ai-chat-list">
          {chats.length === 0 && <p className="muted small ai-chats-empty">Your chats appear here.</p>}
          {chats.map((c) => (
            <div key={c.id} className={`ai-chat-item ${c.id === chatId ? 'on' : ''}`}>
              <button type="button" onClick={() => openChat(c.id)} title={c.title}>
                <span className="ai-chat-title">{c.title}</span>
                <span className="muted small">{formatDate(c.updatedAt)}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={`Delete ${c.title}`} onClick={() => removeChat(c.id)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="ai-main">
        <header className="ai-head">
          <button type="button" className="icon-btn ai-chats-toggle" aria-label="Chats" onClick={() => setShowChats(!showChats)}>
            <Icon name="menu" />
          </button>
          <span className="ai-head-title"><Icon name="sparkle" size={20} /> Assistant</span>
          <button type="button" className="icon-btn ai-chats-toggle" aria-label="New chat" onClick={newChat}>
            <Icon name="edit" />
          </button>
          <button type="button" className="icon-btn" aria-label="Close Assistant" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="ai-scroll">
          <CardContext.Provider value={onAct}>
            <div className="ai-column">
              {!enabled && (
                <div className="ai-welcome">
                  <span className="ai-mark"><Icon name="sparkle" size={30} /></span>
                  <h1>The Assistant isn’t set up yet</h1>
                  <p className="muted">
                    It needs an AI key. The admin adds one in Admin console → Assistant → AI settings.
                  </p>
                </div>
              )}
              {enabled && empty && (
                <div className="ai-welcome">
                  <span className="ai-mark"><Icon name="sparkle" size={30} /></span>
                  <h1>{firstName ? `How can I help, ${firstName}?` : 'How can I help?'}</h1>
                  <p className="muted">I can read and search your mail, write replies, set up Google Meet meetings and send notes to your team. Nothing goes out until you press Send.</p>
                  <div className="ai-suggestions">
                    {SUGGESTIONS.filter((s) => !s.meet || status.meet).map((s) => (
                      <button
                        key={s.text}
                        type="button"
                        onClick={() => {
                          if (s.fill) {
                            setInput(s.text);
                            setTimeout(() => box.current?.focus(), 0);
                          } else ask(s.text);
                        }}
                      >
                        <Icon name={s.icon} size={18} /> {s.text.trim()}{s.fill ? '…' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {items.map((item, i) =>
                item.role === 'user' ? (
                  <div key={i} className="ai-user"><div>{item.text}</div></div>
                ) : (
                  <Reply key={i} item={item} live={item.live} />
                ),
              )}
              {error && <div className="alert ai-alert">{error}</div>}
              <div ref={bottom} />
            </div>
          </CardContext.Provider>
        </div>

        <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <div className="ai-box">
            <label className="sr-only" htmlFor="ai-input">Message the Assistant</label>
            <textarea
              id="ai-input"
              ref={box}
              rows={1}
              maxLength={8000}
              disabled={!enabled}
              placeholder={enabled ? 'Write, find or schedule…' : 'Not set up yet'}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
            />
            {busy ? (
              <button type="button" className="ai-send stop" aria-label="Stop" onClick={stop}>
                <span className="ai-stop-square" />
              </button>
            ) : (
              <button className="ai-send" aria-label="Send" disabled={!enabled || !input.trim()}>
                <Icon name="send" size={20} />
              </button>
            )}
          </div>
          <p className="ai-foot muted small">
            The Assistant can make mistakes, so check what it writes. Nothing is sent until you press Send.
            {status?.provider === 'gemini' && ' · Test mode (Google Gemini)'}
            {status?.provider === 'openrouter' && ` · Test mode (OpenRouter: ${status.model})`}
            {enabled && spent > 0 && ` · This month: US$${spent.toFixed(2)}`}
          </p>
        </form>
      </div>
    </section>
  );
}
