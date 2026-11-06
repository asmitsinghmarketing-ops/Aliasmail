import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Notifications: who gets told about new mail and notes, what they see, and that devices that
// have gone are forgotten. The push service is replaced by a stand-in.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-push-'));
Object.assign(process.env, { DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', JWT_SECRET: 'push-test-secret', MAIL_USER: 'owner@example.com', NODE_ENV: 'test' });
const push = await import('../src/push.js');
const { db } = await import('../src/store.js');
const { noteEvents } = await import('../src/mail-events.js');

const sent = [];
let fail = null;
push.useSender(async (sub, body) => {
  if (fail) throw fail;
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(body) });
});
const flush = () => new Promise((r) => setTimeout(r, 20));
const device = (n) => ({ subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: `key${n}`, auth: `auth${n}` } }, device: `Phone ${n}` });
const mail = (uid, fields = {}) => ({ uid, recipients: ['john@example.com'], from: { name: 'Prince Singh', address: 'prince@client.test' }, subject: `Subject ${uid}`, arrivedAt: new Date().toISOString(), state: {}, ...fields });

test.after(() => fs.rm(dir, { recursive: true, force: true }));

test('new mail reaches the right person, once per batch, and not for their own or promotional mail', async () => {
  push.startPush();
  assert.match(push.publicKey(), /^[A-Za-z0-9_-]{80,}$/);
  assert.match(db().push.vapid.privateKey, /^v1:/, 'the private key is stored encrypted');

  push.subscribe('john@example.com', device(1));
  push.subscribe('mary@example.com', device(2));
  assert.throws(() => push.subscribe('john@example.com', { subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } } }), /Invalid subscription/);

  push.notifyNewMail([mail(1)]);
  await flush();
  assert.deepEqual(sent.map((s) => [s.endpoint, s.title, s.body, s.url]), [['https://push.example/1', 'Email from Prince Singh', 'Subject 1', '/?message=1']]);

  sent.length = 0;
  push.notifyNewMail([mail(2), mail(3, { from: { name: 'Isa Bell', address: 'isa@t.test' } }), mail(4, { category: 'promotions' }), mail(6, { category: 'social' }), mail(7, { category: 'updates' }), mail(5, { from: { name: 'John', address: 'john@example.com' } })]);
  await flush();
  assert.deepEqual(sent.map((s) => [s.title, s.body]), [['2 new emails', 'Prince Singh, Isa Bell']]);

  // Old mail (an import) and mail for someone else: nothing.
  sent.length = 0;
  push.notifyNewMail([mail(6, { arrivedAt: new Date(Date.now() - 2 * 3600e3).toISOString() }), mail(7, { recipients: ['other@example.com'] })]);
  await flush();
  assert.equal(sent.length, 0);
});

test('instant notes notify the recipient; switched-off kinds and gone devices are respected', async () => {
  sent.length = 0;
  noteEvents.emit('note', ['mary@example.com', 'john@example.com'], { from: 'john@example.com', to: 'mary@example.com', fromName: 'John', text: 'Call me', files: [] });
  await flush();
  assert.deepEqual(sent.map((s) => [s.endpoint, s.title, s.body, s.url]), [['https://push.example/2', 'Note from John', 'Call me', '/?notes=john%40example.com']]);

  // Mary turns notes off on her phone.
  push.updateDevice('mary@example.com', 'https://push.example/2', { notes: false });
  sent.length = 0;
  noteEvents.emit('note', ['mary@example.com', 'john@example.com'], { from: 'john@example.com', to: 'mary@example.com', fromName: 'John', text: 'Again', files: [] });
  await flush();
  assert.equal(sent.length, 0);

  // John's phone was uninstalled: the push service says "gone" and the device is forgotten.
  fail = Object.assign(new Error('gone'), { statusCode: 410 });
  assert.equal(await push.notify('john@example.com', 'mail', { title: 'x' }), 0);
  fail = null;
  assert.deepEqual(push.devicesOf('john@example.com'), []);
});

test('a group note notifies every other member, titled with the group', async () => {
  push.subscribe('lee@example.com', device(3));
  sent.length = 0;
  noteEvents.emit('note', ['john@example.com', 'mary@example.com', 'lee@example.com'], { from: 'john@example.com', group: 'g1', groupName: 'Sales', fromName: 'John', text: 'Price approved', files: [] });
  await flush();
  // Mary turned notes off on her phone earlier; John sent it.
  assert.deepEqual(sent.map((s) => [s.endpoint, s.title, s.body, s.url]), [['https://push.example/3', 'Sales', 'John: Price approved', '/?notes=group%3Ag1']]);
});

test('task and call notification preferences are delivered independently', async () => {
  push.subscribe('sara@example.com', device(4));
  sent.length = 0;
  assert.equal(await push.notify('sara@example.com', 'tasks', { kind: 'task', title: 'Task assigned', body: 'Review proposal' }), 1);
  assert.equal(await push.notify('sara@example.com', 'calls', { kind: 'call', title: 'Incoming call', body: 'John is calling' }), 1);
  assert.deepEqual(sent.map((item) => item.kind), ['task', 'call']);

  push.updateDevice('sara@example.com', 'https://push.example/4', { tasks: false, calls: false });
  sent.length = 0;
  assert.equal(await push.notify('sara@example.com', 'tasks', { title: 'Task' }), 0);
  assert.equal(await push.notify('sara@example.com', 'calls', { title: 'Call' }), 0);
});
