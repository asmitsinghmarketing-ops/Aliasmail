// Instant notes: quick private messages between teammates, with files. Sent and received over the
// live WebSocket (live.js), or the plain API (routes/notes.js) where sockets are blocked; both
// use these functions. They never leave Nextspace: nothing is sent by email.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { persistence } from './persist.js';
import { noteEvents } from './mail-events.js';
import { teammates } from './team.js';
import { normalize } from './aliases.js';

const MAX_TEXT = 4000;
const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KEEP = 10_000; // notes kept in all; the oldest go first

export const notes = () => (db().instantNotes ||= []);
export const between = (a, b) => (n) => (n.from === a && n.to === b) || (n.from === b && n.to === a);
export const noteView = (n) => ({
  id: n.id,
  from: n.from,
  to: n.to,
  text: n.text,
  at: n.at,
  read: Boolean(n.readAt),
  files: (n.files || []).map(({ id, name, type, size }) => ({ id, name, type, size })),
});

/** Send a note from `me`: { to, text, files: [{ name, type, data (base64) }] }. Returns its view. */
export async function createNote(me, input = {}) {
  const to = normalize(input.to);
  if (to === me || !teammates().some((p) => p.address === to)) throw new HttpError(400, 'Choose someone from your team');
  const text = String(input.text || '').trim().slice(0, MAX_TEXT);
  const fileInput = Array.isArray(input.files) ? input.files : [];
  if (fileInput.length > MAX_FILES) throw new HttpError(400, `Up to ${MAX_FILES} files in one note`);
  if (!text && !fileInput.length) throw new HttpError(400, 'Write a note or attach a file');

  const files = [];
  for (const f of fileInput) {
    const data = Buffer.from(String(f?.data || ''), 'base64');
    if (!data.length) throw new HttpError(400, 'A file is empty');
    if (data.length > MAX_FILE_BYTES) throw new HttpError(413, `${String(f.name || 'A file').slice(0, 80)} is larger than 10 MB`);
    const id = `note-${crypto.randomUUID()}`;
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(f.type || '')) ? String(f.type) : 'application/octet-stream';
    await persistence().putFile(id, type, data);
    files.push({ id, name: String(f.name || 'file').replace(/[\r\n"\\/]/g, '_').slice(0, 200), type, size: data.length });
  }

  const note = { id: crypto.randomUUID(), from: me, to, text, files, at: new Date().toISOString(), readAt: null };
  notes().push(note);
  // Oldest notes go first once there are too many; their files go with them.
  for (const old of notes().splice(0, Math.max(0, notes().length - KEEP))) {
    for (const f of old.files || []) persistence().deleteFile(f.id).catch(() => {});
  }
  save();
  const sender = teammates().find((p) => p.address === me);
  // At once to the recipient, and to the sender's other open windows.
  noteEvents.emit('note', [to, me], { ...noteView(note), fromName: sender?.name || '' });
  return noteView(note);
}

/** Mark everything `other` sent to `me` as read; tells both sides. Returns how many changed. */
export function markNotesRead(me, other) {
  const from = normalize(other);
  const now = new Date().toISOString();
  let changed = 0;
  for (const n of notes()) {
    if (n.from === from && n.to === me && !n.readAt) {
      n.readAt = now;
      changed++;
    }
  }
  if (changed) {
    save();
    noteEvents.emit('note-read', [me, from], { by: me, with: from });
  }
  return changed;
}
