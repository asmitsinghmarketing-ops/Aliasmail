import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The first-login tour is remembered with the account: once per person, on any device.
const PORT = 9550 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
let server;
let dir;

const start = (file) => spawn(process.execPath, ['src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env, PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off', JWT_SECRET: 'tour-test-secret',
    MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '', MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
  },
  stdio: 'ignore',
});
const ready = async () => {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-tour-'));
  server = start(path.join(dir, 'db.json'));
  await ready();
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { body, call: (p, options = {}) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } }) };
}

test('the tour is offered once per account, kept across sign-ins, and separate for each person', async () => {
  const admin = await signIn(ADMIN);
  assert.equal(admin.body.user.tourDone, false, 'sign-in says so, for the first screen');
  for (const name of ['john', 'mary']) {
    assert.equal((await admin.call('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: `${name}@example.com`, displayName: name, password: 'long-password-123' }) })).status, 201);
  }

  const john = await signIn({ email: 'john@example.com', password: 'long-password-123' });
  assert.equal(john.body.user.tourDone, false);
  assert.equal((await john.call('/auth/tour', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await (await john.call('/auth/me')).json()).tourDone, true);

  // A new sign-in, as from another device.
  assert.equal((await signIn({ email: 'john@example.com', password: 'long-password-123' })).body.user.tourDone, true);
  // Finishing it again changes nothing.
  assert.equal((await john.call('/auth/tour', { method: 'POST', body: '{}' })).status, 200);

  // Everyone else is untouched.
  assert.equal((await signIn({ email: 'mary@example.com', password: 'long-password-123' })).body.user.tourDone, false);
  assert.equal((await (await admin.call('/auth/me')).json()).tourDone, false);

  // The administrator's is kept too.
  assert.equal((await admin.call('/auth/tour', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await (await admin.call('/auth/me')).json()).tourDone, true);

  // Only for someone signed in, and with the header that stops other websites sending it.
  assert.equal((await fetch(`${BASE}/api/auth/tour`, { method: 'POST', headers: HEADERS, body: '{}' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/auth/tour`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('it is still remembered after the server restarts', async () => {
  await new Promise((r) => setTimeout(r, 500)); // Saves are written shortly after they're made.
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  server = start(path.join(dir, 'db.json'));
  await ready();
  assert.equal((await signIn({ email: 'john@example.com', password: 'long-password-123' })).body.user.tourDone, true);
  assert.equal((await signIn({ email: 'mary@example.com', password: 'long-password-123' })).body.user.tourDone, false);
});

test('each person’s tab layout is kept on their account, and only tab names are accepted', async () => {
  const john = await signIn({ email: 'john@example.com', password: 'long-password-123' });
  assert.equal(john.body.user.layout, null);
  const layout = { rail: { order: ['notes', 'tasks'], hidden: ['meet'] }, inbox: { order: ['all', 'primary'], hidden: ['social'] } };
  const saved = await john.call('/auth/layout', { method: 'PUT', body: JSON.stringify(layout) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).layout, layout);
  assert.deepEqual((await signIn({ email: 'john@example.com', password: 'long-password-123' })).body.user.layout, layout, 'on another device too');
  assert.equal((await signIn({ email: 'mary@example.com', password: 'long-password-123' })).body.user.layout, null, 'nobody else’s');

  for (const bad of [[], 'x', { rail: 'x' }, { rail: { order: 'tasks' } }, { rail: { order: ['<script>'] } }, { inbox: { hidden: [1] } }, { rail: { order: Array.from({ length: 41 }, (_, i) => `t${i}`) } }]) {
    assert.equal((await john.call('/auth/layout', { method: 'PUT', body: JSON.stringify(bad) })).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  // Anything else sent along is dropped, and repeats are kept once.
  const extra = await (await john.call('/auth/layout', { method: 'PUT', body: JSON.stringify({ rail: { order: ['tasks', 'tasks'], hidden: [], colour: 'red' }, theme: 'dark' }) })).json();
  assert.deepEqual(extra.layout, { rail: { order: ['tasks'], hidden: [] } });
  // Empty means back to the usual tabs.
  assert.equal((await (await john.call('/auth/layout', { method: 'PUT', body: '{}' })).json()).layout, null);
  assert.equal((await (await john.call('/auth/me')).json()).layout, null);
  assert.equal((await fetch(`${BASE}/api/auth/layout`, { method: 'PUT', headers: HEADERS, body: '{}' })).status, 401);
});
