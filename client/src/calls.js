// A team call in this window: camera, microphone and screen media through Cloudflare SFU when it is
// configured, with the original direct WebRTC mesh as the no-SFU mode. Nothing here depends on React:
// call carries on while moving between mail, tasks and the rest of the app.
//
// Every connection has three fixed channels: microphone, camera, shared screen. Turning a camera or
// screen on or off only changes what goes into a channel, which needs no renegotiating and so can't
// collide with what the other side is doing. Of each pair, one side (the larger id) starts things.
import { api, LOGOUT_EVENT } from './api.js';
import { createCloudflareSfu } from './cloudflareSfu.js';
import { subscribe as subscribeLive } from './live.js';
import { canNativeScreenShare, startNativeScreenShare } from './nativeScreenShare.js';

const SLOTS = ['audio', 'camera', 'screen'];
const CHECK_IN_MS = 15_000;
const NETWORK_SAMPLE_MS = 4_000;
const RECONNECT_AFTER_MS = 5_000;
// After a repaired SFU endpoint stays healthy for this long, a later network handoff gets its own
// repair attempt instead of immediately moving the whole room to the peer-to-peer backup.
const SFU_STABLE_MS = 15_000;
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
  chat: [], // in-call messages: { id, from, name, guest, text, at, pending?, failed? }
  unread: 0, // chat messages that came in while the chat wasn't open
  networkQuality: 'unknown', // unknown | good | fair | poor
};

let chatOpen = false;

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
let networkSampler = null;
let endedTimer = null;
let attempt = 0; // Bumped to abandon a call still being set up.
let rejoining = false;
let wakeLock = null;
let sfu = null;
let sfuMedia = new Map(); // peer id -> { audio, camera, screen }
let sfuProblemShown = false;
let sfuNetwork = new WeakMap();
let sfuRetryCount = 0;
let sfuRetryTimer = null;
let sfuStableTimer = null;

const tracks = { audio: () => mic, camera: () => camera, screen: () => screen };

const usesSfu = () => state.call?.media === 'sfu';

function receiveSfuTrack(peerId, name, track) {
  const media = sfuMedia.get(peerId) || {};
  const stream = new MediaStream([track]);
  media[name] = stream;
  sfuMedia.set(peerId, media);
  track.onended = () => {
    if (sfuMedia.get(peerId)?.[name] !== stream) return;
    delete media[name];
    publishPeers();
  };
  publishPeers();
}

function reportSfuError(err) {
  if (state.phase !== 'in-call') return;
  clearTimeout(sfuStableTimer);
  sfuStableTimer = null;
  // A short network handoff or one failed renegotiation should not move every participant away
  // from SFU. Recreate this endpoint once; only a repeated failure changes the room topology.
  if (!sfuRetryCount && navigator.onLine !== false) {
    sfuRetryCount = 1;
    set({ notice: 'Reconnecting media…' });
    sfu?.close();
    sfu = null;
    sfuMedia = new Map();
    clearTimeout(sfuRetryTimer);
    sfuRetryTimer = setTimeout(() => {
      sfuRetryTimer = null;
      if (state.phase !== 'in-call' || !usesSfu()) return;
      ensureSfu();
      sfu?.sync(state.call).catch(() => {});
    }, 1200);
    return;
  }
  if (navigator.onLine === false) {
    sfu?.close();
    sfu = null;
    set({ notice: OFFLINE_NOTICE });
    return;
  }
  if (sfuProblemShown) return;
  sfuProblemShown = true;
  set({ notice: 'Cloudflare media couldn’t connect, so this meeting is switching to its backup connection.' });
  transport?.post('/media/fallback', { peerId: state.me, reason: String(err?.message || '').slice(0, 160) })
    .then((result) => applyCall(result.call || result, result.iceServers))
    .catch(() => {});
}

