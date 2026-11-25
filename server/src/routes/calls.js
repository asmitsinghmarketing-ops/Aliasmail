// Team calls inside Nextspace. With Cloudflare SFU configured, this route authorizes each media
// session and proxies SDP without receiving audio or video. Without SFU it keeps the original direct
// WebRTC signaling path. It also rings people and keeps track of who is in each call.
//
// A call can also get a meeting link (/join/<code>). Teammates who open it join straight in;
// anyone else types their name and waits in a lobby until someone in the call lets them in
// (guestRouter below, which needs no account: a guest proves who they are with the private
// token they got when they knocked).
import crypto from 'node:crypto';
import { Router } from 'express';
import config from '../config.js';
import { cloudflareSfuEnabled, cloudflareSfuRequest, createCloudflareSfuSession } from '../cloudflare-sfu.js';
import { cloudflareTurnEnabled, cloudflareTurnServers } from '../cloudflare-turn.js';
import { requireAuth, safeEqual } from '../auth.js';
import { HttpError } from '../errors.js';
import { nameOf, personOf, teammate } from '../team.js';
import { callEvents } from '../mail-events.js';
import { createNotification } from '../notifications.js';
import { notify } from '../push.js';
import { clientIp, limiter, randomToken, sha256 } from '../security.js';
import { db } from '../store.js';

const router = Router();
router.use(requireAuth());

// Cloudflare SFU carries the media. Twelve keeps full-room browser bandwidth and free-tier usage
// reasonable while allowing a proper team meeting rather than the old six-person P2P ceiling.
export const MAX_PEOPLE = 12;
const RING_MS = 60_000;
// Tests shorten these so reconnect behaviour can be exercised without a minute-long test. Production
// always uses the conservative values below.
const testTiming = (name, fallback) => process.env.NODE_ENV === 'test' && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback;
const PEER_TIMEOUT_MS = testTiming('CALL_PEER_TIMEOUT_MS', 45_000); // Windows check in every 15 seconds; a closed laptop drops out after this.
const KEEP_ENDED_MS = 5 * 60_000;
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_LOBBY = 20; // people waiting to be let in at once
const LOBBY_MS = 10 * 60_000; // nobody answered: the guest is told and has to knock again
const LOBBY_GONE_MS = 45_000; // a waiting guest who closed the page
// Someone's window dropped out without leaving (a phone asleep, a lost network): the call waits this
// long for them to come back before ending for whoever is left alone in it.
const REJOIN_GRACE_MS = testTiming('CALL_REJOIN_GRACE_MS', 60_000);
const SWEEP_MS = testTiming('CALL_SWEEP_MS', 15_000);
const GUEST = 'guest:';
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const SFU_TRACKS = new Set(['audio', 'camera', 'screen']);
const SFU_SESSION = /^[a-zA-Z0-9_-]{8,160}$/;
const MAX_SDP_BYTES = 512 * 1024;

const calls = new Map();
const codes = new Map(); // meeting code -> call id

const isGuest = (address) => String(address).startsWith(GUEST);
const nameIn = (call, address) => (isGuest(address) ? call.guests.get(address.slice(GUEST.length))?.name || 'Guest' : nameOf(address));

/**
 * What windows are told about a call. Guests see the people in it by name only: not the team's
 * addresses, who else was rung, or who else is waiting outside.
 */
const publicCall = (call, { forGuest = false } = {}) => ({
  id: call.id,
  from: forGuest ? '' : call.from,
  fromName: call.fromName,
  video: call.video,
  status: call.status,
  reason: call.reason || null,
  createdAt: call.createdAt,
  expiresAt: call.expiresAt,
  code: call.code || null,
  title: call.title || null, // a scheduled meeting's name
  media: call.media,
  invited: forGuest ? [] : [...call.invited].map(([address, invite]) => ({ address, name: nameOf(address), status: invite.status })),
  peers: [...call.peers].map(([id, peer]) => ({
    id, address: forGuest && !isGuest(peer.address) ? '' : peer.address, name: nameIn(call, peer.address), guest: isGuest(peer.address),
    muted: peer.muted, camera: peer.camera, sharing: peer.sharing, hand: peer.hand, recording: peer.recording,
    reaction: reactionOf(peer),
    ...(peer.sfu?.publisher?.ready && {
      sfu: { sessionId: peer.sfu.publisher.sessionId, tracks: [...peer.sfu.publisher.tracks] },
    }),
  })),
  lobby: forGuest ? [] : [...call.guests.values()].filter((guest) => guest.status === 'waiting').map((guest) => ({ id: guest.id, name: guest.name, since: guest.since })),
});

