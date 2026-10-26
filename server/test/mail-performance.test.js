import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMailTransport } from '../src/mail-transport.js';
import { createMessageCache } from '../src/message-cache.js';
import { createFileBackend } from '../src/persist.js';

const raw = Buffer.from(`From: a@example.com
To: b@example.com
Subject: Cache test

Private message body.`);
const settings = {
  mailbox: 'owner@example.com', jwtSecret: 'test-only-secret',
  mailBridge: { configured: true, url: 'https://bridge.example.com/mail', token: 'test-token' },
  imap: { host: 'imap.example.com', port: 993, secure: true, auth: { user: 'owner@example.com', pass: 'test-password' } },
  smtp: {}, folders: {},
  messageCache: { enabled: true, maxBytes: 1024 * 1024, maxAgeMs: 86400_000 },
};
function mockClients() {
  const instances = [];
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; this.logins = 0; this.releases = 0; this.listCalls = 0; instances.push(this); }
    async connect() { this.logins++; }
    async list() { this.listCalls++; return [{ path: 'Sent Items', specialUse: '\\Sent' }]; }
    async getMailboxLock(path) { this.mailbox = { path, uidValidity: 123n, exists: 2 }; return { release: () => this.releases++ }; }
    async fetchAll(range, query, options) {
      if (this.hold && query.source) await this.hold;
      if (query.flags) return [{ uid: 1, flags: new Set(['\\Seen']) }, { uid: 2, flags: new Set() }];
      return (Array.isArray(range) ? range : [1]).map((uid) => ({ uid, source: raw, headers: raw, size: raw.length }));
    }
    async messageMove() { if (this.failMove) throw new Error('Disconnected after move'); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    async logout() { this.close(); }
  }
  return { Client, instances };
}

test('bridge installations never attempt direct IMAP, including warmup', async (t) => {
  const { Client, instances } = mockClients();
  let calls = 0;
  const transport = createMailTransport(settings, { Client, fetcher: async () => { calls++; return { ok: true, json: async () => ({ raw: raw.toString('base64') }) }; } });
  t.after(() => transport.close());
  await transport.warm();
  await transport.request('fetch', { uid: 1 });
  assert.equal(instances.length, 0);
  assert.equal(calls, 1);
});

test('direct IMAP reuses login, reports seen flags, reconnects after close', async (t) => {
  const { Client, instances } = mockClients();
  const transport = createMailTransport({ ...settings, mailTransport: 'direct' }, { Client });
  t.after(() => transport.close());
  let changes = 0;
  transport.onChange(() => changes++);
  const first = await transport.request('sync', { folder: 'inbox', knownUids: [], knownUidValidity: '' });
  assert.deepEqual(first.seenUids, [1]);
  assert.equal(first.messages.length, 2);
  const next = await transport.request('sync', { folder: 'inbox', knownUids: [1, 2], knownUidValidity: '123' });
  assert.equal(next.messages.length, 0);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].logins, 1);
  assert.equal(instances[0].releases, 2);
  instances[0].emit('exists', {});
  assert.equal(changes, 1);
  instances[0].close();
  await transport.request('sync', { folder: 'inbox', knownUids: [1, 2], knownUidValidity: '123' });
  assert.equal(instances.length, 2);
});

test('foreground fetch is independent of pending INBOX batch and uses one login', async (t) => {
  const { Client, instances } = mockClients();
  const transport = createMailTransport({ ...settings, mailTransport: 'direct' }, { Client });
  t.after(() => transport.close());
  await transport.warm();
  let release;
  instances[0].hold = new Promise((resolve) => { release = resolve; });
  const batch = transport.request('fetchMany', { folder: 'inbox', uids: [1, 2] });
  const opened = await transport.request('fetch', { folder: 'inbox', uid: 1 });
  assert.equal(opened.raw, raw.toString('base64'));
  assert.equal(instances.length, 2);
  assert.equal(instances[1].logins, 1);
  release();
  await batch;
  await transport.request('fetch', { folder: 'inbox', uid: 2 });
  assert.equal(instances.length, 2);
});

test('auto mode backs off a blocked IMAP port and uses the bridge', async (t) => {
  const { Client } = mockClients();
  let logins = 0;
  Client.prototype.connect = async () => { logins++; throw new Error('Blocked port'); };
  let calls = 0;
  const transport = createMailTransport({ ...settings, mailTransport: 'auto' }, { Client, fetcher: async () => { calls++; return { ok: true, json: async () => ({ raw: null }) }; } });
  t.after(() => transport.close());
  await transport.request('fetch', { folder: 'inbox', uid: 1 });
  await transport.request('fetch', { folder: 'inbox', uid: 2 });
  assert.equal(logins, 1);
  assert.equal(calls, 2);
});

test('an ambiguous move failure is never repeated through the bridge', async (t) => {
  const { Client, instances } = mockClients();
  let bridgeCalls = 0;
  const transport = createMailTransport({ ...settings, mailTransport: 'auto' }, { Client, fetcher: async () => { bridgeCalls++; throw new Error('must not retry'); } });
  t.after(() => transport.close());
  await transport.warm();
  instances[0].failMove = true;
  await assert.rejects(transport.request('move', { folder: 'inbox', to: 'sent', uids: [1] }), /Disconnected/);
  assert.equal(bridgeCalls, 0);
});

