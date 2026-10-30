import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

// The real server with a stand-in bridge holding two large messages (uids 1 and 2) whose PDF is
// left out when opened (fetchLite) and served as plain binary by download.php, slowly, in pieces.
const PORT = 5900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const pdf = crypto.randomBytes(3 * 1024 * 1024);
const hits = { download: 0, fetchPart: 0 };
let botCheck = false;

let server;
let bridge;
let dir;
let cookie = '';

const call = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method, headers: { Cookie: cookie, 'X-Requested-With': 'AliasMail', ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (set) cookie = set;
  return res;
};

test.before(async () => {
  const full = (await new MailComposer({
    from: 'client@outside.test', to: ADMIN.email, subject: 'Big contract', text: 'See attached.',
    attachments: [{ filename: 'Contract.pdf', contentType: 'application/pdf', content: pdf }],
  }).compile().build()).toString();
  // The light copy and the part, cut the way the bridge's fetchLite / fetchPart do.
  const start = full.indexOf('Content-Type: application/pdf');
  const bodyStart = full.indexOf('\r\n\r\n', start) + 4;
  const end = full.indexOf('\r\n--', bodyStart);
  const lite = `${full.slice(0, bodyStart - 2)}X-AliasMail-Part: 2; size=${end - bodyStart}\r\n\r\n\r\n${full.slice(end + 2)}`;
  const part = full.slice(start, end);
  const b64 = (s) => Buffer.from(s).toString('base64');

  bridge = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/download.php') {
      hits.download++;
      if (botCheck) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>One moment, please...</title>'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pdf.length });
      let offset = 0;
      const next = () => {
        if (offset >= pdf.length) return res.end();
        res.write(pdf.subarray(offset, offset + 256 * 1024));
        offset += 256 * 1024;
        setTimeout(next, 20);
      };
      return next();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const d = JSON.parse(body || '{}');
      const reply = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (d.action === 'sync') {
        if (d.folder !== 'inbox') return reply({ uidValidity: '1', uids: [], seenUids: [], messages: [] });
        const known = new Set(d.knownUids || []);
        return reply({ uidValidity: '1', uids: [1, 2], seenUids: [], messages: [1, 2].filter((u) => !known.has(u)).map((uid) => ({ uid, raw: b64(full), size: full.length, hasAttachments: true })) });
      }
      if (d.action === 'fetchLite') return reply({ raw: b64(lite), lite: true });
      if (d.action === 'partLink') return reply({ url: `http://127.0.0.1:${bridge.address().port}/download.php?id=${'a'.repeat(48)}` });
      if (d.action === 'fetchPart') { hits.fetchPart++; return reply({ raw: b64(part) }); }
      reply({ ok: true, messages: [] });
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-download-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'download-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}/`,
      MAIL_BRIDGE_TOKEN: 'bridge-token', MAIL_TRANSPORT: 'bridge', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call('POST', '/api/auth/login', ADMIN)).status, 200);
  await call('POST', '/api/mail/refresh');
});

test.after(async () => {
  server?.kill();
  bridge?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const download = async (uid) => {
  const res = await call('GET', `/api/mail/messages/${uid}/attachments/0`);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

test('a bot check page in place of download.php: the attachment still arrives (fetchPart)', async () => {
  botCheck = true;
  const { res, bytes } = await download(1);
  assert.equal(res.status, 200);
  assert.deepEqual(bytes, pdf);
  assert.equal(hits.fetchPart, 1);
  botCheck = false;
});

test('large attachments stream from download.php, are kept for later, and can be fetched ahead', async () => {
  // 3. "warm" (the message is on screen) fetches it before any click.
  const before = hits.download;
  assert.equal((await call('GET', '/api/mail/messages/2/warm')).status, 200);
  for (let i = 0; i < 100 && hits.download === before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hits.download, before + 1);
  await new Promise((r) => setTimeout(r, 1200)); // let it finish arriving

  // 1 + 2. The click gets it byte for byte, from memory: no second trip to the bridge.
  const { res, bytes } = await download(2);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Contract\.pdf/);
  assert.deepEqual(bytes, pdf);
  assert.equal(hits.download, before + 1);
  assert.equal(hits.fetchPart, 1); // only the earlier bot-check fallback
});
