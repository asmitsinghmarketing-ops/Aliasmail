import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

// The real server with a stand-in bridge holding one message (with a PDF) for john@example.com.
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const pdf = crypto.randomBytes(40_000);
const sent = [];
let sendMode = 'ok'; // ok | spam | down

let server;
let bridge;
let dir;

test.before(async () => {
  const raw = await new MailComposer({
    from: 'client@outside.test', to: 'john@example.com', subject: 'Contract', text: 'Please see the contract.',
    attachments: [{ filename: 'Contract.pdf', contentType: 'application/pdf', content: pdf }],
  }).compile().build();
  bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      if (data.action === 'sync') {
        if (data.folder !== 'inbox' || (data.knownUids || []).includes(1)) return reply({ uidValidity: '1', uids: data.folder === 'inbox' ? [1] : [], seenUids: [], messages: [] });
        return reply({ uidValidity: '1', uids: [1], seenUids: [], messages: [{ uid: 1, raw: raw.toString('base64'), size: raw.length, hasAttachments: true }] });
      }
      if (data.action === 'fetch') return reply({ raw: raw.toString('base64') });
      if (data.action === 'fetchMany') return reply({ messages: [{ uid: 1, raw: raw.toString('base64') }] });
      if (data.action === 'sendRaw') {
        if (sendMode === 'spam') { res.statusCode = 502; return reply({ error: 'SMTP rejected command: 550 This message was classified as SPAM and may not be delivered' }); }
        if (sendMode === 'down') { res.statusCode = 502; return reply({ error: 'SMTP connection failed: Connection timed out (110)' }); }
        sent.push(Buffer.from(data.raw, 'base64'));
        return reply({ ok: true });
      }
      reply({ ok: true });
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-forward-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'forward-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}/`,
      MAIL_BRIDGE_TOKEN: 'bridge-token', MAIL_TRANSPORT: 'bridge', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
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
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { Cookie: cookie, 'X-Requested-With': 'AliasMail', ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    if (set) cookie = set;
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/api/auth/login', credentials)).status, 200);
  return call;
}

test('forwarding sends the original attachment, only for someone who can open the message', async () => {
  const admin = await signIn(ADMIN);
  await admin('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password' });
  await admin('POST', '/api/admin/aliases', { address: 'mary@example.com', password: 'mary-password' });
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });
  await john('POST', '/api/mail/refresh');
  const list = await john('GET', '/api/mail/messages?folder=inbox');
  const msg = list.data.items.find((m) => m.subject === 'Contract');
  assert.ok(msg, 'john sees the message');
  const opened = await john('GET', `/api/mail/messages/${msg.id}`);
  const att = opened.data.attachments[0];
  assert.equal(att.filename, 'Contract.pdf');

  const forward = { kind: 'inbox', id: msg.id, index: att.index };
  const ok = await john('POST', '/api/mail/send', {
    to: 'partner@outside.test', subject: 'Fwd: Contract', text: 'FYI',
    attachments: [{ filename: att.filename, contentType: att.contentType, size: att.size, forward }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const parsed = await simpleParser(sent.at(-1));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'Contract.pdf');
  assert.deepEqual(parsed.attachments[0].content, pdf);

  // Mary can't see john's mail, so she can't forward its attachment either.
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password' });
  const refused = await mary('POST', '/api/mail/send', {
    to: 'x@outside.test', subject: 'Fwd', text: '', attachments: [{ filename: 'Contract.pdf', size: 1, forward }],
  });
  assert.equal(refused.status, 404);
  assert.equal(sent.length, 1);
});

test('a message that cannot be sent waits in the Outbox instead of being lost', async () => {
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });
  const before = sent.length;
  const outbox = async () => (await john('GET', '/api/mail/messages?folder=outbox')).data.items;

  // Refused by the mail server: kept as failed with the reason, not retried automatically.
  sendMode = 'spam';
  const refused = await john('POST', '/api/mail/send', { to: 'a@outside.test', subject: '', text: 'He' });
  assert.equal(refused.status, 202);
  assert.equal(refused.data.queued, true);
  assert.equal(refused.data.retrying, false);
  assert.match(refused.data.error, /classified as SPAM/);

  // Temporary trouble: queued for an automatic retry.
  sendMode = 'down';
  const later = await john('POST', '/api/mail/send', { to: 'b@outside.test', subject: 'Report', text: 'Attached soon' });
  assert.equal(later.status, 202);
  assert.equal(later.data.retrying, true);

  let items = await outbox();
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.subject === '').failed, true);
  assert.equal(items.find((i) => i.subject === 'Report').failed, false);
  assert.equal((await john('GET', '/api/mail/folders')).data.outbox, 2);
  assert.equal((await john('GET', '/api/mail/folders')).data.scheduled, 0);

  // Retry now, with the mail server working again: both go out and the Outbox empties.
  sendMode = 'ok';
  assert.equal((await john('POST', '/api/mail/outbox/retry', { ids: items.map((i) => i.id) })).status, 200);
  for (let i = 0; i < 50 && (await outbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
  items = await outbox();
  assert.equal(items.length, 0);
  assert.equal(sent.length, before + 2);
});
