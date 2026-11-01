// Instant notes over plain HTTP: the list of teammates, a conversation's history, files, and
// sending/reading where the live WebSocket (live.js) isn't available.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { persistence } from '../persist.js';
import { personOf, teammates } from '../team.js';
import { normalize } from '../aliases.js';
import { between, createNote, markNotesRead, noteView, notes } from '../instant-notes.js';
import { onlinePeople } from '../live.js';

const router = Router();
router.use(requireAuth());

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FILE_ID = /^note-[0-9a-f-]{36}$/;

/** Teammates to write to, each with the last note exchanged, unread count and whether they're online. */
router.get('/threads', (req, res) => {
  const me = personOf(req.user);
  const all = notes();
  const online = onlinePeople();
  res.json(teammates()
    .filter((p) => p.address !== me)
    .map((p) => {
      const mine = all.filter(between(me, p.address));
      const last = mine.at(-1);
      return { ...p, online: online.has(p.address), last: last ? noteView(last) : null, unread: mine.filter((n) => n.to === me && !n.readAt).length };
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
  res.json(notes().filter(between(me, other)).slice(-200).map(noteView));
});

/** Send a note: { to, text, files: [{ name, type, data (base64) }] }. */
router.post('/', async (req, res) => {
  res.status(201).json(await createNote(personOf(req.user), req.body ?? {}));
});

/** Mark everything a teammate sent me as read. */
router.post('/read', (req, res) => {
  res.json({ ok: true, changed: markNotesRead(personOf(req.user), req.body?.with) });
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
