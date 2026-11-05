import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-tasks-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'tasks-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return (url, options = {}) => fetch(`${BASE}/api${url}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });
}

test('team projects and tasks validate ownership, assignment and status changes', async () => {
  const admin = await signIn(ADMIN);
  for (const name of ['john', 'mary']) {
    const response = await admin('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: `${name}@example.com`, password: `${name}-password-1`, displayName: name[0].toUpperCase() + name.slice(1) }) });
    assert.equal(response.status, 201);
  }
  const john = await signIn({ email: 'john@example.com', password: 'john-password-1' });
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password-1' });

  const madeProject = await admin('/tasks/projects', { method: 'POST', body: JSON.stringify({ name: 'Website launch', color: '#7048e8' }) });
  assert.equal(madeProject.status, 201);
  const project = await madeProject.json();
  assert.equal((await john(`/tasks/projects/${project.id}`, { method: 'DELETE' })).status, 403);

  const madeTask = await john('/tasks/items', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, title: 'Publish landing page', description: 'Review\nthen publish', assignee: 'mary@example.com', priority: 'high', dueDate: '2026-11-30' }),
  });
  assert.equal(madeTask.status, 201);
  const task = await madeTask.json();
  assert.deepEqual([task.status, task.assignee, task.priority, task.description], ['todo', 'mary@example.com', 'high', 'Review\nthen publish']);

  assert.equal((await john('/tasks/items', { method: 'POST', body: JSON.stringify({ projectId: project.id, title: 'Bad assignment', assignee: 'outside@example.net' }) })).status, 400);
  assert.equal((await john(`/tasks/items/${task.id}`, { method: 'PATCH', body: JSON.stringify({ dueDate: '2026-02-30' }) })).status, 400);

  const completed = await mary(`/tasks/items/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(completed.status, 200);
  assert.ok((await completed.json()).completedAt);
  const snapshot = await (await mary('/tasks')).json();
  assert.deepEqual([snapshot.projects.length, snapshot.tasks.length, snapshot.tasks[0].status], [1, 1, 'done']);

  const removed = await admin(`/tasks/projects/${project.id}`, { method: 'DELETE' });
  assert.deepEqual(await removed.json(), { ok: true, removedTasks: 1 });
  const empty = await (await john('/tasks')).json();
  assert.deepEqual([empty.projects.length, empty.tasks.length], [0, 0]);
});
