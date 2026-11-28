// Instant notes: quick private messages between teammates, with files, one to one or in groups.
// Sent and received over the live WebSocket (live.js), or the plain API (routes/notes.js) where
// sockets are blocked; both use these functions. They never leave Nextspace: nothing is emailed.
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
const MAX_GROUP = 50; // people in one group
const MAX_GROUP_NAME = 60;
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '✅'];

export const notes = () => (db().instantNotes ||= []);
export const groups = () => (db().noteGroups ||= []);
/** One-to-one notes between two people (group notes have no `to`). */
export const between = (a, b) => (n) => !n.group && ((n.from === a && n.to === b) || (n.from === b && n.to === a));
export const inGroup = (id) => (n) => n.group === id;

export const noteView = (n) => ({
  id: n.id,
  from: n.from,
  to: n.to || null,
  group: n.group || null,
  text: n.deleted ? '' : n.text,
  at: n.at,
  deleted: Boolean(n.deleted),
  replyTo: n.replyTo || null,
  reactions: n.deleted ? {} : n.reactions || {},
  // One to one: read by the other person. In a group: who has read it (not the sender).
  read: n.group ? (n.readBy || []).length > 0 : Boolean(n.readAt),
  ...(n.group && { readBy: n.readBy || [] }),
  files: n.deleted ? [] : (n.files || []).map(({ id, name, type, size }) => ({ id, name, type, size })),
});

/** Who can see a note: the two people it's between, or the group's members. */
const audience = (n) => (n.group ? groups().find((g) => g.id === n.group)?.members || [] : [n.from, n.to]);

/** A note `me` can see, or a 404. */
function visibleNote(me, id) {
  const note = notes().find((n) => n.id === id);
  if (!note || !audience(note).includes(me)) throw new HttpError(404, 'Note not found');
  return note;
}

/** Add or take back an emoji reaction. Everyone in the conversation sees it change. */
export function reactToNote(me, id, emoji) {
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Choose one of the reactions');
  const note = visibleNote(me, id);
  if (note.deleted) throw new HttpError(400, 'This note was deleted');
  const reactions = (note.reactions ||= {});
  const who = reactions[emoji] || [];
  reactions[emoji] = who.includes(me) ? who.filter((a) => a !== me) : [...who, me];
  if (!reactions[emoji].length) delete reactions[emoji];
  save();
  noteEvents.emit('note-update', audience(note), noteView(note));
  return noteView(note);
}

/** Delete one of my own notes for everyone: its text and files go; a "deleted" marker stays. */
export function deleteNote(me, id) {
  const note = visibleNote(me, id);
  if (note.from !== me) throw new HttpError(403, 'You can only delete your own notes');
  if (!note.deleted) {
    for (const f of note.files || []) persistence().deleteFile(f.id).catch(() => {});
    note.deleted = true;
    note.text = '';
    note.files = [];
    note.reactions = {};
    save();
    noteEvents.emit('note-update', audience(note), noteView(note));
  }
  return noteView(note);
}

export const groupView = (g) => ({ id: g.id, name: g.name, members: g.members, createdBy: g.createdBy, createdAt: g.createdAt });

/** A group `me` belongs to, or a 404 (also for groups that aren't theirs). */
export function groupFor(me, id) {
  const group = groups().find((g) => g.id === id && g.members.includes(me));
  if (!group) throw new HttpError(404, 'Group not found');
  return group;
}

/** Teammates' addresses from a list, without `me`; refuses anyone who isn't on the team. */
function teamMembers(me, list) {
  const team = new Set(teammates().map((p) => p.address));
  const wanted = [...new Set((Array.isArray(list) ? list : []).map(normalize).filter(Boolean))].filter((a) => a !== me);
  const stranger = wanted.find((a) => !team.has(a));
  if (stranger) throw new HttpError(400, `${stranger} isn’t on your team`);
  return wanted;
}

const groupName = (value) => {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
  if (!name) throw new HttpError(400, 'Give the group a name');
  return name;
};

/** A new group: { name, members } (the creator is added). At least 2 other people. */
export function createGroup(me, input = {}) {
  const others = teamMembers(me, input.members);
  if (others.length < 2) throw new HttpError(400, 'Choose at least 2 people. For one person, write to them directly.');
  if (others.length + 1 > MAX_GROUP) throw new HttpError(400, `Up to ${MAX_GROUP} people in a group`);
  const group = { id: crypto.randomUUID(), name: groupName(input.name), members: [me, ...others], createdBy: me, createdAt: new Date().toISOString() };
  groups().push(group);
  save();
  noteEvents.emit('group', group.members, { group: groupView(group), change: 'created', by: me });
  return groupView(group);
}