/** How browsers reach each other: STUN finds a public address; TURN relays where that isn't enough. */
export function iceServersFor(who, settings = config.calls, now = Date.now()) {
  const servers = [];
  if (settings.stunUrls.length) servers.push({ urls: settings.stunUrls });
  if (cloudflareTurnEnabled(settings)) {
    servers.push(...cloudflareTurnServers(now));
  } else if (settings.turnUrls.length && settings.turnSecret) {
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
  const guestView = publicCall(call, { forGuest: true });
  for (const address of new Set([...call.peers.values()].map((peer) => peer.address))) {
    callEvents.emit('room', address, isGuest(address) ? guestView : view);
  }
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
  for (const guest of call.guests.values()) callEvents.emit('lobby', GUEST + guest.id, { status: 'ended' });
  call.guests.clear();
  call.peers.clear();
  call.dropped.clear();
  if (call.code) codes.delete(call.code);
}

const members = (call) => [...call.peers.values()].filter((peer) => !isGuest(peer.address));
// Timed-out windows keep their seat briefly so a busy call cannot fill up and then reject them.
const reservedSeats = (call) => call.dropped.size + [...call.guests.values()].filter((guest) => guest.status === 'away').length;
const seats = (call) => call.peers.size + reservedSeats(call);

/** Someone dropped out a moment ago and may well be back: don't end the call on them yet. */
const waitingForReturn = (call) => call.dropped.size > 0;

/** After someone joins, leaves or doesn't answer: does the call carry on? */
function settle(call) {
  if (call.status === 'ended') return;
  if (waitingForReturn(call)) return tell(call);
  // A meeting with a link stays open for whoever comes, as long as a teammate is there to let them in.
  if (call.code) {
    if (!members(call).length) return endCall(call, call.connected ? 'ended' : 'cancelled');
    return tell(call);
  }
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

function addPeer(call, address, id = crypto.randomUUID()) {
  call.peers.set(id, {
    address, muted: false, camera: false, sharing: false, hand: false, recording: false, lastSeen: Date.now(),
    sfu: { sessions: new Map(), publisher: null },
  });
  return id;
}

function people(value, me, { allowNone = false } = {}) {
  const list = (Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value]).map((address) => String(address || '').trim().toLowerCase());
  const unique = [...new Set(list)];
  if (!unique.length && allowNone) return [];
  if (!unique.length || unique.some((address) => !address || address === me || !teammate(address))) throw new HttpError(400, 'Choose another active teammate');
  return unique;
}

/** A meeting code like "kdw-qmzp-tra": easy to read out, and too many to guess. */
export function newCode() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (;;) {
    const bytes = crypto.randomBytes(10);
    const raw = [...bytes].map((b) => letters[b % 26]).join('');
    const code = `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`;
    if (!codes.has(code) && !db().meetings.some((meeting) => meeting.code === code)) return code;
  }
}

function giveLink(call, code) {
  if (!call.code) {
    call.code = code || newCode();
    codes.set(call.code, call.id);
  }
  return call.code;
}

const LINK_AFTER_END_MS = 12 * 60 * 60_000; // a scheduled meeting's link keeps working this long after it was due to end

/** A scheduled meeting whose link still works, by its code; null if none. */
export function scheduledByCode(code) {
  const value = String(code || '').toLowerCase();
  if (!CODE.test(value)) return null;
  const meeting = db().meetings.find((item) => item.code === value);
  if (!meeting) return null;
  const end = Date.parse(meeting.startAt) + meeting.durationMin * 60_000;
  return Date.now() > end + LINK_AFTER_END_MS ? null : meeting;
}

/** A call going on now under this meeting code, or null. */
function liveByCode(code) {
  const value = String(code || '').toLowerCase();
  const call = CODE.test(value) ? calls.get(codes.get(value)) : null;
  return call && call.status !== 'ended' ? call : null;
}

