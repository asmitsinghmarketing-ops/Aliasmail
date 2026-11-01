// Instant notes: quick private messages between teammates, with files. Each one is pushed at once
// to the recipient over the live connection every open Nextspace keeps (/api/mail/events).
// They never leave Nextspace: nothing is sent by email.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, save } from '../store.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { persistence } from '../persist.js';
import { noteEvents } from '../mail-events.js';
import { personOf, teammates } from '../team.js';
import { normalize } from '../aliases.js';

const router = Router();
router.use(requireAuth());

const MAX_TEXT = 4000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KEEP = 10_000; // notes kept in all; the oldest go first
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FILE_ID = /^note-[0-9a-f-]{36}$/;

const notes = () => (db().instantNotes ||= []);
const between = (a, b) => (n) => (n.from === a && n.to === b) || (n.from === b && n.to === a);
const view = (n) => ({
  id: n.id,
  from: n.from,
  to: n.to,
  text: n.text,
  at: n.at,
  read: Boolean(n.readAt),
  files: (n.files || []).map(({ id, name, type, size }) => ({ id, name, type, size })),
});

/** Teammates to write to, each with the last note exchanged and how many from them are unread. */
router.get('/threads', (req, res) => {
  const me = personOf(req.user);
  const all = notes();
  res.json(teammates()
    .filter((p) => p.address !== me)
    .map((p) => {
      const mine = all.filter(between(me, p.address));
      const last = mine.at(-1);
      return { ...p, last: last ? view(last) : null, unread: mine.filter((n) => n.to === me && !n.readAt).length };
    })
    .sort((a, b) => (b.last?.at || '').localeCompare(a.last?.at || '')));
});

/** Unread notes in all, for the badge, and which address is "me". */
router.get('/unread', (req, res) => {
  const me = personOf(req.user);
  res.json({ me, unread: notes().filter((n) => n.to === me && !n.readAt).length });
});

/** The notes exchanged with one teammate (the latest 200), oldest first. */
router.get('/', (req, res) => {
  const me = personOf(req.user);
  const other = normalize(req.query.with);
  res.json(notes().filter(between(me, other)).slice(-200).map(view));
});

/** Send a note: { to, text, files: [{ name, type, data (base64) }] }. */
router.post('/', async (req, res) => {
  const me = personOf(req.user);
  const to = normalize(req.body?.to);
  if (to === me || !teammates().some((p) => p.address === to)) throw new HttpError(400, 'Choose someone from your team');
  const text = String(req.body?.text || '').trim().slice(0, MAX_TEXT);
  const input = Array.isArray(req.body?.files) ? req.body.files : [];
  if (input.length > MAX_FILES) throw new HttpError(400, `Up to ${MAX_FILES} files in one note`);
  if (!text && !input.length) throw new HttpError(400, 'Write a note or attach a file');

  const files = [];
  for (const f of input) {
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
  // At once to the recipient (and the sender's other open windows).
  noteEvents.emit('note', [to, me], { ...view(note), fromName: sender?.name || '' });
  res.status(201).json(view(note));
});

/** Mark everything a teammate sent me as read. */
router.post('/read', (req, res) => {
  const me = personOf(req.user);
  const other = normalize(req.body?.with);
  const now = new Date().toISOString();
  let changed = 0;
  for (const n of notes()) {
    if (n.from === other && n.to === me && !n.readAt) {
      n.readAt = now;
      changed++;
    }
  }
  if (changed) {
    save();
    noteEvents.emit('note-read', [me, other], { by: me, with: other });
  }
  res.json({ ok: true, changed });
});

/** A note's file, for its sender and recipient only. */
router.get('/files/:id', async (req, res) => {
  const me = personOf(req.user);
  if (!FILE_ID.test(req.params.id)) throw new HttpError(404, 'File not found');
  const note = notes().find((n) => (n.files || []).some((f) => f.id === req.params.id));
  if (!note || (note.from !== me && note.to !== me)) throw new HttpError(404, 'File not found');
  const meta = note.files.find((f) => f.id === req.params.id);
  const stored = await persistence().getFile(meta.id);
  if (!stored) throw new HttpError(404, 'This file is no longer available');
  const inline = INLINE.has(meta.type) && !req.query.download;
  res.set({
    'Content-Type': meta.type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'",
    'Cache-Control': 'private, max-age=3600',
  });
  res.send(stored.data);
});

export default router;
