import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Runs the real server against a throwaway data file and checks who can open which mailbox.
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/api`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };

let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-roles-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test',
      JWT_SECRET: 'roles-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, MAIL_TRANSPORT: 'direct',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A signed-in browser: keeps the session cookie and sends the CSRF header. */
async function signIn(credentials) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' }, body: JSON.stringify(credentials),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const call = async (method, url, { body, mailbox } = {}) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { 'X-Requested-With': 'AliasMail', Cookie: cookie || '', ...(body && { 'Content-Type': 'application/json' }), ...(mailbox && { 'X-Mailbox': mailbox }) },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  };
  return { status: res.status, call };
}

test('group mailboxes are shared only through roles, and only for reading and sending', async () => {
  const admin = await signIn(ADMIN);
  assert.equal(admin.status, 200);
  const add = (body) => admin.call('POST', '/admin/aliases', { body });
  const john = (await add({ address: 'john@example.com', password: 'john-password', type: 'personal' })).data;
  await add({ address: 'sara@example.com', password: 'sara-password' });
  const support = (await add({ address: 'support@example.com', type: 'group', displayName: 'Support' })).data;
  assert.equal(support.type, 'group');

  // A group mailbox has no sign-in of its own.
  assert.equal((await signIn({ email: 'support@example.com', password: '' })).status, 401);

  const role = await admin.call('POST', '/admin/roles', { body: { name: 'Support team', mailboxes: [support.id], members: [john.id] } });
  assert.equal(role.status, 201);
  // Personal mailboxes can't be put in a role as shared mailboxes.
  assert.equal((await admin.call('POST', '/admin/roles', { body: { name: 'Bad', mailboxes: [john.id] } })).status, 400);

  const asJohn = await signIn({ email: 'john@example.com', password: 'john-password' });
  const me = await asJohn.call('GET', '/auth/me');
  assert.deepEqual(me.data.mailboxes.map((m) => [m.address, m.roles]), [['support@example.com', ['Support team']]]);
  assert.equal((await asJohn.call('GET', '/mail/messages', { mailbox: 'support@example.com' })).status, 200);
  assert.equal((await asJohn.call('GET', '/mail/settings', { mailbox: 'support@example.com' })).data.address, 'support@example.com');

  // Another person's personal mailbox stays private.
  assert.equal((await asJohn.call('GET', '/mail/messages', { mailbox: 'sara@example.com' })).status, 403);
  // Settings of the shared mailbox can't be changed by members.
  assert.equal((await asJohn.call('PATCH', '/mail/settings', { mailbox: 'support@example.com', body: { displayName: 'x' } })).status, 403);
  assert.equal((await asJohn.call('DELETE', '/mail/settings/avatar', { mailbox: 'support@example.com' })).status, 403);
  // Their own settings still work.
  assert.equal((await asJohn.call('PATCH', '/mail/settings', { body: { displayName: 'John' } })).status, 200);

  // Without the role, nobody else gets in.
  const asSara = await signIn({ email: 'sara@example.com', password: 'sara-password' });
  assert.equal((await asSara.call('GET', '/mail/messages', { mailbox: 'support@example.com' })).status, 403);
  assert.deepEqual((await asSara.call('GET', '/auth/me')).data.mailboxes, []);

  // Removing someone from the role takes effect on their very next request.
  await admin.call('PATCH', `/admin/roles/${role.data.id}`, { body: { members: [] } });
  assert.equal((await asJohn.call('GET', '/mail/messages', { mailbox: 'support@example.com' })).status, 403);

  // The admin can open any group mailbox.
  assert.equal((await admin.call('GET', '/mail/messages', { mailbox: 'support@example.com' })).status, 200);
});

test('turning a personal mailbox into a group mailbox ends its sign-in', async () => {
  const admin = await signIn(ADMIN);
  const alias = (await admin.call('POST', '/admin/aliases', { body: { address: 'team@example.com', password: 'team-password' } })).data;
  const asTeam = await signIn({ email: 'team@example.com', password: 'team-password' });
  assert.equal((await asTeam.call('GET', '/mail/messages')).status, 200);

  await admin.call('PATCH', `/admin/aliases/${alias.id}`, { body: { type: 'group' } });
  assert.equal((await asTeam.call('GET', '/mail/messages')).status, 401);
  assert.equal((await signIn({ email: 'team@example.com', password: 'team-password' })).status, 401);

  // Back to personal needs a new password.
  assert.equal((await admin.call('PATCH', `/admin/aliases/${alias.id}`, { body: { type: 'personal' } })).status, 400);
  assert.equal((await admin.call('PATCH', `/admin/aliases/${alias.id}`, { body: { type: 'personal', password: 'new-password-1' } })).status, 200);
  assert.equal((await signIn({ email: 'team@example.com', password: 'new-password-1' })).status, 200);
});
