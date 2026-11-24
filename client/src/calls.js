// A team call in this window: the camera and microphone, a direct connection (WebRTC) to each other
// person, and what the screen shows. Nothing here depends on React: CallCenter watches it, so a
// call carries on while moving between mail, tasks and the rest of the app.
//
// Every connection has three fixed channels: microphone, camera, shared screen. Turning a camera or
// screen on or off only changes what goes into a channel, which needs no renegotiating and so can't
// collide with what the other side is doing. Of each pair, one side (the larger id) starts things.
import { api, LOGOUT_EVENT } from './api.js';
import { subscribe as subscribeLive } from './live.js';

const SLOTS = ['audio', 'camera', 'screen'];
const CHECK_IN_MS = 15_000;
const RECONNECT_AFTER_MS = 5_000;
// Still not connected after this long: it's not going to work by itself, so say why.
const STUCK_AFTER_MS = 20_000;
const ENDED_NOTICE_MS = 3_000;
// Not connected to someone for this long: try again (and again, at this pace) until it works.
const RECOVER_EVERY_MS = 12_000;
// A connection message that couldn't be sent (network blip): try again after these waits.
const SIGNAL_RETRIES = [1_000, 3_000];
// Each camera's upper limit, by how many others it goes to: everyone sends to everyone, so the
// more people, the less each picture may use (as Meet does), and the call stays smooth.
const CAMERA_BITRATE = [1_500_000, 1_500_000, 900_000, 650_000, 450_000, 350_000];
const SCREEN_BITRATE = 1_200_000;
const OFFLINE_NOTICE = 'You’re offline. The call will reconnect when your connection is back.';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IDLE = {
  phase: 'idle', // idle | joining | in-call | ended
  call: null,
  me: null, // this window's id in the call
  peers: [], // the others: { id, address, name, muted, camera, sharing, hand, connection, audio, cameraStream, screenStream }
  muted: false,
  cameraOn: false,
  sharing: false,
  hand: false,
  recording: false,
  guest: false, // joined with a meeting link, without an account
  micAvailable: true,
  localCamera: null,
  localScreen: null,
  localAudio: null,
  notice: '',
  endReason: '',
  startedAt: null,
};

let state = IDLE;
const watchers = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  watchers.forEach((fn) => fn());
};

/** For useSyncExternalStore. */
export const callState = () => state;
export const watchCall = (fn) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};

let connections = new Map(); // other window's id -> its connection
let transport = null; // how this window talks to the server about the call (memberTransport / guestTransport)
let iceServers = [];
let mic = null;
let camera = null;
let screen = null;
let stopLive = null;
let checkIn = null;
let endedTimer = null;
let attempt = 0; // Bumped to abandon a call still being set up.
let rejoining = false;
let wakeLock = null;

const tracks = { audio: () => mic, camera: () => camera, screen: () => screen };

/* ---------------------------------- this computer's devices ---------------------------------- */

const mediaError = (err, what) => {
  if (err?.name === 'NotAllowedError') return `Your browser is blocking the ${what}. Allow it in the site settings, then try again.`;
  if (err?.name === 'NotFoundError') return `No ${what} was found on this device.`;
  if (err?.name === 'NotReadableError') return `Another app is using the ${what}.`;
  return `Couldn’t use the ${what}.`;
};

// `exact` when picked during a call (fail loudly if it's gone); `ideal` for a remembered choice
// (that device if it's still there, otherwise the default one).
const deviceConstraint = (deviceId, exact) => deviceId && { deviceId: exact ? { exact: deviceId } : { ideal: deviceId } };
const micOptions = (deviceId, exact = true) => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...deviceConstraint(deviceId, exact) });
const cameraOptions = (deviceId, exact = true) => ({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, ...deviceConstraint(deviceId, exact) });

/* The microphone, speaker and camera picked last time, kept on this computer for the next call. */
const DEVICES_KEY = 'aliasmail:call-devices';
function savedDevices() {
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY)) || {};
  } catch {
    return {};
  }
}
function saveDevice(kind, deviceId) {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ ...savedDevices(), [kind]: deviceId }));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this call only.
  }
}
const deviceOf = (track) => track?.getSettings?.().deviceId || '';