/** Is a scheduled meeting going on right now? (For the calendar's Join button.) */
export const isLive = (code) => Boolean(liveByCode(code));

/** An open meeting by its code. Ended or unknown codes look the same. */
function byCode(code) {
  const call = liveByCode(code);
  if (!call) throw new HttpError(404, 'This meeting has ended or the link is wrong');
  return call;
}

/** A new call with this person in it. `code` + `title` start a scheduled meeting. */
function createCall(from, { to = [], video = false, meeting = false, code = null, title = null }) {
  const call = {
    id: crypto.randomUUID(), from, fromName: nameOf(from), video: Boolean(video), status: to.length ? 'ringing' : 'active', reason: null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + RING_MS).toISOString(),
    invited: new Map(), peers: new Map(), dropped: new Map(), guests: new Map(), connected: false, code: null, title,
    media: cloudflareSfuEnabled() ? 'sfu' : 'p2p',
  };
  calls.set(call.id, call);
  if (meeting) giveLink(call, code);
  const peerId = addPeer(call, from);
  ring(call, to);
  return { call, peerId };
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

const sfuState = (peer) => {
  peer.sfu ||= { sessions: new Map(), publisher: null };
  peer.sfu.sessions ||= new Map();
  return peer.sfu;
};

const sfuDescription = (value) => {
  if (!value || !['offer', 'answer'].includes(value.type) || typeof value.sdp !== 'string' || !value.sdp || value.sdp.length > MAX_SDP_BYTES) {
    throw new HttpError(400, 'Invalid SFU session description');
  }
  return { type: value.type, sdp: value.sdp };
};

const ownedSfuSession = (peer, value, role) => {
  const sessionId = String(value || '');
  if (!SFU_SESSION.test(sessionId) || sfuState(peer).sessions.get(sessionId) !== role) throw new HttpError(404, 'SFU session not found');
  return sessionId;
};

const publishedSfuTrack = (call, requesterId, locator) => {
  const sessionId = String(locator?.sessionId || '');
  const trackName = String(locator?.trackName || '');
  if (!SFU_TRACKS.has(trackName)) return false;
  return [...call.peers].some(([id, peer]) => id !== requesterId
    && peer.sfu?.publisher?.ready
    && peer.sfu.publisher.sessionId === sessionId
    && peer.sfu.publisher.tracks.has(trackName));
};

/**
 * Cloudflare's app secret stays here. Each browser may only mutate sessions created for its own
 * call peer, and subscriptions may only name tracks currently published inside this same call.
 */
