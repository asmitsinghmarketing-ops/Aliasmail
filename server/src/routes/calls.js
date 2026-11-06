// Instant calls started from a one-to-one Instant Notes conversation. Google Meet carries the
// audio/video; this route securely rings the teammate in their open windows and by Web Push.
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { personOf, teammates } from '../team.js';
import { callEvents } from '../mail-events.js';
import { notify } from '../push.js';
import { deleteMeeting } from '../google-meet.js';

const router = Router();
router.use(requireAuth());

const calls = new Map();
const CALL_MS = 60_000;
const clean = () => {
  const oldest = Date.now() - 5 * 60_000;
  for (const [id, call] of calls) if (Date.parse(call.createdAt) < oldest) {
    clearTimeout(call.timer);
    calls.delete(id);
  }
};
const person = (address) => teammates().find((member) => member.address === address);
const publicCall = (call) => ({ id: call.id, from: call.from, fromName: call.fromName, to: call.to, link: call.link, createdAt: call.createdAt, expiresAt: call.expiresAt, status: call.status });
const meetingId = (value) => {
  const id = String(value || '');
  if (id && !/^[A-Za-z0-9_-]{1,300}$/.test(id)) throw new HttpError(400, 'Invalid meeting event');
  return id;
};
const cancelMeeting = async (call) => {
  if (!call.meetingId || call.meetingCancelled) return;
  try {
    await deleteMeeting(call.ownerRole, call.ownerEmail, call.meetingId);
    call.meetingCancelled = true;
  } catch (err) {
    console.warn(`[calls] couldn’t cancel meeting ${call.id}: ${err.message}`);
  }
};

function meetLink(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new HttpError(400, 'Invalid meeting link'); }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com') throw new HttpError(400, 'Calls require a Google Meet link');
  return url.href.slice(0, 500);
}

router.post('/', async (req, res) => {
  clean();
  const from = personOf(req.user);
  const to = String(req.body?.to || '').trim().toLowerCase();
  const recipient = person(to);
  if (!recipient || to === from) throw new HttpError(400, 'Choose another active teammate');
  const sender = person(from);
  const createdAt = new Date().toISOString();
  const call = {
    id: crypto.randomUUID(), from, fromName: sender?.name || from, to, link: meetLink(req.body?.link), createdAt,
    expiresAt: new Date(Date.now() + CALL_MS).toISOString(), status: 'ringing', meetingId: meetingId(req.body?.meetingId),
    ownerRole: req.user.role, ownerEmail: req.user.email, meetingCancelled: false,
  };
  calls.set(call.id, call);
  call.timer = setTimeout(async () => {
    if (call.status !== 'ringing') return;
    call.status = 'missed';
    callEvents.emit('response', call.from, { id: call.id, status: call.status, by: call.to });
    callEvents.emit('ended', call.to, { id: call.id, status: call.status });
    await cancelMeeting(call);
  }, CALL_MS);
  call.timer.unref?.();
  callEvents.emit('call', to, publicCall(call));
  void notify(to, 'calls', {
    kind: 'call', title: `Incoming call from ${call.fromName}`, body: 'Open Nextspace to answer the call.',
    url: `/?call=${encodeURIComponent(call.id)}`, tag: `call-${call.id}`, callId: call.id,
  });
  res.status(201).json(publicCall(call));
});

router.get('/:id', (req, res) => {
  clean();
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || (call.from !== me && call.to !== me)) throw new HttpError(404, 'Call not found or has ended');
  if (Date.parse(call.expiresAt) < Date.now() && call.status === 'ringing') call.status = 'missed';
  res.json(publicCall(call));
});

router.post('/:id/respond', async (req, res) => {
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || call.to !== me) throw new HttpError(404, 'Call not found or has ended');
  if (call.status !== 'ringing' || Date.parse(call.expiresAt) < Date.now()) throw new HttpError(409, 'This call has already ended');
  clearTimeout(call.timer);
  call.status = req.body?.answer === 'accept' ? 'accepted' : 'declined';
  callEvents.emit('response', call.from, { id: call.id, status: call.status, by: me });
  // Stop this call ringing in every other open window/device belonging to the recipient.
  callEvents.emit('ended', call.to, { id: call.id, status: call.status });
  if (call.status === 'declined') await cancelMeeting(call);
  res.json(publicCall(call));
});

router.post('/:id/cancel', async (req, res) => {
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || call.from !== me) throw new HttpError(404, 'Call not found');
  if (call.status === 'ringing') {
    clearTimeout(call.timer);
    call.status = 'cancelled';
    callEvents.emit('ended', call.to, { id: call.id, status: call.status });
    await cancelMeeting(call);
  }
  res.json({ ok: true });
});

export default router;