/** Microphone and (if asked) camera. A missing camera or microphone doesn't stop anyone joining. */
async function openDevices(video, muted = false) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (https) connection and a modern browser.');
  const saved = savedDevices();
  const notices = [];
  try {
    const track = (await navigator.mediaDevices.getUserMedia({ audio: micOptions(saved.audioinput, false) })).getAudioTracks()[0];
    track.enabled = !muted; // honour the pre-join choice before this track can reach another person
    useMic(track);
  } catch (err) {
    notices.push(`${mediaError(err, 'microphone')} You can still listen.`);
  }
  if (video) {
    try {
      useCamera((await navigator.mediaDevices.getUserMedia({ video: cameraOptions(saved.videoinput, false) })).getVideoTracks()[0]);
    } catch (err) {
      notices.push(mediaError(err, 'camera'));
    }
  }
  return notices.join(' ');
}

/**
 * Start using a microphone track. If it stops by itself (headset unplugged, USB mic removed, the
 * browser revoking access), switch to the default microphone instead of going silent.
 */
function useMic(track) {
  mic = track;
  track.onended = async () => {
    if (mic !== track || state.phase !== 'in-call') return;
    try {
      const next = (await navigator.mediaDevices.getUserMedia({ audio: micOptions() })).getAudioTracks()[0];
      if (mic !== track || state.phase !== 'in-call') return next.stop();
      next.enabled = !state.muted;
      useMic(next);
      track.stop();
      setChannel('audio', next);
      set({ micDevice: deviceOf(next), notice: `Your microphone was disconnected. Now using ${next.label || 'the default microphone'}.` });
    } catch (err) {
      mic = null;
      setChannel('audio', null);
      set({ notice: `Your microphone was disconnected. ${mediaError(err, 'microphone')}` });
    }
    publishLocal();
    sendState();
  };
}

/** Start using a camera track. If the camera goes away, turn the camera off and say so. */
function useCamera(track) {
  camera = track;
  track.onended = () => {
    if (camera !== track || state.phase !== 'in-call') return;
    camera = null;
    setChannel('camera', null);
    set({ notice: 'Your camera was disconnected, so it has been turned off.' });
    publishLocal();
    sendState();
  };
}

const streamOf = (track) => (track ? new MediaStream([track]) : null);

function publishLocal() {
  set({
    micAvailable: Boolean(mic),
    micDevice: deviceOf(mic) || state.micDevice,
    cameraDevice: deviceOf(camera) || state.cameraDevice,
    localAudio: streamOf(mic),
    localCamera: streamOf(camera),
    localScreen: streamOf(screen),
    cameraOn: Boolean(camera),
    sharing: Boolean(screen),
  });
}

function stopDevices() {
  [mic, camera, screen].forEach((track) => track?.stop());
  mic = camera = screen = null;
}

/* ---------------------------------- talking to the server ---------------------------------- */

/** Teammates: signed-in requests under /calls/<id>, and the app's live connection. */
const memberTransport = (callId) => ({
  guest: false,
  post: (suffix, body) => api(`/calls/${callId}${suffix}`, { method: 'POST', body }),
  refresh: () => api(`/calls/${callId}`),
  // Dropped by the server (the phone slept, the network went): back in, as a new window.
  rejoin: (peerId) => api(`/calls/${callId}/rejoin`, { method: 'POST', body: { peerId } }),
  subscribe: subscribeLive,
  // Closing the tab: an ordinary request wouldn't finish in time, and a beacon can't carry the
  // header the server requires.
  leaveNow: (body) => fetch(`/api/calls/${callId}/leave`, {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' }, body: JSON.stringify(body),
  }),
});

/**
 * Guests (meeting link, no account): requests under /meet/<code> that carry the private token they
 * got when they knocked, and their own event stream (`subscribe`, from the join page).
 */
