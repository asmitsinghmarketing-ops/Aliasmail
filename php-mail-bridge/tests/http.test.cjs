const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('bridge HTTP authentication, fallback, and private worker scripts', { timeout: 15000 }, async (t) => {
  const parent = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(parent, 'aliasmail-worker-http-'));
  const settings = path.join(dir, 'settings.php');
  await fs.writeFile(settings, "<?php $GLOBALS['aliasmailSettings']=['MAIL_USER'=>'test','MAIL_PASSWORD'=>'test','MAIL_BRIDGE_TOKEN'=>'worker-test-token','MAIL_WORKER_DIR'=>getenv('TEST_WORKER_DIR'),'MAIL_UPLOAD_DIR'=>getenv('TEST_UPLOAD_DIR'),'MAIL_UPLOAD_URL'=>'https://upload.test/upload.php','MAIL_UPLOAD_ORIGIN'=>'https://mail.test'];");
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const proc = spawn('php', ['-n', '-S', '127.0.0.1:' + port, '-t', path.resolve('php-mail-bridge')], {
    env: { ...process.env, ALIASMAIL_SETTINGS_FILE: settings, TEST_WORKER_DIR: path.join(dir, 'private'), TEST_UPLOAD_DIR: path.join(dir, 'uploads') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  proc.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (proc.exitCode === null) { const exited = once(proc, 'exit'); proc.kill(); await exited; }
    assert.equal(path.dirname(dir), parent);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let n = 0; ; n++) {
    try { await fetch(base + '/index.php'); break; }
    catch (error) {
      if (n > 40 || proc.exitCode !== null) throw new Error('PHP test server did not start: ' + logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const post = (action, auth = true) => fetch(base + '/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer worker-test-token' } : {}) },
    body: JSON.stringify({ action, uid: 1 }),
  });
  assert.equal((await post('workerStatus', false)).status, 401);
  const health = await post('health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, imapExtension: false });
  const status = await post('workerStatus');
  assert.equal(status.status, 200);
  const workers = await status.json();
  assert.equal(workers.workers.foreground.running, false);
  assert.equal(workers.workers.background.running, false);
  const failedRead = await post('fetch');
  assert.equal(failedRead.status, 502);
  assert.match((await failedRead.json()).error, /IMAP extension is not enabled/);

  for (const script of ['worker.php', 'worker-common.php', 'bridge-core.php']) {
    assert.equal((await fetch(base + '/' + script)).status, 403, script + ' must not run over HTTP');
  }
});