function ensureSfu() {
  if (!usesSfu() || sfu || !transport || state.phase !== 'in-call') return;
  sfu = createCloudflareSfu({
    post: transport.post,
    peerId: state.me,
    iceServers,
    onCall: applyCall,
    onMedia: receiveSfuTrack,
    onState: () => {
      const connected = sfu?.peerConnections().some((pc) => pc.connectionState === 'connected');
      if (state.notice === 'Reconnecting media…' && connected) set({ notice: '' });
      if (connected && sfuRetryCount && !sfuStableTimer) {
        const repaired = sfu;
        sfuStableTimer = setTimeout(() => {
          sfuStableTimer = null;
          if (sfu === repaired && repaired.peerConnections().some((pc) => pc.connectionState === 'connected')) sfuRetryCount = 0;
        }, SFU_STABLE_MS);
      } else if (!connected && sfuStableTimer) {
        clearTimeout(sfuStableTimer);
        sfuStableTimer = null;
      }
      publishPeers();
    },
    onError: reportSfuError,
  });
  sfu.start({ audio: mic, camera, screen }).catch(() => {});
}

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

/** Before joining (the join page): the devices picked there, and remembering a new pick. */
export const rememberedDevices = savedDevices;
export const rememberDevice = saveDevice;

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
/**
 * Phones stop the camera (and sometimes the microphone) while the call is in the background, e.g.
 * while someone answers a message in another app. That isn't a device being unplugged: note it,
 * and turn them back on as soon as the call is on screen again (see `resumeDevices`).
 */
const resumeOnReturn = { camera: false, mic: false };
const inBackground = () => document.visibilityState === 'hidden';

function useMic(track) {
  mic = track;
  const activeDevice = deviceOf(track);
  if (activeDevice) saveDevice('audioinput', activeDevice);
  track.onended = async () => {
    if (mic !== track || state.phase !== 'in-call') return;
    if (inBackground()) {
      resumeOnReturn.mic = true;
      mic = null;
      setChannel('audio', null);
      publishLocal();
      return;
    }
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
  const activeDevice = deviceOf(track);
  if (activeDevice) saveDevice('videoinput', activeDevice);
  track.onended = () => {
    if (camera !== track || state.phase !== 'in-call') return;
    camera = null;
    setChannel('camera', null);
    if (inBackground()) resumeOnReturn.camera = true;
    else set({ notice: 'Your camera was disconnected, so it has been turned off.' });
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
  sfu?.close();
  sfu = null;
  sfuMedia = new Map();
  sfuProblemShown = false;
  sfuRetryCount = 0;
  clearTimeout(sfuRetryTimer);
  sfuRetryTimer = null;
  clearTimeout(sfuStableTimer);
  sfuStableTimer = null;
  sfuNetwork = new WeakMap();
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
    const factor = connection.network?.quality === 'poor' ? 0.45 : connection.network?.quality === 'fair' ? 0.7 : 1;
    limitBitrate(transceivers[SLOTS.indexOf('camera')]?.sender, Math.round(cameraLimit * factor));
    limitBitrate(transceivers[SLOTS.indexOf('screen')]?.sender, Math.round(SCREEN_BITRATE * Math.max(0.65, factor)));
  }
}

/**
 * Read WebRTC counters and reduce video before a weak connection starts freezing. Audio is left
 * alone because intelligible speech matters more than a sharp picture on a constrained network.
 */
async function sampleConnection(connection) {
  if (connection.pc.connectionState !== 'connected' || !connection.pc.getStats) return;
  const reports = await connection.pc.getStats();
  let pair = null;
  let received = 0;
  let lost = 0;
  for (const report of reports.values()) {
    if (report.type === 'transport' && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId) || pair;
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) pair ||= report;
    if (report.type === 'inbound-rtp' && !report.isRemote) {
      received += Number(report.packetsReceived) || 0;
      lost += Math.max(0, Number(report.packetsLost) || 0);
    }
  }
  const previous = connection.networkTotals;
  connection.networkTotals = { received, lost };
  const receivedDelta = previous ? Math.max(0, received - previous.received) : 0;
  const lostDelta = previous ? Math.max(0, lost - previous.lost) : 0;
  const loss = receivedDelta + lostDelta ? lostDelta / (receivedDelta + lostDelta) : 0;
  const rttMs = Math.round((Number(pair?.currentRoundTripTime) || 0) * 1000);
  const quality = loss >= 0.08 || rttMs >= 600 ? 'poor' : loss >= 0.03 || rttMs >= 300 ? 'fair' : 'good';
  connection.network = { quality, loss, rttMs };
}

