import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const moduleUrl = new URL('../src/mailbox.js', import.meta.url).href;

// mailbox.js reads its configuration at import, so each scenario runs in its own process.
async function scenario(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-read-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.mjs');
  await fs.writeFile(driver, `
    import { cacheOf, syncInbox, setServerSeen, closeMailbox } from ${JSON.stringify(moduleUrl)};
    const inbox = cacheOf('inbox');
    inbox.uidValidity = '7';
    const msg = (uid, read) => ({ uid, date: '2026-01-0' + uid, recipients: ['a@example.com'], state: { 'a@example.com': { read } }, imapRead: read });
    inbox.messages[1] = msg(1, false);
    inbox.messages[2] = msg(2, true);
    const calls = [];
    let server = { seen: [], flagError: null };
    globalThis.fetch = async (url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req);
      if (req.action === 'flag' && server.flagError) return { ok: false, status: 502, json: async () => ({ error: server.flagError }) };
      const reply = req.action === 'sync' ? { uidValidity: '7', uids: req.folder === 'inbox' ? [1, 2] : [], seenUids: server.seen, messages: [] } : { ok: true, messages: [] };
      return { ok: true, json: async () => reply };
    };
    ${body}
    await closeMailbox();
    process.exit(0);
  `);
  const env = { ...process.env, DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', JWT_SECRET: 'read-sync-test', NODE_ENV: 'test',
    MAIL_USER: 'owner@example.com', MAIL_BRIDGE_URL: 'https://bridge.example.com/mail', MAIL_BRIDGE_TOKEN: 'test', MAIL_TRANSPORT: 'bridge' };
  const { stdout } = await run(process.execPath, [driver], { env });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

test('read or unread in another mail app updates every account in AliasMail', async (t) => {
  const result = await scenario(t, `
    server.seen = [1];                         // 1 read in Titan; 2 marked unread there
    await syncInbox();
    console.log(JSON.stringify({ one: inbox.messages[1], two: inbox.messages[2] }));
  `);
  assert.equal(result.one.state['a@example.com'].read, true);
  assert.equal(result.one.imapRead, true);
  assert.equal(result.two.state['a@example.com'].read, false);
  assert.equal(result.two.imapRead, false);
});

test('reading in AliasMail sets the server flag, and its own change is not mistaken for another app', async (t) => {
  const result = await scenario(t, `
    inbox.messages[1].state['a@example.com'].read = true;
    await setServerSeen([1], true);
    server.seen = [1, 2];
    await syncInbox();
    console.log(JSON.stringify({ flag: calls.find((c) => c.action === 'flag'), one: inbox.messages[1] }));
  `);
  assert.deepEqual(result.flag, { action: 'flag', folder: 'inbox', uids: [1], seen: true });
  assert.equal(result.one.imapRead, true);
  assert.equal(result.one.state['a@example.com'].read, true);
});

test('an old bridge without read flags leaves local state consistent', async (t) => {
  const result = await scenario(t, `
    server.flagError = 'Unsupported bridge action';
    await setServerSeen([1], true);
    console.log(JSON.stringify({ one: inbox.messages[1] }));
  `);
  assert.equal(result.one.imapRead, false);
});
