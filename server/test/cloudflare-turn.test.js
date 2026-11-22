import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIceServers } from '../src/cloudflare-turn.js';
import { iceServersFor } from '../src/routes/calls.js';

test('reads Cloudflare ice servers and drops port 53', () => {
  const servers = parseIceServers({
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'u',
        credential: 'c',
      },
    ],
  });
  assert.deepEqual(servers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
  ]);
});

test('reads the older single-object answer', () => {
  const servers = parseIceServers({ iceServers: { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' } });
  assert.deepEqual(servers, [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }]);
});

test('without Cloudflare set up, fixed TURN settings still work', () => {
  const servers = iceServersFor('a@x', { stunUrls: ['stun:s'], turnUrls: ['turn:t'], turnUsername: 'u', turnCredential: 'c', turnTtlSeconds: 600 });
  assert.deepEqual(servers, [{ urls: ['stun:s'] }, { urls: ['turn:t'], username: 'u', credential: 'c' }]);
});