async function sampleNetwork() {
  if (state.phase !== 'in-call') return;
  if (usesSfu()) {
    const holders = (sfu?.peerConnections() || []).map((pc) => {
      let holder = sfuNetwork.get(pc);
      if (!holder) {
        holder = { pc };
        sfuNetwork.set(pc, holder);
      }
      return holder;
    });
    await Promise.all(holders.map((holder) => sampleConnection(holder).catch(() => {})));
    const qualities = holders.filter(({ pc }) => pc.connectionState === 'connected').map((holder) => holder.network?.quality || 'unknown');
    const networkQuality = qualities.includes('poor') ? 'poor' : qualities.includes('fair') ? 'fair' : qualities.includes('good') ? 'good' : 'unknown';
    if (state.networkQuality !== networkQuality) set({ networkQuality });
    publishPeers();
    return;
  }
  await Promise.all([...connections.values()].map((connection) => sampleConnection(connection).catch(() => {})));
  tuneSenders();
  const qualities = [...connections.values()]
    .filter((connection) => connection.pc.connectionState === 'connected')
    .map((connection) => connection.network?.quality || 'unknown');
  const networkQuality = qualities.includes('poor') ? 'poor' : qualities.includes('fair') ? 'fair' : qualities.includes('good') ? 'good' : 'unknown';
  publishPeers();
  if (state.networkQuality !== networkQuality) set({ networkQuality });
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
  if (usesSfu()) {
    ensureSfu();
    sfu?.replace(slot, track).catch(() => {});
    return;
  }
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

function closeSharePopup(event){

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
  if (usesSfu()) {
    const pcs = sfu?.peerConnections() || [];
    const connected = pcs.some((pc) => pc.connectionState === 'connected');
    const connecting = pcs.some((pc) => ['new', 'connecting'].includes(pc.connectionState));
    const peers = state.call.peers.filter((peer) => peer.id !== state.me).map((peer) => {
      const media = sfuMedia.get(peer.id) || {};
      return {
        ...peer,
        connection: media.audio || media.camera || media.screen ? 'connected' : connected ? 'connected' : connecting ? 'connecting' : 'new',
        stuck: false,
        networkQuality: state.networkQuality,
        networkRttMs: 0,
        packetLoss: 0,
        audio: media.audio || null,
        cameraStream: media.camera || null,
        screenStream: media.screen || null,
      };
    });
    set({ peers });
    return;
  }
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
      networkQuality: connection?.network?.quality || 'unknown',
      networkRttMs: connection?.network?.rttMs || 0,
      packetLoss: connection?.network?.loss || 0,
      audio: connection?.media.audio || null,
      cameraStream: connection?.media.camera || null,
      screenStream: connection?.media.screen || null,
    };
  });
  const backupRecovered = peers.some((peer) => peer.connection === 'connected')
    && state.notice === 'Cloudflare media couldn’t connect, so this meeting is switching to its backup connection.';
  const relayAvailable = iceServers.some(({ urls }) => (Array.isArray(urls) ? urls : [urls])
    .some((url) => /^turns?:/i.test(String(url || ''))));
  const stuckNotice = relayAvailable
    ? `Can’t establish a media path to ${stuckNames.join(', ')}, even with the call relay available. The call is retrying. A firewall, VPN, or unstable network may be interrupting WebRTC; try another network if this continues.`
    : `Can’t connect to ${stuckNames.join(', ')}. A network (often office Wi-Fi, a mobile hotspot or a VPN) is blocking a direct connection. Try another network, or ask your administrator to set up a call relay (TURN).`;
  set({
    peers,
    ...(backupRecovered && { notice: '' }),
    ...(stuckNames.length && { notice: stuckNotice }),
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
  if (usesSfu() && !sfu) {
    ensureSfu();
    sfu?.sync(state.call).catch(() => {});
  }
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
  clearInterval(networkSampler);
  networkSampler = null;
  stopLive?.();
  stopLive = null;
  [...connections.keys()].forEach(disconnect);
  connections = new Map();
  sfu?.close();
  sfu = null;
  sfuMedia = new Map();
  sfuProblemShown = false;
  sfuRetryCount = 0;
  clearTimeout(sfuRetryTimer);
  sfuRetryTimer = null;
  clearTimeout(sfuStableTimer);
  sfuStableTimer = null;
  sfuNetwork = new WeakMap();
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
function applyCall(call, servers) {
  if (state.phase !== 'in-call' || call.id !== state.call?.id) return;
  if (call.status === 'ended') return finish(call.reason);
  if (Array.isArray(servers) && servers.length) iceServers = servers;
  const others = call.peers.filter((peer) => peer.id !== state.me);
  const ids = new Set(others.map((peer) => peer.id));
  for (const id of [...connections.keys()]) if (!ids.has(id)) disconnect(id);
  for (const id of [...sfuMedia.keys()]) if (!ids.has(id)) sfuMedia.delete(id);
  set({ call, startedAt: state.startedAt || (others.length ? Date.now() : null) });
  if (call.media === 'sfu') {
    [...connections.keys()].forEach(disconnect);
    ensureSfu();
    sfu?.sync(call).catch(() => {});
  } else {
    if (sfu) {
      sfu.close();
      sfu = null;
      sfuMedia = new Map();
      sfuNetwork = new WeakMap();
      clearTimeout(sfuStableTimer);
      sfuStableTimer = null;
    }
    others.forEach((peer) => connect(peer.id));
    tuneSenders();
  }
  publishPeers();
}

function onLive(message) {
  if (message.type === 'call-room') applyCall(message.call, message.iceServers);
  else if (message.type === 'call-signal' && message.id === state.call?.id && message.to === state.me && message.data?.chat) {
    addChat([message.data.chat], !chatOpen);
  } else if (message.type === 'call-signal' && message.id === state.call?.id && message.to === state.me) {
    if (usesSfu()) return;
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
  set({ phase: 'in-call', call, me: peerId, notice, muted, hand: false, recording: false, guest: transport.guest, startedAt: null, speakerDevice: saved.audiooutput || 'default', cameraDevice: saved.videoinput });
  publishLocal();
  stopLive = transport.subscribe(onLive);
  checkIn = setInterval(checkInNow, CHECK_IN_MS);
  networkSampler = setInterval(sampleNetwork, NETWORK_SAMPLE_MS);
  applyCall(call);
  sendState();
  keepAwake();
  loadChat();
}

/* ---------------------------------- chat and reactions ---------------------------------- */

/** Messages in, oldest first, each once (history and live messages can overlap). */
function addChat(messages, countUnread = false) {
  const known = new Set(state.chat.map((message) => message.id));
  const fresh = messages.filter((message) => message?.id && !known.has(message.id));
  if (!fresh.length) return;
  const chat = [...state.chat, ...fresh].sort((a, b) => a.at - b.at);
  const unread = countUnread ? state.unread + fresh.filter((message) => message.from !== state.me).length : state.unread;
  set({ chat, unread });
}

/** What was said before this window joined (or while it was reconnecting). */
function loadChat() {
  const call = state.call?.id;
  transport?.post('/chat/history', { peerId: state.me })
    .then((result) => { if (state.call?.id === call) addChat(result?.items || []); })
    .catch(() => {});
}

/** The chat panel is open (nothing counts as unread) or closed. */
export function setChatOpen(open) {
  chatOpen = open;
  if (open && state.unread) set({ unread: 0 });
}

export async function sendChat(text) {
  const clean = String(text || '').trim();
  if (!clean || state.phase !== 'in-call') return;
  const draft = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, from: state.me, name: 'You', text: clean, at: Date.now(), pending: true };
  set({ chat: [...state.chat, draft] });
  try {
    const sent = await transport.post('/chat', { peerId: state.me, text: clean });
    set({ chat: state.chat.map((message) => (message.id === draft.id ? sent : message)) });
  } catch (err) {
    set({ chat: state.chat.map((message) => (message.id === draft.id ? { ...draft, pending: false, failed: err.message || 'Not sent' } : message)) });
  }
}

/** Try a message that didn't go again. */
export function resendChat(id) {
  const failed = state.chat.find((message) => message.id === id && message.failed);
  if (!failed) return;
  set({ chat: state.chat.filter((message) => message.id !== id) });
  void sendChat(failed.text);
}

export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🙏', '🤔'];

/** A quick emoji everyone sees float up for a moment. */
export function react(emoji) {
  if (state.phase !== 'in-call' || !REACTIONS.includes(emoji)) return Promise.resolve();
  return transport.post('/state', { peerId: state.me, reaction: emoji }).then(applyCall).catch(() => {});
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

/**
 * Screen capture support must be detected from the browser, not from the device name. Some mobile
 * browsers now expose getDisplayMedia while iOS and older Android browsers still do not. Trying the
 * real capability lets supported phones use the system share picker and leaves the picture fallback
 * for browsers that genuinely cannot capture their screen.
 */
const canShareScreen = () => canNativeScreenShare() || Boolean(navigator.mediaDevices?.getDisplayMedia);
export { canShareScreen };

let screenRedraw = null; // keeps a shared photo's picture flowing (see sharePicture)
let screenStarting = false; // two quick taps must not open two Android/browser capture prompts

function stopScreen() {
  clearInterval(screenRedraw);
  screenRedraw = null;
  const active = screen;
  screen = null;
  active?.stop();
  active?.nextspaceRelease?.();
  setChannel('screen', null);
  publishLocal();
  sendState();
}

export async function toggleScreen() {
  if (screen) {
    stopScreen();
    return true;
  }
  if (screenStarting) return true;
  if (!canShareScreen()) return false;
  screenStarting = true;
  const nativeScreen = canNativeScreenShare();
  try {
    const track = nativeScreen
      ? await startNativeScreenShare(() => { if (screen?.nextspaceNativeScreen) stopScreen(); })
      : (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })).getVideoTracks()[0];
    if (!track) return false;
    // The permission sheet can outlive a call. Do not start a ghost share after it has ended.
    if (state.phase !== 'in-call') {
      track.stop();
      await track.nextspaceRelease?.();
      return false;
    }
    // Keep text sharp rather than motion smooth.
    track.contentHint = 'detail';
    track.onended = stopScreen; // The browser's own "Stop sharing" button.
    screen = track;
    setChannel('screen', track);
    publishLocal();
    sendState();
    return true;
  } catch (err) {
    // The mobile dialog offers a screenshot immediately after native capture fails. Do not cover it
    // with a second generic error; desktop browsers still get their normal capture error notice.
    if (!nativeScreen && err?.name !== 'NotAllowedError') set({ notice: mediaError(err, 'screen') });
    return false;
  } finally {
    screenStarting = false;
  }
}

/**
 * Present a photo or screenshot (phones, whose browsers can't share the screen itself). It goes out
 * on the same channel as a shared screen, so everyone sees it the same way. Another call replaces it.
 */
export async function sharePicture(file) {
  if (state.phase !== 'in-call' || !file) return;
  const canvas = document.createElement('canvas');
  if (!canvas.captureStream) {
    set({ notice: 'This browser can’t present pictures in a call.' });
    return;
  }
  let picture;
  let released = false;
  let releasePicture = () => { released = true; };
  try {
    if (typeof createImageBitmap === 'function') {
      picture = await createImageBitmap(file);
      releasePicture = () => {
        if (released) return;
        released = true;
        picture.close?.();
      };
    }
    else {
      const url = URL.createObjectURL(file);
      releasePicture = () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(url);
      };
      picture = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
    }
  } catch {
    releasePicture();
    set({ notice: 'That file isn’t a picture this browser can open. Choose a photo or screenshot.' });
    return;
  }
  // At most 1920 × 1080, keeping its shape, so a tall phone screenshot stays tall.
  const scale = Math.min(1, 1920 / picture.width, 1080 / picture.height);
  canvas.width = Math.max(2, Math.round(picture.width * scale));
  canvas.height = Math.max(2, Math.round(picture.height * scale));
  const context = canvas.getContext('2d');
  const draw = () => context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  draw();
  const track = canvas.captureStream(5).getVideoTracks()[0];
  track.contentHint = 'detail';
  track.nextspaceRelease = releasePicture;
  const previousEnded = track.onended;
  track.onended = () => {
    previousEnded?.();
    releasePicture();
    if (screen === track) stopScreen();
  };
  if (screen) stopScreen();
  // A still picture produces no new frames by itself; some browsers then show the others nothing.
  screenRedraw = setInterval(() => {
    draw();
    track.requestFrame?.();
  }, 500);
  screen = track;
  setChannel('screen', track);
  publishLocal();
  sendState();
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
  if (document.visibilityState !== 'visible') return;
  catchUp();
  void resumeDevices();
});

