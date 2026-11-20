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
async function openDevices(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (https) connection and a modern browser.');
  const saved = savedDevices();
  const notices = [];
  try {
    useMic((await navigator.mediaDevices.getUserMedia({ audio: micOptions(saved.audioinput, false) })).getAudioTracks()[0]);
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
      if (!res.ok) throw new Error(data?.error || 'Something went wrong. Try again.');
      return data;
    },
    refresh: null, // the guest's event stream sends where things stand each time it reconnects
    subscribe,
    leaveNow: (body) => fetch(url('/leave'), { method: 'POST', keepalive: true, credentials: 'same-origin', headers, body: JSON.stringify(body) }),
  };
}

function sendState() {
  if (state.phase !== 'in-call') return;
  transport.post('/state', { peerId: state.me, muted: state.muted, camera: state.cameraOn, sharing: state.sharing, hand: state.hand, recording: state.recording })
    .then(applyCall)
    .catch(() => {}); // The next check-in tries again.
}

/* ---------------------------------- one connection per person ---------------------------------- */

function send(connection, data) {
  // One at a time, so the other side gets them in order.
  connection.sending = connection.sending
    .then(() => transport.post('/signal', { peerId: state.me, to: connection.id, data }))
    .catch(() => {});
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
  if (connection.initiator) offer(connection, { iceRestart: true }).catch(() => {});
  else send(connection, { restart: true });
}

function connect(id) {
  const existing = connections.get(id);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers });
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
      clearTimeout(connection.stuckTimer);
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

function tearDown() {
  attempt++;
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

function enter({ call, peerId, iceServers: servers }, notice, via) {
  iceServers = servers;
  transport = via || memberTransport(call.id);
  clearTimeout(endedTimer);
  const saved = savedDevices();
  set({ phase: 'in-call', call, me: peerId, notice, muted: false, hand: false, recording: false, guest: transport.guest, startedAt: null, speakerDevice: saved.audiooutput, cameraDevice: saved.videoinput });
  publishLocal();
  stopLive = transport.subscribe(onLive);
  checkIn = setInterval(sendState, CHECK_IN_MS);
  applyCall(call);
  sendState();
}

async function begin(video, request, via) {
  if (state.phase === 'in-call' || state.phase === 'joining') await hangUp();
  clearTimeout(endedTimer);
  const mine = ++attempt;
  set({ ...IDLE, phase: 'joining' });
  try {
    const notice = await openDevices(video);
    if (mine !== attempt) return;
    const joined = await request();
    if (mine !== attempt) {
      (via || memberTransport(joined.call.id)).post('/leave', { peerId: joined.peerId }).catch(() => {});
      return;
    }
    enter(joined, notice, via);
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
export const joinByCode = (code, { video = true } = {}) => begin(video, () => api(`/calls/code/${encodeURIComponent(code)}/join`, { method: 'POST', body: {} }));

/** A guest who has just been let in (`admitted` is what the server sent them). */
export const joinAsGuest = (admitted, via, { video = true } = {}) => begin(video, async () => admitted, via);

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

window.addEventListener(LOGOUT_EVENT, () => {
  tearDown();
  set(IDLE);
});