export function guestTransport({ code, guestId, token, subscribe }) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail', 'X-Guest-Id': guestId, 'X-Guest-Token': token };
  const url = (suffix) => `/api/meet/${encodeURIComponent(code)}${suffix}`;
  return {
    guest: true,
    async post(suffix, body) {
      const res = await fetch(url(suffix), { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body || {}) });
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      if (!res.ok) throw Object.assign(new Error(data?.error || 'Something went wrong. Try again.'), { status: res.status });
      return data;
    },
    refresh: null, // the guest's event stream sends where things stand each time it reconnects
    rejoin() {
      return this.post('/rejoin', {});
    },
    subscribe,
    leaveNow: (body) => fetch(url('/leave'), { method: 'POST', keepalive: true, credentials: 'same-origin', headers, body: JSON.stringify(body) }),
  };
}

function sendState() {
  if (state.phase !== 'in-call' || rejoining || !transport) return;
  transport.post('/state', { peerId: state.me, muted: state.muted, camera: state.cameraOn, sharing: state.sharing, hand: state.hand, recording: state.recording })
    .then(applyCall)
    // The server no longer has this window in the call: get back in. Anything else: the next check-in tries again.
    .catch((err) => err?.status === 404 && rejoin());
}

/**
 * Back into the call after the server let this window go: a phone that slept or switched apps, or
 * a network that went away for a while. The camera and microphone carry on; the connections to the
 * others start afresh.
 */
async function rejoin() {
  if (rejoining || state.phase !== 'in-call' || !transport?.rejoin) return;
  const mine = attempt;
  rejoining = true;
  set({ notice: 'Reconnecting to the call…' });
  let joined;
  try {
    joined = await transport.rejoin(state.me);
  } catch (err) {
    if (mine !== attempt) return;
    rejoining = false;
    // The call is over (or full): say so. A network problem: the next check-in tries again.
    if ([403, 404, 409].includes(err?.status)) finish('ended');
    return;
  }
  if (mine !== attempt) return;
  rejoining = false;
  [...connections.keys()].forEach(disconnect);
  if (joined.iceServers) iceServers = joined.iceServers;
  set({ me: joined.peerId, notice: '' });
  applyCall(joined.call);
  sendState();
}

/* ---------------------------------- one connection per person ---------------------------------- */

function send(connection, data) {
  // One at a time, so the other side gets them in order. A network blip: try again shortly.
  connection.sending = connection.sending.then(async () => {
    for (let i = 0; ; i++) {
      if (connections.get(connection.id) !== connection || !transport) return;
      try {
        await transport.post('/signal', { peerId: state.me, to: connection.id, data });
        return;
      } catch (err) {
        // They left, or the server let this window go: a check-in sorts out which (and rejoins).
        if (err?.status === 404) return sendState();
        if (err?.status || i >= SIGNAL_RETRIES.length) return;
        await pause(SIGNAL_RETRIES[i]);
      }
    }
  }).catch(() => {});
}

function queueCandidate(connection, candidate) {
  connection.outgoing.push(candidate);
  if (connection.outgoingTimer) return;
  connection.outgoingTimer = setTimeout(() => {
    connection.outgoingTimer = null;
    send(connection, { candidates: connection.outgoing.splice(0) });
  }, 60);
}

function fillChannels(connection) {
  connection.pc.getTransceivers().forEach((transceiver, i) => {
    const slot = SLOTS[i];
    if (!slot) return;
    transceiver.direction = 'sendrecv';
    transceiver.sender.replaceTrack(tracks[slot]() || null).catch(() => {});
  });
}

/** How much each picture may use, by how many people it goes to. */
function tuneSenders() {
  const cameraLimit = CAMERA_BITRATE[Math.min(connections.size, CAMERA_BITRATE.length - 1)];
  for (const connection of connections.values()) {
    const transceivers = connection.pc.getTransceivers();
    limitBitrate(transceivers[SLOTS.indexOf('camera')]?.sender, cameraLimit);
    limitBitrate(transceivers[SLOTS.indexOf('screen')]?.sender, SCREEN_BITRATE);
  }
}