/** Back on screen: turn on again whatever the phone stopped while the call was in the background. */
async function resumeDevices() {
  if (state.phase !== 'in-call') return;
  // Some phones end the track without telling us: check it too.
  if (camera?.readyState === 'ended') {
    camera = null;
    setChannel('camera', null);
    resumeOnReturn.camera = true;
  }
  if (mic?.readyState === 'ended') {
    mic = null;
    setChannel('audio', null);
    resumeOnReturn.mic = true;
  }
  const saved = savedDevices();
  if (resumeOnReturn.mic && !mic) {
    resumeOnReturn.mic = false;
    try {
      const track = (await navigator.mediaDevices.getUserMedia({ audio: micOptions(state.micDevice || saved.audioinput, false) })).getAudioTracks()[0];
      if (state.phase !== 'in-call' || mic) track.stop();
      else {
        track.enabled = !state.muted;
        useMic(track);
        setChannel('audio', track);
      }
    } catch (err) {
      set({ notice: `Your microphone couldn’t restart. ${mediaError(err, 'microphone')}` });
    }
  }
  if (resumeOnReturn.camera && !camera) {
    resumeOnReturn.camera = false;
    try {
      const track = (await navigator.mediaDevices.getUserMedia({ video: cameraOptions(state.cameraDevice || saved.videoinput, false) })).getVideoTracks()[0];
      if (state.phase !== 'in-call' || camera) track.stop();
      else {
        useCamera(track);
        setChannel('camera', track);
      }
    } catch (err) {
      set({ notice: `Your camera couldn’t restart. ${mediaError(err, 'camera')}` });
    }
  }
  publishLocal();
  sendState();
}

