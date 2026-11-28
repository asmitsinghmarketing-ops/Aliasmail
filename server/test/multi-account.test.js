import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Several accounts on one browser (an admin account and a personal one): add, list, switch,
// signing in again replaces the older sign-in, and signing out hands over to the next account.
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-accounts-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'accounts-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
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

/** A tiny browser: keeps cookies between calls. */
function browser() {
  const jar = new Map();
  return async (route, { method = 'GET', body } = {}) => {
    const res = await fetch(`${BASE}/api${route}`, {
      method,
      headers: { ...HEADERS, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name); else jar.set(name, value);
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('an admin and a personal account side by side', async () => {
  const admin = browser();
  assert.equal((await admin('/auth/login', { method: 'POST', body: ADMIN })).status, 200);
  const made = await admin('/admin/aliases', { method: 'POST', body: { address: 'me@example.com', password: 'personal-pass-1' } });
  assert.equal(made.status, 201);

  const call = browser();
  await call('/auth/login', { method: 'POST', body: ADMIN });
  const added = await call('/auth/accounts/add', { method: 'POST' });
  assert.equal(added.status, 200);
  assert.equal((await call('/auth/me')).status, 401, 'the sign-in page comes up while adding');
  assert.deepEqual((await call('/auth/accounts')).body.accounts.map((a) => a.email), [ADMIN.email]);

  await call('/auth/login', { method: 'POST', body: { email: 'me@example.com', password: 'personal-pass-1' } });
  let accounts = (await call('/auth/accounts')).body.accounts;
  assert.deepEqual(accounts.map((a) => [a.email, a.current, a.role]), [['me@example.com', true, 'user'], [ADMIN.email, false, 'admin']]);

  const switched = await call('/auth/accounts/switch', { method: 'POST', body: { id: accounts[1].id } });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.user.role, 'admin');
  assert.equal((await call('/auth/me')).body.email, ADMIN.email);
  accounts = (await call('/auth/accounts')).body.accounts;
  assert.deepEqual(accounts.map((a) => [a.email, a.current]), [[ADMIN.email, true], ['me@example.com', false]]);

  // Signing in again to a kept account replaces it instead of listing it twice.
  await call('/auth/accounts/add', { method: 'POST' });
  await call('/auth/login', { method: 'POST', body: { email: 'me@example.com', password: 'personal-pass-1' } });
  accounts = (await call('/auth/accounts')).body.accounts;
  assert.deepEqual(accounts.map((a) => a.email), ['me@example.com', ADMIN.email]);

  assert.equal((await call('/auth/accounts/switch', { method: 'POST', body: { id: 'not-a-session' } })).status, 404);

  // Signing out of one account leaves the other signed in.
  const out = await call('/auth/logout', { method: 'POST' });
  assert.equal(out.body.switched, true);
  assert.equal((await call('/auth/me')).body.email, ADMIN.email);
  const last = await call('/auth/logout', { method: 'POST' });
  assert.equal(last.body.switched, undefined);
  assert.equal((await call('/auth/me')).status, 401);
  assert.deepEqual((await call('/auth/accounts')).body.accounts, []);
});