function limitBitrate(sender, maxBitrate) {
  if (!sender?.getParameters) return;
  try {
    const params = sender.getParameters();
    // Not set up yet: done again once connected.
    if (!params.encodings?.length || params.encodings[0].maxBitrate === maxBitrate) return;
    params.encodings[0].maxBitrate = maxBitrate;
    sender.setParameters(params).catch(() => {});
  } catch {
    // Older browsers choose for themselves.
  }
}

function setChannel(slot, track) {
  const index = SLOTS.indexOf(slot);
  for (const connection of connections.values()) {
    connection.pc.getTransceivers()[index]?.sender.replaceTrack(track || null).catch(() => {});
  }
}

const RESEND_OFFER_MS = 8_000;

async function offer(connection, options) {
  const { pc } = connection;
  await pc.setLocalDescription(await pc.createOffer(options));
  send(connection, { description: pc.localDescription });
  // No answer yet: the other window may not have been listening when it arrived. Ask again.
  clearTimeout(connection.offerTimer);
  connection.offerTimer = setTimeout(function again() {
    if (connections.get(connection.id) !== connection || pc.signalingState !== 'have-local-offer') return;
    send(connection, { description: pc.localDescription });
    connection.offerTimer = setTimeout(again, RESEND_OFFER_MS);
  }, RESEND_OFFER_MS);
}

function recover(connection) {
  connection.recoveredAt = Date.now();
  if (connection.initiator) offer(connection, { iceRestart: true }).catch(() => {});
  else send(connection, { restart: true });
}

function connect(id) {
  const existing = connections.get(id);
  if (existing) return existing;
  // max-bundle: microphone, camera and screen share one network path, so only one is set up (and relayed).
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const connection = {
    id, pc, initiator: state.me > id, media: {}, waiting: [], outgoing: [], outgoingTimer: null, retryTimer: null,
    work: Promise.resolve(), sending: Promise.resolve(), since: Date.now(), stuckTimer: null, warned: false,
  };
  connections.set(id, connection);
  const watchStuck = () => {
    clearTimeout(connection.stuckTimer);
    connection.stuckTimer = setTimeout(publishPeers, STUCK_AFTER_MS - (Date.now() - connection.since) + 50);
  };
  watchStuck();
  pc.onicecandidate = ({ candidate }) => candidate && queueCandidate(connection, candidate);
  pc.ontrack = ({ track, transceiver }) => {
    const slot = SLOTS[pc.getTransceivers().indexOf(transceiver)];
    if (!slot) return;
    connection.media[slot] = new MediaStream([track]);
    publishPeers();
  };
  pc.onconnectionstatechange = () => {
    clearTimeout(connection.retryTimer);
    if (pc.connectionState === 'connected') {
      connection.since = null;
      connection.warned = false;
      clearTimeout(connection.stuckTimer);
      tuneSenders();
    } else if (!connection.since) {
      connection.since = Date.now();
      watchStuck();
    }
    if (pc.connectionState === 'failed') recover(connection);
    else if (pc.connectionState === 'disconnected') connection.retryTimer = setTimeout(() => recover(connection), RECONNECT_AFTER_MS);
    publishPeers();
  };
  if (connection.initiator) {
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    fillChannels(connection);
    offer(connection).catch(() => recover(connection));
  }
  return connection;
}

function disconnect(id) {
  const connection = connections.get(id);
  if (!connection) return;
  clearTimeout(connection.retryTimer);
  clearTimeout(connection.outgoingTimer);
  clearTimeout(connection.stuckTimer);
  clearTimeout(connection.offerTimer);
  connection.pc.close();
  connections.delete(id);
}

async function handleSignal(connection, data) {
  const { pc } = connection;
  if (data.restart) {
    if (connection.initiator) await offer(connection, { iceRestart: true });
    return;
  }
  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      fillChannels(connection);
      await pc.setLocalDescription(await pc.createAnswer());
      send(connection, { description: pc.localDescription });
    }
    for (const candidate of connection.waiting.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    publishPeers();
  }
  for (const candidate of data.candidates || []) {
    if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
    else connection.waiting.push(candidate); // Candidates can overtake the description they belong to.
  }
}

