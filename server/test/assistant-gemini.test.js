import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The Assistant on Google Gemini (test mode) against a stand-in for the Gemini API: a function
// call, an email card, a streamed answer; the function results and thought signatures go back.
const PORT = 7500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

let server;
let gemini;
let dir;
const requests = [];

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
  res.end();
}
const usage = { promptTokenCount: 900, candidatesTokenCount: 50, thoughtsTokenCount: 30 };

test.before(async () => {
  gemini = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.systemInstruction?.parts?.[0]?.text?.includes('You route requests')) {
        return sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ text: '{"intent":"other"}' }] }, finishReason: 'STOP' }], usageMetadata: usage }]);
      }
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      const turn = JSON.parse(body).contents.filter((c) => c.role === 'model').length;
      if (turn === 0) {
        return sse(res, [
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Looking for ' }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ text: 'it.' }, { functionCall: { name: 'search_mail', args: { query: 'invoice' } }, thoughtSignature: 'sig-1' }] }, finishReason: 'STOP' }], usageMetadata: usage },
        ]);
      }
      if (turn === 1) {
        return sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'draft_email', args: { to: ['billing@vendor.test'], subject: 'Invoice', body: 'Hello,\n\nPlease resend the invoice.' } } }] }, finishReason: 'STOP' }], usageMetadata: usage }]);
      }
      return sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'The email is ready to send.' }] }, finishReason: 'STOP' }], usageMetadata: usage }]);
    });
  });
  await new Promise((r) => gemini.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-gemini-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'gemini-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '',
      MAIL_TRANSPORT: 'direct', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      ANTHROPIC_API_KEY: '', ASSISTANT_PROVIDER: '', GEMINI_API_KEY: 'gemini-test-key', GEMINI_MODEL: 'gemini-test-model',
      GEMINI_API_URL: `http://127.0.0.1:${gemini.address().port}/v1beta`,
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
  gemini?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

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

test('with only a Gemini key, the Assistant uses Gemini: tools, cards and streaming work', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(ADMIN) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (p, options = {}) => fetch(`${BASE}/api${p}`, { ...options, headers: { ...HEADERS, Cookie: cookie } });

  const status = await (await call('/assistant/status')).json();
  assert.deepEqual([status.enabled, status.provider, status.model], [true, 'gemini', 'gemini-test-model']);

  const chat = await (await call('/assistant/chats', { method: 'POST' })).json();
  const parts = await answered(call, chat.id, { message: 'Ask the vendor to resend the invoice', timeZone: 'Asia/Kolkata' });
  assert.equal(textOf(parts), 'Looking for it.The email is ready to send.');
  const card = parts.find((p) => p.type === 'card').card;
  assert.deepEqual([card.kind, card.data.to, card.status], ['email', ['billing@vendor.test'], 'pending']);

  // The request: the key in a header (not the URL), the model, function declarations.
  const first = requests[0];
  assert.match(first.url, /\/v1beta\/models\/gemini-test-model:streamGenerateContent\?alt=sse$/);
  assert.equal(first.headers['x-goog-api-key'], 'gemini-test-key');
  const names = first.body.tools[0].functionDeclarations.map((f) => f.name);
  assert.deepEqual(names, ['search_mail', 'read_email', 'list_team', 'draft_email', 'send_note']);
  assert.equal(first.body.tools[0].functionDeclarations.find((f) => f.name === 'list_team').parameters, undefined);
  assert.match(first.body.systemInstruction.parts[0].text, /Nextspace Assistant/);
  assert.deepEqual(first.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });

  // The model's turn goes back unchanged (thought signature included), then the function result.
  const second = requests[1].body.contents;
  assert.equal(second[1].parts.find((p) => p.functionCall).thoughtSignature, 'sig-1');
  assert.deepEqual(second[2].parts[0].functionResponse, { name: 'search_mail', response: { result: 'No messages found.' } });

  // Free tier: counted, at no cost.
  const used = await (await call('/assistant/usage')).json();
  assert.deepEqual([used.provider, used.total.requests, used.total.usd], ['gemini', 4, 0]);
  assert.equal(used.total.output, 4 * 80);
});
