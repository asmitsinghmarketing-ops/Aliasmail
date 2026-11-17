// Attendance is explicit: a person clocks in and out. While clocked in, the browser sends a
// small heartbeat (no location, screenshots, files or activity contents) so the app can show
// Online, Away, or Offline. A powered-off/sleeping laptop simply stops sending heartbeats.
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { db, save } from '../store.js';
import { personOf, teammates } from '../team.js';

const router = Router();
router.use(requireAuth());

export const OFFLINE_AFTER_MS = 90_000;
const KEEP_MS = 366 * 24 * 3600_000;

function store() {
  const attendance = (db().attendance ||= {});
  attendance.sessions ||= [];
  return attendance;
}

const openFor = (person) => [...store().sessions].reverse().find((session) => session.person === person && !session.clockOutAt) || null;

export function attendanceStatus(session, now = Date.now()) {
  if (!session || session.clockOutAt) return 'clocked-out';
  if (now - Date.parse(session.lastSeenAt || session.clockInAt) > OFFLINE_AFTER_MS) return 'offline';
  return session.presence === 'away' ? 'away' : 'online';
}

const view = (session, now = Date.now()) => session ? {
  id: session.id,
  person: session.person,
  clockInAt: session.clockInAt,
  clockOutAt: session.clockOutAt || null,
  lastSeenAt: session.lastSeenAt,
  lastActiveAt: session.lastActiveAt,
  status: attendanceStatus(session, now),
} : null;

const displayName = (address) => teammates().find((person) => person.address === address)?.name || address;

router.get('/status', (req, res) => {
  const person = personOf(req.user);
  const current = openFor(person);
  res.json({ clockedIn: Boolean(current), current: view(current) });
});

router.get('/', (req, res) => {
  const me = personOf(req.user);
  const admin = req.user.role === 'admin';
  const now = Date.now();
  const sessions = store().sessions
    .filter((session) => admin || session.person === me)
    .sort((a, b) => b.clockInAt.localeCompare(a.clockInAt))
    .slice(0, admin ? 1000 : 180)
    .map((session) => ({ ...view(session, now), name: displayName(session.person) }));
  const team = admin ? teammates().map((person) => {
    const current = openFor(person.address);
    return { ...person, current: view(current, now), status: attendanceStatus(current, now) };
  }) : [];
  const current = view(openFor(me), now);
  res.json({ me, isAdmin: admin, current, status: attendanceStatus(current, now), sessions, team });
});

router.post('/clock-in', (req, res) => {
  const person = personOf(req.user);
  const existing = openFor(person);
  if (existing) return res.json(view(existing));
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(), person, clockInAt: now, clockOutAt: null,
    lastSeenAt: now, lastActiveAt: now, presence: 'active',
  };
  const attendance = store();
  attendance.sessions.push(session);
  const oldest = Date.now() - KEEP_MS;
  attendance.sessions = attendance.sessions.filter((item) => !item.clockOutAt || Date.parse(item.clockOutAt) >= oldest);
  save();
  res.status(201).json(view(session));
});

router.post('/clock-out', (req, res) => {
  const person = personOf(req.user);
  const session = openFor(person);
  if (!session) throw new HttpError(409, 'You are not clocked in');
  const now = new Date().toISOString();
  session.lastSeenAt = now;
  session.clockOutAt = now;
  session.presence = 'away';
  save();
  res.json(view(session));
});

router.post('/heartbeat', (req, res) => {
  const person = personOf(req.user);
  const session = openFor(person);
  if (!session) throw new HttpError(409, 'You are not clocked in');
  const now = new Date().toISOString();
  const active = req.body?.active === true;
  session.lastSeenAt = now;
  session.presence = active ? 'active' : 'away';
  if (active) session.lastActiveAt = now;
  save();
  res.json(view(session));
});

export default router;
