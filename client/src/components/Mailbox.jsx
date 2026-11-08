import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cachedMailboxList, fetchRemembered, prefetchMailboxList, preloadMessage } from '../api.js';
import { displayName, formatDate, initial, personLabel } from '../format.js';
import { escapeHtml, htmlFromText, sanitizeHtml, textFromHtml } from './RichEditor.jsx';
import { withDriveLinks } from '../drivePicker.js';
import { uploadAttachments, uploadProgress } from '../attachmentUpload.js';
import LoginCodes from './LoginCodes.jsx';
import SendingTray from './SendingTray.jsx';
import { ask } from './Dialog.jsx';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { LabelMenu, Popover, TimeMenu, shortTime, snoozeOptions } from './Menus.jsx';
import MessageView from './MessageView.jsx';
import InstantNotes from './InstantNotes.jsx';
import NotifyPrompt from './NotifyPrompt.jsx';
import { subscribe } from '../live.js';
import { useRowSwipe } from '../rowSwipe.js';
import { meetingText } from '../meet.js';
import Pager from './Pager.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import { arrange } from '../tabLayout.js';
import { lazyPage, MailListSkeleton, OpeningPill, TextSkeleton, whenIdle } from './Loading.jsx';

// Opened on demand, and fetched as soon as the mailbox is idle so that opening them is instant.
const Compose = lazyPage(() => import('./Compose.jsx'));
const Tour = lazyPage(() => import('./Tour.jsx'));
// Who has finished the tour since this page loaded, as their account only says so at sign-in.
const toursSeen = new Set();
// Tab layouts changed since this page loaded, for the same reason; and their saves, one at a time.
const layoutsChanged = new Map();
let layoutSaving = Promise.resolve();
const Settings = lazyPage(() => import('./Settings.jsx'));
const Assistant = lazyPage(() => import('./Assistant.jsx'));
const MeetDialog = lazyPage(() => import('./MeetDialog.jsx'));

// Gmail's folders, in Gmail's order. `count` is the key in /mail/folders shown beside it;
// `color` tints the folder's icon tile in the sidebar.
const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox', count: 'inbox', color: 'var(--brand)', section: 'Folders' },
  { id: 'starred', label: 'Starred', icon: 'star', color: '#f59f00' },
  { id: 'snoozed', label: 'Snoozed', icon: 'clock', color: '#0c8599' },
  { id: 'important', label: 'Important', icon: 'important', count: 'important', color: '#d6336c' },
  { id: 'sent', label: 'Sent', icon: 'send', color: '#1c7ed6' },
  { id: 'scheduled', label: 'Scheduled', icon: 'scheduleSend', count: 'scheduled', plain: true, color: '#7048e8' },
  // Like Gmail, the Outbox appears only while something in it is waiting to be sent.
  { id: 'outbox', label: 'Outbox', icon: 'outbox', count: 'outbox', plain: true, color: '#e03131', onlyWhenUsed: true },
  { id: 'drafts', label: 'Drafts', icon: 'draft', count: 'drafts', plain: true, color: '#ae3ec9' },
  { id: 'all', label: 'All Mail', icon: 'mail', color: '#2b8a3e' },
  // Spam is switched off for now (also SYNCED_FOLDERS in server/src/mailbox.js). Uncomment to show it:
  // { id: 'spam', label: 'Spam', icon: 'spam', count: 'spam', plain: true, color: '#e03131' },
  { id: 'trash', label: 'Trash', icon: 'trash', color: '#868e96' },
];

const CATEGORY_TABS = [
  // Everything in the Inbox together. The server only narrows the list for the four categories below.
  { id: 'all', label: 'All', icon: 'mail', color: '#2b8a3e' },
  { id: 'primary', label: 'Primary', icon: 'inbox', color: 'var(--alias)' },
  { id: 'promotions', label: 'Promotions', icon: 'tag', color: 'var(--green)' },
  { id: 'social', label: 'Social', icon: 'people', color: '#1971c2' },
  { id: 'updates', label: 'Updates', icon: 'info', color: 'var(--orange)' },
];

// Which Inbox tab was open last, for each mailbox on this device. Browser storage can be blocked
// or empty (private windows), and then it simply opens on Primary.
const TAB_KEY = 'nextspace-inbox-tab';
function rememberedTab(address) {
  try {
    const saved = localStorage.getItem(`${TAB_KEY}:${address}`);
    return CATEGORY_TABS.some((tab) => tab.id === saved) ? saved : 'primary';
  } catch {
    return 'primary';
  }
}
function rememberTab(address, tab) {
  try {
    localStorage.setItem(`${TAB_KEY}:${address}`, tab);
  } catch { /* Not remembered this time; nothing else depends on it. */ }
}

// The list is split by when mail arrived, like Outlook: Today, Yesterday, this week, this month,
// then month by month.
function dateGroup(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400e3);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7 && day.getDay() < today.getDay()) return 'Earlier this week';
  if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) return 'Earlier this month';
  return d.toLocaleDateString(undefined, { month: 'long', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}
// Lists in date order get the groups; Scheduled and the Outbox are ordered by send time instead.
const UNGROUPED = new Set(['scheduled', 'outbox']);
// Emails at the top of a list loaded in the background, so opening them is instant.
const PRELOAD_TOP = 8;

// Folders holding inbox messages (per-account state applies); the rest are special lists.
const MAIL_FOLDERS = ['inbox', 'starred', 'snoozed', 'important', 'all'];
// Views of received mail narrowed by inbox category (Primary, Promotions, …).
const CATEGORIZED = ['inbox'];
const listPath = (folder, page = 1, search = '', category = 'primary') => {
  const params = new URLSearchParams({ folder, page, q: search, ...(CATEGORIZED.includes(folder) && !search && { category }) });
  return `/mail/messages?${params}`;
};
// A sender's organisation, from their address (none for personal mail providers).
const PERSONAL_DOMAINS = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail|rediffmail|zoho)\./i;
function orgOf(person) {
  const domain = String(person?.address || '').split('@')[1] || '';
  if (!domain || PERSONAL_DOMAINS.test(domain)) return '';
  const name = domain.split('.').slice(-2, -1)[0] || domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
const initialsOf = (name, address) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || String(address || '?')).slice(0, 2).toUpperCase();
};
const isMailFolder = (folder) => MAIL_FOLDERS.includes(folder) || folder.startsWith('label:');

// Toast text for each action, and the action that undoes it.
const DONE = {
  archive: ['archived', 'inbox'],
  trash: ['moved to Trash', 'restore'],
  inbox: ['moved to Inbox', null],
  restore: ['restored', 'trash'],
  delete: ['deleted forever', null],
  read: ['marked as read', 'unread'],
  unread: ['marked as unread', 'read'],
  spam: ['marked as spam', null],
  notSpam: ['moved to Inbox', null],
  unsnooze: ['unsnoozed', null],
  cancel: ['cancelled and moved to Drafts', null],
  retry: ['being sent again', null],
};
// Actions after which an open message no longer belongs in the current view.
const LEAVES_VIEW = ['archive', 'trash', 'inbox', 'restore', 'delete', 'unread', 'spam', 'notSpam', 'snooze', 'cancel', 'retry'];

const URLS = { inbox: '/mail/messages', sent: '/mail/sent', spam: '/mail/spam', scheduled: '/mail/scheduled' };

const SHORTCUTS = [
  ['c', 'Compose'],
  ['/', 'Search'],
  ['j / k', 'Older / newer message'],
  ['o or Enter', 'Open message'],
  ['u or Esc', 'Back to list'],
  ['x', 'Select message'],
  ['e', 'Archive'],
  ['#', 'Delete'],
  ['s', 'Star / unstar'],
  ['+ / -', 'Mark important / not important'],
  ['Shift + i', 'Mark as read'],
  ['Shift + u', 'Mark as unread'],
  ['r', 'Reply'],
  ['a', 'Reply all'],
  ['f', 'Forward'],
  ['Ctrl + Enter', 'Send (in compose)'],
  ['?', 'Show shortcuts'],
];

const UNDO_SEND_MS = 5000;

// Mail-server refusals in plain words, with what to do about them.
function friendlyReason(reason) {
  const r = String(reason || '');
  if (/classified as SPAM/i.test(r)) return 'The mail server flagged it as spam, which usually happens when there is no subject or almost no text. Add a subject and a few sentences, then send it again.';
  if (/(user unknown|no such user|does not exist|5\.1\.1|recipient.*(rejected|invalid))/i.test(r)) return 'One of the addresses doesn’t exist. Check the recipients and send it again.';
  if (/(too large|size limit|5\.3\.4|\b552\b)/i.test(r)) return 'The message is too large for the mail server. Remove an attachment or share it from Drive instead.';
  if (/(timed out|couldn’t reach|ECONNREFUSED|connection failed|didn’t answer)/i.test(r)) return 'The mail server couldn’t be reached just now.';
  return r.trim().replace(/[.\s]*$/, '.');
}

// The original as it looked (links, formatting, tables, pictures), quoted like Gmail does.
const originalHtml = (msg) => (msg.html ? sanitizeHtml(msg.html) : htmlFromText(msg.text || ''));
const QUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex';
const person = (p) => (p.name ? `${escapeHtml(p.name)} &lt;${escapeHtml(p.address || '')}&gt;` : escapeHtml(p.address || ''));

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Who owns a conversation: their avatar and first name ("You" for yourself). */
function OwnerChip({ address, me, team, avatars }) {
  const person = team.find((p) => p.address === address) || { address, name: '' };
  const first = address === me ? 'You' : (person.name || address.split('@')[0]).split(' ')[0];
  return (
    <span className="owner-chip" title={`Owner: ${person.name || address}`}>
      <Avatar url={avatars[address] || person.avatarUrl} person={person} color={person.color} size="sm" />
      <span>{first}</span>
    </span>
  );
}

/**
 * Beside an open conversation: who the sender is, its owner, team notes (never sent
 * to the sender) and a meeting shortcut.
 */
