import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { geminiUserMessage } from '../src/assistant-gemini.js';
import { openrouterUserMessage } from '../src/assistant-openrouter.js';

const PIXEL = { name: 'pixel.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw4AAAAASUVORK5CYII=' };

test('image messages use each provider’s vision format', () => {
  assert.deepEqual(geminiUserMessage('Look', PIXEL).parts[1], { inlineData: { mimeType: 'image/png', data: PIXEL.data } });
  assert.deepEqual(openrouterUserMessage('Look', PIXEL).content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL.data}` } });
});

// The Assistant against a stand-in for the Anthropic API: a turn that searches mail, prepares an
// email card and answers; usage and limits; and that nobody else can read the chat.
const PORT = 7200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

let server;
let claude;
let dir;
const requests = []; // what Nextspace sent to "Claude" (the step-by-step calls)
const plans = []; // the fast path's "what does the person want?" calls

// One streamed reply in the Messages API's event format.
function sse(res, content, stopReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of block.text.match(/.{1,8}/g)) send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 200 } });
  send('message_stop', {});
  res.end();
}

test.before(async () => {
  claude = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = { headers: req.headers, body: JSON.parse(body) };
      if (JSON.stringify(request.body.system || '').includes('You route requests')) {
        plans.push(request);
        return sse(res, [{ type: 'text', text: '{"intent":"other"}' }], 'end_turn');
      }
      requests.push(request);
      const turn = request.body.messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) return sse(res, [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_1', name: 'search_mail', input: { query: 'proposal' } }], 'tool_use');
      if (turn === 1) return sse(res, [{ type: 'tool_use', id: 'tu_2', name: 'draft_email', input: { to: ['prince@client.test'], subject: 'Phase 1', body: 'Hi Prince,\n\nMonday at 11 works.' } }], 'tool_use');
      return sse(res, [{ type: 'text', text: 'Your reply is ready. Check the card and press **Send**.' }], 'end_turn');
    });
  });
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-assistant-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'assistant-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}`, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_PROFILE: '',
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
  claude?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function cookieFor(credentials) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// Sends a message, then reads the chat until the answer is finished (as the browser does).
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

test('a turn searches mail, prepares an email card and answers; usage and limits are kept', async () => {
  const admin = await cookieFor(ADMIN);
  const call = (p, options = {}, cookie = admin) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });

  assert.equal((await (await call('/assistant/status')).json()).enabled, true);
  const chat = await (await call('/assistant/chats', { method: 'POST' })).json();
  const parts = await answered(call, chat.id, { message: 'Reply to Prince about the proposal', now: 'Sunday 1 November 2026, 15:30', timeZone: 'Asia/Kolkata' });
  // The fast path's understanding step (it chose the step-by-step loop here), then the loop.
  assert.deepEqual(parts.map((p) => p.type), ['step', 'text', 'step', 'step', 'card', 'text']);
  assert.equal(parts[0].text, 'Understanding your request');
  assert.equal(textOf(parts), 'Let me look.Your reply is ready. Check the card and press **Send**.');
  const card = parts.find((p) => p.type === 'card').card;
  assert.deepEqual([card.kind, card.status, card.data.to, card.data.subject], ['email', 'pending', ['prince@client.test'], 'Phase 1']);

  // What went to Claude: tools, caching, the fallback opt-in, the person's time, then the results.
  const first = requests[0];
  assert.deepEqual(first.body.tools.map((t) => t.name), ['search_mail', 'read_email', 'list_team', 'draft_email', 'send_note']);
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  assert.equal(first.body.fallbacks, 'default');
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.match(first.body.messages[0].content[0].text, /Asia\/Kolkata.*\n\nReply to Prince/s);
  const results = requests[1].body.messages.at(-1).content;
  assert.equal(results[0].tool_use_id, 'tu_1');
  assert.equal(results[0].content, 'No messages found.');
  assert.match(requests[2].body.messages.at(-1).content[0].content, /NOT been sent/);

  // The chat is saved, the card can be settled, and Claude hears about it next time.
  const saved = await (await call(`/assistant/chats/${chat.id}`)).json();
  assert.equal(saved.title, 'Reply to Prince about the proposal');
  assert.deepEqual(saved.items.map((i) => i.role), ['user', 'assistant']);
  const settled = await (await call(`/assistant/chats/${chat.id}/cards/tu_2`, { method: 'POST', body: JSON.stringify({ status: 'done' }) })).json();
  assert.equal(settled.status, 'done');

  // Someone else can't see or use the chat.
  await call('/admin/aliases', { method: 'POST', body: JSON.stringify({ address: 'john@example.com', password: 'john-password', displayName: 'John' }) });
  const john = await cookieFor({ email: 'john@example.com', password: 'john-password' });
  assert.equal((await call(`/assistant/chats/${chat.id}`, {}, john)).status, 404);
  assert.equal((await call('/assistant/usage', {}, john)).status, 403);

  // Image-only prompts skip the text fast path, reach Claude as a vision block, and only small
  // metadata (not the base64 data) is retained in the visible chat.
  const imageChat = await (await call('/assistant/chats', { method: 'POST' })).json();
  const imageRequest = requests.length;
  await answered(call, imageChat.id, { message: '', image: PIXEL, now: 'Sunday 1 November 2026, 15:35', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(requests[imageRequest].body.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PIXEL.data },
  });
  const savedImageChat = await (await call(`/assistant/chats/${imageChat.id}`)).json();
  assert.deepEqual(savedImageChat.items[0].image, { name: 'pixel.png', mediaType: 'image/png' });
  assert.equal(JSON.stringify(savedImageChat).includes(PIXEL.data), false);

  const usage = await (await call('/assistant/usage')).json();
  // Six step-by-step calls plus the first text turn's fast path, at Opus 5.5 prices.
  assert.equal(plans.length, 1);
  assert.equal(plans[0].body.tools, undefined);
  assert.equal(plans[0].body.max_tokens, 1200);
  assert.deepEqual(plans[0].body.output_config, { effort: 'low' });
  assert.equal(usage.total.requests, 7);
  assert.equal(usage.total.input, 7000);
  assert.equal(usage.total.cacheRead, 21000);
  assert.ok(Math.abs(usage.total.usd - (7000 * 4 + 1400 * 20 + 21000 * 0.2) / 1e6) < 1e-9);

  // A limit that has been reached stops the next message before it reaches Claude.
  await call('/assistant/limits', { method: 'PUT', body: JSON.stringify({ monthlyUsd: 0.01, perPersonUsd: 0 }) });
  const before = requests.length;
  const blocked = await call(`/assistant/chats/${chat.id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'And another' }) });
  assert.equal(blocked.status, 429);
  assert.equal(requests.length, before);
});
