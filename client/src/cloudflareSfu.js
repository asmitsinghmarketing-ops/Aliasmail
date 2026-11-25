// Browser half of Cloudflare Realtime SFU. The server owns the App Secret and authorizes every
// operation; this module only exchanges SDP and media tracks through the call-scoped proxy routes.

const TRACK_NAMES = ['audio', 'camera', 'screen'];
const GATHER_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 12_000;

const waitForIce = (pc, timeout = GATHER_TIMEOUT_MS) => new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  let timer;
  const done = () => {
    clearTimeout(timer);
    pc.removeEventListener('icegatheringstatechange', changed);
    resolve();
  };
  const changed = () => pc.iceGatheringState === 'complete' && done();
  pc.addEventListener('icegatheringstatechange', changed);
  timer = setTimeout(done, timeout);
  return undefined;
});

const description = (value) => ({ type: value.type, sdp: value.sdp });
const waitForConnection = (pc, timeout = CONNECT_TIMEOUT_MS) => new Promise((resolve, reject) => {
  if (pc.connectionState === 'connected') return resolve();
  let timer;
  const done = (error) => {
    clearTimeout(timer);
    pc.removeEventListener('connectionstatechange', changed);
    if (error) reject(error);
    else resolve();
  };
  const changed = () => {
    if (pc.connectionState === 'connected') done();
    else if (['failed', 'closed'].includes(pc.connectionState)) done(new Error('Cloudflare SFU media connection failed'));
  };
  pc.addEventListener('connectionstatechange', changed);
  timer = setTimeout(() => done(new Error('Cloudflare SFU media connection timed out')), timeout);
  return undefined;
});
const trackName = (value) => (TRACK_NAMES.includes(value) ? value : null);
const requireTracks = (result, expected, action) => {
  const outcomes = Array.isArray(result?.tracks) ? result.tracks : [];
  const failed = outcomes.find((track) => track?.errorCode);
  if (failed) throw new Error(failed.errorDescription || `Cloudflare could not ${action} a media track`);
  if (outcomes.length < expected || outcomes.some((track) => track?.mid === undefined)) throw new Error(`Cloudflare did not ${action} every media track`);
  return outcomes;
};

// Bound each publication so larger rooms remain usable on ordinary connections and do not burn
// through Cloudflare's egress allowance with twelve independent full-bitrate 720p feeds.
const sendEncodings = (name) => [{
  maxBitrate: name === 'audio' ? 48_000 : name === 'screen' ? 1_500_000 : 550_000,
  ...(name !== 'audio' && { maxFramerate: name === 'screen' ? 20 : 24 }),
}];

