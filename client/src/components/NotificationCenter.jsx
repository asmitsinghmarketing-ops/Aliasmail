import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { subscribe } from '../live.js';
import Icon from './Icon.jsx';

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return 'Now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

const iconFor = (type) => type === 'task-completed' ? 'checkCircle' : type === 'task-assigned' ? 'person' : 'bell';

export default function NotificationCenter({ onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');
  const root = useRef(null);

  const load = () => api('/notifications').then((data) => { setItems(data.items); setUnread(data.unread); }).catch(() => {});

  useEffect(() => {
    load();
    const stop = subscribe((message) => {
      if (message.type !== 'notification' || !message.notification) return;
      setItems((current) => [message.notification, ...current.filter((item) => item.id !== message.notification.id)].slice(0, 50));
      setUnread((count) => count + 1);
    });
    const focus = () => load();
    window.addEventListener('focus', focus);
    return () => { stop(); window.removeEventListener('focus', focus); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => !root.current?.contains(event.target) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const markRead = async (notification) => {
    if (!notification.readAt) {
      const readAt = new Date().toISOString();
      setItems((current) => current.map((item) => item.id === notification.id ? { ...item, readAt } : item));
      setUnread((count) => Math.max(0, count - 1));
      await api('/notifications/read', { method: 'POST', body: { ids: [notification.id] } }).catch(() => load());
    }
    setOpen(false);
    onNavigate?.(notification);
  };

  const markAll = async () => {
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt || readAt })));
    setUnread(0);
    setError('');
    try { await api('/notifications/read', { method: 'POST', body: {} }); }
    catch (err) { setError(err.message); load(); }
  };

  return (
    <div className="notification-center" ref={root}>
      <button type="button" className={`icon-btn notification-bell ${open ? 'on' : ''}`} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} title="Notifications" onClick={() => setOpen(!open)}>
        <Icon name="bell" />
        {unread > 0 && <span className="notification-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section className="notification-menu" aria-label="Notifications">
          <header><div><h2>Notifications</h2>{unread > 0 && <span>{unread} unread</span>}</div>{unread > 0 && <button type="button" className="link small" onClick={markAll}>Mark all read</button>}</header>
          {error && <div className="notification-error">{error}</div>}
          <div className="notification-list">
            {items.map((item) => (
              <button type="button" key={item.id} className={`notification-item ${item.readAt ? '' : 'unread'}`} onClick={() => markRead(item)}>
                <span className={`notification-kind ${item.type}`}><Icon name={iconFor(item.type)} size={18} /></span>
                <span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><time>{relativeTime(item.createdAt)}</time></span>
                {!item.readAt && <i aria-label="Unread" />}
              </button>
            ))}
            {!items.length && <div className="notification-empty"><Icon name="bell" size={28} /><strong>You’re all caught up</strong><span>New assignments and team updates appear here.</span></div>}
          </div>
        </section>
      )}
    </div>
  );
}
