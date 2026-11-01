import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

// Team workflow: To do / Waiting / Done, an owner per conversation, and team-only notes.
const PORT = 6200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };

let server;
let bridge;
let dir;

test.before(async () => {
  const raw = await new MailComposer({ from: 'Prince <prince@client.test>', to: 'john@example.com', subject: 'Proposal', text: 'Can we talk Monday?' }).compile().build();
  bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      if (data.action === 'sync') {
        if (data.folder !== 'inbox' || (data.knownUids || []).includes(1)) return reply({ uidValidity: '1', uids: data.folder === 'inbox' ? [1] : [], seenUids: [], messages: [] });
        return reply({ uidValidity: '1', uids: [1], seenUids: [], messages: [{ uid: 1, raw: raw.toString('base64'), size: raw.length }] });
      }
      if (data.action === 'fetch' || data.action === 'fetchLite') return reply({ raw: raw.toString('base64') });
      if (data.action === 'fetchMany') return reply({ messages: [{ uid: 1, raw: raw.toString('base64') }] });
      reply({ ok: true });
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-team-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'team-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}/`,
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

const ids = (list) => list.data.items.map((i) => i.id);

test('a conversation moves between To do, Waiting and Done, gets an owner and team notes', async () => {
  const admin = await signIn(ADMIN);
  await admin('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password', displayName: 'John' });
  const john = await signIn({ email: 'john@example.com', password: 'john-password' });
  await john('POST', '/api/mail/refresh');

  assert.deepEqual(ids(await john('GET', '/api/mail/messages?folder=todo')), [1]);
  assert.equal((await john('GET', '/api/mail/folders')).data.todo, 1);

  await john('POST', '/api/mail/messages/action', { ids: [1], action: 'waiting' });
  assert.deepEqual(ids(await john('GET', '/api/mail/messages?folder=todo')), []);
  const waiting = await john('GET', '/api/mail/messages?folder=waiting');
  assert.deepEqual([ids(waiting), waiting.data.items[0].waiting], [[1], true]);

  // Owner: only someone on the team; everyone who can see it sees the owner.
  const team = (await john('GET', '/api/mail/team')).data.map((p) => p.address);
  assert.deepEqual(team.sort(), ['john@example.com', 'owner@example.com']);
  assert.equal((await john('PATCH', '/api/mail/messages/1/team', { assignee: 'stranger@else.test' })).status, 400);
  assert.equal((await john('PATCH', '/api/mail/messages/1/team', { assignee: 'owner@example.com' })).data.assignee, 'owner@example.com');
  assert.deepEqual(ids(await admin('GET', '/api/mail/messages?folder=assigned')), [1]);
  assert.equal((await admin('GET', '/api/mail/folders')).data.assigned, 1);

  // Team notes: shown with the message, removable only by their author.
  assert.equal((await john('POST', '/api/mail/messages/1/notes', { text: '  ' })).status, 400);
  const noted = await john('POST', '/api/mail/messages/1/notes', { text: 'Pricing approved by finance' });
  assert.equal(noted.status, 201);
  const opened = (await admin('GET', '/api/mail/messages/1')).data;
  assert.equal(opened.sender.threads, 1);
  assert.deepEqual([opened.team.assignee, opened.team.notes[0].text, opened.team.notes[0].by, opened.notes], ['owner@example.com', 'Pricing approved by finance', 'john@example.com', 1]);
  const noteId = opened.team.notes[0].id;

  await john('POST', '/api/mail/messages/action', { ids: [1], action: 'done' });
  assert.deepEqual(ids(await john('GET', '/api/mail/messages?folder=done')), [1]);
  assert.deepEqual(ids(await john('GET', '/api/mail/messages?folder=waiting')), []);
  await john('POST', '/api/mail/messages/action', { ids: [1], action: 'todo' });
  assert.deepEqual(ids(await john('GET', '/api/mail/messages?folder=todo')), [1]);

  assert.equal((await john('DELETE', `/api/mail/messages/1/notes/${noteId}`)).data.notes.length, 0);
});
