const AVATAR_COLORS = ['#e8590c', '#2b8a3e', '#7048e8', '#d6336c', '#0c8599', '#f08c00', '#c92a2a', '#5c940d', '#ae3ec9', '#1971c2'];

export function colorFor(text = '') {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export const initial = (person) => (person?.name || person?.address || '?').trim().charAt(0).toUpperCase();
export const displayName = (person) => person?.name || person?.address || '(unknown)';

export function formatDate(iso, long = false) {
  const date = new Date(iso);
  const now = new Date();
  if (long) return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString();
}

export function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const timeAgo = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(iso, true);
};

/** "me" for the signed-in alias, otherwise the person's name or address. */
export const personLabel = (person, me) => (person?.address === me ? 'me' : displayName(person));

/** Two digits: 7 → "07". */
export const pad2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
/** A local calendar day, as "2026-11-21" (what <input type="date"> uses). */
export const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** A local time of day, as "09:30" (what <input type="time"> uses). */
export const localTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** Up to two initials from a name or address: "Asha Rao" → "AR". */
export const initials = (value) => String(value || '?').split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
/** Text made safe to put inside HTML. */
export const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A promise that resolves after `ms` milliseconds. */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
