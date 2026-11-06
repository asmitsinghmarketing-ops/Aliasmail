import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// Calls inside Nextspace: who can join, what each window can do, how a call ends, and that remote
// desktops stay private to their owner. The audio and video itself is the browsers' job.
const PORT = 8700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
const TURN_SECRET = 'turn-test-secret';
const PEOPLE = ['john', 'mary', 'sara', 'omar', 'lena', 'noah', 'tom'];

let server;
let dir;
const cookies = {};
const sockets = [];

const call = (who, p, body) => fetch(`${BASE}/api${p}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...HEADERS, Cookie: cookies[who] },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (who, p, body) => (await call(who, p, body)).json();

function listen(who) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/live`, { headers: { Cookie: cookies[who], Origin: BASE } });
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw)));
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, got }));
    ws.on('error', reject);
  });
}

async function waitFor(got, match, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = got.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out; got: ${JSON.stringify(got.map((m) => m.type))}`);
}

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-calls-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'calls-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '', MAIL_TRANSPORT: 'direct',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, CALL_TURN_URLS: 'turn:turn.example.com:3478', CALL_TURN_SECRET: TURN_SECRET,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = async (credentials) => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  cookies.admin = await login(ADMIN);
  for (const name of PEOPLE) {
    const made = await call('admin', '/admin/aliases', { address: `${name}@example.com`, displayName: name, password: 'long-password-123' });
    assert.equal(made.status, 201);
    cookies[name] = await login({ email: `${name}@example.com`, password: 'long-password-123' });
  }
});

test.after(async () => {
  sockets.forEach((ws) => ws.close());
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

const start = (who, to, video = false) => json(who, '/calls', { to, video });

test('a call rings, connects, passes connection details between windows, and ends', async () => {
  const john = await listen('john');
  const mary = await listen('mary');
  const started = await start('john', 'mary@example.com', true);
  assert.equal(started.call.status, 'ringing');
  assert.ok(started.peerId);

  const ringing = await waitFor(mary.got, (m) => m.type === 'incoming-call' && m.call.id === started.call.id);
  assert.deepEqual([ringing.call.from, ringing.call.video], ['john@example.com', true]);

  // Short-lived TURN sign-in that the TURN server can check, and the secret itself never sent.
  const stun = started.iceServers.find((server) => String(server.urls).includes('stun:'));
  assert.ok(stun);
  const turn = started.iceServers.find((server) => String(server.urls).includes('turn:'));
  assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
  assert.equal(turn.credential, crypto.createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64'));
  assert.ok(!JSON.stringify(started).includes(TURN_SECRET));

  const joined = await json('mary', `/calls/${started.call.id}/join`, {});
  assert.equal(joined.call.peers.length, 2);
  assert.equal((await waitFor(mary.got, (m) => m.type === 'call-ended' && m.id === started.call.id)).status, 'accepted');
  const room = await waitFor(john.got, (m) => m.type === 'call-room' && m.call.peers.length === 2);
  assert.equal(room.call.status, 'active');

  const sent = await call('john', `/calls/${started.call.id}/signal`, { peerId: started.peerId, to: joined.peerId, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.equal(sent.status, 204);
  const signal = await waitFor(mary.got, (m) => m.type === 'call-signal');
  assert.deepEqual([signal.from, signal.to, signal.data.description.sdp], [started.peerId, joined.peerId, 'x']);

  await call('mary', `/calls/${started.call.id}/state`, { peerId: joined.peerId, muted: true, camera: true, sharing: true, hand: true });
  const updated = await waitFor(john.got, (m) => m.type === 'call-room' && m.call.peers.some((peer) => peer.muted));
  assert.deepEqual(['muted', 'camera', 'sharing', 'hand'].map((key) => updated.call.peers.find((peer) => peer.id === joined.peerId)[key]), [true, true, true, true]);

  // When one of two leaves, the call is over for the other.
  await call('mary', `/calls/${started.call.id}/leave`, { peerId: joined.peerId });
  const over = await waitFor(john.got, (m) => m.type === 'call-room' && m.call.status === 'ended');
  assert.equal(over.call.reason, 'ended');
  assert.equal((await call('john', `/calls/${started.call.id}/join`, {})).status, 409);
});

test('nobody outside a call can see it, join it, or speak for someone in it', async () => {
  const started = await start('john', 'mary@example.com');
  const id = started.call.id;
  const omar = 'omar';
  assert.equal((await call(omar, `/calls/${id}`)).status, 404);
  assert.equal((await call(omar, `/calls/${id}/join`, {})).status, 404);
  assert.equal((await call(omar, `/calls/${id}/respond`, { answer: 'decline' })).status, 404);
  assert.equal((await call(omar, `/calls/${id}/signal`, { peerId: started.peerId, to: started.peerId, data: {} })).status, 404);
  // Mary is invited, but can't use John's place in the call.
  assert.equal((await call('mary', `/calls/${id}/leave`, { peerId: started.peerId })).status, 404);
  assert.equal((await call('mary', `/calls/${id}/signal`, { peerId: started.peerId, to: started.peerId, data: {} })).status, 404);
  // Connection details must be small and for someone in the call.
  assert.equal((await call('john', `/calls/${id}/signal`, { peerId: started.peerId, to: 'nobody', data: {} })).status, 404);
  assert.equal((await call('john', `/calls/${id}/signal`, { peerId: started.peerId, to: started.peerId, data: { sdp: 'x'.repeat(70_000) } })).status, 400);
  await call('john', `/calls/${id}/leave`, { peerId: started.peerId });

  assert.equal((await call('john', '/calls', { to: 'john@example.com' })).status, 400);
  assert.equal((await call('john', '/calls', { to: 'nobody@else.test' })).status, 400);
  assert.equal((await call('john', '/calls', { to: [] })).status, 400);
});

test('declining or cancelling ends a call nobody joined, and tells everyone why', async () => {
  const john = await listen('john');
  const mary = await listen('mary');

  const declined = await start('john', 'mary@example.com');
  await waitFor(mary.got, (m) => m.type === 'incoming-call' && m.call.id === declined.call.id);
  assert.equal((await call('mary', `/calls/${declined.call.id}/respond`, { answer: 'decline' })).status, 200);
  assert.equal((await waitFor(john.got, (m) => m.type === 'call-room' && m.call.id === declined.call.id && m.call.status === 'ended')).call.reason, 'declined');
  assert.equal((await call('mary', `/calls/${declined.call.id}/respond`, { answer: 'decline' })).status, 409);

  const cancelled = await start('john', 'mary@example.com');
  await waitFor(mary.got, (m) => m.type === 'incoming-call' && m.call.id === cancelled.call.id);
  await call('john', `/calls/${cancelled.call.id}/leave`, { peerId: cancelled.peerId });
  assert.equal((await waitFor(mary.got, (m) => m.type === 'call-ended' && m.id === cancelled.call.id)).status, 'cancelled');
  assert.equal((await json('mary', `/calls/${cancelled.call.id}`)).ringingForMe, false);
});

test('a group call carries on when one person leaves or declines, and has a size limit', async () => {
  const started = await start('john', ['mary@example.com', 'sara@example.com', 'omar@example.com']);
  const id = started.call.id;
  const mary = await json('mary', `/calls/${id}/join`, {});
  await call('sara', `/calls/${id}/respond`, { answer: 'decline' });
  const omar = await json('omar', `/calls/${id}/join`, {});
  assert.equal(omar.call.peers.length, 3);
  await call('omar', `/calls/${id}/leave`, { peerId: omar.peerId });
  const after = await json('mary', `/calls/${id}`);
  assert.deepEqual([after.status, after.peers.length], ['active', 2]);

  // Someone in the call can add someone; someone not in it can't.
  assert.equal((await call('lena', `/calls/${id}/invite`, { peerId: mary.peerId, to: ['noah@example.com'] })).status, 404);
  const lena = await listen('lena');
  assert.equal((await call('mary', `/calls/${id}/invite`, { peerId: mary.peerId, to: ['lena@example.com'] })).status, 200);
  await waitFor(lena.got, (m) => m.type === 'incoming-call' && m.call.id === id);
  await call('john', `/calls/${id}/leave`, { peerId: started.peerId });
  await call('mary', `/calls/${id}/leave`, { peerId: mary.peerId });

  assert.equal((await call('john', '/calls', { to: PEOPLE.filter((name) => name !== 'john').map((name) => `${name}@example.com`) })).status, 400);
});

test('remote desktops are checked, private to their owner, and share no sign-in details', async () => {
  const bad = [
    { host: '' },
    { host: 'pc.example.com\r\ndrivestoredirect:s:*' },
    { host: 'bad host' },
    { host: 'pc.example.com', port: 70000 },
    { host: 'pc.example.com', username: 'me\nredirectclipboard:i:1' },
    { host: 'pc.example.com', gateway: 'not a host' },
  ];
  for (const body of bad) assert.equal((await call('john', '/remote-desktops', body)).status, 400, JSON.stringify(body));

  const res = await call('john', '/remote-desktops', { name: 'Office PC', host: 'Office-PC.example.com', username: 'john', domain: 'corp', gateway: 'rd.example.com' });
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.deepEqual([saved.host, saved.port, saved.owner], ['office-pc.example.com', 3389, undefined]);
  assert.equal((await json('john', '/remote-desktops')).length, 1);
  assert.deepEqual(await json('mary', '/remote-desktops'), []);

  const asMary = (method) => fetch(`${BASE}/api/remote-desktops/${saved.id}`, { method, headers: { ...HEADERS, Cookie: cookies.mary }, body: method === 'PUT' ? JSON.stringify({ host: 'evil.example.com' }) : undefined });
  assert.equal((await asMary('PUT')).status, 404);
  assert.equal((await asMary('DELETE')).status, 404);

  // Shared in a call: where to connect, but not John's user name or domain.
  const mary = await listen('mary');
  const started = await start('john', 'mary@example.com');
  const joined = await json('mary', `/calls/${started.call.id}/join`, {});
  assert.equal((await call('mary', `/calls/${started.call.id}/remote-desktop`, { peerId: joined.peerId, connectionId: saved.id })).status, 404);
  assert.equal((await call('john', `/calls/${started.call.id}/remote-desktop`, { peerId: started.peerId, connectionId: saved.id })).status, 204);
  const shared = await waitFor(mary.got, (m) => m.type === 'call-desktop');
  assert.deepEqual([shared.shared.host, shared.shared.name, shared.shared.fromName], ['office-pc.example.com', 'Office PC', 'john']);
  assert.ok(!JSON.stringify(shared).includes('corp') && !('username' in shared.shared));
  await call('john', `/calls/${started.call.id}/leave`, { peerId: started.peerId });

  const removed = await fetch(`${BASE}/api/remote-desktops/${saved.id}`, { method: 'DELETE', headers: { ...HEADERS, Cookie: cookies.john } });
  assert.equal(removed.status, 204);
});
