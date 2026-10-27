import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cachedMailboxList, preloadMessage } from '../api.js';
import { displayName, formatDate, initial, personLabel } from '../format.js';
import Compose from './Compose.jsx';
import { ask } from './Dialog.jsx';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { LabelMenu, Popover, TimeMenu, shortTime, snoozeOptions } from './Menus.jsx';
import MessageView from './MessageView.jsx';
import Pager from './Pager.jsx';
import Settings from './Settings.jsx';

// Gmail's folders, in Gmail's order. `count` is the key in /mail/folders shown beside it;
// `color` tints the folder's icon tile in the sidebar.
const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox', count: 'inbox', color: '#e8590c' },
  { id: 'starred', label: 'Starred', icon: 'star', color: '#f59f00' },
  { id: 'snoozed', label: 'Snoozed', icon: 'clock', color: '#0c8599' },
  { id: 'important', label: 'Important', icon: 'important', count: 'important', color: '#d6336c' },
  { id: 'sent', label: 'Sent', icon: 'send', color: '#1c7ed6' },
  { id: 'scheduled', label: 'Scheduled', icon: 'scheduleSend', count: 'scheduled', plain: true, color: '#7048e8' },
  { id: 'drafts', label: 'Drafts', icon: 'draft', count: 'drafts', plain: true, color: '#ae3ec9' },
  { id: 'all', label: 'All Mail', icon: 'mail', color: '#2b8a3e' },
  // Spam is switched off for now (also SYNCED_FOLDERS in server/src/mailbox.js). Uncomment to show it:
  // { id: 'spam', label: 'Spam', icon: 'spam', count: 'spam', plain: true, color: '#e03131' },
  { id: 'trash', label: 'Trash', icon: 'trash', color: '#868e96' },
];

const CATEGORY_TABS = [
  { id: 'primary', label: 'Primary', icon: 'inbox', color: 'var(--alias)' },
  { id: 'promotions', label: 'Promotions', icon: 'tag', color: 'var(--green)' },
  { id: 'social', label: 'Social', icon: 'people', color: '#1971c2' },
  { id: 'updates', label: 'Updates', icon: 'info', color: 'var(--orange)' },
];

// Folders holding inbox messages (per-account state applies); the rest are special lists.
const MAIL_FOLDERS = ['inbox', 'starred', 'snoozed', 'important', 'all'];
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
};
// Actions after which an open message no longer belongs in the current view.
const LEAVES_VIEW = ['archive', 'trash', 'inbox', 'restore', 'delete', 'unread', 'spam', 'notSpam', 'snooze', 'cancel'];

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