function ConversationPanel({ msg, me, team, avatars, onTeam, onMeet }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const view = msg.team || { assignee: null, notes: [] };
  const from = msg.from || {};
  const save = async (path, options) => {
    setBusy(true);
    setError('');
    try {
      onTeam(await api(path, options));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="convo-panel" aria-label="About this conversation">
      <section className="panel-card">
        <div className="panel-person">
          <Avatar url={avatars[from.address]} person={from} size="lg" />
          <div>
            <strong>{displayName(from)}</strong>
            <span className="muted small">{[orgOf(from), from.address].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        {msg.sender && (
          <dl className="panel-facts">
            <dt>Conversations</dt>
            <dd>{msg.sender.threads}</dd>
            <dt>First mail</dt>
            <dd>{formatDate(msg.sender.since)}</dd>
          </dl>
        )}
      </section>

      <section className="panel-card">
        <h2>Owner</h2>
        <label className="panel-owner">
          <span className="sr-only">Owner</span>
          <select
            value={view.assignee || ''}
            disabled={busy}
            onChange={(e) => save(`/mail/messages/${msg.id}/team`, { method: 'PATCH', body: { assignee: e.target.value || null } })}
          >
            <option value="">Nobody yet</option>
            {team.map((p) => (
              <option key={p.address} value={p.address}>
                {p.address === me ? `You (${p.name || p.address})` : p.name ? `${p.name} · ${p.address}` : p.address}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel-card">
        <h2>Team notes</h2>
        <p className="muted small panel-hint">Only your team sees these. They are never sent.</p>
        {view.notes.map((n) => (
          <div key={n.id} className="panel-note">
            <div className="panel-note-head">
              <strong>{n.by === me ? 'You' : n.name || n.by.split('@')[0]}</strong>
              <span className="muted small">{formatDate(n.at)}</span>
              {n.by === me && (
                <button type="button" className="link small" disabled={busy} onClick={() => save(`/mail/messages/${msg.id}/notes/${n.id}`, { method: 'DELETE' })}>
                  Delete
                </button>
              )}
            </div>
            <p>{n.text}</p>
          </div>
        ))}
        <form
          className="panel-note-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (note.trim() && (await save(`/mail/messages/${msg.id}/notes`, { method: 'POST', body: { text: note } }))) setNote('');
          }}
        >
          <label className="sr-only" htmlFor="team-note">Add a note for the team</label>
          <textarea id="team-note" rows={2} maxLength={2000} placeholder="Add a note for the team…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-outline" disabled={busy || !note.trim()}>Add note</button>
        </form>
      </section>

      {onMeet && (
        <section className="panel-card">
          <h2>Talk it over</h2>
          <button type="button" className="btn btn-outline panel-meet" onClick={onMeet}>
            <Icon name="videocam" size={18} /> Schedule a meeting
          </button>
        </section>
      )}
      {error && <div className="alert">{error}</div>}
    </aside>
  );
}

let pendingLayerBack;

/** True on phone-sized screens (the Gmail-app layout), updated as the window changes. */
function usePhone() {
  const query = '(max-width: 800px)';
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setPhone(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
}

/** Phone: the open email's less-used actions under ⋮ (Snooze, Important, Labels, Newer/Older). */
function PhoneMoreMenu({ close, onPrev, onNext, snoozed, onSnooze, onUnsnooze, important, onImportant, labelMenu }) {
  const [view, setView] = useState('main');
  const item = (icon, label, onClick, disabled) => (
    <button type="button" className="menu-item check-item" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={20} /> {label}
    </button>
  );
  if (view === 'snooze') return <TimeMenu title="Snooze until…" options={snoozeOptions()} close={close} onPick={onSnooze} />;
  if (view === 'labels') return labelMenu(close);
  const run = (fn) => () => { close(); fn(); };
  return (
    <div className="menu phone-more">
      {onNext !== undefined && item('chevronLeft', 'Newer', run(onPrev || (() => {})), !onPrev)}
      {onNext !== undefined && item('chevronRight', 'Older', run(onNext || (() => {})), !onNext)}
      {onSnooze && (snoozed ? item('clock', 'Unsnooze', run(onUnsnooze)) : item('clock', 'Snooze…', () => setView('snooze')))}
      {onImportant && item('important', important ? 'Mark as not important' : 'Mark as important', run(onImportant))}
      {labelMenu && item('label', 'Labels…', () => setView('labels'))}
    </div>
  );
}

function IconButton({ icon, title, onClick, danger, size }) {
  return (
    <button
      className={`icon-btn ${danger ? 'danger' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/**
 * Avatar menu: the open mailbox, then the account's own mailbox and the group mailboxes its
 * roles give it, Gmail-style. Without any group mailboxes the avatar just opens Settings.
 */
function MailboxSwitcher({ user, account, mailboxes, shared, onSwitch, onRefresh, onSettings, onLogout }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    onRefresh?.();
    const onDown = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (address) => {
    setOpen(false);
    onSwitch(address);
  };
  const others = [
    ...(shared ? [{ ...account, address: account.email, own: true }] : []),
    ...mailboxes.filter((m) => m.address !== user.email),
  ];
  const trigger = (
    <button
      className="avatar-btn"
      title={mailboxes.length ? 'Switch mailbox' : 'Settings and profile picture'}
      aria-haspopup={mailboxes.length ? 'menu' : undefined}
      aria-expanded={mailboxes.length ? open : undefined}
      onClick={() => (mailboxes.length || shared ? setOpen(!open) : onSettings())}
    >
      <Avatar url={user.avatarUrl} person={{ name: user.displayName, address: user.email }} color={user.color} />
    </button>
  );

  return (
    <span className="popover-wrap switcher" ref={wrap}>
      {trigger}
      {open && (
        <div className="popover right">
          <div className="menu switcher-menu" role="menu">
            <div className="switcher-current">
              <Avatar url={user.avatarUrl} person={{ name: user.displayName, address: user.email }} color={user.color} size="lg" />
              <strong>{user.displayName || user.email}</strong>
              {user.displayName && <span className="muted small">{user.email}</span>}
              <span className={`pill ${shared ? 'warn' : 'on'}`}>{shared ? `Shared · ${shared.roles.join(', ')}` : 'Your mailbox'}</span>
              {!shared && (
                <button type="button" className="btn btn-outline" onClick={() => { setOpen(false); onSettings(); }}>
                  Manage your settings
                </button>
              )}
            </div>
            {others.length > 0 && <div className="menu-title small muted">Switch to</div>}
            {others.map((m) => (
              <button type="button" role="menuitem" key={m.address} className="menu-item switcher-item" onClick={() => choose(m.own ? null : m.address)}>
                <Avatar url={m.avatarUrl} person={{ name: m.displayName, address: m.address }} color={m.color} size="sm" />
                <span className="switcher-text">
                  <span className="switcher-name">{m.displayName || m.address}</span>
                  <span className="muted small">{m.own ? 'Your mailbox' : `${m.address} · ${m.roles.join(', ')}`}</span>
                </span>
              </button>
            ))}
            <button type="button" role="menuitem" className="menu-item switcher-signout" onClick={onLogout}>
              <Icon name="logout" size={18} /> Sign out
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/** One tab in the left bar: an icon with its name under it. */
function RailTab({ tab }) {
  const name = tab.title || tab.label;
  return (
    <button type="button" data-tour={tab.id} className={`rail-btn ${tab.on ? 'on' : ''}`} title={name} aria-label={tab.badge ? `${name}, ${tab.badge} unread` : name} onClick={tab.onClick}>
      <Icon name={tab.icon} size={22} />
      <span className="rail-label">{tab.label}</span>
      {tab.badge > 0 && <span className="rail-badge">{tab.badge > 99 ? '99+' : tab.badge}</span>}
    </button>
  );
}

export default function Mailbox({ user, account = user, mailboxes = [], shared = null, onSwitchMailbox, onRefreshMailboxes, onLogout, onUserChange, onOpenAdmin, onOpenTasks, onOpenAutomations }) {
  const [folder, setFolder] = useState('inbox');
  const [team, setTeam] = useState([]); // who can own a conversation
  // Instant notes: the panel, its unread badge, and the latest note pushed over the live connection.
  const [notesOpen, setNotesOpen] = useState(false);
  // The Assistant (Claude): open or not, and whether it is set up.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantStatus, setAssistantStatus] = useState(null);
  const [notesWith, setNotesWith] = useState(null);
  const [notesUnread, setNotesUnread] = useState(0);
  const [notesMe, setNotesMe] = useState('');
  const [latestNote, setLatestNote] = useState(null);
  const notesView = useRef({ open: false, me: '' });
  notesView.current = { open: notesOpen, me: notesMe };
  const [category, setCategory] = useState(() => rememberedTab(user.email));
  useEffect(() => { rememberTab(user.email, category); }, [user.email, category]);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  // Phones scroll through the whole list (the next 50 load at the bottom) instead of paging.
  const phone = usePhone();
  const [loadingMore, setLoadingMore] = useState(false);
  const moreSentinel = useRef(null);
  const [counts, setCounts] = useState({});
  const [labels, setLabels] = useState([]);
  const [people, setPeople] = useState({}); // address -> profile picture URL
  const [open, setOpen] = useState(null); // list item being viewed
  const [openMsg, setOpenMsg] = useState(null); // its fully loaded message
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [draft, setDraft] = useState(null);
  const [signature, setSignature] = useState({ text: '', html: '' });
  const [modal, setModal] = useState(null); // 'settings' | 'shortcuts'
  // Phones hide the drawer; tablets and small laptops start with the icon rail so the list has room.
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  // Messages on their way out from this page (attachments uploading, then sending), shown at
  // the top of the Outbox with their progress until they have gone.
  const [sending, setSending] = useState([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sending.length) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 400);
    return () => clearInterval(timer);
  }, [sending.length]);
  const [leaving, setLeaving] = useState(new Set()); // rows animating out of the list
  const toastTimer = useRef(null);
  const searchInput = useRef(null);
  const drawerSwipe = useRef(null);
  const firstMailboxLoad = useRef(true);
  const me = user.email;

  const labelsById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);
  const showTabs = CATEGORIZED.includes(folder) && !search;

  // `extra`: { tone: 'error' | 'warning' | 'success', title, actions: [{ label, onClick }] }.
  const flash = (text, undo, ms = 6000, extra = {}) => {
    setToast({ text, undo, ...extra });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  const loadLabels = () => api('/mail/labels').then(setLabels).catch(() => {});

  const loadRequest = useRef(0);
  const latestLoad = useRef(null);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const path = listPath(folder, page, search, category);
      const cached = cachedMailboxList(path);
      const keepScrolled = (data) => (prev) => {
        if (!phone || page !== 1 || prev.items.length <= data.items.length || prev.view !== path) return { ...data, view: path };
        const fresh = new Set(data.items.map((i) => i.id));
        return { ...data, view: path, items: [...data.items, ...prev.items.slice(data.items.length).filter((i) => !fresh.has(i.id))], scrolledPages: prev.scrolledPages };
      };
      if (cached) { setList(keepScrolled(cached)); setLoading(false); }
      const data = await api(path).then((data) => {
        if (request === loadRequest.current) {
          setList(keepScrolled(data));
          setLoading(false);
        }
        return data;
      });
      if (request !== loadRequest.current) return;
      setList(keepScrolled(data));
      setError('');
    } catch (err) {
      if (request === loadRequest.current) setError(err.message);
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [folder, category, page, search, phone]);
  latestLoad.current = load;

  useEffect(() => { document.querySelector('.rail-box.on')?.scrollIntoView({ block: 'nearest' }); }, [me]);

  useEffect(() => whenIdle(() => {
    Compose.preload();
    Settings.preload();
    Assistant.preload();
    MeetDialog.preload();
  }), []);

  useEffect(() => {
    setLoading(!cachedMailboxList(listPath(folder, page, search, category)));
    setSelected(new Set());
    setCursor(0);
    load();
    if (firstMailboxLoad.current) {
      firstMailboxLoad.current = false;
      // Sync runs in the API process. Do not start a mailbox connection on every tab/window;
      // the live sync loop will populate a newly deployed mailbox shortly.
    }
    // Poll only while the page is on screen; catch up at once when it comes back (a phone
    // waking up, a tab brought to the front, the network returning).
    const visible = () => document.visibilityState === 'visible';
    // 10s: answered from the server's copy (no mailbox access), and the fallback for hosting
    // proxies that hold back live updates.
    const timer = setInterval(() => visible() && load(), 10000);
    const wake = () => visible() && load();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [load]);

  // Counts are independent from the visible list. Fetch them once for the sidebar and refresh
  // at a slower cadence instead of making every list poll wait on a second server query.
  useEffect(() => {
    let active = true;
    const refreshCounts = () => api('/mail/folders').then((data) => active && setCounts(data)).catch(() => {});
    refreshCounts();
    const timer = window.setInterval(refreshCounts, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [me]);

  // Load only the current list at startup. Warming every folder creates a request burst and
  // competes with the first useful paint, especially for shared mailboxes.
  useEffect(() => {
    if (navigator.connection?.saveData) return undefined;
    const nextFolder = folder === 'inbox' ? 'sent' : 'inbox';
    const id = window.setTimeout(() => {
      prefetchMailboxList(listPath(nextFolder, 1, '', nextFolder === 'inbox' ? category : 'primary'));
    }, 1200);
    return () => window.clearTimeout(id);
  }, [folder, category, me]);

  // The live connection (live.js): mail changes and instant notes, the moment they happen.
  useEffect(() => {
    let timer;
    // The badge always comes from the server, so every device shows the same number.
    const refreshUnread = () => api('/notes/unread').then(({ unread }) => setNotesUnread(unread)).catch(() => {});
    const stop = subscribe((message) => {
      if (message.type === 'mail') {
        clearTimeout(timer);
        timer = setTimeout(() => latestLoad.current?.(), 150);
      } else if (message.type === 'note-read') {
        // Read here or on another device.
        if (message.by === notesView.current.me) refreshUnread();
      } else if (message.type === 'note') {
        const { note } = message;
        setLatestNote(note);
        if (note.from === notesView.current.me || notesView.current.open) return;
        refreshUnread();
        const preview = note.text || `Sent ${note.files.length === 1 ? 'a file' : `${note.files.length} files`}`;
        flash(preview.length > 140 ? `${preview.slice(0, 140)}…` : preview, null, 9000, {
          tone: 'note',
          title: note.group ? `${note.fromName || note.from} in ${note.groupName || 'a group'}` : `Note from ${note.fromName || note.from}`,
          actions: [{ label: 'Reply', onClick: () => openNotes(note.group ? `group:${note.group}` : note.from) }],
        });
      } else if (message.type === 'open') {
        // Connected again after a drop: catch up on anything missed.
        refreshUnread();
        latestLoad.current?.();
      }
    });
    return () => { clearTimeout(timer); stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the notes panel: the badge shows what is really still unread.
  useEffect(() => {
    if (!notesOpen) api('/notes/unread').then(({ unread }) => setNotesUnread(unread)).catch(() => {});
  }, [notesOpen]);

  // Opened from a notification: ?message=<id> opens that email, ?notes=<address> those notes
  // (also when Nextspace was already open: the service worker passes the link on).
  useEffect(() => {
    const openFrom = (href) => {
      const params = new URL(href, window.location.origin).searchParams;
      const id = params.get('message');
      const notesFrom = params.get('notes');
      if (id && /^d+$/.test(id)) {
        setAssistantOpen(false);
        setNotesOpen(false);
        setModal(null);
        setOpen({ id: Number(id), kind: 'inbox', subject: '', from: { name: '', address: '' }, date: '', to: [], cc: [], labels: [], read: true });
        setOpenMsg(null);
      } else if (notesFrom) {
        openNotes(notesFrom);
      }
    };
    const shortcut = new URLSearchParams(window.location.search);
    if (shortcut.has('compose') || shortcut.has('folder')) {
      // Opened this early the signature hasn't arrived yet, and the draft needs it.
      if (shortcut.has('compose')) {
        fetchRemembered('/mail/settings').catch(() => null).then((s) => {
          const block = signatureBlock({ html: s?.signatureHtml, text: s?.signature });
          setDraft(block ? { html: block } : { text: '' });
        });
      }
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (/[?&](message|notes)=/.test(window.location.search)) {
      openFrom(window.location.href);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const onMessage = (e) => e.data?.type === 'open' && openFrom(e.data.url);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from connecting Google in Settings → Security: reopen it and say how it went.
  const [settingsTab, setSettingsTab] = useState('profile');
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get('google');
    if (!outcome) return;
    window.history.replaceState(null, '', window.location.pathname);
    const said = {
      linked: 'Google account connected. You can now sign in with Google.',
      'in-use': 'That Google account is already connected to another Nextspace account.',
      cancelled: 'Connecting Google was cancelled.',
      'drive-linked': 'Google Drive connected. Open your draft and choose Insert from Drive.',
      'drive-denied': 'Drive wasn’t connected: allow access to the files you pick, then try again.',
      'drive-other-account': 'Use the same Google account that is connected to Nextspace for Drive.',
      'meet-linked': 'Google Meet connected. Start or schedule a meeting from “New meeting”.',
      'meet-denied': 'Google Meet wasn’t connected: allow Nextspace to add events to your calendar, then try again.',
      'meet-other-account': 'Use the same Google account that is connected to Nextspace for Meet.',
      'all-linked': 'Google apps connected. Insert Drive files and Meet links in Compose, or start a meeting from the apps menu.',
      'some-linked': 'Some Google apps were connected. Tick every box on Google’s screen to connect the rest.',
      'all-denied': 'Nothing was connected: tick the boxes on Google’s screen, then try again.',
      'all-other-account': 'Use the same Google account that is connected to Nextspace.',
      'chat-linked': 'Google Chat connected. Run the test in Google apps to see whether Google allows it for your account.',
      'chat-denied': 'Google Chat wasn’t connected: tick the box on Google’s screen, then try again.',
      'chat-other-account': 'Use the same Google account that is connected to Nextspace for Chat.',
    };
    if (outcome === 'continue' || outcome === 'not-linked') return;
    setSettingsTab(/^(drive|meet|chat|all|some)-/.test(outcome) ? 'google' : 'security');
    setModal('settings');
    flash(said[outcome] || 'Couldn’t connect Google. Try again.', null, 8000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [driveOn, setDriveOn] = useState(false);
  const [meetOn, setMeetOn] = useState(false);
  const [chatOn, setChatOn] = useState(false);
  useEffect(() => {
    loadLabels();
    api('/auth/info')
      .then((info) => {
        setDriveOn(Boolean(info.drive));
        setMeetOn(Boolean(info.meet));
        setChatOn(Boolean(info.chat));
      })
      .catch(() => {});
    api('/mail/people').then(setPeople).catch(() => {});
    api('/mail/team').then(setTeam).catch(() => {});
    api('/assistant/status').then(setAssistantStatus).catch(() => {});
    api('/notes/unread')
      .then(({ me: self, unread }) => {
        setNotesMe(self);
        setNotesUnread(unread);
      })
      .catch(() => {});
    fetchRemembered('/mail/settings')
      .then((s) => setSignature({ text: s.signature, html: s.signatureHtml }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (collapsed || !window.matchMedia('(max-width: 800px)').matches) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setCollapsed(true);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [collapsed]);

  useEffect(() => {
    if (!window.matchMedia('(max-width: 800px)').matches) return undefined;

    // The menu follows the finger by moving it directly. Going through React here would redraw the
    // whole mailbox on every frame of the drag, which is what makes a drag stutter.
    const parts = () => [document.getElementById('mail-sidebar'), document.querySelector('.sidebar-backdrop')];

    const letGo = () => {
      const [sidebar, backdrop] = parts();
      for (const element of [sidebar, backdrop]) element?.classList.remove('dragging');
      if (sidebar) sidebar.style.transform = '';
      if (backdrop) {
        backdrop.style.opacity = '';
        backdrop.style.removeProperty('--drawer-handle-offset');
      }
    };

    const onTouchStart = (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const [sidebar] = parts();
      const width = sidebar?.getBoundingClientRect().width || Math.min(320, window.innerWidth * 0.86);
      // Closed, only the screen's edge opens it. Open, a swipe can start anywhere: on the menu or the
      // dimmed page beside it, as swiping is how it closes.
      if (collapsed && touch.clientX > 24) return;

      drawerSwipe.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        width,
        wasCollapsed: collapsed,
        active: false,
        startedAt: Date.now(),
      };
    };

    const onTouchMove = (event) => {
      const swipe = drawerSwipe.current;
      if (!swipe || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - swipe.startX;
      const dy = touch.clientY - swipe.startY;
      if (!swipe.active && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drawerSwipe.current = null;
        return;
      }
      if (Math.abs(dx) < 4 || Math.abs(dx) < Math.abs(dy)) return;

      event.preventDefault();
      const [sidebar, backdrop] = parts();
      if (!sidebar) return;
      if (!swipe.active) {
        swipe.active = true;
        for (const element of [sidebar, backdrop]) element?.classList.add('dragging');
      }
      // How far along the menu is, from 0 (closed) to the width of the menu (open).
      const shown = swipe.wasCollapsed ? Math.max(0, Math.min(swipe.width, dx)) : Math.max(0, swipe.width + Math.min(0, dx));
      sidebar.style.transform = `translate3d(${shown - swipe.width}px, 0, 0)`;
      if (backdrop) {
        backdrop.style.opacity = String(shown / swipe.width);
        backdrop.style.setProperty('--drawer-handle-offset', `${shown - swipe.width}px`);
      }
    };

    const finishSwipe = (event) => {
      const swipe = drawerSwipe.current;
      if (!swipe) return;
      drawerSwipe.current = null;
      if (!swipe.active) return;
      const touch = event.changedTouches[0];
      const dx = touch ? touch.clientX - swipe.startX : 0;
      // Far enough, or a quick flick in that direction.
      const flicked = Math.abs(dx) > 24 && Math.abs(dx) / Math.max(1, Date.now() - swipe.startedAt) > 0.4;
      const threshold = Math.max(56, swipe.width * 0.18);
      const nowOpen = swipe.wasCollapsed ? dx > threshold || (flicked && dx > 0) : !(dx < -threshold || (flicked && dx < 0));
      // All in one go, so it glides on from where the finger left it rather than jumping first.
      const [sidebar, backdrop] = parts();
      letGo();
      sidebar?.classList.toggle('collapsed', !nowOpen);
      backdrop?.classList.toggle('open', nowOpen);
      setCollapsed(!nowOpen);
    };

    const cancelSwipe = () => {
      drawerSwipe.current = null;
      letGo();
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', finishSwipe, { passive: true });
    document.addEventListener('touchcancel', cancelSwipe, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', finishSwipe);
      document.removeEventListener('touchcancel', cancelSwipe);
    };
  }, [collapsed]);

  const folderLabel = folder.startsWith('label:') ? labelsById[folder.slice(6)]?.name || 'Label' : FOLDERS.find((f) => f.id === folder)?.label;

  useEffect(() => {
    document.title = `${folderLabel}${counts.inbox ? ` (${counts.inbox})` : ''} - ${me}`;
    return () => {
      document.title = 'Nextspace';
    };
  }, [folderLabel, counts.inbox, me]);

  // Phone: when the end of the list scrolls into view, fetch the next 50 and add them below.
  const hasMore = phone && !search && list.items.length < list.total;
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const next = (list.scrolledPages || 1) + 1;
    const view = list.view;
    setLoadingMore(true);
    try {
      const data = await api(listPath(folder, next, search, category));
      setList((prev) => {
        if (prev.view !== view) return prev;
        const have = new Set(prev.items.map((i) => i.id));
        return { ...prev, total: data.total, scrolledPages: next, items: [...prev.items, ...data.items.filter((i) => !have.has(i.id))] };
      });
    } catch {
      /* the next scroll tries again */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, list.scrolledPages, list.view, folder, search, category]);
  useEffect(() => {
    const target = moreSentinel.current;
    if (!target || !hasMore) return undefined;
    const watcher = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '600px 0px' });
    watcher.observe(target);
    return () => watcher.disconnect();
  }, [hasMore, loadMore]);

  function openNotes(withAddress = null) {
    setNotesWith(withAddress);
    setNotesOpen(true);
    if (window.matchMedia('(max-width: 800px)').matches) setCollapsed(true);
  }

  function goTo(nextFolder) {
    prefetchMailboxList(listPath(nextFolder, 1, '', nextFolder === 'inbox' ? category : 'primary'));
    setFolder(nextFolder);
    setPage(1);
    if (window.matchMedia('(max-width: 800px)').matches) setCollapsed(true);
    if (modal === 'settings') setModal(null);
    closeViewer();
  }

  function closeViewer() {
    setOpen(null);
    setOpenMsg(null);
  }

  // On a phone, the back button closes what is open (a message, Settings, the menu, Notes, the
  // Assistant) instead of leaving the app. Compose has its own step on top of this one.
  const backLayer = phone && Boolean(open || modal === 'settings' || notesOpen || assistantOpen || !collapsed);
  const closeLayer = useRef(null);
  closeLayer.current = () => {
    setCollapsed(true);
    setModal((current) => (current === 'settings' ? null : current));
    setNotesOpen(false);
    setAssistantOpen(false);
    closeViewer();
  };
  useEffect(() => {
    if (!backLayer) return undefined;
    clearTimeout(pendingLayerBack);
    if (!history.state?.nextspaceLayer) history.pushState({ ...history.state, nextspaceLayer: true }, '');
    let popped = false;
    const onPop = () => {
      if (history.state?.nextspaceLayer) return; // Only Compose closed: this layer is still open.
      popped = true;
      closeLayer.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped) {
        pendingLayerBack = setTimeout(() => {
          if (history.state?.nextspaceLayer && !history.state?.aliasmailCompose) history.back();
        }, 0);
      }
    };
  }, [backLayer]);

  const rowSwipe = useRowSwipe({
    enabled: phone && folder === 'inbox' && !search && selected.size === 0,
    onSwipe: (id) => act([id], 'archive'),
  });

  async function refresh() {
    setSyncing(true);
    try {
      await api('/mail/refresh', { method: 'POST' });
      await load();
    } catch (err) {
      flash(err.message);
    } finally {
      setSyncing(false);
    }
  }

  /* ----- actions ----- */

  // Whether `action` takes messages out of the list currently shown (so their rows collapse away).
  const removesFromView = (action) =>
    ['trash', 'delete', 'spam', 'notSpam', 'snooze', 'cancel'].includes(action) ||
    ['sent', 'drafts'].includes(folder) ||
    (action === 'archive' && folder === 'inbox') ||
    (action === 'restore' && folder === 'trash');

  async function act(ids, action, extra = {}, { silent = false } = {}) {
    if (!ids.length) return;
    if (!open && removesFromView(action)) setLeaving(new Set(ids));
    try {
      if (folder === 'sent') await api('/mail/sent/delete', { method: 'POST', body: { ids } });
      else if (folder === 'drafts') await api('/mail/drafts/delete', { method: 'POST', body: { ids } });
      else if (folder === 'scheduled') await api('/mail/scheduled/cancel', { method: 'POST', body: { ids } });
      else if (folder === 'outbox') await api(action === 'retry' ? '/mail/outbox/retry' : action === 'cancel' ? '/mail/scheduled/cancel' : '/mail/outbox/delete', { method: 'POST', body: { ids } });
      else if (folder === 'spam') await api('/mail/spam/action', { method: 'POST', body: { ids, action } });
      else await api('/mail/messages/action', { method: 'POST', body: { ids, action, ...extra } });

      const [doneText, undoAction] =
        folder === 'sent' || (folder === 'outbox' && action === 'delete') ? ['deleted', null] : folder === 'drafts' ? ['discarded', null] : folder === 'outbox' && action === 'cancel' ? ['moved to Drafts', null] : action === 'snooze' ? [`snoozed until ${shortTime(extra.until)}`, 'unsnooze'] : DONE[action] || [];
      if (doneText && !silent) {
        const noun = ids.length === 1 ? 'Conversation' : `${ids.length} conversations`;
        const undo = undoAction && (() => act(ids, undoAction, {}, { silent: true }).then(() => flash('Action undone.')));
        flash(`${noun} ${doneText}.`, undo);
      }
      setSelected(new Set());
      if (open && ids.includes(open.id) && (LEAVES_VIEW.includes(action) || !isMailFolder(folder))) closeViewer();
      await load();
    } catch (err) {
      flash(err.message);
    } finally {
      setLeaving(new Set());
    }
  }

  async function emptyFolder() {
    const isTrash = folder === 'trash';
    const name = isTrash ? 'Trash' : 'Spam';
    if (!(await ask({ title: `Empty ${name}?`, message: `Everything in ${name} will be deleted forever. This can't be undone.`, confirmLabel: `Empty ${name}`, danger: true }))) return;
    try {
      if (isTrash) await api('/mail/trash/empty', { method: 'POST' });
      else await api('/mail/spam/action', { method: 'POST', body: { ids: list.items.map((i) => i.id), action: 'delete' } });
      flash(`${isTrash ? 'Trash' : 'Spam'} emptied.`);
      load();
    } catch (err) {
      flash(err.message);
    }
  }

  async function toggleFlag(item, flag) {
    const value = !item[flag];
    const action = flag === 'starred' ? (value ? 'star' : 'unstar') : value ? 'important' : 'notImportant';
    setList((l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, [flag]: value } : i)) }));
    await api('/mail/messages/action', { method: 'POST', body: { ids: [item.id], action } });
    api('/mail/folders').then(setCounts).catch(() => {});
    if ((folder === 'starred' && flag === 'starred') || (folder === 'important' && flag === 'important')) load();
    return { ...item, [flag]: value };
  }
  const toggleStar = (item) => toggleFlag(item, 'starred');

  async function toggleLabel(ids, label, add) {
    await act(ids, add ? 'addLabel' : 'removeLabel', { labelId: label.id }, { silent: true });
    flash(`${ids.length === 1 ? 'Conversation' : `${ids.length} conversations`} ${add ? 'added to' : 'removed from'} "${label.name}".`);
  }

  async function createLabel(name) {
    try {
      const label = await api('/mail/labels', { method: 'POST', body: { name } });
      setLabels((l) => [...l, label]);
      return label;
    } catch (err) {
      flash(err.message);
    }
  }

  async function deleteLabel(label) {
    if (!(await ask({ title: `Delete the label "${label.name}"?`, message: 'Messages stay in your mailbox; only this label is removed from them.', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/mail/labels/${label.id}`, { method: 'DELETE' });
    setLabels((l) => l.filter((x) => x.id !== label.id));
    if (folder === `label:${label.id}`) goTo('inbox');
    else load();
  }

  async function openDraft(id) {
    try {
      setDraft(await api(`/mail/drafts/${id}`));
    } catch (err) {
      flash(err.message);
    }
  }

  function openAt(index) {
    const item = list.items[index];
    if (!item) return;
    if (item.kind === 'draft') {
      setCursor(index);
      openDraft(item.id);
      return;
    }
    setOpen(item);
    setOpenMsg(null);
    setCursor(index);
    // Messages are loaded without marking them read (so preloading is harmless); opening marks it.
    if (!item.read) {
      setList((l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, read: true } : i)) }));
      const markRead = item.kind === 'inbox' ? api('/mail/messages/action', { method: 'POST', body: { ids: [item.id], action: 'read' } }) : Promise.resolve();
      markRead.then(() => api('/mail/folders')).then(setCounts).catch(() => {});
    }
    // Have the neighbours ready for j / k and the arrows.
    for (const near of [list.items[index + 1], list.items[index - 1]]) if (near) preload(near);
  }

  const messageUrl = (item) => `${URLS[item.kind] || URLS.inbox}/${item.id}`;
  const preload = (item) => item.kind !== 'draft' && preloadMessage(messageUrl(item));

  // Preload a message when the pointer rests on its row for a moment.
  const hoverTimer = useRef(null);
  // Load the top of the list in the background (phones can't hover), one email at a time and
  // each only once (getMessage keeps them). Skipped when the device asks to save data.
  useEffect(() => {
    if (navigator.connection?.saveData) return undefined;
    const wanted = list.items.filter((i) => i.kind !== 'draft' && i.kind !== 'scheduled' && i.kind !== 'outbox').slice(0, PRELOAD_TOP);
    let stop = false;
    const run = async () => {
      for (const item of wanted) {
        if (stop || document.visibilityState !== 'visible') return;
        await preloadMessage(messageUrl(item));
      }
    };
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    const handle = idle(() => run());
    return () => {
      stop = true;
      (window.cancelIdleCallback || clearTimeout)(handle);
    };
  }, [list.items]); // eslint-disable-line react-hooks/exhaustive-deps

  // An email is open: get the next two ready, so moving on is instant.
  useEffect(() => {
    if (!open) return;
    const index = list.items.findIndex((i) => i.id === open.id && i.kind === open.kind);
    if (index < 0) return;
    for (const next of list.items.slice(index + 1, index + 3)) preload(next);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowEnter = (item) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => preload(item), 120);
  };
  const onRowLeave = () => clearTimeout(hoverTimer.current);

  function toggleSelect(id) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  function selectBy(kind) {
    const pick = {
      all: () => true,
      none: () => false,
      read: (i) => i.read,
      unread: (i) => !i.read,
      starred: (i) => i.starred,
      unstarred: (i) => !i.starred,
    }[kind];
    setSelected(new Set(list.items.filter(pick).map((i) => i.id)));
  }

  /* ----- compose & send ----- */

  // The signature below a "-- " line, as formatted in Settings (or its plain text, set before
  // the editor existed).
  const signatureBlock = ({ html, text } = signature) => {
    const body = html ? sanitizeHtml(html) : text ? htmlFromText(text) : '';
    return body ? `<br><br><div>-- </div>${body}` : '';
  };
  // Replies and forwards: the signature, then the original in full (HTML), below the cursor.
  const quotedHtml = (msg) =>
    `${signatureBlock()}<br><br><div>On ${escapeHtml(formatDate(msg.date, true))}, ${person(msg.from)} wrote:</div>` +
    `<blockquote style="${QUOTE_STYLE}">${originalHtml(msg)}</blockquote>`;
  const forwardedHtml = (msg) =>
    `${signatureBlock()}<br><br><div>---------- Forwarded message ---------<br>From: <b>${person(msg.from)}</b><br>` +
    `Date: ${escapeHtml(formatDate(msg.date, true))}<br>Subject: ${escapeHtml(msg.subject || '')}<br>` +
    `To: ${(msg.to || []).map(person).join(', ')}${msg.cc?.length ? `<br>Cc: ${msg.cc.map(person).join(', ')}` : ''}</div><br>${originalHtml(msg)}`;
  const replyHeaders = (msg) => ({
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    inReplyTo: msg.messageId,
    references: [...asArray(msg.references), msg.messageId].filter(Boolean),
  });

  const compose = () => setDraft(signatureBlock() ? { html: signatureBlock() } : { text: '' });

  // The Assistant's cards: emails go through the normal send (Undo, Outbox, signature); a reply
  // carries the original's headers so it stays in the same conversation.
  async function assistantEmail(card) {
    const d = card.data;
    let headers = {};
    if (d.replyToId) {
      const original = await api(/^\d+$/.test(d.replyToId) ? `/mail/messages/${d.replyToId}?peek=1` : `/mail/sent/${encodeURIComponent(d.replyToId)}`).catch(() => null);
      if (original) headers = { inReplyTo: original.messageId, references: [...asArray(original.references), original.messageId].filter(Boolean) };
    }
    const html = htmlFromText(d.body) + signatureBlock();
    return { to: d.to.join(', '), cc: d.cc.join(', '), subject: d.subject, html, text: textFromHtml(html), ...headers };
  }
  const assistantActions = {
    sendEmail: async (card) => {
      handleSend({ ...(await assistantEmail(card)), files: [] });
      return '';
    },
    editEmail: async (card) => {
      const draftFields = await assistantEmail(card);
      setAssistantOpen(false);
      setDraft(draftFields);
    },
    createMeeting: async (card) => {
      const meeting = await api('/mail/meet', { method: 'POST', body: card.data });
      return meeting.link || '';
    },
    sendNote: async (card) => {
      await api('/notes', { method: 'POST', body: { to: card.data.to, text: card.data.text, files: [] } });
      return '';
    },
    runAutomation: async (card) => {
      const run = await api(`/automations/${card.data.id}/run`, { method: 'POST', body: { input: card.data.input || {} } });
      return `Run started · ${run.id}`;
    },
  };

  const reply = (msg) => setDraft({ ...replyHeaders(msg), to: (msg.replyTo || msg.from).address, html: quotedHtml(msg) });

  function replyAll(msg) {
    const sender = (msg.replyTo || msg.from).address;
    const others = (people) => people.map((p) => p.address).filter((a) => a && a !== me && a !== sender);
    setDraft({
      ...replyHeaders(msg),
      to: [sender, ...others(msg.to || [])].join(', '),
      cc: [...new Set(others(msg.cc || []))].join(', '),
      html: quotedHtml(msg),
    });
  }

  // Like Gmail, a forward carries the original's attachments (removable in compose). The server
  // fetches them from the mailbox when sending, so nothing is downloaded here.
  const forward = (msg) =>
    setDraft({
      files: (msg.attachments || [])
        .filter((a) => !a.unavailable && (msg.kind === 'inbox' || msg.kind === 'sent'))
        .map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size || 0, forward: { kind: msg.kind, id: msg.id, index: a.index } })),
      subject: /^fwd?:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
      html: forwardedHtml(msg),
    });

  // A send waiting out its undo delay lives only in this page: leaving now would drop it silently.
  const pendingSends = useRef(0);
  useEffect(() => {
    const warn = (e) => {
      if (pendingSends.current > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // An undone or failed send reopens compose with everything that was in it.
  const reopen = ({ files, draftId, sendAt, ...fields }) => setDraft({ ...fields, id: draftId, files, unsaved: true });

  function handleSend(payload) {
    setDraft(null);
    const { files, driveFiles, driveAccess, ...rest } = payload;
    // Attachments keep uploading in the background (started when they were attached); the
    // message goes out once they're done.
    const uploading = uploadAttachments(files);
    uploading.catch(() => {});
    const bodyWith = (uploaded) => ({
      ...rest,
      ...withDriveLinks(payload, driveFiles),
      attachments: uploaded.map(({ uploadId, filename, contentType, size, forward, content }) => ({ uploadId, filename, contentType, size, forward, content })),
    });
    // Sharing Drive files with the recipients happens after sending; say if any couldn't be shared.
    const sharedNote = (result) => {
      const failed = result?.drive?.failed || [];
      if (failed.length) flash(`Sent, but ${failed.length === 1 ? `“${failed[0]}” couldn’t be shared` : `${failed.length} Drive files couldn’t be shared`}. Share it from Google Drive.`, null, 12000);
    };

    if (payload.sendAt) {
      uploading
        .then((uploaded) => api('/mail/send', { method: 'POST', body: bodyWith(uploaded) }))
        .then(() => {
          flash(`Send scheduled for ${shortTime(payload.sendAt)}.`);
          load();
        })
        .catch((err) => {
          flash(`Not scheduled: ${err.message}`);
          reopen(payload);
        });
      return;
    }

    // Like Gmail: "Message sent" right away with Undo; the real send happens quietly once the
    // undo window ends. A failure is reported then, and the message reopens so nothing is lost.
    let cancelled = false;
    pendingSends.current += 1;
    // Like Gmail, it shows in the Outbox (with its progress) until it has actually gone out.
    const key = `s${Date.now()}${Math.random().toString(36).slice(2)}`;
    const phase = (p) => setSending((list) => list.map((s) => (s.key === key ? { ...s, phase: p } : s)));
    const done = () => setSending((list) => list.filter((s) => s.key !== key));
    // Undo, offered by the sending card until the undo window ends.
    const undo = () => {
      if (cancelled) return;
      cancelled = true;
      pendingSends.current -= 1;
      clearTimeout(timer);
      done();
      reopen(payload);
      flash('Sending undone.');
    };
    setSending((list) => [...list, { key, subject: payload.subject, to: payload.to, files, phase: 'waiting', undo }]);
    const timer = setTimeout(async () => {
      if (cancelled) return;
      const subject = payload.subject || '(no subject)';
      try {
        let uploaded;
        phase('uploading');
        const waitStarted = Date.now();
        try {
          uploaded = await uploading;
        } catch (err) {
          throw new Error(`An attachment didn’t upload (${err.message.replace(/[.\s]*$/, '')})`);
        }
        if (cancelled) return;
        phase('sending');
        // Hop timing, kept by the server with this send (admin → delivery timings).
        const clientTiming = { undoMs: UNDO_SEND_MS, uploadWaitMs: Date.now() - waitStarted };
        const postStarted = Date.now();
        const result = await api('/mail/send', { method: 'POST', body: { ...bodyWith(uploaded), clientTiming } });
        if (result.timing) console.info('[Nextspace] send timing', { ...clientTiming, requestMs: Date.now() - postStarted, ...result.timing });
        if (result.queued) {
          // Not sent, but not lost: it waits in the Outbox (retried by itself unless refused).
          flash(
            result.uncertain
              ? 'The connection dropped while sending, so it may already have gone out. Check Sent before retrying from the Outbox.'
              : result.retrying
                ? `${friendlyReason(result.error)} Nextspace will keep trying in the background.`
                : friendlyReason(result.error),
            null,
            20000,
            {
              tone: result.retrying ? 'warning' : 'error',
              title: result.retrying ? `“${subject}” is waiting in the Outbox` : `“${subject}” wasn’t sent`,
              actions: [{ label: 'Open Outbox', onClick: () => goTo('outbox') }],
            },
          );
        } else {
          sharedNote(result);
        }
        load();
      } catch (err) {
        flash(`${err.message.replace(/[.\s]*$/, '.')} It’s open again so you can fix it and send.`, null, 15000, { tone: 'error', title: `Couldn’t send “${subject}”` });
        reopen(payload);
      } finally {
        pendingSends.current -= 1;
        done();
      }
    }, UNDO_SEND_MS);
    // "Message sent" with Undo replaces any older pop-up.
    setToast(null);
  }

  /* ----- keyboard shortcuts (Gmail style) ----- */

  const onKey = useRef(null);
  onKey.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (tag === 'BUTTON' && e.key === 'Enter') return;
    // Keys pressed in Instant notes belong to it (Enter there must never open an email).
    if (notesOpen || assistantOpen || e.target.closest?.('.notes-panel, .assistant')) return;
    if (modal) {
      if (e.key === 'Escape') setModal(null);
      return;
    }

    const items = list.items;
    const index = open ? items.findIndex((i) => i.id === open.id) : cursor;
    const current = open || items[cursor];
    const targets = open ? [open.id] : selected.size ? [...selected] : current ? [current.id] : [];
    const mail = isMailFolder(folder);

    switch (e.key) {
      case 'c': compose(); break;
      case '/': searchInput.current?.focus(); break;
      case 'j': open ? openAt(index + 1) : setCursor(Math.min(cursor + 1, items.length - 1)); break;
      case 'k': open ? openAt(index - 1) : setCursor(Math.max(cursor - 1, 0)); break;
      case 'o':
      case 'Enter': if (!open) openAt(cursor); break;
      case 'u':
      case 'Escape': if (open) { closeViewer(); load(); } break;
      case 'x': if (!open && current) toggleSelect(current.id); break;
      case 'e': if (mail) act(targets, 'archive'); break;
      case '#': act(targets, folder === 'trash' || folder === 'spam' ? 'delete' : 'trash'); break;
      case 's': if (current?.kind === 'inbox') toggleStar(current); break;
      case '+':
      case '=': if (mail) act(targets, 'important', {}, { silent: true }); break;
      case '-': if (mail) act(targets, 'notImportant', {}, { silent: true }); break;
      case 'I': if (mail || folder === 'trash') act(targets, 'read'); break;
      case 'U': if (mail || folder === 'trash') act(targets, 'unread'); break;
      case 'r': if (openMsg?.kind === 'inbox') reply(openMsg); break;
      case 'a': if (openMsg?.kind === 'inbox') replyAll(openMsg); break;
      case 'f': if (openMsg) forward(openMsg); break;
      case '?': setModal('shortcuts'); break;
      default: return;
    }
    e.preventDefault();
  };

  useEffect(() => {
    const handler = (e) => onKey.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /* ----- action buttons for the toolbar, row hover and message view ----- */

  function actionButtons(ids, items, { compact = false } = {}) {
    const size = compact ? 18 : 24;
    if (folder === 'sent') return <IconButton icon="trash" title="Delete" danger size={size} onClick={() => act(ids, 'delete')} />;
    if (folder === 'drafts') return <IconButton icon="trash" title="Discard drafts" danger size={size} onClick={() => act(ids, 'delete')} />;
    if (folder === 'scheduled') return <IconButton icon="close" title="Cancel send" size={size} onClick={() => act(ids, 'cancel')} />;
    if (folder === 'outbox') {
      return (
        <>
          <IconButton icon="refresh" title="Try sending again now" size={size} onClick={() => act(ids, 'retry')} />
          <IconButton icon="edit" title="Edit (moves to Drafts)" size={size} onClick={() => act(ids, 'cancel')} />
          <IconButton icon="trash" title="Delete" danger size={size} onClick={() => act(ids, 'delete')} />
        </>
      );
    }
    if (folder === 'spam') {
      return (
        <>
          <IconButton icon="inbox" title="Not spam" size={size} onClick={() => act(ids, 'notSpam')} />
          <IconButton icon="deleteForever" title="Delete forever" danger size={size} onClick={() => act(ids, 'delete')} />
        </>
      );
    }
    if (folder === 'trash') {
      return (
        <>
          <IconButton icon="restore" title="Move to Inbox" size={size} onClick={() => act(ids, 'restore')} />
          <IconButton icon="deleteForever" title="Delete forever" danger size={size} onClick={() => act(ids, 'delete')} />
        </>
      );
    }

    const allArchived = items.length > 0 && items.every((i) => i.archived);
    const allRead = items.every((i) => i.read);
    const allImportant = items.length > 0 && items.every((i) => i.important);
    const snoozed = items.some((i) => i.snoozedUntil);
    return (
      <>
        {allArchived ? (
          <IconButton icon="inbox" title="Move to Inbox" size={size} onClick={() => act(ids, 'inbox')} />
        ) : (
          <IconButton icon="archive" title="Archive (e)" size={size} onClick={() => act(ids, 'archive')} />
        )}
        <IconButton icon="trash" title="Delete (#)" danger size={size} onClick={() => act(ids, 'trash')} />
        {allRead ? (
          <IconButton icon="mail" title="Mark as unread (Shift+u)" size={size} onClick={() => act(ids, 'unread')} />
        ) : (
          <IconButton icon="markRead" title="Mark as read (Shift+i)" size={size} onClick={() => act(ids, 'read')} />
        )}
        {snoozed ? (
          <IconButton icon="clock" title="Unsnooze" size={size} onClick={() => act(ids, 'unsnooze')} />
        ) : (
          <Popover icon="clock" title="Snooze" align={compact ? 'right' : 'left'}>
            {(close) => <TimeMenu title="Snooze until…" options={snoozeOptions()} close={close} onPick={(date) => act(ids, 'snooze', { until: date.toISOString() })} />}
          </Popover>
        )}
        {!compact && (
          <>
            <IconButton
              icon="important"
              title={allImportant ? 'Mark as not important (-)' : 'Mark as important (+)'}
              onClick={() => act(ids, allImportant ? 'notImportant' : 'important', {}, { silent: true })}
            />
            <Popover icon="label" title="Labels">
              {(close) => (
                <LabelMenu
                  labels={labels}
                  items={items}
                  close={close}
                  onToggle={(label, add) => toggleLabel(ids, label, add)}
                  onCreate={async (name) => {
                    const label = await createLabel(name);
                    if (label) await toggleLabel(ids, label, true);
                  }}
                />
              )}
            </Popover>
          </>
        )}
      </>
    );
  }

  const shownCounts = { ...counts, outbox: (counts.outbox || 0) + sending.length };

  // The Outbox's live rows: each message this page is uploading or sending right now.
  const sendingRows = folder === 'outbox' && !search && sending.length > 0 && (
    <div className="sending-rows" aria-live="polite">
      {sending.map((m) => {
        const { loaded, total } = uploadProgress(m.files);
        const pct = total ? Math.round((loaded / total) * 100) : 100;
        // Attachments upload from the moment they're attached, so show that even during Undo.
        const uploadingNow = m.phase !== 'sending' && total > 0 && loaded < total;
        const status = uploadingNow ? `Uploading attachments · ${pct}%` : m.phase === 'waiting' ? 'Sending in a moment…' : 'Sending…';
        const bar = uploadingNow ? pct : m.phase === 'waiting' ? 0 : null;
        return (
          <div key={m.key} className="sending-row">
            <span className="sending-icon" aria-hidden="true"><Icon name="send" size={18} /></span>
            <div className="sending-text">
              <div className="sending-line">
                <strong>{m.subject || '(no subject)'}</strong>
                <span className="muted small"> · to {m.to || '—'}</span>
              </div>
              <div className={`sending-bar ${bar === null ? 'indeterminate' : ''}`}>
                <span style={bar === null ? undefined : { width: `${Math.max(bar, 3)}%` }} />
              </div>
            </div>
            <span className="sending-status">{status}</span>
          </div>
        );
      })}
    </div>
  );

  const allSelected = list.items.length > 0 && list.items.every((i) => selected.has(i.id));
  const selectedIds = [...selected];
  const selectedItems = list.items.filter((i) => selected.has(i.id));
  const openIndex = open ? list.items.findIndex((i) => i.id === open.id) : -1;
  // The list row is refreshed after every action, so it has the current star / labels / importance.
  const live = openIndex >= 0 ? list.items[openIndex] : open;
  const livePatch = live?.kind === 'inbox' ? { starred: live.starred, important: live.important, labels: live.labels, archived: live.archived } : null;

  const notice =
    open?.kind === 'spam'
      ? 'This message is in Spam. Be careful with links, and attachments are blocked.'
      : open?.outbox
        ? open.uncertain
          ? 'Not sent from the Outbox: the connection dropped while sending, so it may already have gone out. Check Sent before trying again.'
          : open.failed
            ? `Not sent. ${friendlyReason(open.lastError)}`
            : `Waiting in the Outbox. ${friendlyReason(open.lastError)} Trying again ${shortTime(open.sendAt)}.`
        : open?.kind === 'scheduled'
          ? `Scheduled to send ${shortTime(open.sendAt)}.${open.error ? ` Last attempt failed: ${open.error}` : ''}`
          : null;

  function rowDate(item) {
    if (item.outbox) return <span className={item.failed ? 'text-red' : 'text-orange'}>{item.failed ? (item.uncertain ? 'Check Sent' : 'Not sent') : `Retry ${shortTime(item.sendAt)}`}</span>;
    if (item.kind === 'scheduled') return <span className={item.error ? 'text-red' : 'text-orange'}>{item.error ? 'Failed' : shortTime(item.sendAt)}</span>;
    if (item.snoozedUntil) return <span className="text-orange">{shortTime(item.snoozedUntil)}</span>;
    return formatDate(item.date);
  }

  // Whose avatar a row shows: the sender, or for mail you wrote, the first recipient.
  const rowPerson = (item) =>
    (['sent', 'draft', 'scheduled'].includes(item.kind) ? item.to?.[0] : item.from) || { name: '', address: '' };

  const drawerVisiblyOpen = !collapsed;

  // The left bar's tabs. To add one, add a line here. The list scrolls if it outgrows the screen,
  // and `pinned` keeps a tab in view at the bottom.
  // The tour: by itself on someone's first time in their own mailbox, once the page has settled and
  // nothing else is open; and again whenever they ask.
  const [touring, setTouring] = useState(false);
  useEffect(() => {
    if (touring || shared || account.tourDone || toursSeen.has(account.email) || loading || open || modal || draft) return undefined;
    const timer = setTimeout(() => setTouring(true), 500);
    return () => clearTimeout(timer);
  }, [touring, shared, account.tourDone, account.email, loading, open, modal, draft]);
  const finishTour = useCallback(() => {
    setTouring(false);
    if (toursSeen.has(account.email)) return;
    toursSeen.add(account.email);
    if (!account.tourDone) api('/auth/tour', { method: 'POST', body: {} }).catch(() => {});
  }, [account.email, account.tourDone]);
  function startTour() {
    setCollapsed(true);
    setModal(null);
    setNotesOpen(false);
    setAssistantOpen(false);
    closeViewer();
    setFolder('inbox');
    setSearch('');
    setTimeout(() => setTouring(true), 400); // Once the Inbox is back on screen.
  }

  // Their own choice of tabs and order (Settings → Tabs).
  const [layout, setLayout] = useState(() => layoutsChanged.get(account.email) || account.layout || {});
  const changeLayout = (next) => {
    setLayout(next);
    layoutsChanged.set(account.email, next);
    layoutSaving = layoutSaving.then(() => api('/auth/layout', { method: 'PUT', body: next })).catch(() => flash('Couldn’t save your tabs. Try again in a moment.'));
  };
  const inboxTabs = arrange(CATEGORY_TABS, layout.inbox);
  // A tab they've just hidden can't stay open.
  useEffect(() => {
    if (!inboxTabs.some((tab) => tab.id === category)) setCategory(inboxTabs[0].id);
  }, [inboxTabs, category]);

  const railTabs = [
    { id: 'tasks', label: 'Tasks', icon: 'checkCircle', onClick: onOpenTasks },
    { id: 'automations', label: 'Automate', title: 'Automations', icon: 'scheduleSend', onClick: onOpenAutomations, hidden: shared },
    { id: 'assistant', label: 'Assistant', icon: 'sparkle', on: assistantOpen, onClick: () => setAssistantOpen(!assistantOpen), hidden: shared },
    { id: 'notes', label: 'Notes', title: 'Instant notes', icon: 'chat', on: notesOpen, badge: notesUnread, onClick: () => (notesOpen ? setNotesOpen(false) : openNotes()) },
    { id: 'meet', label: 'Meeting', title: 'New meeting', icon: 'videocam', onClick: () => setModal('meet'), hidden: !meetOn || shared },
    { id: 'tour', label: 'Tour', title: 'Take the tour', icon: 'info', pinned: true, onClick: () => startTour(), hidden: shared },
    { id: 'settings', label: 'Settings', icon: 'settings', pinned: true, locked: true, onClick: () => { setSettingsTab('profile'); setModal('settings'); }, hidden: shared },
  ].filter((tab) => !tab.hidden);
  const shownRail = arrange(railTabs, layout.rail);
  // The phone's bottom bar: Inbox, then the first four of the same tabs in the same order, then More.
  const phoneTabs = shownRail.filter((tab) => ['assistant', 'tasks', 'automations', 'notes'].includes(tab.id)).slice(0, 4);

  return (
    <div className={`app has-rail ${drawerVisiblyOpen ? 'menu-open' : ''} ${sending.some((m) => m.phase === 'waiting') ? 'has-send-tray' : ''}`}>
      <nav className="rail" aria-label="Workspace">
        <Logo inverse size={46} className="rail-logo" />
        <div className="rail-mailboxes" role="group" aria-label="Mailboxes">
          {[{ ...account, address: account.email, own: true }, ...mailboxes].map((m) => {
            const current = m.address === me;
            const label = m.own ? 'Your mailbox' : m.displayName || m.address;
            return (
              <button
                key={m.address}
                type="button"
                className={`rail-box ${current ? 'on' : ''}`}
                title={`${label} · ${m.address}`}
                aria-label={label}
                aria-current={current ? 'true' : undefined}
                onClick={() => !current && onSwitchMailbox(m.own ? null : m.address)}
              >
                {initialsOf(m.displayName, m.address)}
              </button>
            );
          })}
        </div>
        <span className="rail-divider" aria-hidden="true" />
        <div className="rail-tabs">
          {shownRail.filter((tab) => !tab.pinned).map((tab) => <RailTab key={tab.id} tab={tab} />)}
        </div>
        <div className="rail-pinned">
          {shownRail.filter((tab) => tab.pinned).map((tab) => <RailTab key={tab.id} tab={tab} />)}
        </div>
      </nav>
      <header className="topbar">
        <div className="brand">
          <button
            className="icon-btn mobile-menu-toggle"
            type="button"
            title="Main menu"
            aria-label="Main menu"
            aria-expanded={!collapsed}
            aria-controls="mail-sidebar"
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="menu" />
          </button>
          <Logo />
          <span className="brand-text"><Wordmark /></span>
        </div>
        <nav className="crumbs" aria-label="You are in">
          <span>{shared ? shared.displayName || me : 'Your mailbox'}</span>
          <span aria-hidden="true">/</span>
          <strong>{modal === 'settings' ? 'Settings' : search ? 'Search' : showTabs && category !== 'primary' ? `${folderLabel} · ${CATEGORY_TABS.find((t) => t.id === category)?.label}` : folderLabel}</strong>
        </nav>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
            setPage(1);
            closeViewer();
            searchInput.current?.blur();
          }}
        >
          <Icon name="search" />
          <input
            ref={searchInput}
            aria-label="Search mail"
            enterKeyHint="search"
            placeholder="Search mail"
            title="Search mail. Try from:, has:attachment, or is:unread."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
          />
          {search && (
            <button type="button" className="icon-btn" title="Clear search" onClick={() => { setQuery(''); setSearch(''); }}>
              <Icon name="close" size={18} />
            </button>
          )}
        </form>
        <div className="account">
          <NotificationCenter onNavigate={(notification) => { if (notification.type?.startsWith('task-')) onOpenTasks(); }} />
          {onOpenAdmin && (
            <button data-tour="admin" className="btn btn-outline admin-switch" title="Manage aliases and the whole mailbox" onClick={onOpenAdmin}>
              <Icon name="shield" size={18} /> <span className="hide-sm">Admin console</span>
            </button>
          )}
          {(meetOn || driveOn || chatOn) && !shared && (
            <Popover icon="apps" title="Google apps" align="right">
              {(close) => (
                <div className="apps-menu">
                  {meetOn && (
                    <button type="button" className="apps-tile" style={{ '--app': '#00897b' }} onClick={() => { close(); setModal('meet'); }}>
                      <span><Icon name="videocam" /></span>New meeting
                    </button>
                  )}
                  {meetOn && (
                    <a className="apps-tile" style={{ '--app': '#1a73e8' }} href="https://calendar.google.com/" target="_blank" rel="noreferrer" onClick={close}>
                      <span><Icon name="event" /></span>Calendar
                    </a>
                  )}
                  {chatOn && (
                    <a className="apps-tile" style={{ '--app': '#188038' }} href="https://chat.google.com/" target="_blank" rel="noreferrer" onClick={close}>
                      <span><Icon name="chat" /></span>Chat
                    </a>
                  )}
                  {driveOn && (
                    <a className="apps-tile" style={{ '--app': '#f9ab00' }} href="https://drive.google.com/" target="_blank" rel="noreferrer" onClick={close}>
                      <span><Icon name="drive" /></span>Drive
                    </a>
                  )}
                  <button type="button" className="apps-manage" onClick={() => { close(); setSettingsTab('google'); setModal('settings'); }}>
                    <Icon name="settings" size={18} /> Manage connections
                  </button>
                </div>
              )}
            </Popover>
          )}
          <button className="icon-btn hide-sm" title="Keyboard shortcuts (?)" onClick={() => setModal('shortcuts')}>
            <Icon name="keyboard" />
          </button>
          {!shared && (
            <button className="icon-btn" title="Settings" onClick={() => { setSettingsTab('profile'); setModal('settings'); }}>
              <Icon name="settings" />
            </button>
          )}
          <MailboxSwitcher
            user={user}
            account={account}
            mailboxes={mailboxes}
            shared={shared}
            onSwitch={onSwitchMailbox}
            onRefresh={onRefreshMailboxes}
            onSettings={() => setModal('settings')}
            onLogout={onLogout}
          />
          <div className="account-text">
            <strong>{user.displayName || me}</strong>
            {user.displayName && <span className="muted small">{me}</span>}
          </div>
        </div>
      </header>

      {shared && (
        <div className="shared-banner" role="status">
          <Icon name="people" size={18} />
          <span className="shared-banner-text">
            Shared mailbox <strong>{me}</strong>
            <span className="muted"> · {shared.roles.join(', ')}</span>
          </span>
          <button type="button" className="btn btn-outline" onClick={() => onSwitchMailbox(null)}>
            Back to my mailbox
          </button>
        </div>
      )}

      <div className="layout">
        <aside
          id="mail-sidebar"
          className={`sidebar ${collapsed ? 'collapsed' : ''}`}
        >
          <div className="mobile-drawer-head">
            <div className="mobile-drawer-brand">
              <Logo className="mobile-drawer-logo" />
              <Wordmark />
            </div>
          </div>
          <div className="pane-head">
            <span className="muted small">{(me.split('@')[1] || '').replace(/\.[a-z.]+$/i, '').replace(/^./, (c) => c.toUpperCase())}</span>
            <strong>{shared ? shared.displayName || me : 'Your mailbox'}</strong>
            <span className="muted small pane-address">{me}</span>
          </div>
          <button
            className="compose-btn"
            onClick={() => {
              if (window.matchMedia('(max-width: 800px)').matches) setCollapsed(true);
              compose();
            }}
            title="Compose (c)"
          >
            <Icon name="edit" /> <span>New message</span>
          </button>
          <nav>
            {(() => {
              const shown = FOLDERS.filter((f) => !f.hidden && (!f.onlyWhenUsed || shownCounts[f.count] > 0 || folder === f.id));
              return shown.flatMap((f, i) => [
                ...(f.section && f.section !== shown[i - 1]?.section ? [<div key={`section-${f.section}`} className="nav-section">{f.section}</div>] : []),
                <button
                  key={f.id}
                  className={`nav-item ${folder === f.id ? 'active' : ''}`}
                  onPointerEnter={() => prefetchMailboxList(listPath(f.id, 1, '', f.id === 'inbox' ? category : 'primary'))}
                  onFocus={() => prefetchMailboxList(listPath(f.id, 1, '', f.id === 'inbox' ? category : 'primary'))}
                  onClick={() => goTo(f.id)}
                  title={f.label}
                >
                  <span className="nav-icon" style={{ '--c': f.color }}>
                    <Icon name={f.icon} size={18} />
                  </span>
                  <span className="nav-label">{f.label}</span>
                  {f.count && shownCounts[f.count] > 0 && <span className={`count ${f.plain ? 'plain' : ''}`}>{shownCounts[f.count]}</span>}
                </button>,
                ...(f.id === 'inbox'
                  ? inboxTabs.map((t) => (
                      <button
                        key={`category-${t.id}`}
                        className={`nav-item nav-sub mobile-only ${folder === 'inbox' && !search && category === t.id ? 'active' : ''}`}
                        onPointerEnter={() => prefetchMailboxList(listPath('inbox', 1, '', t.id))}
                        onFocus={() => prefetchMailboxList(listPath('inbox', 1, '', t.id))}
                        onClick={() => {
                          prefetchMailboxList(listPath('inbox', 1, '', t.id));
                          setCategory(t.id);
                          goTo('inbox');
                        }}
                      >
                        <span className="nav-icon" style={{ '--c': t.color }}>
                          <Icon name={t.icon} size={16} />
                        </span>
                        <span className="nav-label">{t.label}</span>
                        {t.id !== 'primary' && counts.categories?.[t.id] > 0 && <span className="count">{counts.categories[t.id]}</span>}
                      </button>
                    ))
                  : []),
              ]);
            })()}
            {onOpenAdmin && (
              <button
                className="nav-item admin-mobile-item"
                onClick={() => {
                  setCollapsed(true);
                  onOpenAdmin();
                }}
                title="Admin console"
              >
                <span className="nav-icon" style={{ '--c': 'var(--violet)' }}>
                  <Icon name="shield" size={18} />
                </span>
                <span className="nav-label">Admin console</span>
              </button>
            )}
            {shared ? (
              <button className="nav-item mobile-only" onClick={() => onSwitchMailbox(null)} title="Back to my mailbox">
                <span className="nav-icon" style={{ '--c': '#495057' }}>
                  <Icon name="back" size={18} />
                </span>
                <span className="nav-label">Back to my mailbox</span>
              </button>
            ) : (
              <>
                <button className="nav-item mobile-only" onClick={startTour} title="Take the tour">
                  <span className="nav-icon" style={{ '--c': 'var(--brand)' }}>
                    <Icon name="info" size={18} />
                  </span>
                  <span className="nav-label">Take the tour</span>
                </button>
                <button className="nav-item mobile-only" onClick={() => { setCollapsed(true); setModal('settings'); }} title="Settings">
                  <span className="nav-icon" style={{ '--c': '#495057' }}>
                    <Icon name="settings" size={18} />
                  </span>
                  <span className="nav-label">Settings</span>
                </button>
              </>
            )}
            <button className="nav-item mobile-only" onClick={onLogout} title="Sign out">
              <span className="nav-icon" style={{ '--c': '#495057' }}>
                <Icon name="logout" size={18} />
              </span>
              <span className="nav-label">Sign out</span>
            </button>
          </nav>

          {mailboxes.length > 0 && (
            <div className="drawer-mailboxes mobile-only">
              <div className="labels-head">
                <span>Mailboxes</span>
              </div>
              <nav>
                {[{ ...account, address: account.email, own: true }, ...mailboxes].map((m) => {
                  const current = m.address === me;
                  return (
                    <button
                      key={m.address}
                      className={`nav-item mailbox-item ${current ? 'active' : ''}`}
                      aria-current={current ? 'true' : undefined}
                      title={m.address}
                      onClick={() => {
                        setCollapsed(true);
                        if (!current) onSwitchMailbox(m.own ? null : m.address);
                      }}
                    >
                      <Avatar url={m.avatarUrl} person={{ name: m.displayName, address: m.address }} color={m.color} size="sm" />
                      <span className="nav-label">
                        {m.displayName || m.address}
                        <span className="muted small mailbox-sub">{m.own ? 'Your mailbox' : m.roles.join(', ')}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
          )}

          <div className="labels-head">
            <span>Labels</span>
            <button
              className="icon-btn"
              title="Create new label"
              onClick={async () => {
                const name = await ask({ title: 'New label', input: { label: 'Label name', placeholder: 'e.g. Clients', maxLength: 40 }, confirmLabel: 'Create' });
                if (name) createLabel(name);
              }}
            >
              <Icon name="add" size={18} />
            </button>
          </div>
          <nav>
            {labels.map((l) => (
              <div
                key={l.id}
                className={`nav-item label-item ${folder === `label:${l.id}` ? 'active' : ''}`}
                onPointerEnter={() => prefetchMailboxList(listPath(`label:${l.id}`))}
                onClick={() => goTo(`label:${l.id}`)}
                title={l.name}
              >
                <span style={{ color: l.color, display: 'grid' }}>
                  <Icon name="label" />
                </span>
                <span className="nav-label">{l.name}</span>
                {counts.labels?.[l.id] > 0 && <span className="count">{counts.labels[l.id]}</span>}
                <button
                  className="label-delete"
                  title="Delete label"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLabel(l);
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </nav>
        </aside>
        <button
          className={`sidebar-backdrop ${collapsed ? '' : 'open'}`}
          type="button"
          aria-label="Close navigation menu"
          tabIndex={collapsed ? -1 : 0}
          onClick={() => setCollapsed(true)}
        />

        {!open && modal !== 'settings' && (
          <button className="compose-fab" type="button" onClick={() => compose()} aria-label="Compose">
            <Icon name="edit" /> <span>Compose</span>
          </button>
        )}
        {!open && modal !== 'settings' && (
          <nav className="bottom-nav" aria-label="Folders">
            {['inbox'].map((id) => {
              const f = FOLDERS.find((x) => x.id === id);
              return (
                <button key={id} type="button" className={folder === id && !notesOpen && !assistantOpen ? 'on' : ''} onClick={() => { setAssistantOpen(false); goTo(id); }}>
                  <span className="bottom-nav-icon">
                    <Icon name={f.icon} />
                    {f.count && counts[f.count] > 0 && <span className="bottom-nav-badge">{counts[f.count] > 99 ? '99+' : counts[f.count]}</span>}
                  </span>
                  {f.label}
                </button>
              );
            })}
            {phoneTabs.map((tab) => (
              <button key={tab.id} type="button" data-tour={`nav-${tab.id}`} className={tab.on ? 'on' : ''} onClick={tab.id === 'assistant' ? () => { setNotesOpen(false); setAssistantOpen(true); } : tab.onClick}>
                <span className="bottom-nav-icon">
                  <Icon name={tab.icon} />
                  {tab.badge > 0 && <span className="bottom-nav-badge">{tab.badge > 99 ? '99+' : tab.badge}</span>}
                </span>
                {tab.label}
              </button>
            ))}
            <button type="button" className={folder === 'inbox' || notesOpen || assistantOpen ? '' : 'on'} onClick={() => { setAssistantOpen(false); setCollapsed(false); }}>
              <span className="bottom-nav-icon"><Icon name="menu" /></span>
              More
            </button>
          </nav>
        )}

        <main className="content">
          {modal === 'settings' && !shared ? (
            <Suspense fallback={<div className="settings-loading"><TextSkeleton lines={6} /></div>}>
            <Settings
              initialTab={settingsTab}
              tabs={{
                layout,
                onChange: changeLayout,
                rail: railTabs.filter((tab) => !tab.pinned).map(({ id, label, icon, locked }) => ({ id, label, icon, locked })),
                pinned: railTabs.filter((tab) => tab.pinned).map(({ id, label, icon, locked }) => ({ id, label, icon, locked })),
                inbox: CATEGORY_TABS.map(({ id, label, icon }) => ({ id, label, icon })),
              }}
              color={user.color}
              onAvatarChange={(avatarUrl) => {
                onUserChange({ ...user, avatarUrl });
                setPeople((p) => ({ ...p, [me]: avatarUrl }));
              }}
              onClose={() => setModal(null)}
              onSaved={(s) => {
                setModal(null);
                setSignature({ text: s.signature, html: s.signatureHtml });
                onUserChange({ ...user, displayName: s.displayName, avatarUrl: s.avatarUrl });
                flash('Settings saved.');
              }}
            />
            </Suspense>
          ) : open ? (
            <MessageView
              key={`${open.kind}:${open.id}`}
              url={messageUrl(open)}
              preview={open}
              me={me}
              labelsById={labelsById}
              avatars={people}
              notice={notice}
              noticeTone={open.outbox ? (open.failed ? 'error' : 'warning') : undefined}
              patch={livePatch}
              actions={actionButtons([open.id], [{ ...live, read: true }])}
              aside={open.kind === 'inbox' && openMsg && String(openMsg.id) === String(open.id) ? (
                <ConversationPanel
                  msg={openMsg}
                  me={me}
                  team={team}
                  avatars={people}
                  onTeam={(view) => {
                    setOpenMsg((m) => ({ ...m, team: view }));
                    setList((l) => ({ ...l, items: l.items.map((i) => (String(i.id) === String(open.id) ? { ...i, assignee: view.assignee, notes: view.notes.length } : i)) }));
                  }}
                  onMeet={meetOn && !shared ? () => setModal('meet') : null}
                />
              ) : null}
              phoneMore={
                <span className="mobile-only">
                  <Popover icon="moreVert" title="More" align="right">
                    {(close) => (
                      <PhoneMoreMenu
                        close={close}
                        onPrev={openIndex > 0 ? () => openAt(openIndex - 1) : null}
                        onNext={openIndex >= 0 && openIndex < list.items.length - 1 ? () => openAt(openIndex + 1) : null}
                        {...(MAIL_FOLDERS.includes(folder) && {
                          snoozed: Boolean(live.snoozedUntil),
                          onSnooze: (date) => act([open.id], 'snooze', { until: date.toISOString() }),
                          onUnsnooze: () => act([open.id], 'unsnooze'),
                          important: Boolean(live.important),
                          onImportant: () => act([open.id], live.important ? 'notImportant' : 'important', {}, { silent: true }),
                          labelMenu: (closeMenu) => (
                            <LabelMenu
                              labels={labels}
                              items={[live]}
                              close={closeMenu}
                              onToggle={(label, add) => toggleLabel([open.id], label, add)}
                              onCreate={async (name) => {
                                const label = await createLabel(name);
                                if (label) await toggleLabel([open.id], label, true);
                              }}
                            />
                          ),
                        })}
                      />
                    )}
                  </Popover>
                </span>
              }
              position={openIndex >= 0 ? { index: openIndex, total: list.items.length } : null}
              onPrev={openIndex > 0 ? () => openAt(openIndex - 1) : null}
              onNext={openIndex >= 0 && openIndex < list.items.length - 1 ? () => openAt(openIndex + 1) : null}
              onBack={() => {
                closeViewer();
                load();
              }}
              onLoaded={setOpenMsg}
              onStar={toggleStar}
              onReply={reply}
              onReplyAll={replyAll}
              onForward={open.kind === 'spam' || open.kind === 'scheduled' ? null : forward}
              footerActions={
                open.outbox
                  ? [
                      { label: 'Send again', icon: 'send', primary: true, onClick: () => act([open.id], 'retry') },
                      { label: 'Edit', icon: 'edit', onClick: () => act([open.id], 'cancel') },
                      { label: 'Delete', icon: 'trash', onClick: () => act([open.id], 'delete') },
                    ]
                  : null
              }
            />
          ) : (
            <div className="view-enter" key={`${folder}|${category}|${search}`}>
              <div className="view-head">
                <div className="view-title">
                  <h1>{search ? 'Search results' : folderLabel}</h1>
                  <p className="muted">
                    {folder === 'inbox' && !search
                      ? `${counts.inbox || 0} unread`
                      : list.total ? `${list.total} ${list.total === 1 ? 'conversation' : 'conversations'}` : ''}
                  </p>
                </div>
              </div>
              <div className={`toolbar ${selected.size > 0 ? 'selecting' : ''}`}>
                {selected.size > 0 ? (
                  <button className="icon-btn mobile-only" title="Clear selection" onClick={() => selectBy('none')}>
                    <Icon name="close" />
                  </button>
                ) : (
                  <span className="toolbar-title mobile-only">
                    {showTabs && folder === 'inbox' ? CATEGORY_TABS.find((t) => t.id === category)?.label : folderLabel}
                  </span>
                )}
                <span className="select-box">
                  <input
                    type="checkbox"
                    title="Select all"
                    checked={allSelected}
                    ref={(el) => el && (el.indeterminate = selected.size > 0 && !allSelected)}
                    onChange={() => selectBy(allSelected || selected.size ? 'none' : 'all')}
                  />
                  <select value="" onChange={(e) => selectBy(e.target.value)} title="Select">
                    <option value="" disabled hidden />
                    <option value="all">All</option>
                    <option value="none">None</option>
                    <option value="read">Read</option>
                    <option value="unread">Unread</option>
                    <option value="starred">Starred</option>
                    <option value="unstarred">Unstarred</option>
                  </select>
                </span>
                {selected.size === 0 ? (
                  <button className={`icon-btn ${syncing ? 'spin' : ''}`} title="Check for new mail" onClick={refresh}>
                    <Icon name="refresh" />
                  </button>
                ) : (
                  actionButtons(selectedIds, selectedItems)
                )}
                {selected.size > 0 && <span className="muted small">{selected.size} selected</span>}
                <Pager list={list} onPage={setPage} />
                {selected.size === 0 && (
                  <span className="mobile-only list-more">
                    <Popover icon="moreVert" title="More" align="right">
                      {(close) => (
                        <div className="menu phone-more">
                          <button type="button" className="menu-item check-item" onClick={() => { close(); refresh(); }}>
                            <Icon name="refresh" size={20} /> Check for new mail
                          </button>
                          <button type="button" className="menu-item check-item" onClick={() => { close(); selectBy('all'); }}>
                            <Icon name="check" size={20} /> Select all
                          </button>
                          {MAIL_FOLDERS.includes(folder) && list.items.some((i) => !i.read) && (
                            <button type="button" className="menu-item check-item" onClick={() => { close(); act(list.items.filter((i) => !i.read).map((i) => i.id), 'read'); }}>
                              <Icon name="markRead" size={20} /> Mark all as read
                            </button>
                          )}
                        </div>
                      )}
                    </Popover>
                  </span>
                )}
              </div>

              {showTabs && (
                <div className="tabs">
                  {inboxTabs.map((t) => (
                    <button
                      key={t.id}
                      className={`tab ${category === t.id ? 'on' : ''}`}
                      style={{ '--tab': t.color }}
                      onPointerEnter={() => prefetchMailboxList(listPath('inbox', 1, '', t.id))}
                      onFocus={() => prefetchMailboxList(listPath('inbox', 1, '', t.id))}
                      onClick={() => {
                        prefetchMailboxList(listPath('inbox', 1, '', t.id));
                        setCategory(t.id);
                        setPage(1);
                      }}
                    >
                      <Icon name={t.icon} />
                      <span className="tab-label">{t.label}</span>
                      {t.id !== 'primary' && counts.categories?.[t.id] > 0 && <span className="tab-badge">{counts.categories[t.id]} new</span>}
                    </button>
                  ))}
                </div>
              )}

              {(folder === 'trash' || folder === 'spam') && list.total > 0 && (
                <div className="banner">
                  {folder === 'trash' ? 'Messages in Trash stay here until you delete them forever.' : 'Spam is filtered by your mail provider.'}
                  <button className="link" onClick={emptyFolder}>
                    Empty {folder === 'trash' ? 'Trash' : 'Spam'} now
                  </button>
                </div>
              )}
              {folder === 'scheduled' && list.total > 0 && <div className="banner">These messages will be sent at the time shown. Cancel one to move it back to Drafts.</div>}
              {error && <div className="alert m">{error}</div>}
              {folder === 'inbox' && !search && !shared && <NotifyPrompt onOpenSettings={() => { setSettingsTab('notifications'); setModal('settings'); }} />}
              {CATEGORIZED.includes(folder) && !search && (
                <LoginCodes
                  reloadKey={list}
                  onOpen={({ id, subject, from, date }) => {
                    const index = list.items.findIndex((i) => i.kind === 'inbox' && i.id === id);
                    if (index >= 0) return openAt(index);
                    // In another inbox tab (codes usually land in Updates): open it from here.
                    setOpen({ id, kind: 'inbox', subject, from, date, to: [], cc: [], labels: [], read: true });
                    setOpenMsg(null);
                  }}
                />
              )}
              {search && (
                <div className="search-note">
                  Results for “{search}” <button className="link" onClick={() => { setQuery(''); setSearch(''); }}>Clear</button>
                </div>
              )}

              {sendingRows}
              <div className="rows" {...rowSwipe}>
                {loading && <MailListSkeleton />}
                {!loading && list.items.length === 0 && !sendingRows && (
                  <div className="empty">
                    <Icon name={search ? 'search' : 'inbox'} size={40} className="empty-icon" />
                    {search
                      ? 'No messages match your search.'
                      : CATEGORIZED.includes(folder)
                        ? category === 'all' ? 'Your Inbox is empty — you’re all caught up.' : `Nothing in ${CATEGORY_TABS.find((t) => t.id === category)?.label} — you’re all caught up.`
                        : `Nothing in ${folderLabel}.`}
                  </div>
                )}
                {!loading && list.items.length > 0 && MAIL_FOLDERS.includes(folder) && (
                  <div className="list-head" aria-hidden="true">
                    <span /><span>From</span><span>Conversation</span><span>Owner</span><span>Received</span>
                  </div>
                )}
                {!loading &&
                  list.items.map((item, i) => (
                    <Fragment key={item.id}>
                    {!UNGROUPED.has(folder) && dateGroup(item.date) !== (i ? dateGroup(list.items[i - 1].date) : null) && (
                      <div className="row-group" role="presentation">{dateGroup(item.date)}</div>
                    )}
                    <div
                      className={`row ${item.read ? '' : 'unread'} ${selected.has(item.id) ? 'selected' : ''} ${i === cursor ? 'focused' : ''} ${leaving.has(item.id) ? 'leaving' : ''}`}
                      style={{ '--i': Math.min(i, 15) }}
                      data-swipe-id={item.kind === 'inbox' ? item.id : undefined}
                      onClick={() => openAt(i)}
                      onMouseEnter={() => onRowEnter(item)}
                      onPointerDown={() => preload(item)}
                      onMouseLeave={onRowLeave}
                    >
                      <input type="checkbox" checked={selected.has(item.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(item.id)} />
                      <button
                        type="button"
                        className="row-avatar"
                        aria-label={selected.has(item.id) ? 'Deselect' : 'Select'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(item.id);
                        }}
                      >
                        {selected.has(item.id) ? (
                          <span className="avatar row-check"><Icon name="check" /></span>
                        ) : (
                          <Avatar url={people[rowPerson(item).address]} person={rowPerson(item)} />
                        )}
                      </button>
                      {item.kind === 'inbox' ? (
                        <>
                          <IconButton icon={item.starred ? 'star' : 'starOutline'} title={item.starred ? 'Starred' : 'Not starred'} size={18} onClick={() => toggleStar(item)} />
                          <button
                            className={`icon-btn importance ${item.important ? 'on' : ''}`}
                            title={item.important ? 'Important' : 'Click to mark as important'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFlag(item, 'important');
                            }}
                          >
                            <Icon name="important" size={18} />
                          </button>
                        </>
                      ) : (
                        <span className="row-spacer" />
                      )}
                      <span className="row-from">
                        {item.kind === 'draft' && <span className="draft-label">Draft </span>}
                        {['sent', 'draft', 'scheduled'].includes(item.kind)
                          ? `To: ${(item.to || []).map((p) => personLabel(p, me)).join(', ') || '(no recipients)'}`
                          : personLabel(item.from, me)}
                        {item.kind === 'inbox' && orgOf(item.from) && <span className="row-org">{orgOf(item.from)}</span>}
                      </span>
                      <span className="row-main">
                        {folder === 'all' && !item.archived && <span className="tag">Inbox</span>}
                        {(search || (showTabs && category === 'all')) && item.category && item.category !== 'primary' && <span className="tag">{item.category}</span>}
                        {item.notes > 0 && <span className="tag notes-tag" title="Team notes">{item.notes} {item.notes === 1 ? 'note' : 'notes'}</span>}
                        {item.via === 'cc' && <span className="tag cc" title="You were CC'd">cc</span>}
                        {item.via === 'bcc' && <span className="tag bcc" title="You were BCC'd">bcc</span>}
                        {item.labels.map(
                          (id) =>
                            labelsById[id] &&
                            folder !== `label:${id}` && (
                              <span key={id} className="tag label-tag" style={{ '--chip': labelsById[id].color }}>
                                {labelsById[id].name}
                              </span>
                            ),
                        )}
                        <span className="row-subject">{item.subject || '(no subject)'}</span>
                        {item.snippet && <span className="row-snippet">{item.snippet}</span>}
                      </span>
                      {item.hasAttachments && <Icon name="attach" size={16} className="muted row-clip" />}
                      <span className="row-owner">{item.assignee && <OwnerChip address={item.assignee} me={me} team={team} avatars={people} />}</span>
                      <span className="row-date" title={formatDate(item.date, true)}>{rowDate(item)}</span>
                      <span className="row-hover">{actionButtons([item.id], [item], { compact: true })}</span>
                    </div>
                    </Fragment>
                  ))}
                {!loading && hasMore && (
                  <div ref={moreSentinel} className="list-more-loading" aria-live="polite">
                    {loadingMore && <span className="loading-more"><Icon name="refresh" size={16} /> Loading more</span>}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {touring && (
        <Suspense fallback={null}>
          <Tour phone={phone} isAdmin={user.role === 'admin'} onClose={finishTour} />
        </Suspense>
      )}

      {draft && (
        <Suspense fallback={<OpeningPill />}>
        <Compose
          key={JSON.stringify({ ...draft, files: draft.files?.length })}
          from={user.displayName ? `${user.displayName} <${me}>` : me}
          draft={draft}
          onClose={(message) => {
            setDraft(null);
            if (message) flash(message);
            load();
          }}
          onSend={handleSend}
          driveOn={driveOn}
          meetOn={meetOn}
        />
        </Suspense>
      )}

      {assistantOpen && !shared && (
        <Suspense fallback={<OpeningPill />}>
        <Assistant
          status={assistantStatus}
          onClose={() => setAssistantOpen(false)}
          actions={assistantActions}
        />
        </Suspense>
      )}

      {notesOpen && (
        <InstantNotes
          me={notesMe}
          incoming={latestNote}
          startWith={notesWith}
          onClose={() => setNotesOpen(false)}
          onRead={(count) => setNotesUnread((n) => Math.max(0, n - count))}
        />
      )}

      {modal === 'meet' && (
        <Suspense fallback={<OpeningPill />}>
        <MeetDialog
          onClose={() => setModal(null)}
          onEmail={(meeting) => {
            setModal(null);
            setDraft({ to: meeting.guests.join(', '), subject: meeting.title, html: htmlFromText(meetingText(meeting)) + signatureBlock() });
          }}
        />
        </Suspense>
      )}

      {modal === 'shortcuts' && (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Keyboard shortcuts</h2>
              <button className="icon-btn" onClick={() => setModal(null)}>
                <Icon name="close" />
              </button>
            </div>
            <table className="shortcuts">
              <tbody>
                {SHORTCUTS.map(([key, label]) => (
                  <tr key={key}>
                    <td><kbd>{key}</kbd></td>
                    <td>{label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Search operators: <code>from:</code> <code>to:</code> <code>cc:</code> <code>subject:</code> <code>has:attachment</code> <code>is:unread</code>{' '}
              <code>is:starred</code> <code>"exact phrase"</code>
            </p>
          </div>
        </div>
      )}

      <SendingTray items={sending} onView={() => goTo('outbox')} />
      {toast && (
        <div className={`toast ${toast.tone ? `toast-card toast-${toast.tone}` : ''}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone && (
            <span className="toast-icon" aria-hidden="true">
              <Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'note' ? 'chat' : toast.tone === 'warning' ? 'outbox' : 'spam'} size={20} />
            </span>
          )}
          {toast.tone ? (
            <span className="toast-body">
              {toast.title && <strong className="toast-title">{toast.title}</strong>}
              <span className="toast-text">{toast.text}</span>
              {toast.actions?.length > 0 && (
                <span className="toast-actions">
                  {toast.actions.map((a) => (
                    <button
                      key={a.label}
                      className="toast-action"
                      onClick={() => {
                        setToast(null);
                        a.onClick();
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          ) : (
            <>
              {toast.text}
              {toast.actions?.map((a) => (
                <button
                  key={a.label}
                  className="toast-action"
                  onClick={() => {
                    setToast(null);
                    a.onClick();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </>
          )}
          {toast.undo && (
            <button
              className="toast-action"
              onClick={() => {
                setToast(null);
                toast.undo();
              }}
            >
              Undo
            </button>
          )}
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
