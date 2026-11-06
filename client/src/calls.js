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
  micAvailable: true,
  localCamera: null,
  localScreen: null,
  localAudio: null,
  notice: '',
  endReason: '',
  sharedDesktops: [],
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

const micOptions = (deviceId) => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId && { deviceId: { exact: deviceId } }) });
const cameraOptions = (deviceId) => ({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, ...(deviceId && { deviceId: { exact: deviceId } }) });

/** Microphone and (if asked) camera. A missing camera or microphone doesn't stop anyone joining. */
async function openDevices(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (https) connection and a modern browser.');
  const notices = [];
  try {
    mic = (await navigator.mediaDevices.getUserMedia({ audio: micOptions() })).getAudioTracks()[0];
  } catch (err) {
    notices.push(`${mediaError(err, 'microphone')} You can still listen.`);
  }
  if (video) {
    try {
      camera = (await navigator.mediaDevices.getUserMedia({ video: cameraOptions() })).getVideoTracks()[0];
    } catch (err) {
      notices.push(mediaError(err, 'camera'));
    }
  }
  return notices.join(' ');
}

const streamOf = (track) => (track ? new MediaStream([track]) : null);

function publishLocal() {
  set({
    micAvailable: Boolean(mic),
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

const path = (suffix = '') => `/calls/${state.call.id}${suffix}`;

function sendState() {
  if (state.phase !== 'in-call') return;
  api(path('/state'), { method: 'POST', body: { peerId: state.me, muted: state.muted, camera: state.cameraOn, sharing: state.sharing, hand: state.hand } })
    .then(applyCall)
    .catch(() => {}); // The next check-in tries again.
}

/* ---------------------------------- one connection per person ---------------------------------- */

function send(connection, data) {
  // One at a time, so the other side gets them in order.
  connection.sending = connection.sending
    .then(() => api(path('/signal'), { method: 'POST', body: { peerId: state.me, to: connection.id, data } }))
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

async function offer(connection, options) {
  const { pc } = connection;
  await pc.setLocalDescription(await pc.createOffer(options));
  send(connection, { description: pc.localDescription });
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
    work: Promise.resolve(), sending: Promise.resolve(),
  };
  connections.set(id, connection);
  pc.onicecandidate = ({ candidate }) => candidate && queueCandidate(connection, candidate);
  pc.ontrack = ({ track, transceiver }) => {
    const slot = SLOTS[pc.getTransceivers().indexOf(transceiver)];
    if (!slot) return;
    connection.media[slot] = new MediaStream([track]);
    publishPeers();
  };
  pc.onconnectionstatechange = () => {
    clearTimeout(connection.retryTimer);
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
  const peers = state.call.peers.filter((peer) => peer.id !== state.me).map((peer) => {
    const connection = connections.get(peer.id);
    return {
      ...peer,
      connection: connection?.pc.connectionState || 'new',
      audio: connection?.media.audio || null,
      cameraStream: connection?.media.camera || null,
      screenStream: connection?.media.screen || null,
    };
  });
  set({ peers });
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
  } else if (message.type === 'call-desktop' && message.shared.id === state.call?.id) {
    set({ sharedDesktops: [...state.sharedDesktops.filter((item) => item.host !== message.shared.host), message.shared] });
  } else if (message.type === 'open' && state.call) {
    // Back online after a dropped connection: catch up on anything missed meanwhile.
    api(path()).then(applyCall).catch(() => {});
  }
}

function enter({ call, peerId, iceServers: servers }, notice) {
  iceServers = servers;
  clearTimeout(endedTimer);
  set({ phase: 'in-call', call, me: peerId, notice, muted: false, hand: false, sharedDesktops: [], startedAt: null });
  publishLocal();
  stopLive = subscribeLive(onLive);
  checkIn = setInterval(sendState, CHECK_IN_MS);
  applyCall(call);
  sendState();
}

async function begin(video, request) {
  if (state.phase === 'in-call' || state.phase === 'joining') await hangUp();
  clearTimeout(endedTimer);
  const mine = ++attempt;
  set({ ...IDLE, phase: 'joining' });
  try {
    const notice = await openDevices(video);
    if (mine !== attempt) return;
    const joined = await request();
    if (mine !== attempt) {
      api(`/calls/${joined.call.id}/leave`, { method: 'POST', body: { peerId: joined.peerId } }).catch(() => {});
      return;
    }
    enter(joined, notice);
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

export async function hangUp() {
  const { call, me, phase } = state;
  tearDown();
  set(IDLE);
  if (phase === 'in-call') await api(`/calls/${call.id}/leave`, { method: 'POST', body: { peerId: me } }).catch(() => {});
}

export function toggleMute() {
  if (!mic) return;
  mic.enabled = state.muted;
  set({ muted: !state.muted });
  sendState();
}

export async function toggleCamera() {
  if (camera) {
    camera.stop();
    camera = null;
    setChannel('camera', null);
  } else {
    try {
      camera = (await navigator.mediaDevices.getUserMedia({ video: cameraOptions(state.cameraDevice) })).getVideoTracks()[0];
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

export const clearNotice = () => set({ notice: '' });

export const inviteToCall = (to) => api(path('/invite'), { method: 'POST', body: { peerId: state.me, to } }).then(applyCall);

export const shareRemoteDesktop = (connectionId) => api(path('/remote-desktop'), { method: 'POST', body: { peerId: state.me, connectionId } });

export const dismissSharedDesktop = (host) => set({ sharedDesktops: state.sharedDesktops.filter((item) => item.host !== host) });

/** Change microphone or camera during a call. */
export async function chooseDevice(kind, deviceId) {
  try {
    if (kind === 'audioinput') {
      const next = (await navigator.mediaDevices.getUserMedia({ audio: micOptions(deviceId) })).getAudioTracks()[0];
      next.enabled = !state.muted;
      mic?.stop();
      mic = next;
      setChannel('audio', next);
      set({ micDevice: deviceId });
    } else if (kind === 'videoinput') {
      set({ cameraDevice: deviceId });
      if (camera) {
        const next = (await navigator.mediaDevices.getUserMedia({ video: cameraOptions(deviceId) })).getVideoTracks()[0];
        camera.stop();
        camera = next;
        setChannel('camera', next);
      }
    } else {
      set({ speakerDevice: deviceId });
    }
    publishLocal();
  } catch (err) {
    set({ notice: mediaError(err, kind === 'audioinput' ? 'microphone' : 'camera') });
  }
}

// Closing the tab: say goodbye so others don't wait for the timeout. An ordinary request wouldn't
// finish in time, and a beacon can't carry the header the server requires.
window.addEventListener('pagehide', () => {
  if (state.phase !== 'in-call') return;
  fetch(`/api${path('/leave')}`, {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
    body: JSON.stringify({ peerId: state.me }),
  }).catch(() => {});
});

window.addEventListener(LOGOUT_EVENT, () => {
  tearDown();
  set(IDLE);
});