const createSfuHandlers = (findPeer) => ({
  create: async (req, res) => {
    if (!cloudflareSfuEnabled()) throw new HttpError(503, 'Cloudflare SFU is not configured');
    const { peer } = findPeer(req);
    const role = req.body?.role === 'publish' ? 'publish' : req.body?.role === 'subscribe' ? 'subscribe' : null;
    if (!role) throw new HttpError(400, 'Choose an SFU session role');
    const created = await createCloudflareSfuSession();
    if (!created?.sessionId || !SFU_SESSION.test(created.sessionId)) throw new HttpError(502, 'Cloudflare returned an invalid SFU session');
    const media = sfuState(peer);
    media.sessions.set(created.sessionId, role);
    if (role === 'publish') media.publisher = { sessionId: created.sessionId, allocated: new Set(), tracks: new Set(), ready: false };
    res.status(201).json({ sessionId: created.sessionId });
  },

  tracks: async (req, res) => {
    const { call, peerId, peer } = findPeer(req);
    const media = sfuState(peer);
    const requested = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    // Cloudflare accepts up to 64 tracks in one request. A 12-person room can subscribe to every
    // participant's audio, camera and occasional screen share without splitting SDP exchanges.
    if (!requested.length || requested.length > 64) throw new HttpError(400, 'Choose SFU tracks');
    const local = requested.every((track) => track?.location === 'local');
    const remote = requested.every((track) => track?.location === 'remote');
    if (!local && !remote) throw new HttpError(400, 'SFU tracks must use one direction');
    const role = local ? 'publish' : 'subscribe';
    const sessionId = ownedSfuSession(peer, req.params.sessionId, role);
    let tracks;
    if (local) {
      if (media.publisher?.sessionId !== sessionId) throw new HttpError(409, 'This SFU publishing session was replaced');
      tracks = requested.map((track) => {
        const trackName = String(track.trackName || '');
        const mid = String(track.mid ?? '');
        if (!SFU_TRACKS.has(trackName) || !mid || mid.length > 32) throw new HttpError(400, 'Invalid local SFU track');
        return { location: 'local', mid, trackName };
      });
    } else {
      tracks = requested.map((track) => {
        if (!publishedSfuTrack(call, peerId, track)) throw new HttpError(403, 'That SFU publication is not available in this call');
        return { location: 'remote', sessionId: String(track.sessionId), trackName: String(track.trackName) };
      });
    }
    const body = { tracks };
    if (req.body?.sessionDescription) body.sessionDescription = sfuDescription(req.body.sessionDescription);
    const result = await cloudflareSfuRequest(`sessions/${sessionId}/tracks/new`, { body });
    if (local) {
      const outcomes = Array.isArray(result?.tracks) ? result.tracks : [];
      tracks.forEach((track, index) => {
        if (!outcomes[index]?.errorCode && outcomes[index]?.mid !== undefined) media.publisher.allocated.add(track.trackName);
      });
    }
    res.json(result);
  },

  renegotiate: async (req, res) => {
    const { peer } = findPeer(req);
    const media = sfuState(peer);
    const sessionId = String(req.params.sessionId || '');
    if (!SFU_SESSION.test(sessionId) || !media.sessions.has(sessionId)) throw new HttpError(404, 'SFU session not found');
    const result = await cloudflareSfuRequest(`sessions/${sessionId}/renegotiate`, {
      method: 'PUT', body: { sessionDescription: sfuDescription(req.body?.sessionDescription) },
    });
    res.json(result);
  },

  ready: (req, res) => {
    const { call, peer } = findPeer(req);
    const sessionId = ownedSfuSession(peer, req.params.sessionId, 'publish');
    const media = sfuState(peer);
    if (media.publisher?.sessionId !== sessionId) throw new HttpError(409, 'This SFU publishing session was replaced');
    const tracks = (Array.isArray(req.body?.tracks) ? req.body.tracks : []).map(String);
    if (!tracks.length || tracks.some((track) => !SFU_TRACKS.has(track) || !media.publisher.allocated.has(track))) throw new HttpError(400, 'Invalid SFU publications');
    tracks.forEach((track) => media.publisher.tracks.add(track));
    media.publisher.ready = true;
    tell(call);
    res.json(publicCall(call, { forGuest: isGuest(peer.address) }));
  },
});

/** For recordings: the call, if `address` is in it with this window. */
export function callWithPeer(callId, address, peerId) {
  const call = calls.get(String(callId || ''));
  const peer = call?.peers.get(String(peerId || ''));
  if (!call || call.status === 'ended' || !peer || peer.address !== address) throw new HttpError(404, 'You are not in this call');
  return call;
}

/** Teammates in a call right now (guests have no account to watch a recording with). */
export const teamIn = (call) => [...new Set(members(call).map((peer) => peer.address))];
/** Everyone in a call right now, by name (guests included). */
export const namesIn = (call) => [...new Set([...call.peers.values()].map((peer) => nameIn(call, peer.address)))];
/** A call still going on, or null. */
export const liveCall = (id) => {
  const call = calls.get(String(id || ''));
  return call && call.status !== 'ended' ? call : null;
};

// Windows that vanished without saying goodbye, guests nobody let in, and calls that ended a while ago.
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
        if (!isGuest(peer.address)) call.dropped.set(peerId, { address: peer.address, since: now });
        changed = true;
      }
    }
    // The wait for someone to come back is over: settle the call as it now stands.
    for (const [peerId, dropped] of call.dropped) {
      if (now - dropped.since > REJOIN_GRACE_MS) {
        call.dropped.delete(peerId);
        changed = true;
      }
    }
    for (const [guestId, guest] of call.guests) {
      const waitedTooLong = guest.status === 'waiting' && (now - guest.since > LOBBY_MS || (!guest.streams && now - guest.lastSeen > LOBBY_GONE_MS));
      // A guest whose window dropped out may come back (rejoin) for a while without knocking again.
      if (guest.status === 'admitted' && !call.peers.has(guest.peerId)) {
        guest.status = 'away';
        guest.awaySince = now;
      }
      const goneForGood = guest.status === 'away' && now - guest.awaySince > LOBBY_MS;
      if (waitedTooLong || goneForGood) {
        if (waitedTooLong) callEvents.emit('lobby', GUEST + guestId, { status: 'expired' });
        call.guests.delete(guestId);
        changed = true;
      }
    }
    if (changed) settle(call);
  }
}, SWEEP_MS).unref?.();

