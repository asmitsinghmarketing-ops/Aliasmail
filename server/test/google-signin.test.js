import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The real server, with a stand-in for Google's token endpoint.
const PORT = 4800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

let server;
let google;
let dir;
let nextIdentity = null; // what the fake Google says the next sign-in is
const nonces = new Map(); // code -> nonce

const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test.before(async () => {
  google = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const nonce = nonces.get(form.get('code'));
      res.setHeader('Content-Type', 'application/json');
      if (!nonce || !form.get('code_verifier') || form.get('client_id') !== CLIENT_ID) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      res.end(JSON.stringify({ id_token: idToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce, ...nextIdentity }) }));
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-google-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'google-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '', MAIL_TRANSPORT: 'direct',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.address().port}/token`,
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
  google?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A browser: a cookie jar, manual redirects, and the CSRF header on changes. */
function browser() {
  const jar = new Map();
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(method !== 'GET' && { 'X-Requested-With': 'AliasMail' }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k);
      else jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
  /** Start a Google round trip and come back from "Google" as `identity`. */
  const viaGoogle = async (mode, identity, { tamperState = false } = {}) => {
    const start = await call('GET', `/api/auth/google/start?mode=${mode}`);
    if (start.status !== 303 || !start.location.includes('client_id')) return start;
    const sent = new URL(start.location);
    const code = `code-${Math.random()}`;
    nonces.set(code, sent.searchParams.get('nonce'));
    nextIdentity = identity;
    const state = tamperState ? 'forged' : sent.searchParams.get('state');
    return call('GET', `/api/auth/google/callback?code=${code}&state=${state}`);
  };
  return { call, viaGoogle, jar };
}

const JOHN_GOOGLE = { sub: 'google-john-1', email: 'john@example.com', email_verified: true, name: 'John' };

test('a Google account connected in Settings can then sign in', async () => {
  const admin = browser();
  await admin.call('POST', '/api/auth/login', ADMIN);
  await admin.call('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password' });

  // Not connected yet: refused, even though the email matches.
  const stranger = browser();
  assert.equal((await stranger.viaGoogle('login', JOHN_GOOGLE)).location, '/?google=not-linked');

  // Connect it while signed in with the password.
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  assert.equal((await john.viaGoogle('link', JOHN_GOOGLE)).location, '/?google=linked');
  assert.equal((await john.call('GET', '/api/auth/mfa')).data.google.email, 'john@example.com');

  // Now Google sign-in works, from a fresh browser.
  const phone = browser();
  assert.equal((await phone.viaGoogle('login', JOHN_GOOGLE)).location, '/?google=continue');
  const finished = await phone.call('POST', '/api/auth/google/finish');
  assert.equal(finished.data.user.email, 'john@example.com');
  assert.equal((await phone.call('GET', '/api/auth/me')).data.email, 'john@example.com');
  // The result can't be used twice.
  assert.equal((await phone.call('POST', '/api/auth/google/finish')).status, 401);
});

test('a forged return from Google, or an unknown Google account, is refused', async () => {
  const b = browser();
  assert.equal((await b.viaGoogle('login', JOHN_GOOGLE, { tamperState: true })).location, '/?google=error');
  assert.equal((await browser().viaGoogle('login', { sub: 'someone-else', email: 'x@gmail.com' })).location, '/?google=not-linked');
  // Linking needs a signed-in session.
  assert.equal((await browser().call('GET', '/api/auth/google/start?mode=link')).location, '/?google=signin-first');
});

test('one Google account can only be connected to one alias', async () => {
  const admin = browser();
  await admin.call('POST', '/api/auth/login', ADMIN);
  await admin.call('POST', '/api/admin/aliases', { address: 'sara@example.com', password: 'sara-password' });
  const sara = browser();
  await sara.call('POST', '/api/auth/login', { email: 'sara@example.com', password: 'sara-password' });
  assert.equal((await sara.viaGoogle('link', JOHN_GOOGLE)).location, '/?google=in-use');
});

test('2-step verification still applies, and a new password from the admin cuts Google off', async () => {
  const admin = browser();
  await admin.call('POST', '/api/auth/login', ADMIN);
  await admin.call('PATCH', '/api/admin/security', { requireMfa: true });
  const b = browser();
  await b.viaGoogle('login', JOHN_GOOGLE);
  const finished = await b.call('POST', '/api/auth/google/finish');
  assert.equal(finished.data.mfa, 'setup');
  assert.equal((await b.call('GET', '/api/auth/me')).status, 401);
  await admin.call('PATCH', '/api/admin/security', { requireMfa: false });

  const john = (await admin.call('GET', '/api/admin/overview')).data.aliases.find((a) => a.address === 'john@example.com');
  assert.equal(john.googleEmail, 'john@example.com');
  await admin.call('PATCH', `/api/admin/aliases/${john.id}`, { password: 'brand-new-password' });
  assert.equal((await browser().viaGoogle('login', JOHN_GOOGLE)).location, '/?google=not-linked');
});
