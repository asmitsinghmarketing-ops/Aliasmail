// Instant calls started from a one-to-one Instant Notes conversation. Google Meet carries the
// audio/video; this route securely rings the teammate in their open windows and by Web Push.
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { personOf, teammates } from '../team.js';
import { callEvents } from '../mail-events.js';
import { notify } from '../push.js';

const router = Router();
router.use(requireAuth());

const calls = new Map();
const CALL_MS = 60_000;
const clean = () => {
  const oldest = Date.now() - 5 * 60_000;
  for (const [id, call] of calls) if (Date.parse(call.createdAt) < oldest) calls.delete(id);
};
const person = (address) => teammates().find((member) => member.address === address);
const publicCall = (call) => ({ id: call.id, from: call.from, fromName: call.fromName, to: call.to, link: call.link, createdAt: call.createdAt, expiresAt: call.expiresAt, status: call.status });

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
    expiresAt: new Date(Date.now() + CALL_MS).toISOString(), status: 'ringing',
  };
  calls.set(call.id, call);
  callEvents.emit('call', to, publicCall(call));
  void notify(to, 'calls', {
    kind: 'call', title: `Incoming call from ${call.fromName}`, body: 'Open Nextspace to answer the call.',
    url: `/?call=${encodeURIComponent(call.id)}`, tag: `call-${call.id}`,
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

router.post('/:id/respond', (req, res) => {
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || call.to !== me) throw new HttpError(404, 'Call not found or has ended');
  if (call.status !== 'ringing' || Date.parse(call.expiresAt) < Date.now()) throw new HttpError(409, 'This call has already ended');
  call.status = req.body?.answer === 'accept' ? 'accepted' : 'declined';
  callEvents.emit('response', call.from, { id: call.id, status: call.status, by: me });
  res.json(publicCall(call));
});

router.post('/:id/cancel', (req, res) => {
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || call.from !== me) throw new HttpError(404, 'Call not found');
  if (call.status === 'ringing') {
    call.status = 'cancelled';
    callEvents.emit('ended', call.to, { id: call.id, status: call.status });
  }
  res.json({ ok: true });
});

export default router;