/*
 * The phone's / computer's own call controls (notification shade, lock screen, the browser's media
 * hub): the meeting's name, mute, camera and hang up, so the call is easy to handle from outside
 * the page. Browsers that don't know an action simply ignore it.
 */
let watchedLive = false;
function mediaAction(action, handler) {
  try {
    navigator.mediaSession?.setActionHandler(action, handler);
  } catch { /* not supported here */ }
}
watchCall(() => {
  const session = navigator.mediaSession;
  if (!session) return;
  const live = state.phase === 'in-call';
  try {
    if (live) {
      const title = state.call?.title || (state.peers.length ? state.peers.map((peer) => peer.name).join(', ') : 'Nextspace call');
      if (session.metadata?.title !== title && window.MediaMetadata) session.metadata = new window.MediaMetadata({ title, artist: 'Nextspace call', artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] });
      session.setMicrophoneActive?.(Boolean(mic) && !state.muted);
      session.setCameraActive?.(Boolean(camera));
    } else if (session.metadata?.artist === 'Nextspace call') session.metadata = null;
  } catch { /* older browsers */ }
  if (live === watchedLive) return;
  watchedLive = live;
  mediaAction('hangup', live ? () => { void hangUp(); } : null);
  mediaAction('togglemicrophone', live ? () => toggleMute() : null);
  mediaAction('togglecamera', live ? () => { void toggleCamera(); } : null);
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
