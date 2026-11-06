import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The Assistant through OpenRouter (OpenAI-style chat API) against a stand-in: a tool call whose
// arguments arrive in pieces, an email card, a streamed answer; tool results go back as "tool" messages.
const PORT = 7800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

let server;
let router;
let dir;
const requests = [];

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usage = { usage: { prompt_tokens: 700, completion_tokens: 40 }, choices: [] };

// The fast path's "what does the person want?" answers, by the latest message.
let planned = 0;
const planningRequests = [];
function plan(prompt) {
  planned++;
  const latest = prompt.split('Latest message:').pop();
  if (/hello there/i.test(latest)) return JSON.stringify({ intent: 'answer', answer: 'Hi! How can I help?' });
  if (/email billing/i.test(latest)) return JSON.stringify({ intent: 'email', to: ['billing@vendor.test'], subject: 'Invoice', body: 'Hello,\n\nCould you send the invoice?' });
  if (/payroll/i.test(latest)) return 'Sure: ```json\n' + JSON.stringify({ intent: 'summarise', folder: 'unread', query: 'payroll' }) + '\n```';
  return JSON.stringify({ intent: 'other' });
}

test.before(async () => {
  router = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      const planning = request.body.messages[0]?.content?.includes?.('You route requests');
      if (planning) {
        planningRequests.push(request);
        return sse(res, [delta({ content: plan(request.body.messages.at(-1).content) }, 'stop'), usage]);
      }
      requests.push(request);
      const turn = request.body.messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) {
        return sse(res, [
          delta({ role: 'assistant', content: 'Checking ' }),
          delta({ content: 'your mail.' }),
          delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_mail', arguments: '{"que' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"invoice"}' } }] }, 'tool_calls'),
          usage,
        ]);
      }
      if (turn === 1) {
        return sse(res, [
          delta({ tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'draft_email', arguments: JSON.stringify({ to: ['billing@vendor.test'], subject: 'Invoice', body: 'Hello,\n\nPlease resend it.' }) } }] }, 'tool_calls'),
          usage,
        ]);
      }
      return sse(res, [delta({ content: 'Ready to send.' }, 'stop'), usage]);
    });
  });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-openrouter-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'openrouter-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', ASSISTANT_PROVIDER: '',
      OPENROUTER_API_KEY: 'or-test-key', OPENROUTER_MODEL: 'test/free-model:free', OPENROUTER_URL: `http://127.0.0.1:${router.address().port}/api/v1`,
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
  router?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function answered(call, chatId, body) {
  const res = await call(`/assistant/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 202);
  for (let i = 0; i < 100; i++) {
    const chat = await (await call(`/assistant/chats/${chatId}`)).json();
    if (!chat.running) return chat.items.at(-1).parts;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no answer');
}
const textOf = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

test('with only an OpenRouter key and model, the Assistant uses OpenRouter: tools, cards and text work', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(ADMIN) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (p, options = {}) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });

  const status = await (await call('/assistant/status')).json();
  assert.deepEqual([status.enabled, status.provider, status.model], [true, 'openrouter', 'test/free-model:free']);

  const chat = await (await call('/assistant/chats', { method: 'POST' })).json();
  const parts = await answered(call, chat.id, { message: 'Ask the vendor to resend the invoice' });
  assert.equal(textOf(parts), 'Checking your mail.Ready to send.');
  const card = parts.find((p) => p.type === 'card').card;
  assert.deepEqual([card.kind, card.data.to], ['email', ['billing@vendor.test']]);

  // The request: bearer key, model, system message first, tools as functions.
  const first = requests[0];
  assert.equal(first.url, '/api/v1/chat/completions');
  assert.equal(first.headers.authorization, 'Bearer or-test-key');
  assert.equal(first.body.model, 'test/free-model:free');
  assert.equal(first.body.messages[0].role, 'system');
  assert.deepEqual(first.body.tools.map((t) => t.function.name), ['search_mail', 'read_email', 'list_team', 'draft_email', 'send_note', 'list_automations', 'run_automation']);

  // The tool call (arguments joined from pieces) goes back, then its result as a "tool" message.
  const second = requests[1].body.messages;
  const asked = second.find((m) => m.role === 'assistant');
  assert.deepEqual(asked.tool_calls[0], { id: 'call_a', type: 'function', function: { name: 'search_mail', arguments: '{"query":"invoice"}' } });
  assert.deepEqual(second.at(-1), { role: 'tool', tool_call_id: 'call_a', content: 'No messages found.' });

  const used = await (await call('/assistant/usage')).json();
  assert.deepEqual([used.provider, used.total.requests, used.total.usd], ['openrouter', 4, 0]);
});

test('common requests take the fast path: one call to understand, Nextspace does the rest', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(ADMIN) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (p, options = {}) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });
  const chat = await (await call('/assistant/chats', { method: 'POST' })).json();
  const stepByStep = requests.length;

  // Small talk: answered by the understand call itself.
  let before = planned;
  let parts = await answered(call, chat.id, { message: 'Hello there' });
  assert.equal(textOf(parts), 'Hi! How can I help?');
  assert.equal(planned - before, 1);
  assert.equal(planningRequests.at(-1).body.max_tokens, 1200);

  // A new email: written in the same call, shown as a card.
  before = planned;
  parts = await answered(call, chat.id, { message: 'Email billing@vendor.test asking for the invoice' });
  const card = parts.find((p) => p.type === 'card').card;
  assert.deepEqual([card.kind, card.status, card.data.to, card.data.subject, card.data.body], ['email', 'pending', ['billing@vendor.test'], 'Invoice', 'Hello,\n\nCould you send the invoice?']);
  assert.match(textOf(parts), /ready below/);
  assert.equal(planned - before, 1);

  // A summary of nothing: the search runs here, no second call needed (and fenced JSON is read).
  parts = await answered(call, chat.id, { message: 'Anything about payroll in my unread mail?' });
  assert.match(textOf(parts), /didn’t find any unread mail about “payroll”/);
  assert.deepEqual(parts.filter((p) => p.type === 'step').map((p) => p.text), ['Understanding your request', 'Searching mail for “payroll”']);

  // None of these needed the step-by-step loop.
  assert.equal(requests.length, stepByStep);
});
