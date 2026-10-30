const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('signed direct upload is reconstructed, verified, and read by its owner', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aliasmail-upload-'));
  const settings = path.join(dir, 'settings.php');
  await fs.writeFile(settings, `<?php $GLOBALS['aliasmailSettings']=['MAIL_USER'=>'test','MAIL_PASSWORD'=>'test','MAIL_BRIDGE_TOKEN'=>'token','MAIL_UPLOAD_DIR'=>${JSON.stringify(path.join(dir, 'files').replaceAll('\\', '/'))},'MAIL_UPLOAD_URL'=>'https://upload.test/upload.php','MAIL_UPLOAD_ORIGIN'=>'https://mail.test'];`);
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', path.resolve('php-mail-bridge')], {
    env: { ...process.env, ALIASMAIL_SETTINGS_FILE: settings }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = ''; proc.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => { if (proc.exitCode === null) { const exited = once(proc, 'exit'); proc.kill(); await exited; } await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { await fetch(base + '/index.php'); break; } catch { if (attempt > 40 || proc.exitCode !== null) throw new Error(logs); await new Promise((r) => setTimeout(r, 100)); }
  }
  const file = crypto.randomBytes(200000);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const start = await fetch(base + '/index.php', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' }, body: JSON.stringify({
    action: 'startUpload', owner: 'test@example.com', filename: 'signed.bin', contentType: 'application/octet-stream', size: file.length,
    sha256: crypto.createHash('sha256').update(file).digest('hex'), publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }) });
  assert.equal(start.status, 200); const session = await start.json();
  for (let offset = 0, index = 0; offset < file.length; offset += session.chunkBytes, index++) {
    const response = await fetch(`${base}/upload.php?action=chunk`, { method: 'POST', headers: { Origin: 'https://mail.test', 'Content-Type': 'application/octet-stream', 'X-Upload-Id': session.uploadId, 'X-Chunk-Index': String(index) }, body: file.subarray(offset, offset + session.chunkBytes) });
    assert.equal(response.status, 200, await response.text());
  }
  const signature = crypto.sign('sha256', Buffer.from(session.manifest), privateKey).toString('base64');
  const final = await fetch(`${base}/upload.php?action=finalize`, { method: 'POST', headers: { Origin: 'https://mail.test', 'Content-Type': 'application/json', 'X-Upload-Id': session.uploadId }, body: JSON.stringify({ signature }) });
  assert.equal(final.status, 200, await final.text());
  const consumed = await fetch(base + '/index.php', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' }, body: JSON.stringify({ action: 'consumeUpload', owner: 'test@example.com', uploadId: session.uploadId }) });
  assert.equal(consumed.status, 200); assert.deepEqual(Buffer.from((await consumed.json()).content, 'base64'), file);
});
