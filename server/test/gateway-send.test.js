import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Outside mail through GoDaddy's Node gateway: the real server with a stand-in gateway on its
// fixed address (127.0.0.1:2525) and a stand-in bridge.
const PORT = 5900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const gatewayCalls = [];
const bridgeCalls = [];
let gatewayMode = 'ok'; // ok | refuse | broken

let server;
let bridge;
let gateway;
let dir;
let gatewayAvailable = true;

test.before(async () => {
  gateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      gatewayCalls.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      if (gatewayMode === 'refuse') { res.statusCode = 400; return res.end(JSON.stringify({ success: false, error: 'from domain not verified' })); }
      if (gatewayMode === 'broken') { res.statusCode = 500; return res.end(JSON.stringify({ success: false, error: 'relay error' })); }
      res.end(JSON.stringify({ success: true, messageId: `gw-${gatewayCalls.length}` }));
    });
  });
  await new Promise((resolve) => {
    gateway.once('error', () => { gatewayAvailable = false; resolve(); });
    gateway.listen(2525, '127.0.0.1', resolve);
  });
  bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      bridgeCalls.push(data);
      res.setHeader('Content-Type', 'application/json');
      if (data.action === 'sync') return res.end(JSON.stringify({ uidValidity: '1', uids: [], seenUids: [], messages: [] }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-gateway-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'gateway-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}/`,
      MAIL_BRIDGE_TOKEN: 'bridge-token', MAIL_TRANSPORT: 'bridge', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, APP_URL: 'https://mail.example.com',
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
  bridge?.close();
  gateway?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { Cookie: cookie, 'X-Requested-With': 'AliasMail', ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
    if (set.length) cookie = set.join('; ');
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
  await call('POST', '/api/auth/login', credentials);
  return call;
}

const sendsOf = (action) => bridgeCalls.filter((c) => c.action === action).length;
const settle = () => new Promise((r) => setTimeout(r, 300));

test('outside mail goes through the gateway when switched on; the Sent copy still lands in the mailbox', async (t) => {
  if (!gatewayAvailable) return t.skip('port 2525 is in use on this machine');
  const admin = await signIn(ADMIN);
  assert.equal((await admin('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password', displayName: 'John' })).status, 201);
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });

  // Off by default: the usual route.
  await john('POST', '/api/mail/send', { to: 'client@outside.test', subject: 'Off', text: 'hi' });
  assert.equal(gatewayCalls.length, 0);
  assert.equal(sendsOf('sendRaw'), 1);

  assert.deepEqual((await admin('PATCH', '/api/admin/sending', { gateway: true })).data.gateway, true);
  const logo = (await fs.readFile(new URL('../../client/public/icon-192.png', import.meta.url))).toString('base64');
  const sent = await john('POST', '/api/mail/send', {
    to: 'client@outside.test', cc: 'owner@example.com', subject: 'Quote', text: 'Quote attached',
    html: `<p>Quote attached</p><img src="data:image/png;base64,${logo}">`,
    attachments: [{ filename: 'quote.txt', contentType: 'text/plain', content: Buffer.from('total 100').toString('base64') }],
  });
  assert.equal(sent.status, 201);
  const call = gatewayCalls.at(-1);
  assert.deepEqual([call.to, call.cc, call.subject, call.from], [['client@outside.test'], ['owner@example.com'], 'Quote', '"John" <john@example.com>']);
  assert.equal(Buffer.from(call.attachments[0].content, 'base64').toString(), 'total 100');
  // The picture is linked from this site instead of embedded, and that link works.
  const link = /src="(https:\/\/mail\.example\.com\/api\/avatars\/[^"]+)"/.exec(call.html)?.[1];
  assert.ok(link, call.html.slice(0, 200));
  const picture = await fetch(BASE + new URL(link).pathname);
  assert.equal(picture.status, 200);
  await settle();
  assert.equal(sendsOf('sendRaw'), 1, 'not sent a second time through the relay');
  assert.ok(sendsOf('saveSent') >= 1, 'Sent copy saved');
  assert.equal(sent.data.timing.route, 'GoDaddy Node gateway');
});

test('replies, mail only to our own aliases, and a gateway that refuses all go the usual way', async (t) => {
  if (!gatewayAvailable) return t.skip('port 2525 is in use on this machine');
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });
  const before = gatewayCalls.length;
  const relayed = sendsOf('sendRaw');

  await john('POST', '/api/mail/send', { to: 'client@outside.test', subject: 'Re: Quote', text: 'ok', inReplyTo: '<a@outside.test>' });
  await john('POST', '/api/mail/send', { to: 'owner@example.com', subject: 'Internal', text: 'hi' });
  assert.equal(gatewayCalls.length, before);
  assert.equal(sendsOf('sendRaw'), relayed + 2);

  gatewayMode = 'refuse';
  const refused = await john('POST', '/api/mail/send', { to: 'client@outside.test', subject: 'Still goes', text: 'hi' });
  assert.equal(refused.status, 201);
  assert.equal(gatewayCalls.length, before + 1);
  assert.equal(sendsOf('sendRaw'), relayed + 3);

  // A server error might have sent it: not sent again, it waits in the Outbox as uncertain.
  gatewayMode = 'broken';
  const unsure = await john('POST', '/api/mail/send', { to: 'client@outside.test', subject: 'Unsure', text: 'hi' });
  assert.equal(unsure.status, 202);
  assert.equal(unsure.data.uncertain, true);
  assert.equal(sendsOf('sendRaw'), relayed + 3);
  gatewayMode = 'ok';
});

test('the admin test sends one message through the gateway and reports how long it took', async (t) => {
  if (!gatewayAvailable) return t.skip('port 2525 is in use on this machine');
  const admin = await signIn(ADMIN);
  const result = (await admin('POST', '/api/admin/sending/test', { to: 'me@outside.test' })).data;
  assert.equal(result.ok, true);
  assert.equal(typeof result.ms, 'number');
  assert.deepEqual(gatewayCalls.at(-1).to, ['me@outside.test']);
  gatewayMode = 'refuse';
  const refused = (await admin('POST', '/api/admin/sending/test', { to: 'me@outside.test' })).data;
  assert.deepEqual([refused.ok, refused.notSent], [false, true]);
  assert.match(refused.reason, /not verified/);
  gatewayMode = 'ok';
  assert.equal((await admin('POST', '/api/admin/sending/test', { to: 'nope' })).status, 400);
});
