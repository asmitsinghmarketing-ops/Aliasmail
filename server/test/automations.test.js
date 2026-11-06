import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 9000 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
let server;
let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-automations-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'automations-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '',
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

test('users save, activate and run allowlisted workflows with logs and ownership', async () => {
  const admin = await signIn(ADMIN);
  for (const name of ['john', 'mary']) {
    const response = await admin('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: `${name}@example.com`, password: `${name}-password-1`, displayName: name[0].toUpperCase() + name.slice(1) }) });
    assert.equal(response.status, 201);
  }
  const john = await signIn({ email: 'john@example.com', password: 'john-password-1' });
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password-1' });
  const project = await (await admin('/tasks/projects', { method: 'POST', body: JSON.stringify({ name: 'Sales', color: '#0b5cd5' }) })).json();

  const plan = {
    name: 'New lead follow-up',
    description: 'Creates the team follow-up work without arbitrary code.',
    steps: [
      { action: 'create_task', label: 'Create sales task', params: { projectId: project.id, title: 'Follow up: {{input.text}}', assignee: 'mary@example.com', priority: 'high' } },
      { action: 'send_note', label: 'Tell Mary', params: { to: 'mary@example.com', text: 'New lead: {{input.text}}' } },
      { action: 'create_draft', label: 'Prepare reply', params: { to: 'lead@example.net', subject: 'Thanks for contacting us', body: 'We received: {{input.text}}' } },
      { action: 'notify_user', label: 'Notify Mary', params: { to: 'mary@example.com', title: 'Lead automation completed', body: '{{input.text}}' } },
    ],
  };
  const made = await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'Follow up a lead', plan }) });
  assert.equal(made.status, 201);
  const automation = await made.json();
  assert.equal(automation.enabled, false);
  assert.equal((await admin(`/automations/${automation.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 404, 'another account cannot change it');
  assert.equal((await john(`/automations/${automation.id}/run`, { method: 'POST', body: JSON.stringify({ input: { text: 'Acme website audit' } }) })).status, 404, 'draft cannot run');

  assert.equal((await john(`/automations/${automation.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 200);
  const queued = await john(`/automations/${automation.id}/run`, { method: 'POST', body: JSON.stringify({ input: { text: 'Acme website audit' } }) });
  assert.equal(queued.status, 202);
  const runId = (await queued.json()).id;
  let snapshot;
  for (let i = 0; i < 50; i++) {
    snapshot = await (await john('/automations')).json();
    if (snapshot.runs.find((run) => run.id === runId)?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = snapshot.runs.find((item) => item.id === runId);
  assert.deepEqual([run.status, run.steps.length, run.steps.every((step) => step.status === 'completed')], ['completed', 4, true]);

  const tasks = (await (await john('/tasks')).json()).tasks;
  assert.ok(tasks.some((task) => task.title === 'Follow up: Acme website audit' && task.assignee === 'mary@example.com'));
  const notes = await (await mary('/notes?with=john%40example.com')).json();
  assert.ok(notes.some((note) => note.text === 'New lead: Acme website audit'));
  const draftId = run.steps.find((step) => step.action === 'create_draft').result.id;
  const draft = await (await john(`/mail/drafts/${draftId}`)).json();
  assert.deepEqual([draft.to, draft.subject, draft.text], ['lead@example.net', 'Thanks for contacting us', 'We received: Acme website audit']);
  const notifications = await (await mary('/notifications')).json();
  assert.ok(notifications.items.some((item) => item.type === 'automation' && item.body === 'Acme website audit'));

  const unsafe = await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'Run code', plan: { name: 'Unsafe', steps: [{ action: 'run_javascript', params: { code: 'process.exit()' } }] } }) });
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).error, /unsupported function/i);
  assert.equal((await john(`/automations/${automation.id}`, { method: 'DELETE' })).status, 200);
});
