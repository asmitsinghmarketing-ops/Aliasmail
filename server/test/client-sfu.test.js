import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareSfu, cloudflareSfuInternals } from '../../client/src/cloudflareSfu.js';

class PeerConnection {
  static instances = [];

  constructor() {
    this.transceivers = [];
    this.iceGatheringState = 'complete';
    this.connectionState = 'new';
    PeerConnection.instances.push(this);
  }

  addTransceiver(track) {
    const transceiver = {
      mid: String(this.transceivers.length),
      sender: { track, replaceTrack: async (next) => { transceiver.sender.track = next; } },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer() { return { type: 'offer', sdp: `offer-${this.transceivers.length}` }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) {
    this.remoteDescription = value;
    this.connectionState = 'connected';
  }
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = 'closed'; }
}

test('the browser SFU publishes, adds screen media, subscribes, and renegotiates', async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = PeerConnection;
  PeerConnection.instances = [];
  const requests = [];
  let sessions = 0;
  const post = async (path, body) => {
    requests.push({ path, body });
    if (path === '/sfu/session') return { sessionId: body.role === 'publish' ? `publisher-${++sessions}` : `subscriber-${++sessions}` };
    if (path.endsWith('/ready')) return { id: 'call', peers: [] };
    if (path.endsWith('/renegotiate')) return { ok: true };
    if (path.endsWith('/tracks')) {
      if (body.tracks[0].location === 'local') {
        return { tracks: body.tracks.map((track) => ({ mid: track.mid })), sessionDescription: { type: 'answer', sdp: 'sfu-answer' } };
      }
      return { tracks: body.tracks.map((track, index) => ({ mid: String(index) })), sessionDescription: { type: 'offer', sdp: 'sfu-offer' } };
    }
    throw new Error(`Unexpected request ${path}`);
  };

  try {
    const calls = [];
    const sfu = createCloudflareSfu({ post, peerId: 'me', onCall: (call) => calls.push(call) });
    await sfu.start({ audio: { kind: 'audio' }, camera: { kind: 'video' }, screen: null });
    await sfu.replace('screen', { kind: 'video' });
    await sfu.sync({ peers: [{ id: 'other', sfu: { sessionId: 'remote-publisher', tracks: ['audio', 'camera'] } }] });

    const local = requests.filter(({ path, body }) => path.endsWith('/tracks') && body.tracks[0].location === 'local');
    assert.deepEqual(local[0].body.tracks.map((track) => track.trackName), ['audio', 'camera']);
    assert.deepEqual(local[1].body.tracks.map((track) => track.trackName), ['screen']);
    const remote = requests.find(({ path, body }) => path.endsWith('/tracks') && body.tracks[0].location === 'remote');
    assert.deepEqual(remote.body.tracks.map((track) => track.trackName), ['audio', 'camera']);
    assert.ok(requests.some(({ path, body }) => path.endsWith('/renegotiate') && body.sessionDescription.type === 'answer'));
    assert.equal(calls.length, 2);
    sfu.close();
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});

test('SFU helper only accepts known publication names', () => {
  assert.equal(cloudflareSfuInternals.trackName('camera'), 'camera');
  assert.equal(cloudflareSfuInternals.trackName('screen'), 'screen');
  assert.equal(cloudflareSfuInternals.trackName('../secret'), null);
});