function publishPeers() {
  if (!state.call) return;
  const stuckNames = [];
  const peers = state.call.peers.filter((peer) => peer.id !== state.me).map((peer) => {
    const connection = connections.get(peer.id);
    const stuck = Boolean(connection?.since && Date.now() - connection.since >= STUCK_AFTER_MS);
    if (stuck && !connection.warned) {
      connection.warned = true;
      stuckNames.push(peer.name);
    }
    return {
      ...peer,
      connection: connection?.pc.connectionState || 'new',
      stuck,
      audio: connection?.media.audio || null,
      cameraStream: connection?.media.camera || null,
      screenStream: connection?.media.screen || null,
    };
  });
  set({
    peers,
    ...(stuckNames.length && {
      notice: `Can’t connect to ${stuckNames.join(', ')}. A network (often office Wi-Fi, a mobile hotspot or a VPN) is blocking a direct connection. Try another network, or ask your administrator to set up a call relay (TURN).`,
    }),
  });
}

/* ---------------------------------- the call as a whole ---------------------------------- */

const END_REASONS = {
  declined: 'They declined the call.',
  missed: 'No answer.',
  cancelled: 'Call cancelled.',
  ended: 'Call ended.',
};

/**
 * The regular check-in: tells the server this window is still here, and tries again with anyone
 * it still isn't connected to (a lost message or a changed network otherwise leaves them stuck).
 */
function checkInNow() {
  sendState();
  const now = Date.now();
  for (const connection of connections.values()) {
    if (connection.pc.connectionState === 'connected' || !connection.since) continue;
    if (now - connection.since < RECOVER_EVERY_MS || now - (connection.recoveredAt || 0) < RECOVER_EVERY_MS) continue;
    recover(connection);
  }
}

/** Back online, or back to this tab (a phone unlocked): catch up and repair what broke meanwhile. */
function catchUp() {
  if (state.phase !== 'in-call') return;
  if (state.notice === OFFLINE_NOTICE) set({ notice: '' });
  sendState();
  transport?.refresh?.().then(applyCall).catch(() => {});
  for (const connection of connections.values()) {
    if (!['connected', 'new'].includes(connection.pc.connectionState)) recover(connection);
  }
  keepAwake();
}

/** Keep a phone's screen on during the call, as Meet does. */
async function keepAwake() {
  if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible' || state.phase !== 'in-call') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (state.phase !== 'in-call' || wakeLock) return void lock.release().catch(() => {});
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Battery saver, or not allowed: the screen sleeps as usual.
  }
}

function letSleep() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function tearDown() {
  attempt++;
  rejoining = false;
  letSleep();
  clearInterval(checkIn);
  checkIn = null;
  stopLive?.();
  stopLive = null;
  [...connections.keys()].forEach(disconnect);
  connections = new Map();
  stopDevices();
  transport = null;
}

function finish(reason) {
  tearDown();
  set({ ...IDLE, phase: 'ended', endReason: END_REASONS[reason] || END_REASONS.ended });
  clearTimeout(endedTimer);
  endedTimer = setTimeout(() => set(IDLE), ENDED_NOTICE_MS);
}

/** The server's view of the call: connect to whoever is new, drop whoever has gone. */
function applyCall(call) {
  if (state.phase !== 'in-call' || call.id !== state.call?.id) return;
  if (call.status === 'ended') return finish(call.reason);
  const others = call.peers.filter((peer) => peer.id !== state.me);
  const ids = new Set(others.map((peer) => peer.id));
  for (const id of [...connections.keys()]) if (!ids.has(id)) disconnect(id);
  set({ call, startedAt: state.startedAt || (others.length ? Date.now() : null) });
  others.forEach((peer) => connect(peer.id));
  tuneSenders();
  publishPeers();
}

function onLive(message) {
  if (message.type === 'call-room') applyCall(message.call);
  else if (message.type === 'call-signal' && message.id === state.call?.id && message.to === state.me) {
    const connection = connect(message.from);
    connection.work = connection.work.then(() => handleSignal(connection, message.data)).catch(() => {});
  } else if (message.type === 'open' && state.call) {
    // Back online after a dropped connection: catch up on anything missed meanwhile.
    transport?.refresh?.().then(applyCall).catch(() => {});
  }
}

