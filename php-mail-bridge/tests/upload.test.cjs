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

test('uploaded files are put into a message in place of their placeholders', { timeout: 15000 }, async (t) => {
  const { execFileSync } = require('node:child_process');
  const MailComposer = require(require.resolve('nodemailer/lib/mail-composer', { paths: [path.resolve('server')] }));
  const { simpleParser } = require(require.resolve('mailparser', { paths: [path.resolve('server')] }));
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aliasmail-splice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = path.join(dir, 'files'); await fs.mkdir(files);
  const settings = path.join(dir, 'settings.php');
  await fs.writeFile(settings, `<?php $GLOBALS['aliasmailSettings']=['MAIL_UPLOAD_DIR'=>${JSON.stringify(files.replaceAll('\\', '/'))}];`);
  const pdf = { id: crypto.randomBytes(24).toString('hex'), filename: 'Quote ₹.pdf', bytes: crypto.randomBytes(150000) };
  await fs.writeFile(path.join(files, `${pdf.id}.bin`), pdf.bytes);
  await fs.writeFile(path.join(files, `${pdf.id}.json`), JSON.stringify({ kind: 'attachment', id: pdf.id, owner: 'a@example.com', complete: true, expires: Math.floor(Date.now() / 1000) + 600 }));
  const raw = await new MailComposer({ from: 'a@example.com', to: 'b@example.com', subject: 'Quote', text: 'Attached.',
    attachments: [{ filename: pdf.filename, contentType: 'application/pdf', content: Buffer.from(`AMU:${pdf.id}`), contentTransferEncoding: 'base64' }] }).compile().build();
  await fs.writeFile(path.join(dir, 'in.eml'), raw);
  // -n: no php.ini, so a broken local extension can't print warnings into the message.
  const php = (owner) => execFileSync('php', ['-n', '-r', `require 'php-mail-bridge/bridge-core.php'; require 'php-mail-bridge/upload-common.php';
    echo upload_splice(file_get_contents($argv[1]), [$argv[2]], $argv[3]);`, path.join(dir, 'in.eml'), pdf.id, owner],
  { env: { ...process.env, ALIASMAIL_SETTINGS_FILE: settings }, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = await simpleParser(php('A@example.com'));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, pdf.filename);
  assert.deepEqual(parsed.attachments[0].content, pdf.bytes);
  assert.equal(parsed.text.trim(), 'Attached.');
  assert.throws(() => php('someone-else@example.com'), (err) => /Attachment is not available/.test(`${err.stdout}${err.stderr}`));
});
