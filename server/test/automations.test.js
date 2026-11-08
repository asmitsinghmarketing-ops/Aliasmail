import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 9000 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
let server;
let dir;
let model;
let answers = [];
const prompts = [];

test.before(async () => {
  // Stands in for the AI model: gives the next prepared answer, and remembers what it was asked.
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      prompts.push(JSON.stringify(JSON.parse(body).messages));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answers.shift() }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-automations-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'automations-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', ASSISTANT_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test/model', OPENROUTER_URL: `http://127.0.0.1:${model.address().port}/api/v1`,
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
  model?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function signIn(credentials) {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return (url, options = {}) => fetch(`${BASE}/api${url}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });
}

test('users save and run allowlisted workflows with logs and ownership', async () => {
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
  assert.equal((await admin(`/automations/${automation.id}/run`, { method: 'POST', body: JSON.stringify({ input: { text: 'x' } }) })).status, 404, 'another account cannot run it');
  const noInput = await john(`/automations/${automation.id}/run`, { method: 'POST', body: JSON.stringify({ input: {} }) });
  assert.equal(noInput.status, 400, 'details it needs are asked for, not left blank');
  assert.match((await noInput.json()).error, /needs details/);

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

test('an idea becomes a checked list of functions from the model, which then run in order', async () => {
  const admin = await signIn(ADMIN);
  const john = await signIn({ email: 'john@example.com', password: 'john-password-1' });
  const project = await (await admin('/tasks/projects', { method: 'POST', body: JSON.stringify({ name: 'Support', color: '#0b5cd5' }) })).json();
  const plan = (body) => john('/automations/plan', { method: 'POST', body: JSON.stringify(body) });
  const good = {
    name: 'New complaint',
    description: 'Logs a complaint and tells Mary.',
    steps: [
      { action: 'create_task', label: 'Log it', params: { projectId: project.id, title: 'Complaint: {{input.text}}', assignee: 'mary@example.com' } },
      { action: 'notify_user', label: 'Tell Mary', params: { to: 'mary@example.com', title: 'Task made: {{steps.1.title}}' } },
    ],
  };

  // The model is told the idea and what it may use; its answer comes back unsaved.
  answers = [`Here you go: ${JSON.stringify(good)}`];
  prompts.length = 0;
  const planned = await plan({ prompt: 'When a complaint comes in, log it and tell Mary' });
  assert.equal(planned.status, 200);
  const steps = await planned.json();
  assert.deepEqual(steps.steps.map((step) => step.action), ['create_task', 'notify_user']);
  assert.ok(prompts[0].includes('log it and tell Mary') && prompts[0].includes('create_draft') && prompts[0].includes(project.id));
  assert.ok(!(await (await john('/automations')).json()).automations.some((item) => item.name === 'New complaint'), 'planning saves nothing');

  // A wrong answer goes back once with the reason, and the corrected one is used.
  answers = [JSON.stringify({ name: 'Bad', steps: [{ action: 'send_note', params: { to: 'stranger@else.test', text: 'x' } }] }), JSON.stringify(good)];
  prompts.length = 0;
  assert.equal((await plan({ prompt: 'Tell someone' })).status, 200);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('stranger@else.test') && prompts[1].includes('rejected'));

  // Two wrong answers: nothing is offered. Each of these would otherwise fail or come out blank.
  for (const bad of [
    { name: 'x', steps: [{ action: 'run_javascript', params: {} }] },
    { name: 'x', steps: [{ action: 'create_task', params: { projectId: 'made-up', title: 'x' } }] },
    { name: 'x', steps: [{ action: 'send_note', params: { to: 'mary@example.com', text: '{{input.phone}}' } }] },
    { name: 'x', steps: [{ action: 'send_note', params: { to: 'mary@example.com', text: '{{steps.1.title}}' } }] },
    { name: 'x', steps: [{ action: 'create_draft', params: { to: 'not-an-address', body: 'x' } }] },
    { name: 'x', steps: [{ action: 'create_task', params: { projectId: project.id, title: 'x', dueDate: 'next week' } }] },
  ]) {
    answers = [JSON.stringify(bad), JSON.stringify(bad)];
    assert.notEqual((await plan({ prompt: 'Do it' })).status, 200, JSON.stringify(bad));
    assert.equal((await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'Do it', plan: bad }) })).status, 400, 'saving checks it too');
  }
  answers = ['no json here', 'still none'];
  assert.notEqual((await plan({ prompt: 'Do it' })).status, 200);

  // What it can't do, it says so rather than doing something else.
  answers = [JSON.stringify({ unsupported: 'There is no function for sending SMS.' })];
  const unsupported = await plan({ prompt: 'Send an SMS' });
  assert.equal(unsupported.status, 422);
  assert.match((await unsupported.json()).error, /sending SMS/);

  // Saved, it runs straight away, in order, one step using what the one before made.
  const saved = await (await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'Complaints', plan: steps }) })).json();
  const finished = async (id) => {
    for (let i = 0; i < 60; i++) {
      const found = (await (await john('/automations')).json()).runs.find((item) => item.id === id);
      if (found && !['queued', 'running'].includes(found.status)) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('run did not finish');
  };
  const started = await john(`/automations/${saved.id}/run`, { method: 'POST', body: JSON.stringify({ input: { text: 'Late order' } }) });
  assert.equal(started.status, 202);
  const run = await finished((await started.json()).id);
  assert.deepEqual(run.steps.map((step) => [step.action, step.status]), [['create_task', 'completed'], ['notify_user', 'completed']]);
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password-1' });
  const told = (await (await mary('/notifications')).json()).items;
  assert.ok(told.some((item) => item.title === 'Task made: Complaint: Late order'));

  // A failed step stops the ones after it, and they're shown as not run.
  const failing = await (await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'Fails', plan: {
    name: 'Fails',
    steps: [
      { action: 'notify_user', label: 'First', params: { to: 'mary@example.com', title: 'First ran' } },
      { action: 'send_note', label: 'Second', params: { to: '{{input.email}}', text: 'x' } },
      { action: 'notify_user', label: 'Third', params: { to: 'mary@example.com', title: 'Third must not run' } },
    ],
  } }) })).json();
  const stopped = await john(`/automations/${failing.id}/run`, { method: 'POST', body: JSON.stringify({ input: { email: 'outsider@else.test' } }) });
  const failed = await finished((await stopped.json()).id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.steps.map((step) => step.status), ['completed', 'failed', 'skipped']);
  assert.ok(!(await (await mary('/notifications')).json()).items.some((item) => item.title === 'Third must not run'));

  // Nothing starts if something it depends on has gone since it was saved.
  assert.equal((await admin(`/tasks/projects/${project.id}`, { method: 'DELETE' })).status < 300, true);
  const gone = await john(`/automations/${saved.id}/run`, { method: 'POST', body: JSON.stringify({ input: { text: 'x' } }) });
  assert.equal(gone.status, 400);
  assert.match((await gone.json()).error, /project/);
});

test('emails an automation prepares wait in Work items, not Drafts, until someone sends or discards them', async () => {
  const john = await signIn({ email: 'john@example.com', password: 'john-password-1' });
  const saved = await (await john('/automations', { method: 'POST', body: JSON.stringify({ prompt: 'x', plan: { name: 'Thank a client', steps: [{ action: 'create_draft', params: { to: '{{input.email}}', subject: 'Thank you', body: 'Thanks for your order.' } }] } }) })).json();
  const started = await (await john(`/automations/${saved.id}/run`, { method: 'POST', body: JSON.stringify({ input: { email: 'client@outside.test' } }) })).json();
  for (let i = 0; i < 60; i++) {
    const run = (await (await john('/automations')).json()).runs.find((item) => item.id === started.id);
    if (run?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const list = async (folder) => (await (await john(`/mail/messages?folder=${folder}`)).json()).items;
  const work = await list('work');
  const item = work.find((i) => i.subject === 'Thank you');
  assert.ok(item, 'it is a Work item');
  assert.deepEqual([item.kind, item.automation, item.to[0].address], ['draft', 'Thank a client', 'client@outside.test']);
  assert.ok(!(await list('drafts')).some((i) => i.id === item.id), 'and not mixed in with the person’s own drafts');
  const counts = await (await john('/mail/folders')).json();
  assert.equal(counts.work, work.length);
  // Opening it is opening a draft, with everything needed to send it.
  const draft = await (await john(`/mail/drafts/${item.id}`)).json();
  assert.deepEqual([draft.to, draft.text], ['client@outside.test', 'Thanks for your order.']);
  // Editing it keeps it a Work item.
  await john(`/mail/drafts/${item.id}`, { method: 'PUT', body: JSON.stringify({ to: 'client@outside.test', subject: 'Thank you!', text: 'Thanks again.' }) });
  assert.ok((await list('work')).some((i) => i.id === item.id && i.subject === 'Thank you!'));
  await john('/mail/drafts/delete', { method: 'POST', body: JSON.stringify({ ids: [item.id] }) });
  assert.ok(!(await list('work')).some((i) => i.id === item.id), 'discarded');
  // Someone else never sees them.
  const mary = await signIn({ email: 'mary@example.com', password: 'mary-password-1' });
  assert.equal((await (await mary('/mail/folders')).json()).work, 0);
});