function enter({ call, peerId, iceServers: servers }, notice, via, { muted = false } = {}) {
  iceServers = servers;
  transport = via || memberTransport(call.id);
  clearTimeout(endedTimer);
  const saved = savedDevices();
  set({ phase: 'in-call', call, me: peerId, notice, muted, hand: false, recording: false, guest: transport.guest, startedAt: null, speakerDevice: saved.audiooutput, cameraDevice: saved.videoinput });
  publishLocal();
  stopLive = transport.subscribe(onLive);
  checkIn = setInterval(checkInNow, CHECK_IN_MS);
  applyCall(call);
  sendState();
  keepAwake();
}

async function begin(video, request, via, { muted = false } = {}) {
  if (state.phase === 'in-call' || state.phase === 'joining') await hangUp();
  clearTimeout(endedTimer);
  const mine = ++attempt;
  set({ ...IDLE, phase: 'joining' });
  try {
    const notice = await openDevices(video, muted);
    if (mine !== attempt) return;
    const joined = await request();
    if (mine !== attempt) {
      (via || memberTransport(joined.call.id)).post('/leave', { peerId: joined.peerId }).catch(() => {});
      return;
    }
    enter(joined, notice, via, { muted });
  } catch (err) {
    if (mine !== attempt) return;
    tearDown();
    set(IDLE);
    throw err;
  }
}

/** Ring teammates. Call this from a click, so the browser allows the camera and microphone. */
export const startCall = ({ to, video = false }) => begin(video, () => api('/calls', { method: 'POST', body: { to, video } }));

/** Answer a ringing call. */
export const joinCall = (id, { video = false } = {}) => begin(video, () => api(`/calls/${id}/join`, { method: 'POST', body: {} }));

/** A meeting with a link to share, before anyone else is in it. */
export const startMeeting = ({ video = true } = {}) => begin(video, () => api('/calls', { method: 'POST', body: { to: [], video, meeting: true } }));

/** A teammate opening a meeting link: straight in. */
export const joinByCode = (code, { video = true, muted = false } = {}) => begin(video, () => api(`/calls/code/${encodeURIComponent(code)}/join`, { method: 'POST', body: {} }), undefined, { muted });

/** A guest who has just been let in (`admitted` is what the server sent them). */
export const joinAsGuest = (admitted, via, { video = true, muted = false } = {}) => begin(video, async () => admitted, via, { muted });

export async function hangUp() {
  const { me, phase } = state;
  const via = transport;
  tearDown();
  set(IDLE);
  if (phase === 'in-call' && via) await via.post('/leave', { peerId: me }).catch(() => {});
}

/** The meeting link for this call (made the first time it's asked for). Returns the code. */
export async function meetingCode() {
  if (state.call?.code) return state.call.code;
  const { code, call } = await transport.post('/link', { peerId: state.me });
  applyCall(call);
  return code;
}

export const meetingLink = (code) => `${window.location.origin}/join/${code}`;

/** Let someone waiting outside in, or not. */
export const admitGuest = (guestId, allow) => transport.post('/admit', { peerId: state.me, guestId, allow }).then(applyCall);

export function toggleMute() {
  if (!mic) return retryMicrophone();
  mic.enabled = state.muted;
  set({ muted: !state.muted });
  sendState();
  return undefined;
}

/** No microphone yet (blocked, missing or busy when joining): ask for it again. */
export async function retryMicrophone() {
  if (mic || state.phase !== 'in-call') return;
  try {
    const next = (await navigator.mediaDevices.getUserMedia({ audio: micOptions(state.micDevice || savedDevices().audioinput, false) })).getAudioTracks()[0];
    if (mic || state.phase !== 'in-call') return next.stop();
    useMic(next);
    setChannel('audio', next);
    set({ muted: false, notice: '' });
    publishLocal();
    sendState();
  } catch (err) {
    set({ notice: mediaError(err, 'microphone') });
  }
}