/** The emoji reactions anyone in a call can send; each shows for a few seconds. */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🙏', '🤔'];
const REACTION_SHOWN_MS = 6_000;
const REACTION_GAP_MS = 400; // one per this long from each window, so a held key can't flood the call

/** Muted, camera on, sharing, hand raised, recording, and a reaction just sent. */
function updateState(call, peer, body, { canRecord = true } = {}) {
  let changed = false;
  for (const key of ['muted', 'camera', 'sharing', 'hand', ...(canRecord ? ['recording'] : [])]) {
    if (typeof body?.[key] === 'boolean' && peer[key] !== body[key]) {
      peer[key] = body[key];
      changed = true;
    }
  }
  if (typeof body?.reaction === 'string' && REACTIONS.includes(body.reaction)) {
    const now = Date.now();
    if (!peer.reaction || now - peer.reaction.at >= REACTION_GAP_MS) {
      peer.reaction = { emoji: body.reaction, at: now };
      changed = true;
    }
  }
  if (changed) tell(call);
}

const reactionOf = (peer, now = Date.now()) => (peer.reaction && now - peer.reaction.at < REACTION_SHOWN_MS ? peer.reaction : null);

/* In-call chat: kept with the call (the latest CHAT_KEEP messages) so someone joining late, or a
   window that reconnects, can read what was said. Each message goes to the other windows the same
   way connection details do, so it works for guests too. Gone when the call ends. */
const CHAT_KEEP = 200;
const CHAT_MAX_CHARS = 1000;
const CHAT_BURST = 8; // messages per CHAT_BURST_MS from one window
const CHAT_BURST_MS = 10_000;

function postChat(call, peerId, peer, body) {
  const text = typeof body?.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) throw new HttpError(400, 'Write a message first');
  if (text.length > CHAT_MAX_CHARS) throw new HttpError(400, `Messages can be up to ${CHAT_MAX_CHARS} characters`);
  const now = Date.now();
  peer.chatTimes = (peer.chatTimes || []).filter((at) => now - at < CHAT_BURST_MS);
  if (peer.chatTimes.length >= CHAT_BURST) throw new HttpError(429, 'Slow down a little before sending more');
  peer.chatTimes.push(now);
  const message = { id: crypto.randomUUID(), from: peerId, name: nameIn(call, peer.address), guest: isGuest(peer.address), text, at: now };
  call.chat ||= [];
  call.chat.push(message);
  if (call.chat.length > CHAT_KEEP) call.chat.splice(0, call.chat.length - CHAT_KEEP);
  for (const [id, other] of call.peers) {
    if (id !== peerId) callEvents.emit('signal', other.address, { id: call.id, from: peerId, to: id, data: { chat: message } });
  }
  return message;
}

/** Connection details for one other window in the same call, passed on without being read. */
function relay(call, from, body) {
  const to = call.peers.get(String(body?.to || ''));
  if (!to) throw new HttpError(404, 'They have left the call');
  const data = body?.data;
  if (!data || typeof data !== 'object' || JSON.stringify(data).length > MAX_SIGNAL_BYTES) throw new HttpError(400, 'Invalid call data');
  callEvents.emit('signal', to.address, { id: call.id, from, to: String(body.to), data });
}

function joinAsMember(call, me, res) {
  if (call.status === 'ended') throw new HttpError(409, 'This call has already ended');
  if (seats(call) >= MAX_PEOPLE) throw new HttpError(409, `This call is full (${MAX_PEOPLE} people)`);
  const invite = call.invited.get(me);
  if (invite) {
    clearTimeout(invite.timer);
    invite.status = 'joined';
  } else if (call.from !== me) {
    call.invited.set(me, { status: 'joined', timer: null }); // came in with the meeting link
  }
  const peerId = addPeer(call, me);
  call.status = 'active';
  call.connected = true;
  // Stops it ringing in this person's other windows and devices.
  callEvents.emit('ended', me, { id: call.id, status: 'accepted' });
  tell(call);
  res.json({ call: publicCall(call), peerId, iceServers: iceServersFor(me) });
}

