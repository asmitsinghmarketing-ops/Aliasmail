import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Group notes: made from teammates, notes and files only for members, unread and "seen by" per
// member, and who may rename, add, remove and leave.
const PORT = 8400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-groups-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'groups-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
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

async function signIn(credentials) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return (p, options = {}) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });
}

test('a group: notes and files for its members only, unread and seen per member, and who may change it', async () => {
  const admin = await signIn(ADMIN);
  for (const name of ['john', 'mary', 'lee', 'zed']) {
    await admin('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: `${name}@example.com`, password: `${name}-password-1`, displayName: name[0].toUpperCase() + name.slice(1) }) });
  }
  const john = await signIn({ email: 'john@example.com', password: 'john-password-1' });
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password-1' });
  const lee = await signIn({ email: 'lee@example.com', password: 'lee-password-1' });
  const zed = await signIn({ email: 'zed@example.com', password: 'zed-password-1' });

  // At least 2 other people, all teammates.
  assert.equal((await john('/notes/groups', { method: 'POST', body: JSON.stringify({ name: 'Two', members: ['mary@example.com'] }) })).status, 400);
  assert.equal((await john('/notes/groups', { method: 'POST', body: JSON.stringify({ name: 'X', members: ['mary@example.com', 'stranger@else.test'] }) })).status, 400);
  const created = await john('/notes/groups', { method: 'POST', body: JSON.stringify({ name: '  Sales   team ', members: ['mary@example.com', 'lee@example.com'] }) });
  assert.equal(created.status, 201);
  const group = await created.json();
  assert.deepEqual([group.name, group.members, group.createdBy], ['Sales team', ['john@example.com', 'mary@example.com', 'lee@example.com'], 'john@example.com']);

  // John writes with a file; the group's members see it, an outsider sees nothing.
  const sent = await john('/notes', { method: 'POST', body: JSON.stringify({ group: group.id, text: 'Price approved', files: [{ name: 'quote.txt', type: 'text/plain', data: Buffer.from('2.5 lakh').toString('base64') }] }) });
  assert.equal(sent.status, 201);
  const note = await sent.json();
  assert.deepEqual([note.group, note.to, note.readBy], [group.id, null, []]);

  const maryThreads = await (await mary('/notes/threads')).json();
  const room = maryThreads.find((t) => t.kind === 'group');
  assert.deepEqual([room.name, room.unread, room.last.text, room.members.length], ['Sales team', 1, 'Price approved', 3]);
  assert.equal((await (await mary('/notes/unread')).json()).unread, 1);
  assert.equal((await zed('/notes/threads').then((r) => r.json())).some((t) => t.kind === 'group'), false);
  assert.equal((await zed(`/notes?group=${group.id}`)).status, 404);
  assert.equal((await zed('/notes', { method: 'POST', body: JSON.stringify({ group: group.id, text: 'hi' }) })).status, 404);
  assert.equal((await mary(`/notes/files/${note.files[0].id}`)).status, 200);
  assert.equal((await zed(`/notes/files/${note.files[0].id}`)).status, 404);

  // Mary reads it: seen by Mary only; Lee still has it unread.
  assert.equal((await (await mary('/notes/read', { method: 'POST', body: JSON.stringify({ group: group.id }) })).json()).changed, 1);
  const history = await (await john(`/notes?group=${group.id}`)).json();
  assert.deepEqual(history[0].readBy, ['mary@example.com']);
  assert.equal((await (await lee('/notes/unread')).json()).unread, 1);
  assert.equal((await (await mary('/notes/unread')).json()).unread, 0);

  // Anyone can rename and add; only John (who made it) can remove; anyone can leave.
  assert.equal((await mary(`/notes/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Sales' }) })).status, 200);
  assert.equal((await mary(`/notes/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ members: ['john@example.com'] }) })).status, 403);
  const added = await (await mary(`/notes/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ members: ['john@example.com', 'lee@example.com', 'zed@example.com'] }) })).json();
  assert.deepEqual([added.name, added.members.length], ['Sales', 4]);
  assert.equal((await zed(`/notes?group=${group.id}`)).status, 200);
  assert.equal((await zed('/notes/groups/' + group.id + '/leave', { method: 'POST' })).status, 200);
  assert.equal((await zed(`/notes?group=${group.id}`)).status, 404);
  assert.equal((await zed(`/notes/files/${note.files[0].id}`)).status, 404);

  // One-to-one notes are unchanged and separate.
  await john('/notes', { method: 'POST', body: JSON.stringify({ to: 'mary@example.com', text: 'Direct' }) });
  const direct = await (await mary('/notes?with=john@example.com')).json();
  assert.deepEqual(direct.map((n) => n.text), ['Direct']);
});

test('notes can be reacted to, replied to with a quote, and deleted by their sender', async () => {
  const admin = await signIn(ADMIN);
  for (const name of ['amy', 'ben', 'cal']) {
    await admin('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: `${name}@example.com`, password: `${name}-password-1`, displayName: name[0].toUpperCase() + name.slice(1) }) });
  }
  const amy = await signIn({ email: 'amy@example.com', password: 'amy-password-1' });
  const ben = await signIn({ email: 'ben@example.com', password: 'ben-password-1' });
  const cal = await signIn({ email: 'cal@example.com', password: 'cal-password-1' });

  const first = await (await amy('/notes', { method: 'POST', body: JSON.stringify({ to: 'ben@example.com', text: 'Lunch at one?' }) })).json();
  assert.deepEqual([first.deleted, first.replyTo, first.reactions], [false, null, {}]);

  const liked = await (await ben(`/notes/${first.id}/react`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) })).json();
  assert.deepEqual(liked.reactions, { '👍': ['ben@example.com'] });
  const unliked = await (await ben(`/notes/${first.id}/react`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) })).json();
  assert.deepEqual(unliked.reactions, {}, 'reacting again takes it back');
  assert.equal((await ben(`/notes/${first.id}/react`, { method: 'POST', body: JSON.stringify({ emoji: '💩' }) })).status, 400);
  assert.equal((await cal(`/notes/${first.id}/react`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) })).status, 404, 'outsiders cannot see the note');

  const reply = await (await ben('/notes', { method: 'POST', body: JSON.stringify({ to: 'amy@example.com', text: 'Yes!', replyTo: first.id }) })).json();
  assert.deepEqual(reply.replyTo, { id: first.id, from: 'amy@example.com', text: 'Lunch at one?' });
  assert.equal((await cal('/notes', { method: 'POST', body: JSON.stringify({ to: 'amy@example.com', text: 'Me too', replyTo: first.id }) })).status, 400, 'only notes from the same conversation can be quoted');

  assert.equal((await ben(`/notes/${first.id}`, { method: 'DELETE' })).status, 403);
  const gone = await (await amy(`/notes/${first.id}`, { method: 'DELETE' })).json();
  assert.deepEqual([gone.deleted, gone.text, gone.files], [true, '', []]);
  const history = await (await ben('/notes?with=amy@example.com')).json();
  assert.deepEqual(history.map((n) => [n.deleted, n.text]), [[true, ''], [false, 'Yes!']]);
});