export async function toggleCamera() {
  if (camera) {
    camera.stop();
    camera = null;
    setChannel('camera', null);
  } else {
    try {
      useCamera((await navigator.mediaDevices.getUserMedia({ video: cameraOptions(state.cameraDevice, false) })).getVideoTracks()[0]);
      setChannel('camera', camera);
    } catch (err) {
      set({ notice: mediaError(err, 'camera') });
      return;
    }
  }
  publishLocal();
  sendState();
}

const canShareScreen = () => Boolean(navigator.mediaDevices?.getDisplayMedia);
export { canShareScreen };

function stopScreen() {
  screen?.stop();
  screen = null;
  setChannel('screen', null);
  publishLocal();
  sendState();
}

export async function toggleScreen() {
  if (screen) return stopScreen();
  try {
    const track = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })).getVideoTracks()[0];
    // Keep text sharp rather than motion smooth.
    track.contentHint = 'detail';
    track.onended = stopScreen; // The browser's own "Stop sharing" button.
    screen = track;
    setChannel('screen', track);
    publishLocal();
    sendState();
  } catch (err) {
    if (err?.name !== 'NotAllowedError') set({ notice: mediaError(err, 'screen') });
  }
  return undefined;
}

export function toggleHand() {
  set({ hand: !state.hand });
  sendState();
}

/** Tell everyone in the room when this browser is recording the call. */
export function setRecording(recording) {
  set({ recording: Boolean(recording) });
  sendState();
}

export const clearNotice = () => set({ notice: '' });

export const inviteToCall = (to) => transport.post('/invite', { peerId: state.me, to }).then(applyCall);

/** Change microphone or camera during a call. */
export async function chooseDevice(kind, deviceId) {
  try {
    if (kind === 'audioinput') {
      const next = (await navigator.mediaDevices.getUserMedia({ audio: micOptions(deviceId) })).getAudioTracks()[0];
      next.enabled = !state.muted;
      const previous = mic;
      useMic(next); // First, so stopping the old one isn't taken for a disconnected microphone.
      previous?.stop();
      setChannel('audio', next);
      set({ micDevice: deviceId });
    } else if (kind === 'videoinput') {
      set({ cameraDevice: deviceId });
      if (camera) {
        const next = (await navigator.mediaDevices.getUserMedia({ video: cameraOptions(deviceId) })).getVideoTracks()[0];
        const previous = camera;
        useCamera(next);
        previous.stop();
        setChannel('camera', next);
      }
    } else {
      set({ speakerDevice: deviceId });
    }
    saveDevice(kind, deviceId);
    publishLocal();
    sendState();
  } catch (err) {
    set({ notice: mediaError(err, kind === 'audioinput' ? 'microphone' : 'camera') });
  }
}

// Closing the tab: say goodbye so others don't wait for the timeout.
window.addEventListener('pagehide', () => {
  if (state.phase !== 'in-call' || !transport) return;
  transport.leaveNow({ peerId: state.me }).catch(() => {});
});

window.addEventListener('online', catchUp);
window.addEventListener('offline', () => {
  if (state.phase === 'in-call') set({ notice: OFFLINE_NOTICE });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') catchUp();
});

// Some browsers do not fire a track's `ended` event when a USB/Bluetooth device disappears.
// Device enumeration catches that case and also moves a vanished speaker back to the system default.
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (state.phase !== 'in-call' || !navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => null);
  if (!devices) return;
  const micId = deviceOf(mic);
  if (mic && micId && !devices.some((device) => device.kind === 'audioinput' && device.deviceId === micId)) void mic.onended?.();
  if (state.speakerDevice && state.speakerDevice !== 'default' && !devices.some((device) => device.kind === 'audiooutput' && device.deviceId === state.speakerDevice)) {
    saveDevice('audiooutput', 'default');
    set({ speakerDevice: 'default', notice: 'Your speaker was disconnected. Now using the default speaker.' });
  }
});

window.addEventListener(LOGOUT_EVENT, () => {
  tearDown();
  set(IDLE);
});