/**
 * Restore a window that the heartbeat expired. Keeping its peer id makes retries idempotent: if
 * the response is lost, trying again cannot create a duplicate participant.
 */
function rejoinAsMember(call, me, req, res) {
  if (call.status === 'ended') throw new HttpError(409, 'This call has already ended');
  const peerId = String(req.body?.peerId || '');
  const existing = call.peers.get(peerId);
  if (existing) {
    if (existing.address !== me) throw new HttpError(404, 'You are not in this call');
    existing.lastSeen = Date.now();
    return res.json({ call: publicCall(call), peerId, iceServers: iceServersFor(me) });
  }
  const dropped = call.dropped.get(peerId);
  if (!dropped || dropped.address !== me) throw new HttpError(409, 'The reconnect window has expired');
  call.dropped.delete(peerId);
  addPeer(call, me, peerId);
  call.status = 'active';
  call.connected = true;
  settle(call);
  return res.json({ call: publicCall(call), peerId, iceServers: iceServersFor(me) });
}

// `meeting: true` starts a meeting with a link, which may ring nobody yet.
router.post('/', (req, res) => {
  const from = personOf(req.user);
  const meeting = Boolean(req.body?.meeting);
  const to = people(req.body?.to, from, { allowNone: meeting });
  if (to.length + 1 > MAX_PEOPLE) throw new HttpError(400, `A call can have up to ${MAX_PEOPLE} people`);
  const { call, peerId } = createCall(from, { to, video: req.body?.video, meeting });
  res.status(201).json({ call: publicCall(call), peerId, iceServers: iceServersFor(from) });
});

/**
 * A teammate opening a meeting link: straight in, no lobby. For a scheduled meeting nobody has
 * opened yet, this starts it.
 */
router.post('/code/:code/join', (req, res) => {
  const me = personOf(req.user);
  const live = liveByCode(req.params.code);
  if (live) return joinAsMember(live, me, res);
  const scheduled = scheduledByCode(req.params.code);
  if (!scheduled) throw new HttpError(404, 'This meeting has ended or the link is wrong');
  const { call, peerId } = createCall(me, { video: true, meeting: true, code: scheduled.code, title: scheduled.title });
  return res.status(201).json({ call: publicCall(call), peerId, iceServers: iceServersFor(me) });
});

router.get('/:id', (req, res) => {
  const { call, me } = callFor(req);
  res.json({ ...publicCall(call), ringingForMe: call.status !== 'ended' && call.invited.get(me)?.status === 'ringing' });
});

router.post('/:id/join', (req, res) => {
  const { call, me } = callFor(req);
  joinAsMember(call, me, res);
});

router.post('/:id/rejoin', (req, res) => {
  const { call, me } = callFor(req);
  rejoinAsMember(call, me, req, res);
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
  if (seats(call) + ringing + to.length > MAX_PEOPLE) throw new HttpError(400, `A call can have up to ${MAX_PEOPLE} people`);
  ring(call, to);
  tell(call);
  res.json(publicCall(call));
});

/** A link anyone can open. Teammates join at once; others wait to be let in. */
router.post('/:id/link', (req, res) => {
  const { call } = peerFor(req);
  if (call.status === 'ended') throw new HttpError(409, 'This call has already ended');
  const fresh = !call.code;
  giveLink(call);
  if (fresh) tell(call);
  res.json({ code: call.code, call: publicCall(call) });
});

/** Let someone waiting outside in, or turn them away. Anyone on the team who is in the call can. */
router.post('/:id/admit', (req, res) => {
  const { call } = peerFor(req);
  const guest = call.guests.get(String(req.body?.guestId || ''));
  if (!guest || guest.status !== 'waiting') throw new HttpError(409, 'They are no longer waiting');
  const address = GUEST + guest.id;
  if (req.body?.allow) {
    if (seats(call) >= MAX_PEOPLE) throw new HttpError(409, `This call is full (${MAX_PEOPLE} people)`);
    guest.status = 'admitted';
    guest.peerId = addPeer(call, address);
    call.status = 'active';
    call.connected = true;
    callEvents.emit('lobby', address, admitted(call, guest));
  } else {
    call.guests.delete(guest.id);
    callEvents.emit('lobby', address, { status: 'denied' });
  }
  tell(call);
  res.json(publicCall(call));
});

