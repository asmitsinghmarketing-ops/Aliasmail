// Meetings scheduled ahead: a title, a time, the teammates invited, and a link (/join/<code>)
// anyone can be sent. Nothing happens at the start time by itself: the first teammate to open the
// link starts the meeting (routes/calls.js), and guests wait until then. Invited teammates are
// told when they're invited and reminded shortly before the start.
//
// Meetings are forgotten RECORDING_KEEP_DAYS after they were due to end, like their recordings.
import crypto from 'node:crypto';
import { Router } from 'express';
import config from '../config.js';
import { requireAuth } from '../auth.js';
import { HttpError, describeError } from '../errors.js';
import { db, save } from '../store.js';
import { personOf, teammates } from '../team.js';
import { createNotification } from '../notifications.js';
import { notify } from '../push.js';
import { isLive, MAX_PEOPLE, newCode } from './calls.js';

const router = Router();
router.use(requireAuth());

const REMIND_BEFORE_MS = 10 * 60_000;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const MAX_AHEAD_MS = 366 * 86_400_000;

const meetings = () => db().meetings;
const person = (address) => teammates().find((member) => member.address === address);
const nameOf = (address) => person(address)?.name || address;
const endOf = (meeting) => Date.parse(meeting.startAt) + meeting.durationMin * 60_000;
const isAdmin = (req) => req.user.role === 'admin';
const involves = (meeting, me) => meeting.host === me || meeting.invitees.includes(me);

function view(meeting, req) {
  const me = personOf(req.user);
  return {
    id: meeting.id,
    code: meeting.code,
    title: meeting.title,
    description: meeting.description,
    startAt: meeting.startAt,
    endAt: new Date(endOf(meeting)).toISOString(),
    durationMin: meeting.durationMin,
    host: { address: meeting.host, name: nameOf(meeting.host) },
    invitees: meeting.invitees.map((address) => ({ address, name: nameOf(address) })),
    mine: meeting.host === me,
    canEdit: meeting.host === me || isAdmin(req),
    live: isLive(meeting.code),
  };
}

/** Title, time, length, invitees and note from a request, checked. */
function details(body, me, { timeChanged = true } = {}) {
  const title = String(body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Meeting';
  const start = Date.parse(body?.startAt);
  if (!Number.isFinite(start)) throw new HttpError(400, 'Choose a date and time');
  if (timeChanged && start < Date.now() - 5 * 60_000) throw new HttpError(400, 'Choose a time in the future');
  if (start > Date.now() + MAX_AHEAD_MS) throw new HttpError(400, 'Meetings can be scheduled up to a year ahead');
  const durationMin = Number(body?.durationMin);
  if (!DURATIONS.includes(durationMin)) throw new HttpError(400, 'Choose how long the meeting is');
  const list = Array.isArray(body?.invitees) ? body.invitees : [];
  const invitees = [...new Set(list.map((address) => String(address || '').trim().toLowerCase()))].filter((address) => address && address !== me);
  if (invitees.some((address) => !person(address))) throw new HttpError(400, 'Invite people from your team (send the link to anyone else)');
  if (invitees.length + 1 > MAX_PEOPLE) throw new HttpError(400, `A meeting can have up to ${MAX_PEOPLE} people`);
  const description = String(body?.description || '').trim().slice(0, 2000);
  return { title, startAt: new Date(start).toISOString(), durationMin, invitees, description };
}

function tell(addresses, meeting, title, body) {
  for (const address of addresses) {
    createNotification({ to: address, type: 'meeting', title, body, actor: meeting.host });
    void notify(address, 'calls', { kind: 'meeting', title, body, url: `/join/${meeting.code}`, tag: `meeting-${meeting.id}` });
  }
}

const own = (req) => {
  const meeting = meetings().find((item) => item.id === req.params.id);
  if (!meeting || !(involves(meeting, personOf(req.user)) || isAdmin(req))) throw new HttpError(404, 'Meeting not found');
  return meeting;
};
const editable = (req) => {
  const meeting = own(req);
  if (meeting.host !== personOf(req.user) && !isAdmin(req)) throw new HttpError(403, 'Only the person who scheduled it can change it');
  return meeting;
};

// Reminders shortly before the start; meetings long past are forgotten.
setInterval(() => {
  try {
    const now = Date.now();
    let changed = false;
    for (const meeting of meetings()) {
      const start = Date.parse(meeting.startAt);
      if (!meeting.remindedAt && start - now <= REMIND_BEFORE_MS && start - now > -5 * 60_000) {
        meeting.remindedAt = new Date().toISOString();
        changed = true;
        const minutes = Math.max(0, Math.round((start - now) / 60_000));
        tell([meeting.host, ...meeting.invitees], meeting, `${meeting.title} ${minutes ? `starts in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'is starting'}`, 'Open the reminder to join.');
      }
    }
    const forgetBefore = now - config.calls.recordingKeepDays * 86_400_000;
    const kept = meetings().filter((meeting) => endOf(meeting) >= forgetBefore);
    if (kept.length !== meetings().length) {
      db().meetings = kept;
      changed = true;
    }
    if (changed) save();
  } catch (err) {
    console.warn('[meetings] reminders failed:', describeError(err));
  }
}, 30_000).unref?.();

/** Meetings this person organises or is invited to (the admin sees all). */
router.get('/', (req, res) => {
  const me = personOf(req.user);
  const items = meetings()
    .filter((meeting) => isAdmin(req) || involves(meeting, me))
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((meeting) => view(meeting, req));
  res.json({ items });
});

router.post('/', (req, res) => {
  const me = personOf(req.user);
  const meeting = { id: crypto.randomUUID(), code: newCode(), host: me, createdAt: new Date().toISOString(), remindedAt: null, ...details(req.body, me) };
  meetings().push(meeting);
  save();
  tell(meeting.invitees, meeting, `${nameOf(me)} invited you to “${meeting.title}”`, 'See the time and join from Meetings.');
  res.status(201).json(view(meeting, req));
});

router.patch('/:id', (req, res) => {
  const meeting = editable(req);
  const before = new Set(meeting.invitees);
  const moved = meeting.startAt;
  const timeChanged = req.body?.startAt !== undefined && Date.parse(req.body.startAt) !== Date.parse(moved);
  Object.assign(meeting, details({ ...view(meeting, req), invitees: meeting.invitees, ...req.body }, meeting.host, { timeChanged }));
  if (meeting.startAt !== moved) meeting.remindedAt = null;
  save();
  const added = meeting.invitees.filter((address) => !before.has(address));
  const kept = meeting.invitees.filter((address) => before.has(address));
  if (added.length) tell(added, meeting, `${nameOf(meeting.host)} invited you to “${meeting.title}”`, 'See the time and join from Meetings.');
  if (kept.length && meeting.startAt !== moved) tell(kept, meeting, `“${meeting.title}” has a new time`, 'See the new time in Meetings.');
  res.json(view(meeting, req));
});

router.delete('/:id', (req, res) => {
  const meeting = editable(req);
  db().meetings = meetings().filter((item) => item !== meeting);
  save();
  if (endOf(meeting) > Date.now()) {
    for (const address of meeting.invitees) createNotification({ to: address, type: 'meeting', title: `“${meeting.title}” was cancelled`, body: `${nameOf(meeting.host)} cancelled the meeting.`, actor: meeting.host });
  }
  res.json({ ok: true });
});

export default router;
