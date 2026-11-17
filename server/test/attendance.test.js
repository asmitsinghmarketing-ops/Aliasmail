import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attendanceStatus, OFFLINE_AFTER_MS } from '../src/routes/attendance.js';

const PORT = 9500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
let server;
let dir;

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const response = await fetch(`${BASE}/api${url}`, {
      method,
      headers: { ...HEADERS, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
  };
}

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nextspace-attendance-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'attendance-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '', MAIL_TRANSPORT: 'direct',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('people clock themselves in and out; only the admin sees team attendance', async () => {
  const admin = browser();
  assert.equal((await admin('POST', '/auth/login', ADMIN)).status, 200);
  assert.equal((await admin('POST', '/admin/aliases', { address: 'john@example.com', displayName: 'John', password: 'john-password-123' })).status, 201);

  const john = browser();
  assert.equal((await john('POST', '/auth/login', { email: 'john@example.com', password: 'john-password-123' })).status, 200);
  const empty = await john('GET', '/attendance');
  assert.deepEqual([empty.data.status, empty.data.current, empty.data.team.length], ['clocked-out', null, 0]);

  const clocked = await john('POST', '/attendance/clock-in', {});
  assert.equal(clocked.status, 201);
  assert.equal(clocked.data.status, 'online');
  const duplicate = await john('POST', '/attendance/clock-in', {});
  assert.equal(duplicate.data.id, clocked.data.id);

  const away = await john('POST', '/attendance/heartbeat', { active: false });
  assert.equal(away.data.status, 'away');
  const adminView = await admin('GET', '/attendance');
  const member = adminView.data.team.find((person) => person.address === 'john@example.com');
  assert.equal(member.status, 'away');
  assert.ok(adminView.data.sessions.some((session) => session.person === 'john@example.com'));

  const done = await john('POST', '/attendance/clock-out', {});
  assert.equal(done.data.status, 'clocked-out');
  assert.ok(done.data.clockOutAt);
  assert.equal((await john('POST', '/attendance/heartbeat', { active: true })).status, 409);
});

test('a missing heartbeat changes a clocked-in laptop to offline', () => {
  const earlier = new Date(Date.now() - OFFLINE_AFTER_MS - 1000).toISOString();
  assert.equal(attendanceStatus({ clockInAt: earlier, lastSeenAt: earlier, presence: 'active' }), 'offline');
  assert.equal(attendanceStatus({ clockInAt: earlier, lastSeenAt: new Date().toISOString(), presence: 'away' }), 'away');
});
