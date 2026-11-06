// Team calls inside Nextspace. Audio, video and shared screens travel directly between the people
// in a call (WebRTC); this route only rings people, keeps track of who is in the call and passes
// their connection details to each other. It never receives any audio or video.
import crypto from 'node:crypto';
import { Router } from 'express';
import config from '../config.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { personOf, teammates } from '../team.js';
import { callEvents } from '../mail-events.js';
import { createNotification } from '../notifications.js';
import { notify } from '../push.js';
import { connectionFor } from './remote-desktops.js';

const router = Router();
router.use(requireAuth());

// Everyone sends to everyone else directly, which gets heavy quickly: more than this needs a media server.
export const MAX_PEOPLE = 6;
const RING_MS = 60_000;
const PEER_TIMEOUT_MS = 45_000; // Windows check in every 15 seconds; a closed laptop drops out after this.
const KEEP_ENDED_MS = 5 * 60_000;
const MAX_SIGNAL_BYTES = 64 * 1024;

const calls = new Map();

const person = (address) => teammates().find((member) => member.address === address);
const nameOf = (address) => person(address)?.name || address;

const publicCall = (call) => ({
  id: call.id,
  from: call.from,
  fromName: call.fromName,
  video: call.video,
  status: call.status,
  reason: call.reason || null,
  createdAt: call.createdAt,
  expiresAt: call.expiresAt,
  invited: [...call.invited].map(([address, invite]) => ({ address, name: nameOf(address), status: invite.status })),
  peers: [...call.peers].map(([id, peer]) => ({
    id, address: peer.address, name: nameOf(peer.address), muted: peer.muted, camera: peer.camera, sharing: peer.sharing, hand: peer.hand,
  })),
});

/** How browsers reach each other: STUN finds a public address; TURN relays where that isn't enough. */
export function iceServersFor(who, settings = config.calls, now = Date.now()) {
  const servers = [];
  if (settings.stunUrls.length) servers.push({ urls: settings.stunUrls });
  if (settings.turnUrls.length && settings.turnSecret) {
    // Short-lived sign-in for a coturn server (use-auth-secret), so nothing lasting reaches browsers.
    const username = `${Math.floor(now / 1000) + settings.turnTtlSeconds}:${who}`;
    const credential = crypto.createHmac('sha1', settings.turnSecret).update(username).digest('base64');
    servers.push({ urls: settings.turnUrls, username, credential });
  } else if (settings.turnUrls.length && settings.turnUsername) {
    servers.push({ urls: settings.turnUrls, username: settings.turnUsername, credential: settings.turnCredential });
  }
  return servers;
}

/** Tell everyone in the call how it stands now. Windows work out what changed from this. */
function tell(call) {
  const view = publicCall(call);
  for (const address of new Set([...call.peers.values()].map((peer) => peer.address))) callEvents.emit('room', address, view);
}

function endCall(call, reason) {
  if (call.status === 'ended') return;
  call.status = 'ended';
  call.reason = reason;
  call.endedAt = Date.now();
  for (const [address, invite] of call.invited) {
    clearTimeout(invite.timer);
    if (invite.status === 'ringing') {
      invite.status = 'missed';
      callEvents.emit('ended', address, { id: call.id, status: reason });
    }
  }
  tell(call);
  call.peers.clear();
}

/** After someone joins, leaves or doesn't answer: does the call carry on? */
function settle(call) {
  if (call.status === 'ended') return;
  const ringing = [...call.invited.values()].some((invite) => invite.status === 'ringing');
  const invites = [...call.invited.values()];
  if (!call.peers.size) return endCall(call, call.connected ? 'ended' : 'cancelled');
  if (call.peers.size === 1 && !ringing) {
    if (call.connected) return endCall(call, 'ended');
    return endCall(call, invites.some((invite) => invite.status === 'declined') ? 'declined' : 'missed');
  }
  tell(call);
}

function ring(call, addresses) {
  for (const address of addresses) {
    const invite = { status: 'ringing', timer: null };
    invite.timer = setTimeout(() => {
      if (invite.status !== 'ringing') return;
      invite.status = 'missed';
      callEvents.emit('ended', address, { id: call.id, status: 'missed' });
      createNotification({ to: address, type: 'call-missed', title: `Missed call from ${call.fromName}`, actor: call.from });
      settle(call);
    }, RING_MS);
    invite.timer.unref?.();
    call.invited.set(address, invite);
    callEvents.emit('call', address, publicCall(call));
    void notify(address, 'calls', {
      kind: 'call', title: `Incoming ${call.video ? 'video' : 'voice'} call from ${call.fromName}`, body: 'Open Nextspace to answer the call.',
      url: `/?call=${encodeURIComponent(call.id)}`, tag: `call-${call.id}`, callId: call.id,
    });
  }
}

function addPeer(call, address) {
  const id = crypto.randomUUID();
  call.peers.set(id, { address, muted: false, camera: false, sharing: false, hand: false, lastSeen: Date.now() });
  return id;
}

function people(value, me) {
  const list = (Array.isArray(value) ? value : [value]).map((address) => String(address || '').trim().toLowerCase());
  const unique = [...new Set(list)];
  if (!unique.length || unique.some((address) => !address || address === me || !person(address))) throw new HttpError(400, 'Choose another active teammate');
  return unique;
}

/** The call, if this person has anything to do with it. Others are told it doesn't exist. */
function callFor(req) {
  const call = calls.get(req.params.id);
  const me = personOf(req.user);
  if (!call || (call.from !== me && !call.invited.has(me))) throw new HttpError(404, 'Call not found or has ended');
  return { call, me };
}