/** Muted, camera on, sharing, hand raised. Also the regular "still here" from each window. */
router.post('/:id/state', (req, res) => {
  const { call, peer } = peerFor(req);
  updateState(call, peer, req.body);
  res.json(publicCall(call));
});

/** An SFU negotiation failed for one endpoint: every participant must move to the same topology. */
router.post('/:id/media/fallback', (req, res) => {
  const { call } = peerFor(req);
  if (call.media === 'sfu') {
    call.media = 'p2p';
    tell(call);
  }
  res.json(publicCall(call));
});

router.post('/:id/chat', (req, res) => {
  const { call, peerId, peer } = peerFor(req);
  res.status(201).json(postChat(call, peerId, peer, req.body));
});

router.post('/:id/chat/history', (req, res) => {
  const { call } = peerFor(req);
  res.json({ items: call.chat || [] });
});

router.post('/:id/signal', (req, res) => {
  const { call, peerId } = peerFor(req);
  relay(call, peerId, req.body);
  res.status(204).end();
});

const memberSfu = createSfuHandlers(peerFor);
router.post('/:id/sfu/session', memberSfu.create);
router.post('/:id/sfu/:sessionId/tracks', memberSfu.tracks);
router.post('/:id/sfu/:sessionId/renegotiate', memberSfu.renegotiate);
router.post('/:id/sfu/:sessionId/ready', memberSfu.ready);

export default router;

/* ---------------------------------- guests (no account) ---------------------------------- */

export const guestRouter = Router();
// Knocks from one address; enough for an office behind one IP, not for flooding a lobby.
const knocks = limiter('meeting-knock', { max: 30, windowMs: 10 * 60_000, lockMs: 10 * 60_000 });

const admitted = (call, guest) => ({
  status: 'admitted', call: publicCall(call, { forGuest: true }), peerId: guest.peerId, iceServers: iceServersFor(GUEST + guest.id),
});

/** The guest behind a request: their id and the token they were given when they knocked. */
function guestFor(req) {
  const call = byCode(req.params.code);
  const guest = call.guests.get(String(req.get('X-Guest-Id') || req.query.guest || ''));
  const token = String(req.get('X-Guest-Token') || req.query.token || '');
  if (!guest || !token || !safeEqual(sha256(token), guest.tokenHash)) throw new HttpError(404, 'You are not in this meeting');
  guest.lastSeen = Date.now();
  return { call, guest, address: GUEST + guest.id };
}

function guestPeer(req) {
  const { call, guest } = guestFor(req);
  const peer = guest.peerId && call.peers.get(guest.peerId);
  if (!peer) throw new HttpError(404, 'You are not in this meeting');
  peer.lastSeen = Date.now();
  return { call, peer, peerId: guest.peerId };
}

/**
 * What the join page shows before knocking. Nothing about who is in it. A scheduled meeting that
 * nobody from the team has opened yet says so (`started: false`), with when it's due.
 */
guestRouter.get('/:code', (req, res) => {
  const call = liveByCode(req.params.code);
  if (call) return res.json({ code: call.code, hostName: call.fromName, video: call.video, title: call.title, started: true });
  const scheduled = scheduledByCode(req.params.code);
  if (!scheduled) throw new HttpError(404, 'This meeting has ended or the link is wrong');
  return res.json({ code: scheduled.code, hostName: nameOf(scheduled.host), video: true, title: scheduled.title, started: false, startAt: scheduled.startAt });
});