/** Rename, or add people (any member); remove people (only whoever made the group). */
export function updateGroup(me, id, input = {}) {
  const group = groupFor(me, id);
  if ('name' in input) group.name = groupName(input.name);
  if (Array.isArray(input.members)) {
    const next = [me, ...teamMembers(me, input.members)];
    const removed = group.members.filter((a) => !next.includes(a));
    if (removed.length && group.createdBy !== me) throw new HttpError(403, 'Only the person who made the group can remove people');
    if (next.length - 1 < 2) throw new HttpError(400, 'A group needs at least 3 people');
    if (next.length > MAX_GROUP) throw new HttpError(400, `Up to ${MAX_GROUP} people in a group`);
    const everyone = [...new Set([...group.members, ...next])];
    group.members = next;
    save();
    noteEvents.emit('group', everyone, { group: groupView(group), change: 'members', by: me });
    return groupView(group);
  }
  save();
  noteEvents.emit('group', group.members, { group: groupView(group), change: 'renamed', by: me });
  return groupView(group);
}

/** Leave a group. The last person out deletes it, with its notes and files. */
export function leaveGroup(me, id) {
  const group = groupFor(me, id);
  const before = [...group.members];
  group.members = group.members.filter((a) => a !== me);
  if (!group.members.length) {
    db().noteGroups = groups().filter((g) => g !== group);
    for (const n of notes().filter(inGroup(group.id))) for (const f of n.files || []) persistence().deleteFile(f.id).catch(() => {});
    db().instantNotes = notes().filter((n) => n.group !== group.id);
  }
  save();
  noteEvents.emit('group', before, { group: groupView(group), change: 'left', by: me });
}

/** Unread for `me` in a group: notes from others they haven't read. */
export const groupUnread = (me, id) => notes().filter((n) => n.group === id && n.from !== me && !(n.readBy || []).includes(me)).length;

/**
 * Send a note from `me`: { to | group, text, files: [{ name, type, data (base64) }] }.
 * Returns its view.
 */
export async function createNote(me, input = {}) {
  let to = null;
  let group = null;
  if (input.group) {
    group = groupFor(me, String(input.group));
  } else {
    to = normalize(input.to);
    if (to === me || !teammates().some((p) => p.address === to)) throw new HttpError(400, 'Choose someone from your team');
  }
  const text = String(input.text || '').trim().slice(0, MAX_TEXT);
  const fileInput = Array.isArray(input.files) ? input.files : [];
  if (fileInput.length > MAX_FILES) throw new HttpError(400, `Up to ${MAX_FILES} files in one note`);
  if (!text && !fileInput.length) throw new HttpError(400, 'Write a note or attach a file');
  // A reply quotes a note from the same conversation, kept short so the quote stays readable.
  let replyTo = null;
  if (input.replyTo) {
    const quoted = notes().find((n) => n.id === String(input.replyTo));
    const same = quoted && (group ? quoted.group === group.id : between(me, to)(quoted));
    if (!same || quoted.deleted) throw new HttpError(400, 'That note can’t be replied to');
    const quotedText = quoted.text || (quoted.files?.length ? `Attachment: ${quoted.files.map((f) => f.name).join(', ')}` : '');
    replyTo = { id: quoted.id, from: quoted.from, text: quotedText.slice(0, 160) };
  }

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

  const note = group
    ? { id: crypto.randomUUID(), from: me, group: group.id, text, files, at: new Date().toISOString(), readBy: [], ...(replyTo && { replyTo }) }
    : { id: crypto.randomUUID(), from: me, to, text, files, at: new Date().toISOString(), readAt: null, ...(replyTo && { replyTo }) };
  notes().push(note);
  // Oldest notes go first once there are too many; their files go with them.
  for (const old of notes().splice(0, Math.max(0, notes().length - KEEP))) {
    for (const f of old.files || []) persistence().deleteFile(f.id).catch(() => {});
  }
  save();
  const sender = teammates().find((p) => p.address === me);
  // At once to the recipient(s), and to the sender's other open windows.
  noteEvents.emit('note', group ? [...group.members] : [to, me], {
    ...noteView(note),
    fromName: sender?.name || '',
    ...(group && { groupName: group.name }),
  });
  return noteView(note);
}

/** Mark everything `other` sent to `me` as read; tells both sides. Returns how many changed. */
export function markNotesRead(me, other) {
  const from = normalize(other);
  const now = new Date().toISOString();
  let changed = 0;
  for (const n of notes()) {
    if (!n.group && n.from === from && n.to === me && !n.readAt) {
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

/** Mark a group's notes as read by `me`; tells the group (for "Seen by"). Returns how many changed. */
export function markGroupRead(me, id) {
  const group = groupFor(me, id);
  let changed = 0;
  for (const n of notes()) {
    if (n.group === group.id && n.from !== me && !(n.readBy ||= []).includes(me)) {
      n.readBy.push(me);
      changed++;
    }
  }
  if (changed) {
    save();
    noteEvents.emit('note-read', [...group.members], { by: me, group: group.id });
  }
  return changed;
}
