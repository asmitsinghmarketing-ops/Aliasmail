// Instant notes over plain HTTP: the list of conversations (teammates and groups), a
// conversation's history, files, groups, and sending/reading where the live WebSocket (live.js)
// isn't available.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { persistence } from '../persist.js';
import { personOf, teammates } from '../team.js';
import { normalize } from '../aliases.js';
import {
  between, createGroup, createNote, groupFor, groupUnread, groups, groupView, inGroup, leaveGroup, markGroupRead, markNotesRead, noteView, notes, updateGroup,
} from '../instant-notes.js';
import { onlinePeople } from '../live.js';

const router = Router();
router.use(requireAuth());

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FILE_ID = /^note-[0-9a-f-]{36}$/;

const myGroups = (me) => groups().filter((g) => g.members.includes(me));

/**
 * Conversations, latest first: teammates (kind "person": last note, unread, online) and the
 * groups I'm in (kind "group": members, last note, unread).
 */
router.get('/threads', (req, res) => {
  const me = personOf(req.user);
  const all = notes();
  const online = onlinePeople();
  const team = teammates();
  const byAddress = Object.fromEntries(team.map((p) => [p.address, p]));
  const people = team
    .filter((p) => p.address !== me)
    .map((p) => {
      const mine = all.filter(between(me, p.address));
      const last = mine.at(-1);
      return { kind: 'person', ...p, online: online.has(p.address), last: last ? noteView(last) : null, unread: mine.filter((n) => n.to === me && !n.readAt).length };
    });
  const rooms = myGroups(me).map((g) => {
    const last = all.filter(inGroup(g.id)).at(-1);
    return {
      kind: 'group',
      ...groupView(g),
      members: g.members.map((a) => ({ ...(byAddress[a] || { address: a, name: '' }), online: online.has(a) })),
      last: last ? noteView(last) : null,
      unread: groupUnread(me, g.id),
    };
  });
  res.json([...rooms, ...people].sort((a, b) => (b.last?.at || b.createdAt || '').localeCompare(a.last?.at || a.createdAt || '')));
});

/** Unread notes in all, for the badge, and which address is "me". Only from people listed in
 * the panel: a note from someone no longer on the team could never be opened and read. */
router.get('/unread', (req, res) => {
  const me = personOf(req.user);
  const team = new Set(teammates().map((p) => p.address));
  const direct = notes().filter((n) => !n.group && n.to === me && !n.readAt && team.has(n.from)).length;
  const inGroups = myGroups(me).reduce((sum, g) => sum + groupUnread(me, g.id), 0);
  res.json({ me, unread: direct + inGroups });
});

/** The notes with one teammate (?with=) or in a group (?group=), the latest 200, oldest first. */
router.get('/', (req, res) => {
  const me = personOf(req.user);
  if (req.query.group) {
    const group = groupFor(me, String(req.query.group));
    return res.json(notes().filter(inGroup(group.id)).slice(-200).map(noteView));
  }
  const other = normalize(req.query.with);
  res.json(notes().filter(between(me, other)).slice(-200).map(noteView));
});

/** Send a note: { to | group, text, files: [{ name, type, data (base64) }] }. */
router.post('/', async (req, res) => {
  res.status(201).json(await createNote(personOf(req.user), req.body ?? {}));
});

/** Mark notes as read: from a teammate ({ with }) or in a group ({ group }). */
router.post('/read', (req, res) => {
  const me = personOf(req.user);
  const changed = req.body?.group ? markGroupRead(me, String(req.body.group)) : markNotesRead(me, req.body?.with);
  res.json({ ok: true, changed });
});

/* ----- groups ----- */

router.post('/groups', (req, res) => {
  res.status(201).json(createGroup(personOf(req.user), req.body ?? {}));
});

/** Rename ({ name }) or change who's in it ({ members }: everyone but me). */
router.patch('/groups/:id', (req, res) => {
  res.json(updateGroup(personOf(req.user), req.params.id, req.body ?? {}));
});

router.post('/groups/:id/leave', (req, res) => {
  leaveGroup(personOf(req.user), req.params.id);
  res.json({ ok: true });
});

/** A note's file: for its sender and recipient, or the group's members. */
router.get('/files/:id', async (req, res) => {
  const me = personOf(req.user);
  if (!FILE_ID.test(req.params.id)) throw new HttpError(404, 'File not found');
  const note = notes().find((n) => (n.files || []).some((f) => f.id === req.params.id));
  const allowed = note && (note.group ? groups().some((g) => g.id === note.group && g.members.includes(me)) : note.from === me || note.to === me);
  if (!allowed) throw new HttpError(404, 'File not found');
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
