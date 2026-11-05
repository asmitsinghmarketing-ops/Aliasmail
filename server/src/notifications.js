import crypto from 'node:crypto';
import { db, save } from './store.js';
import { notificationEvents } from './mail-events.js';

const MAX_PER_PERSON = 200;

const store = () => (db().notifications ||= []);

export function notificationsFor(person) {
  return store().filter((item) => item.to === person).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createNotification({ to, type, title, body = '', entity = null, actor = '' }) {
  if (!to) return null;
  const item = {
    id: crypto.randomUUID(),
    to,
    type: String(type || 'info').slice(0, 40),
    title: String(title || 'Notification').slice(0, 160),
    body: String(body || '').slice(0, 500),
    entity,
    actor: String(actor || '').slice(0, 200),
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  store().push(item);
  const mine = notificationsFor(to);
  for (const old of mine.slice(MAX_PER_PERSON)) store().splice(store().indexOf(old), 1);
  save();
  notificationEvents.emit('notification', to, item);
  return item;
}

export function markNotificationsRead(person, ids = null) {
  const wanted = ids ? new Set(ids.map(String)) : null;
  const now = new Date().toISOString();
  let changed = 0;
  for (const item of store()) {
    if (item.to === person && !item.readAt && (!wanted || wanted.has(item.id))) {
      item.readAt = now;
      changed++;
    }
  }
  if (changed) save();
  return changed;
}