guestRouter.post('/:code/knock', (req, res) => {
  const ip = clientIp(req);
  knocks.check(ip);
  knocks.fail(ip);
  if (!liveByCode(req.params.code) && scheduledByCode(req.params.code)) throw new HttpError(409, 'This meeting hasn’t started yet. You can ask to join once someone from the team opens it.');
  const call = byCode(req.params.code);
  const name = String(req.body?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Enter your name');
  if ([...call.guests.values()].filter((guest) => guest.status === 'waiting').length >= MAX_LOBBY) throw new HttpError(429, 'Too many people are waiting to join. Try again in a minute.');
  const id = crypto.randomUUID();
  const token = randomToken();
  call.guests.set(id, { id, name, tokenHash: sha256(token), status: 'waiting', since: Date.now(), lastSeen: Date.now(), streams: 0, peerId: null });
  tell(call);
  res.status(201).json({ guestId: id, token });
});

/**
 * The guest's own event stream: whether they've been let in, then the call itself. (EventSource
 * can't send headers, so the token comes in the query; it is only good for this one meeting.)
 */
guestRouter.get('/:code/events', (req, res) => {
  const { call, guest, address } = guestFor(req);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  const pad = `:${' '.repeat(2048)}\n\n`; // pushes each event through proxies that hold small writes
  const write = (message) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n${pad}`); };
  res.write(`retry: 3000\n\n${pad}`);
  const listeners = {
    room: (to, view) => to === address && write({ type: 'call-room', call: view }),
    signal: (to, signal) => to === address && write({ type: 'call-signal', ...signal }),
    lobby: (to, payload) => {
      if (to !== address) return;
      write({ type: 'lobby', ...payload });
      if (['denied', 'expired', 'ended'].includes(payload.status)) res.end();
    },
  };
  for (const [name, listener] of Object.entries(listeners)) callEvents.on(name, listener);
  guest.streams += 1;
  // Where things stand now, also after the stream reconnects.
  if (guest.status === 'admitted') write({ type: 'lobby', ...admitted(call, guest) });
  else write({ type: 'lobby', status: 'waiting' });
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  const cleanup = () => {
    for (const [name, listener] of Object.entries(listeners)) callEvents.off(name, listener);
    clearInterval(heartbeat);
    guest.streams = Math.max(0, guest.streams - 1);
    guest.lastSeen = Date.now();
  };
  res.on('close', cleanup);
});

guestRouter.post('/:code/state', (req, res) => {
  const { call, peer } = guestPeer(req);
  updateState(call, peer, req.body, { canRecord: false });
  res.json(publicCall(call, { forGuest: true }));
});

guestRouter.post('/:code/media/fallback', (req, res) => {
  const { call } = guestPeer(req);
  if (call.media === 'sfu') {
    call.media = 'p2p';
    tell(call);
  }
  res.json(publicCall(call, { forGuest: true }));
});

guestRouter.post('/:code/chat', (req, res) => {
  const { call, peerId, peer } = guestPeer(req);
  res.status(201).json(postChat(call, peerId, peer, req.body));
});

guestRouter.post('/:code/chat/history', (req, res) => {
  const { call } = guestPeer(req);
  res.json({ items: call.chat || [] });
});

guestRouter.post('/:code/signal', (req, res) => {
  const { call, peerId } = guestPeer(req);
  relay(call, peerId, req.body);
  res.status(204).end();
});

const guestSfu = createSfuHandlers(guestPeer);
guestRouter.post('/:code/sfu/session', guestSfu.create);
guestRouter.post('/:code/sfu/:sessionId/tracks', guestSfu.tracks);
guestRouter.post('/:code/sfu/:sessionId/renegotiate', guestSfu.renegotiate);
guestRouter.post('/:code/sfu/:sessionId/ready', guestSfu.ready);

/** Back in after this guest's window dropped out (phone asleep, network gone), without knocking again. */
guestRouter.post('/:code/rejoin', (req, res) => {
  const { call, guest, address } = guestFor(req);
  if (!['admitted', 'away'].includes(guest.status)) throw new HttpError(409, 'Ask to join again');
  if (!guest.peerId || !call.peers.has(guest.peerId)) {
    // This guest's away reservation becomes their active peer again, so the seat count is unchanged.
    guest.peerId = addPeer(call, address, guest.peerId || undefined);
  }
  guest.status = 'admitted';
  guest.awaySince = null;
  tell(call);
  res.json(admitted(call, guest));
});

/** Leaving the call, or giving up waiting. */
guestRouter.post('/:code/leave', (req, res) => {
  let found;
  try {
    found = guestFor(req);
  } catch {
    return res.json({ ok: true }); // already gone, or the meeting ended
  }
  const { call, guest } = found;
  if (guest.peerId) call.peers.delete(guest.peerId);
  call.guests.delete(guest.id);
  settle(call);
  res.json({ ok: true });
});