const quote = (msg) =>
  (msg.text || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

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
              <span className="muted small">{user.email}</span>
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

export default function Mailbox({ user, account = user, mailboxes = [], shared = null, onSwitchMailbox, onRefreshMailboxes, onLogout, onUserChange, onOpenAdmin }) {
  const [folder, setFolder] = useState('inbox');
  const [category, setCategory] = useState('primary');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  const [counts, setCounts] = useState({});
  const [labels, setLabels] = useState([]);
  const [people, setPeople] = useState({}); // address -> profile picture URL
  const [open, setOpen] = useState(null); // list item being viewed
  const [openMsg, setOpenMsg] = useState(null); // its fully loaded message
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [draft, setDraft] = useState(null);
  const [signature, setSignature] = useState('');
  const [modal, setModal] = useState(null); // 'settings' | 'shortcuts'
  // Phones hide the drawer; tablets and small laptops start with the icon rail so the list has room.
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const [drawerDrag, setDrawerDrag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [leaving, setLeaving] = useState(new Set()); // rows animating out of the list
  const toastTimer = useRef(null);
  const searchInput = useRef(null);
  const drawerSwipe = useRef(null);
  const firstMailboxLoad = useRef(true);
  const me = user.email;

  const labelsById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);
  const showTabs = folder === 'inbox' && !search;

  const flash = (text, undo, ms = 6000) => {
    setToast({ text, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  const loadLabels = () => api('/mail/labels').then(setLabels).catch(() => {});

  const loadRequest = useRef(0);
  const latestLoad = useRef(null);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const params = new URLSearchParams({ folder, page, q: search, ...(folder === 'inbox' && !search && { category }) });
      const path = `/mail/messages?${params}`;
      const cached = cachedMailboxList(path);
      if (cached) { setList(cached); setLoading(false); }
      const [data, folderCounts] = await Promise.all([
        api(path).then((data) => {
          if (request === loadRequest.current) {
            setList(data);
            setLoading(false);
          }
          return data;
        }),
        api('/mail/folders'),
      ]);
      if (request !== loadRequest.current) return;
      setList(data);
      setCounts(folderCounts);
      setError('');
    } catch (err) {
      if (request === loadRequest.current) setError(err.message);
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [folder, category, page, search]);
  latestLoad.current = load;

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    setCursor(0);
    load();
    if (firstMailboxLoad.current) {
      firstMailboxLoad.current = false;
      // Startup sync runs in the API process. Refresh the cached list when it finishes so a
      // newly deployed app doesn't leave the first mailbox view empty until the 30s poll.
      api('/mail/refresh', { method: 'POST' }).then(() => latestLoad.current?.()).catch(() => {});
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

  useEffect(() => {
    if (!window.EventSource) return undefined;
    const events = new EventSource('/api/mail/events');
    let timer;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    };
    events.addEventListener('mail', update);
    return () => { clearTimeout(timer); events.close(); };
  }, [load]);

  // Back from connecting Google in Settings → Security: reopen it and say how it went.
  const [settingsTab, setSettingsTab] = useState('profile');
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get('google');
    if (!outcome) return;
    window.history.replaceState(null, '', window.location.pathname);
    const said = {
      linked: 'Google account connected. You can now sign in with Google.',
      'in-use': 'That Google account is already connected to another AliasMail account.',
      cancelled: 'Connecting Google was cancelled.',
    };
    if (outcome === 'continue' || outcome === 'not-linked') return;
    setSettingsTab('security');
    setModal('settings');
    flash(said[outcome] || 'Couldn’t connect Google. Try again.', null, 8000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadLabels();
    api('/mail/people').then(setPeople).catch(() => {});
    api('/mail/settings')
      .then((s) => setSignature(s.signature))
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

    const onTouchStart = (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const sidebar = document.getElementById('mail-sidebar');
      const width = sidebar?.getBoundingClientRect().width || Math.min(320, window.innerWidth * 0.86);
      if (collapsed ? touch.clientX > 24 : touch.clientX > width) return;

      drawerSwipe.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        width,
        wasCollapsed: collapsed,
        active: false,
      };
      setDrawerDrag(0);
    };

    const onTouchMove = (event) => {
      const swipe = drawerSwipe.current;
      if (!swipe || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - swipe.startX;
      const dy = touch.clientY - swipe.startY;
      if (!swipe.active && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drawerSwipe.current = null;
        setDrawerDrag(null);
        return;
      }
      if (Math.abs(dx) < 4 || Math.abs(dx) < Math.abs(dy)) return;

      swipe.active = true;
      event.preventDefault();
      const offset = swipe.wasCollapsed
        ? Math.max(0, Math.min(swipe.width * 1.1, dx))
        : Math.max(-swipe.width, Math.min(0, dx));
      setDrawerDrag(offset);
    };

    const finishSwipe = (event) => {
      const swipe = drawerSwipe.current;
      if (!swipe) return;
      drawerSwipe.current = null;
      const touch = event.changedTouches[0];
      const dx = touch ? touch.clientX - swipe.startX : 0;
      const threshold = Math.max(56, swipe.width * 0.18);
      setDrawerDrag(null);
      if (swipe.active && swipe.wasCollapsed && dx > threshold) setCollapsed(false);
      else if (swipe.active && !swipe.wasCollapsed && dx < -threshold) setCollapsed(true);
    };

    const cancelSwipe = () => {
      drawerSwipe.current = null;
      setDrawerDrag(null);
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
      document.title = 'AliasMail';
    };
  }, [folderLabel, counts.inbox, me]);

  function goTo(nextFolder) {
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
      else if (folder === 'spam') await api('/mail/spam/action', { method: 'POST', body: { ids, action } });
      else await api('/mail/messages/action', { method: 'POST', body: { ids, action, ...extra } });

      const [doneText, undoAction] =
        folder === 'sent' ? ['deleted', null] : folder === 'drafts' ? ['discarded', null] : action === 'snooze' ? [`snoozed until ${shortTime(extra.until)}`, 'unsnooze'] : DONE[action] || [];
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

  const withSignature = (text = '') => (signature ? `\n\n-- \n${signature}${text}` : text);
  const quoted = (msg) => `\n\nOn ${formatDate(msg.date, true)}, ${displayName(msg.from)} wrote:\n${quote(msg)}`;
  const replyHeaders = (msg) => ({
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    inReplyTo: msg.messageId,
    references: [...asArray(msg.references), msg.messageId].filter(Boolean),
  });

  const compose = () => setDraft({ text: withSignature() });

  const reply = (msg) => setDraft({ ...replyHeaders(msg), to: (msg.replyTo || msg.from).address, text: withSignature(quoted(msg)) });

  function replyAll(msg) {
    const sender = (msg.replyTo || msg.from).address;
    const others = (people) => people.map((p) => p.address).filter((a) => a && a !== me && a !== sender);
    setDraft({
      ...replyHeaders(msg),
      to: [sender, ...others(msg.to || [])].join(', '),
      cc: [...new Set(others(msg.cc || []))].join(', '),
      text: withSignature(quoted(msg)),
    });
  }

  const forward = (msg) =>
    setDraft({
      subject: /^fwd?:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
      text: withSignature(
        `\n\n---------- Forwarded message ----------\nFrom: ${displayName(msg.from)} <${msg.from.address}>\nDate: ${formatDate(msg.date, true)}\nSubject: ${msg.subject}\nTo: ${(msg.to || []).map((a) => a.address).join(', ')}\n\n${msg.text}`,
      ),
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
    const body = { ...payload, attachments: payload.files.map(({ size, ...f }) => f) };
    delete body.files;

    if (payload.sendAt) {
      api('/mail/send', { method: 'POST', body })
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
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        await api('/mail/send', { method: 'POST', body });
        load();
      } catch (err) {
        flash(`Couldn’t send “${payload.subject || '(no subject)'}”: ${err.message.replace(/[.\s]*$/, '.')} It’s open again so you can retry.`, null, 12000);
        reopen(payload);
      } finally {
        pendingSends.current -= 1;
      }
    }, UNDO_SEND_MS);
    flash(
      'Message sent.',
      () => {
        cancelled = true;
        pendingSends.current -= 1;
        clearTimeout(timer);
        reopen(payload);
        flash('Sending undone.');
      },
      UNDO_SEND_MS,
    );
  }

  /* ----- keyboard shortcuts (Gmail style) ----- */

  const onKey = useRef(null);
  onKey.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (tag === 'BUTTON' && e.key === 'Enter') return;
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
      : open?.kind === 'scheduled'
        ? `Scheduled to send ${shortTime(open.sendAt)}.${open.error ? ` Last attempt failed: ${open.error}` : ''}`
        : null;

  function rowDate(item) {
    if (item.kind === 'scheduled') return <span className={item.error ? 'text-red' : 'text-orange'}>{item.error ? 'Failed' : shortTime(item.sendAt)}</span>;
    if (item.snoozedUntil) return <span className="text-orange">{shortTime(item.snoozedUntil)}</span>;
    return formatDate(item.date);
  }

  // Whose avatar a row shows: the sender, or for mail you wrote, the first recipient.
  const rowPerson = (item) =>
    (['sent', 'draft', 'scheduled'].includes(item.kind) ? item.to?.[0] : item.from) || { name: '', address: '' };

  const drawerVisiblyOpen = !collapsed || (drawerDrag !== null && drawerDrag > 0);

  return (
    <div className={`app ${drawerVisiblyOpen ? 'menu-open' : ''}`} style={{ '--alias': user.color }}>
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
          {onOpenAdmin && (
            <button className="btn btn-outline admin-switch" title="Manage aliases and the whole mailbox" onClick={onOpenAdmin}>
              <Icon name="shield" size={18} /> <span className="hide-sm">Admin console</span>
            </button>
          )}
          <button className="icon-btn hide-sm" title="Keyboard shortcuts (?)" onClick={() => setModal('shortcuts')}>
            <Icon name="keyboard" />
          </button>
          {!shared && (
            <button className="icon-btn" title="Settings" onClick={() => setModal('settings')}>
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
            <span className="muted small">{me}</span>
          </div>
          <button className="icon-btn" title="Sign out" onClick={onLogout}>
            <Icon name="logout" />
          </button>
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
          className={`sidebar ${collapsed ? 'collapsed' : ''} ${drawerDrag !== null ? 'dragging' : ''}`}
          style={drawerDrag !== null ? { '--drawer-drag-offset': `${drawerDrag}px` } : undefined}
        >
          <div className="mobile-drawer-head">
            <div className="mobile-drawer-brand">
              <Logo className="mobile-drawer-logo" />
              <Wordmark />
            </div>
            <button className="icon-btn mobile-drawer-close" type="button" aria-label="Close menu" onClick={() => setCollapsed(true)}>
              <Icon name="close" />
            </button>
          </div>
          <button
            className="compose-btn"
            onClick={() => {
              if (window.matchMedia('(max-width: 800px)').matches) setCollapsed(true);
              compose();
            }}
            title="Compose (c)"
          >
            <Icon name="edit" /> <span>Compose</span>
          </button>
          <nav>
            {FOLDERS.map((f) => (
              <button key={f.id} className={`nav-item ${folder === f.id ? 'active' : ''}`} onClick={() => goTo(f.id)} title={f.label}>
                <span className="nav-icon" style={{ '--c': f.color }}>
                  <Icon name={f.icon} size={18} />
                </span>
                <span className="nav-label">{f.label}</span>
                {f.count && counts[f.count] > 0 && <span className={`count ${f.plain ? 'plain' : ''}`}>{counts[f.count]}</span>}
              </button>
            ))}
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
              <button className="nav-item mobile-only" onClick={() => { setCollapsed(true); setModal('settings'); }} title="Settings">
                <span className="nav-icon" style={{ '--c': '#495057' }}>
                  <Icon name="settings" size={18} />
                </span>
                <span className="nav-label">Settings</span>
              </button>
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
              <div key={l.id} className={`nav-item label-item ${folder === `label:${l.id}` ? 'active' : ''}`} onClick={() => goTo(`label:${l.id}`)} title={l.name}>
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
        {!collapsed && (
          <button
            className="sidebar-backdrop"
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setCollapsed(true)}
          />
        )}

        {!open && modal !== 'settings' && (
          <button className="compose-fab" type="button" onClick={() => compose()} aria-label="Compose">
            <Icon name="edit" /> <span>Compose</span>
          </button>
        )}
        {!open && modal !== 'settings' && (
          <nav className="bottom-nav" aria-label="Folders">
            {['inbox', 'starred', 'sent'].map((id) => {
              const f = FOLDERS.find((x) => x.id === id);
              return (
                <button key={id} type="button" className={folder === id ? 'on' : ''} onClick={() => goTo(id)}>
                  <span className="bottom-nav-icon">
                    <Icon name={f.icon} />
                    {f.count && counts[f.count] > 0 && <span className="bottom-nav-badge">{counts[f.count] > 99 ? '99+' : counts[f.count]}</span>}
                  </span>
                  {f.label}
                </button>
              );
            })}
            <button type="button" className={['inbox', 'starred', 'sent'].includes(folder) ? '' : 'on'} onClick={() => setCollapsed(false)}>
              <span className="bottom-nav-icon"><Icon name="menu" /></span>
              More
            </button>
          </nav>
        )}

        <main className="content">
          {modal === 'settings' && !shared ? (
            <Settings
              initialTab={settingsTab}
              color={user.color}
              onAvatarChange={(avatarUrl) => {
                onUserChange({ ...user, avatarUrl });
                setPeople((p) => ({ ...p, [me]: avatarUrl }));
              }}
              onClose={() => setModal(null)}
              onSaved={(s) => {
                setModal(null);
                setSignature(s.signature);
                onUserChange({ ...user, displayName: s.displayName, avatarUrl: s.avatarUrl });
                flash('Settings saved.');
              }}
            />
          ) : open ? (
            <MessageView
              key={`${open.kind}:${open.id}`}
              url={messageUrl(open)}
              preview={open}
              me={me}
              labelsById={labelsById}
              avatars={people}
              notice={notice}
              patch={livePatch}
              actions={actionButtons([open.id], [{ ...live, read: true }])}
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
              onForward={open.kind === 'spam' ? null : forward}
            />
          ) : (
            <div className="view-enter" key={`${folder}|${category}|${search}`}>
              <div className={`toolbar ${selected.size > 0 ? 'selecting' : ''}`}>
                {selected.size > 0 ? (
                  <button className="icon-btn mobile-only" title="Clear selection" onClick={() => selectBy('none')}>
                    <Icon name="close" />
                  </button>
                ) : (
                  <span className="toolbar-title mobile-only">
                    {folder === 'inbox' && showTabs ? CATEGORY_TABS.find((t) => t.id === category)?.label : folderLabel}
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
              </div>

              {showTabs && (
                <div className="tabs">
                  {CATEGORY_TABS.map((t) => (
                    <button
                      key={t.id}
                      className={`tab ${category === t.id ? 'on' : ''}`}
                      style={{ '--tab': t.color }}
                      onClick={() => {
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
              {search && (
                <div className="search-note">
                  Results for “{search}” <button className="link" onClick={() => { setQuery(''); setSearch(''); }}>Clear</button>
                </div>
              )}

              <div className="rows">
                {loading && <div className="loading-lines list"><span /><span /><span /><span /></div>}
                {!loading && list.items.length === 0 && (
                  <div className="empty">
                    {search
                      ? 'No messages match your search.'
                      : folder === 'inbox'
                        ? `Nothing in ${CATEGORY_TABS.find((t) => t.id === category)?.label} — you’re all caught up.`
                        : `Nothing in ${folderLabel}.`}
                  </div>
                )}
                {!loading &&
                  list.items.map((item, i) => (
                    <div
                      key={item.id}
                      className={`row ${item.read ? '' : 'unread'} ${selected.has(item.id) ? 'selected' : ''} ${i === cursor ? 'focused' : ''} ${leaving.has(item.id) ? 'leaving' : ''}`}
                      style={{ '--i': Math.min(i, 15) }}
                      onClick={() => openAt(i)}
                      onMouseEnter={() => onRowEnter(item)}
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
                          : displayName(item.from)}
                      </span>
                      <span className="row-main">
                        {folder === 'all' && !item.archived && <span className="tag">Inbox</span>}
                        {search && item.category && item.category !== 'primary' && <span className="tag">{item.category}</span>}
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
                      <span className="row-date" title={formatDate(item.date, true)}>{rowDate(item)}</span>
                      <span className="row-hover">{actionButtons([item.id], [item], { compact: true })}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {draft && (
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
        />
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

      {toast && (
        <div className="toast">
          {toast.text}
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