export function createCloudflareSfu({ post, peerId, iceServers = [], onCall, onMedia, onState, onError }) {
  const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }, ...iceServers];
  let closed = false;
  let publisher = null;
  let subscriber = null;
  let publishWork = Promise.resolve();
  let subscribeWork = Promise.resolve();

  const fail = (err) => {
    if (!closed) onError?.(err);
    throw err;
  };

  const makePeer = () => new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' });

  async function createSession(role) {
    const result = await post('/sfu/session', { peerId, role });
    if (!result?.sessionId) throw new Error('Cloudflare did not create an SFU session');
    return result.sessionId;
  }

  async function publishInitial(local) {
    const available = TRACK_NAMES.filter((name) => local[name]);
    if (!available.length || closed) return;
    const pc = makePeer();
    const transceivers = new Map();
    for (const name of available) transceivers.set(name, pc.addTransceiver(local[name], { direction: 'sendonly', sendEncodings: sendEncodings(name) }));
    const value = { pc, sessionId: null, transceivers, published: new Set(), connected: false };
    publisher = value;
    pc.onconnectionstatechange = () => {
      value.connected = pc.connectionState === 'connected';
      onState?.();
    };
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    const sessionId = await createSession('publish');
    if (closed || publisher?.pc !== pc) return pc.close();
    publisher.sessionId = sessionId;
    const result = await post(`/sfu/${encodeURIComponent(sessionId)}/tracks`, {
      peerId,
      sessionDescription: description(pc.localDescription),
      tracks: available.map((name) => ({ location: 'local', mid: transceivers.get(name).mid, trackName: name })),
    });
    if (!result?.sessionDescription) throw new Error('Cloudflare did not answer the publishing offer');
    requireTracks(result, available.length, 'publish');
    await pc.setRemoteDescription(result.sessionDescription);
    await waitForConnection(pc);
    available.forEach((name) => publisher.published.add(name));
    const call = await post(`/sfu/${encodeURIComponent(sessionId)}/ready`, { peerId, tracks: available });
    onCall?.(call);
  }

  async function addPublication(name, mediaTrack) {
    if (!publisher) return publishInitial({ [name]: mediaTrack });
    const current = publisher.transceivers.get(name);
    if (current) return current.sender.replaceTrack(mediaTrack || null);
    if (!mediaTrack || !publisher.sessionId) return undefined;
    const transceiver = publisher.pc.addTransceiver(mediaTrack, { direction: 'sendonly', sendEncodings: sendEncodings(name) });
    publisher.transceivers.set(name, transceiver);
    await publisher.pc.setLocalDescription(await publisher.pc.createOffer());
    await waitForIce(publisher.pc);
    const result = await post(`/sfu/${encodeURIComponent(publisher.sessionId)}/tracks`, {
      peerId,
      sessionDescription: description(publisher.pc.localDescription),
      tracks: [{ location: 'local', mid: transceiver.mid, trackName: name }],
    });
    if (!result?.sessionDescription) throw new Error(`Cloudflare did not add the ${name} track`);
    requireTracks(result, 1, 'publish');
    await publisher.pc.setRemoteDescription(result.sessionDescription);
    publisher.published.add(name);
    const call = await post(`/sfu/${encodeURIComponent(publisher.sessionId)}/ready`, { peerId, tracks: [name] });
    onCall?.(call);
    return undefined;
  }

  async function ensureSubscriber() {
    if (subscriber) return subscriber;
    const pc = makePeer();
    const sessionId = await createSession('subscribe');
    const value = { pc, sessionId, mids: new Map(), subscriptions: new Set(), connected: false };
    subscriber = value;
    pc.ontrack = ({ track, transceiver }) => {
      const locator = value.mids.get(transceiver.mid);
      if (locator) onMedia?.(locator.peerId, locator.name, track);
    };
    pc.onconnectionstatechange = () => {
      value.connected = pc.connectionState === 'connected';
      onState?.();
    };
    return value;
  }

  async function subscribe(call) {
    if (closed) return;
    const wanted = [];
    for (const peer of call?.peers || []) {
      if (peer.id === peerId || !peer.sfu?.sessionId) continue;
      for (const raw of peer.sfu.tracks || []) {
        const name = trackName(raw);
        if (!name) continue;
        const key = `${peer.sfu.sessionId}:${name}`;
        if (!subscriber?.subscriptions.has(key)) wanted.push({ key, peerId: peer.id, name, sessionId: peer.sfu.sessionId });
      }
    }
    if (!wanted.length) return;
    const receiving = await ensureSubscriber();
    const fresh = wanted.filter(({ key }) => !receiving.subscriptions.has(key));
    if (!fresh.length) return;
    const result = await post(`/sfu/${encodeURIComponent(receiving.sessionId)}/tracks`, {
      peerId,
      tracks: fresh.map(({ sessionId, name }) => ({ location: 'remote', sessionId, trackName: name })),
    });
    const results = requireTracks(result, fresh.length, 'subscribe to');
    fresh.forEach((item, index) => {
      const mid = results[index]?.mid;
      if (mid !== undefined && !results[index]?.errorCode) {
        receiving.mids.set(String(mid), item);
        receiving.subscriptions.add(item.key);
      }
    });
    if (!result?.sessionDescription) throw new Error('Cloudflare did not offer the subscribed tracks');
    await receiving.pc.setRemoteDescription(result.sessionDescription);
    await receiving.pc.setLocalDescription(await receiving.pc.createAnswer());
    await waitForIce(receiving.pc);
    await post(`/sfu/${encodeURIComponent(receiving.sessionId)}/renegotiate`, {
      peerId, sessionDescription: description(receiving.pc.localDescription),
    });
  }

  return {
    start(local) {
      publishWork = publishWork.then(() => publishInitial(local)).catch(fail);
      return publishWork;
    },
    replace(name, mediaTrack) {
      if (!trackName(name)) return Promise.resolve();
      publishWork = publishWork.then(() => addPublication(name, mediaTrack)).catch(fail);
      return publishWork;
    },
    sync(call) {
      subscribeWork = subscribeWork.then(() => subscribe(call)).catch(fail);
      return subscribeWork;
    },
    peerConnections() {
      return [publisher?.pc, subscriber?.pc].filter(Boolean);
    },
    close() {
      closed = true;
      publisher?.pc.close();
      subscriber?.pc.close();
      publisher = subscriber = null;
    },
  };
}

export const cloudflareSfuInternals = { waitForIce, waitForConnection, trackName, sendEncodings };