test('worker status is read from the PHP bridge, even when direct IMAP is used', async (t) => {
  const status = { enabled: true, workers: { foreground: { running: true, requests: 7 }, background: { running: false } } };
  let sent;
  const fetcher = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => status }; };
  for (const mailTransport of ['bridge', 'direct']) {
    const transport = createMailTransport({ ...settings, mailTransport }, { fetcher });
    t.after(() => transport.close());
    assert.deepEqual(await transport.workers(), status);
    assert.equal(sent.action, 'workerStatus');
  }
});

test('worker status is null without a bridge, and an old bridge reports an error', async (t) => {
  const none = createMailTransport({ ...settings, mailBridge: { configured: false } });
  t.after(() => none.close());
  assert.equal(await none.workers(), null);

  const old = createMailTransport(settings, { fetcher: async () => ({ ok: false, status: 502, json: async () => ({ error: 'Unsupported bridge action' }) }) });
  t.after(() => old.close());
  await assert.rejects(old.workers(), /Unsupported bridge action/);
});

test('invalid bridge JSON is a visible failure', async (t) => {
  const transport = createMailTransport(settings, { fetcher: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }) });
  t.after(() => transport.close());
  await assert.rejects(transport.request('fetch', { uid: 1 }), /invalid response/);
});

async function cacheFixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(parent, 'aliasmail-cache-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), parent); await fs.rm(dir, { recursive: true, force: true }); });
  const backend = createFileBackend(path.join(dir, 'db.json'));
  return { dir, backend, create: (options = settings) => createMessageCache(options, () => backend) };
}
const identity = { folder: 'inbox', uidValidity: '123', uid: 1 };

test('encrypted body cache survives a fresh cache instance without mail-server access', async (t) => {
  const { dir, create } = await cacheFixture(t);
  const first = create();
  await first.put(identity, raw);
  const names = await fs.readdir(path.join(dir, 'mail-cache'));
  const stored = await fs.readFile(path.join(dir, 'mail-cache', names[0]));
  assert.equal(stored.includes(Buffer.from('Private message')), false);
  const restarted = create();
  assert.deepEqual(await restarted.get(identity), raw);
  assert.equal(await restarted.get({ ...identity, uidValidity: '456' }), null);
  assert.equal(await restarted.get({ ...identity, folder: 'sent' }), null);
  await restarted.remove(identity);
  assert.equal(await first.get(identity), null);
});

test('cache corruption or a changed encryption key falls back to downloading', async (t) => {
  const { create } = await cacheFixture(t);
  await create().put(identity, raw);
  assert.equal(await create({ ...settings, jwtSecret: 'different-secret' }).get(identity), null);
});

test('expired cache entries are removed, and cache size is bounded', async (t) => {
  const { dir, backend, create } = await cacheFixture(t);
  await create().put(identity, raw);
  const [id] = await fs.readdir(path.join(dir, 'mail-cache'));
  const old = new Date(Date.now() - 2 * 86400_000);
  await fs.utimes(path.join(dir, 'mail-cache', id), old, old);
  assert.equal(await create().get(identity), null);
  await backend.putMessage('a'.repeat(64), Buffer.alloc(80));
  await backend.putMessage('b'.repeat(64), Buffer.alloc(80));
  await backend.pruneMessages({ maxBytes: 100, maxAgeMs: 86400_000 });
  const files = await fs.readdir(path.join(dir, 'mail-cache'));
  assert.equal(files.length, 1);
});

test('cache disabled or over-size messages do not persist', async (t) => {
  const { backend, create } = await cacheFixture(t);
  let writes = 0;
  backend.putMessage = async () => { writes++; };
  await create({ ...settings, messageCache: { ...settings.messageCache, enabled: false } }).put(identity, raw);
  await create().put(identity, Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.equal(writes, 0);
});

test('a fresh server process opens a persisted message without a bridge request', async (t) => {
  const { dir } = await cacheFixture(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const moduleUrl = new URL('../src/mailbox.js', import.meta.url).href;
  const driver = path.join(dir, 'restart-test.mjs');
  await fs.writeFile(driver, `
    import {cacheOf, fetchParsed, closeMailbox} from ${JSON.stringify(moduleUrl)};
    const folder=cacheOf('inbox');
    folder.uidValidity=process.env.TEST_UID_VALIDITY;
    folder.messages[1]={uid:1,size:100,state:{}};
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      return {ok:true,json:async()=>({raw:${JSON.stringify(raw.toString('base64'))}})};
    };
    const parsed=await fetchParsed(1);
    await closeMailbox();
    console.log(JSON.stringify({calls,subject:parsed.subject}));
    process.exit(0);
  `);
  const env = { ...process.env, DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', JWT_SECRET: 'restart-test-key',
    MAIL_USER: 'owner@example.com', MAIL_BRIDGE_URL: 'https://bridge.example.com/mail', MAIL_BRIDGE_TOKEN: 'test',
    MAIL_TRANSPORT: 'bridge', MESSAGE_CACHE_ENABLED: 'true', TEST_UID_VALIDITY: '123' };
  const first = JSON.parse((await run(process.execPath, [driver], { env })).stdout.trim().split(String.fromCharCode(10)).at(-1));
  const second = JSON.parse((await run(process.execPath, [driver], { env })).stdout.trim().split(String.fromCharCode(10)).at(-1));
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 0);
  assert.equal(second.subject, 'Cache test');
  const changed = JSON.parse((await run(process.execPath, [driver], { env: { ...env, TEST_UID_VALIDITY: '456' } })).stdout.trim().split(String.fromCharCode(10)).at(-1));
  assert.equal(changed.calls, 1, 'UIDVALIDITY change must not reuse an old message body');
});
