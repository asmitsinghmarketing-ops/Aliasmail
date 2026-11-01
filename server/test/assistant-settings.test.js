import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Admin console → Assistant: keys and models set in Nextspace (no hosting variables), the key
// never sent back or saved readable, the connection test, and only the admin can do it.
const PORT = 8100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
const KEY = 'sk-or-v1-test-secret-key-1234';

let server;
let router;
let dir;
const seen = [];

test.before(async () => {
  router = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-ai-settings-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'ai-settings-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', ASSISTANT_PROVIDER: '',
      OPENROUTER_URL: `http://127.0.0.1:${router.address().port}/api/v1`,
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
  router?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const cookieFor = async (credentials) => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
};

test('the admin sets the provider, key and model in Nextspace; the key stays secret', async () => {
  const admin = await cookieFor(ADMIN);
  const call = (p, options = {}, cookie = admin) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });

  const before = await (await call('/assistant/settings')).json();
  assert.equal(before.inUse.enabled, false);
  assert.deepEqual(before.keys.openrouter, { set: false, ending: '', from: null });

  const saved = await (await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ provider: 'openrouter', keys: { openrouter: KEY }, openrouterModel: 'test/model:free' }) })).json();
  assert.deepEqual(saved.keys.openrouter, { set: true, ending: '1234', from: 'nextspace' });
  assert.deepEqual(saved.inUse, { provider: 'openrouter', model: 'test/model:free', enabled: true });
  assert.ok(!JSON.stringify(saved).includes(KEY), 'the key is never sent back');

  // The connection test uses the saved key.
  const tested = await (await call('/assistant/settings/test', { method: 'POST' })).json();
  assert.deepEqual([tested.ok, tested.reply, tested.model], [true, 'OK', 'test/model:free']);
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen.at(-1).body.tools, undefined);

  // Bad input is refused; the key is stored encrypted.
  assert.equal((await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ openrouterModel: 'bad model name!' }) })).status, 400);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!(await fs.readFile(path.join(dir, 'db.json'), 'utf8')).includes(KEY), 'not saved readable');

  // A key or model in the wrong tab is refused with a pointer to the right one.
  const wrongKey = await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ keys: { anthropic: 'AIzaSyFakeGeminiKey0000000000000000' } }) });
  assert.equal(wrongKey.status, 400);
  assert.match((await wrongKey.json()).error, /Google Gemini key/);
  const wrongModel = await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ model: 'gemini-3.8-flash' }) });
  assert.equal(wrongModel.status, 400);
  assert.match((await wrongModel.json()).error, /isn’t a Claude model/);

  // Removing the key turns the Assistant off again.
  const removed = await (await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ keys: { openrouter: null } }) })).json();
  assert.equal(removed.inUse.enabled, false);

  // Only the admin.
  await call('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: 'john@example.com', password: 'john-password', displayName: 'John' }) });
  const john = await cookieFor({ email: 'john@example.com', password: 'john-password' });
  assert.equal((await call('/assistant/settings', {}, john)).status, 403);
  assert.equal((await call('/assistant/settings', { method: 'PUT', body: JSON.stringify({ provider: 'gemini' }) }, john)).status, 403);
});