/** The sender's own place in the call: a window can only speak for itself. */
function peerFor(req) {
  const { call, me } = callFor(req);
  const peerId = String(req.body?.peerId || '');
  const peer = call.peers.get(peerId);
  if (!peer || peer.address !== me) throw new HttpError(404, 'You are not in this call');
  peer.lastSeen = Date.now();
  return { call, me, peerId, peer };
}

// Windows that vanished without saying goodbye, and calls that ended a while ago.
setInterval(() => {
  const now = Date.now();
  for (const [id, call] of calls) {
    if (call.status === 'ended') {
      if (now - call.endedAt > KEEP_ENDED_MS) calls.delete(id);
      continue;
    }
    let changed = false;
    for (const [peerId, peer] of call.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        call.peers.delete(peerId);
        changed = true;
      }
    }
    if (changed) settle(call);
  }
}, 15_000).unref?.();

router.post('/', (req, res) => {
  const from = personOf(req.user);
  const to = people(req.body?.to, from);
  if (to.length + 1 > MAX_PEOPLE) throw new HttpError(400, `A call can have up to ${MAX_PEOPLE} people`);
  const call = {
    id: crypto.randomUUID(), from, fromName: nameOf(from), video: Boolean(req.body?.video), status: 'ringing', reason: null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + RING_MS).toISOString(),
    invited: new Map(), peers: new Map(), connected: false,
  };
  calls.set(call.id, call);
  const peerId = addPeer(call, from);
  ring(call, to);
  res.status(201).json({ call: publicCall(call), peerId, iceServers: iceServersFor(from) });
});

router.get('/:id', (req, res) => {
  const { call, me } = callFor(req);
  res.json({ ...publicCall(call), ringingForMe: call.status !== 'ended' && call.invited.get(me)?.status === 'ringing' });
});

router.post('/:id/join', (req, res) => {
  const { call, me } = callFor(req);
  if (call.status === 'ended') throw new HttpError(409, 'This call has already ended');
  if (call.peers.size >= MAX_PEOPLE) throw new HttpError(409, `This call is full (${MAX_PEOPLE} people)`);
  const invite = call.invited.get(me);
  if (invite) {
    clearTimeout(invite.timer);
    invite.status = 'joined';
  }
  const peerId = addPeer(call, me);
  call.status = 'active';
  call.connected = true;
  // Stops it ringing in this person's other windows and devices.
  callEvents.emit('ended', me, { id: call.id, status: 'accepted' });
  tell(call);
  res.json({ call: publicCall(call), peerId, iceServers: iceServersFor(me) });
});

router.post('/:id/respond', (req, res) => {
  const { call, me } = callFor(req);
  const invite = call.invited.get(me);
  if (!invite || invite.status !== 'ringing' || call.status === 'ended') throw new HttpError(409, 'This call has already ended');
  clearTimeout(invite.timer);
  invite.status = 'declined';
  callEvents.emit('ended', me, { id: call.id, status: 'declined' });
  settle(call);
  res.json(publicCall(call));
});

router.post('/:id/leave', (req, res) => {
  const { call, me, peerId } = peerFor(req);
  call.peers.delete(peerId);
  const invite = call.invited.get(me);
  if (invite && ![...call.peers.values()].some((peer) => peer.address === me)) invite.status = 'left';
  settle(call);
  res.json({ ok: true });
});

router.post('/:id/invite', (req, res) => {
  const { call, me } = peerFor(req);
  const to = people(req.body?.to, me).filter((address) => ![...call.peers.values()].some((peer) => peer.address === address) && call.invited.get(address)?.status !== 'ringing');
  const ringing = [...call.invited.values()].filter((invite) => invite.status === 'ringing').length;
  if (call.peers.size + ringing + to.length > MAX_PEOPLE) throw new HttpError(400, `A call can have up to ${MAX_PEOPLE} people`);
  ring(call, to);
  tell(call);
  res.json(publicCall(call));
});

/** Muted, camera on, sharing, hand raised. Also the regular "still here" from each window. */
router.post('/:id/state', (req, res) => {
  const { call, peer } = peerFor(req);
  let changed = false;
  for (const key of ['muted', 'camera', 'sharing', 'hand']) {
    if (typeof req.body?.[key] === 'boolean' && peer[key] !== req.body[key]) {
      peer[key] = req.body[key];
      changed = true;
    }
  }
  if (changed) tell(call);
  res.json(publicCall(call));
});

/** Connection details for one other window in the same call, passed on without being read. */
router.post('/:id/signal', (req, res) => {
  const { call, peerId } = peerFor(req);
  const to = call.peers.get(String(req.body?.to || ''));
  if (!to) throw new HttpError(404, 'They have left the call');
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || JSON.stringify(data).length > MAX_SIGNAL_BYTES) throw new HttpError(400, 'Invalid call data');
  callEvents.emit('signal', to.address, { id: call.id, from: peerId, to: String(req.body.to), data });
  res.status(204).end();
});

/** Offer one of my saved remote desktops to the others in the call. Sign-in details stay behind. */
router.post('/:id/remote-desktop', (req, res) => {
  const { call, me } = peerFor(req);
  const connection = connectionFor(me, String(req.body?.connectionId || ''));
  if (!connection) throw new HttpError(404, 'Remote desktop not found');
  const shared = { id: call.id, from: me, fromName: nameOf(me), name: connection.name, host: connection.host, port: connection.port, gateway: connection.gateway };
  for (const address of new Set([...call.peers.values()].map((peer) => peer.address))) {
    if (address !== me) callEvents.emit('desktop', address, shared);
  }
  res.status(204).end();
});

export default router;
