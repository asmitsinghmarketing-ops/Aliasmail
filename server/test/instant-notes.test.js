import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Instant notes between teammates: pushed at once over the live connection, files private to the pair.
const PORT = 6500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };

let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-notes-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'notes-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' }, body: JSON.stringify(credentials),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { Cookie: cookie, 'X-Requested-With': 'AliasMail', ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, data: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { call, cookie };
}

/** Collect the live-connection events for one person until `count` notes have arrived. */
function listen(cookie) {
  const controller = new AbortController();
  const received = [];
  const ready = fetch(`${BASE}/api/mail/events`, { headers: { Cookie: cookie }, signal: controller.signal }).then(async (res) => {
    const reader = res.body.getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += Buffer.from(value).toString();
      for (const block of buffer.split('\n\n').slice(0, -1)) {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event === 'note') received.push(JSON.parse(data));
      }
      buffer = buffer.split('\n\n').at(-1);
    }
  });
  return { received, stop: () => controller.abort(), ready };
}

test('a note with a file reaches the teammate at once, and only the two of them can open the file', async () => {
  const admin = await signIn(ADMIN);
  await admin.call('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password', displayName: 'John' });
  await admin.call('POST', '/api/admin/aliases', { address: 'mary@example.com', password: 'mary-password', displayName: 'Mary' });
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password' });

  const live = listen(mary.cookie);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal((await john.call('POST', '/api/notes', { to: 'stranger@else.test', text: 'hi' })).status, 400);
  assert.equal((await john.call('POST', '/api/notes', { to: 'mary@example.com', text: '  ' })).status, 400);
  const sent = await john.call('POST', '/api/notes', {
    to: 'mary@example.com', text: 'Price approved — invoice attached',
    files: [{ name: 'invoice.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') }],
  });
  assert.equal(sent.status, 201);

  for (let i = 0; i < 30 && !live.received.length; i++) await new Promise((r) => setTimeout(r, 100));
  live.stop();
  assert.equal(live.received.length, 1, 'pushed over the live connection');
  assert.deepEqual([live.received[0].from, live.received[0].fromName, live.received[0].text, live.received[0].files[0].name], ['john@example.com', 'John', 'Price approved — invoice attached', 'invoice.pdf']);

  assert.equal((await mary.call('GET', '/api/notes/unread')).data.unread, 1);
  const thread = (await mary.call('GET', '/api/notes/threads')).data.find((t) => t.address === 'john@example.com');
  assert.deepEqual([thread.unread, thread.last.text], [1, 'Price approved — invoice attached']);

  const fileId = sent.data.files[0].id;
  const file = await mary.call('GET', `/api/notes/files/${fileId}`);
  assert.equal(file.data.toString(), '%PDF-1.4 test');
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal((await admin.call('GET', `/api/notes/files/${fileId}`)).status, 404, 'not for anyone else');

  await mary.call('POST', '/api/notes/read', { with: 'john@example.com' });
  assert.equal((await mary.call('GET', '/api/notes/unread')).data.unread, 0);
  assert.deepEqual((await john.call('GET', '/api/notes?with=mary@example.com')).data.map((n) => [n.text, n.read]), [['Price approved — invoice attached', true]]);
});
