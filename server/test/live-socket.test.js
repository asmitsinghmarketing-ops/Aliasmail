import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// The live WebSocket: presence, typing, notes sent and received over the socket, and who may connect.
const PORT = 6800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = `ws://127.0.0.1:${PORT}/api/live`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };

let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-live-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'live-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

async function cookieFor(credentials) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' }, body: JSON.stringify(credentials),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** A socket like a browser's, collecting what arrives. */
function connect(cookie, origin = BASE) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LIVE, { headers: { Cookie: cookie, ...(origin && { Origin: origin }) } });
    const got = [];
    ws.on('message', (data) => got.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, got, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
}

const waitFor = async (got, test, ms = 3000) => {
  for (let i = 0; i < ms / 50; i++) {
    const found = got.find(test);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing arrived matching ${test}`);
};

test('presence, typing and notes travel over the socket; strangers and other sites are refused', async () => {
  const adminCookie = await cookieFor(ADMIN);
  for (const [address, name] of [['john@example.com', 'John'], ['mary@example.com', 'Mary']]) {
    await fetch(`${BASE}/api/admin/aliases`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
      body: JSON.stringify({ address, password: `${name.toLowerCase()}-password`, displayName: name }),
    });
  }
  const johnCookie = await cookieFor({ email: 'john@example.com', password: 'john-password' });
  const maryCookie = await cookieFor({ email: 'mary@example.com', password: 'mary-password' });

  await assert.rejects(connect(''), /refused 401/, 'not signed in');
  await assert.rejects(connect(maryCookie, 'https://evil.example'), /refused 401/, 'another website');

  const mary = await connect(maryCookie);
  assert.equal((await waitFor(mary.got, (m) => m.type === 'hello')).me, 'mary@example.com');
  const john = await connect(johnCookie);
  assert.deepEqual(await waitFor(mary.got, (m) => m.type === 'presence' && m.address === 'john@example.com'), { type: 'presence', address: 'john@example.com', online: true });
  const threads = await (await fetch(`${BASE}/api/notes/threads`, { headers: { Cookie: maryCookie } })).json();
  assert.equal(threads.find((t) => t.address === 'john@example.com').online, true);

  john.send({ type: 'typing', to: 'mary@example.com' });
  assert.equal((await waitFor(mary.got, (m) => m.type === 'typing')).from, 'john@example.com');

  john.send({ type: 'note', ref: 'r1', to: 'mary@example.com', text: 'Over the socket', files: [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }] });
  const sent = await waitFor(john.got, (m) => m.type === 'sent' && m.ref === 'r1');
  assert.equal(sent.note.files[0].name, 'a.txt');
  const arrived = await waitFor(mary.got, (m) => m.type === 'note');
  assert.deepEqual([arrived.note.text, arrived.note.fromName], ['Over the socket', 'John']);

  // A call started from Instant Notes rings every open window of the recipient; accepting it
  // tells the caller and returns the already validated Google Meet link.
  const callResponse = await fetch(`${BASE}/api/calls`, {
    method: 'POST',
    headers: { Cookie: johnCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
    body: JSON.stringify({ to: 'mary@example.com', link: 'https://meet.google.com/abc-defg-hij' }),
  });
  assert.equal(callResponse.status, 201);
  const call = await callResponse.json();
  const ringing = await waitFor(mary.got, (m) => m.type === 'incoming-call' && m.call.id === call.id);
  assert.deepEqual([ringing.call.from, ringing.call.to, ringing.call.link], ['john@example.com', 'mary@example.com', 'https://meet.google.com/abc-defg-hij']);
  const accepted = await fetch(`${BASE}/api/calls/${call.id}/respond`, {
    method: 'POST',
    headers: { Cookie: maryCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
    body: JSON.stringify({ answer: 'accept' }),
  });
  assert.equal((await accepted.json()).status, 'accepted');
  assert.equal((await waitFor(john.got, (m) => m.type === 'call-response' && m.id === call.id)).status, 'accepted');
  assert.equal((await waitFor(mary.got, (m) => m.type === 'call-ended' && m.id === call.id)).status, 'accepted');

  const cancellableResponse = await fetch(`${BASE}/api/calls`, {
    method: 'POST',
    headers: { Cookie: johnCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
    body: JSON.stringify({ to: 'mary@example.com', link: 'https://meet.google.com/xyz-abcd-efg' }),
  });
  const cancellable = await cancellableResponse.json();
  await waitFor(mary.got, (m) => m.type === 'incoming-call' && m.call.id === cancellable.id);
  const cancelled = await fetch(`${BASE}/api/calls/${cancellable.id}/cancel`, {
    method: 'POST', headers: { Cookie: johnCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' }, body: '{}',
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await waitFor(mary.got, (m) => m.type === 'call-ended' && m.id === cancellable.id)).status, 'cancelled');

  const badCall = await fetch(`${BASE}/api/calls`, {
    method: 'POST',
    headers: { Cookie: johnCookie, 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
    body: JSON.stringify({ to: 'mary@example.com', link: 'https://evil.example/fake-meeting' }),
  });
  assert.equal(badCall.status, 400);

  john.send({ type: 'note', ref: 'r2', to: 'nobody@else.test', text: 'x' });
  assert.match((await waitFor(john.got, (m) => m.type === 'error' && m.ref === 'r2')).error, /team/);

  mary.send({ type: 'read', ref: 'r3', with: 'john@example.com' });
  assert.equal((await waitFor(mary.got, (m) => m.type === 'done' && m.ref === 'r3')).changed, 1);
  assert.equal((await waitFor(john.got, (m) => m.type === 'note-read')).by, 'mary@example.com');

  john.ws.close();
  assert.equal((await waitFor(mary.got, (m) => m.type === 'presence' && m.address === 'john@example.com' && !m.online)).online, false);
  mary.ws.close();
});
