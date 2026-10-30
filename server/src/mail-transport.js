import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import config from './config.js';
import { HttpError } from './errors.js';

// Two reusable sessions: background INBOX/IDLE and foreground operations.
// Keeping foreground separate means a clicked message skips queued INBOX downloads.
export function createMailTransport(settings, { Client = ImapFlow, fetcher = (...args) => fetch(...args), smtpFactory = nodemailer.createTransport } = {}) {
  const sessions = new Map();
  const folderLists = new WeakMap();
  let directRetryAt = 0;
  let notify = () => {};
  let smtp;
  let stopped = false;
  let reconnectTimer;
  let reconnectDelay = 1000;
  function reconnect() {
    if (stopped || reconnectTimer || mode === 'bridge') return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try { await warm(); reconnectDelay = 1000; }
      catch {
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
        reconnect();
      }
    }, reconnectDelay);
    reconnectTimer.unref?.();
  }
  const mode = settings.mailTransport || (settings.mailBridge.configured ? 'bridge' : 'direct');

  async function connection(lane) {
    if (stopped) throw new Error('Mail transport is closed');
    let slot = sessions.get(lane);
    if (slot) return slot.ready;
    const client = new Client({ ...settings.imap, maxIdleTime: 240_000, socketTimeout: 300_000 });
    slot = { client };
    sessions.set(lane, slot);
    const remove = () => { if (sessions.get(lane) === slot) sessions.delete(lane); };
    client.on('error', () => { remove(); client.close(); reconnect(); });
    client.on('close', () => { remove(); reconnect(); });
    for (const event of ['exists', 'expunge', 'flags']) {
      client.on(event, () => { if (lane === 'inbox') notify(); });
    }
    slot.ready = client.connect().then(() => client).catch((error) => {
      remove();
      client.close();
      throw error;
    });
    return slot.ready;
  }

  async function folderPath(client, folder) {
    if (settings.folders?.[folder]) return settings.folders[folder];
    if (folder === 'inbox') return 'INBOX';
    const special = { sent: '\\Sent', spam: '\\Junk', trash: '\\Trash' }[folder];
    if (!special) throw new HttpError(400, 'Unknown mail folder');
    if (!folderLists.has(client)) folderLists.set(client, client.list());
    const boxes = await folderLists.get(client);
    return boxes.find((box) => box.specialUse === special)?.path || { sent: 'Sent', spam: 'Junk', trash: 'Trash' }[folder];
  }

  async function withFolder(folder, background, fn) {
    const lane = background && folder === 'inbox' ? 'inbox' : 'foreground';
    const client = await connection(lane);
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try { return await fn(client, path); } finally { lock.release(); }
  }

  const hasAttachments = (part) => Boolean(part && (
    part.disposition === 'attachment' || part.dispositionParameters?.filename || part.parameters?.name ||
    (part.childNodes || []).some(hasAttachments)
  ));

  async function direct(action, data) {
    if (!settings.imap.auth.pass) throw new HttpError(503, 'Direct IMAP requires MAIL_PASSWORD on the Node host');
    if (action === 'sendRaw') {
      smtp ||= smtpFactory({ ...settings.smtp, pool: true, maxConnections: 1 });
      await smtp.sendMail({ envelope: data.envelope, raw: Buffer.from(data.raw, 'base64') });
      return { ok: true };
    }
    if (action === 'test') {
      const client = await connection('foreground');
      const boxes = await client.list();
      if (settings.mailBridge.configured) await bridge('test', {});
      else {
        smtp ||= smtpFactory({ ...settings.smtp, pool: true, maxConnections: 1 });
        await smtp.verify();
      }
      return { imap: true, smtp: true, folders: boxes.map((box) => box.path), transport: 'direct' };
    }
    return withFolder(action === 'saveSent' ? 'sent' : (data.folder || 'inbox'), action === 'sync' || action === 'fetchMany', async (client, path) => {
      if (action === 'sync') {
        const uidValidity = String(client.mailbox.uidValidity);
        const flags = client.mailbox.exists ? await client.fetchAll('1:*', { uid: true, flags: true }) : [];
        const uids = flags.map((item) => item.uid);
        const known = new Set(data.knownUidValidity === uidValidity ? data.knownUids : []);
        const wanted = uids.filter((uid) => !known.has(uid)).sort((a, b) => b - a);
        const batch = wanted.slice(0, 50);
        const fetched = batch.length ? await client.fetchAll(batch, { uid: true, headers: true, size: true, bodyStructure: true }, { uid: true }) : [];
        return {
          uidValidity, uids, seenUids: flags.filter((item) => item.flags?.has('\\Seen')).map((item) => item.uid),
          hasMore: wanted.length > batch.length,
          messages: fetched.map((item) => ({ uid: item.uid, raw: item.headers.toString('base64'), size: item.size, hasAttachments: hasAttachments(item.bodyStructure) })),
        };
      }
      if (action === 'fetch' || action === 'fetchMany') {
        const uids = (action === 'fetch' ? [data.uid] : data.uids).map(Number).filter((uid) => Number.isSafeInteger(uid) && uid > 0);
        const messages = uids.length ? await client.fetchAll(uids, { uid: true, source: true }, { uid: true }) : [];
        const result = messages.map((item) => ({ uid: item.uid, raw: item.source.toString('base64') }));
        return action === 'fetch' ? { raw: result[0]?.raw || null } : { messages: result };
      }
      if (action === 'flag') {
        const uids = data.uids.map(Number).filter((uid) => Number.isSafeInteger(uid) && uid > 0);
        if (uids.length) {
          if (data.seen) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          else await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
        }
        return { ok: true };
      }
      if (action === 'delete' || action === 'move') {
        if (action === 'delete' && data.permanent) await client.messageDelete(data.uids, { uid: true });
        else await client.messageMove(data.uids, await folderPath(client, data.to || 'trash'), { uid: true });
        return { ok: true };
      }
      if (action === 'saveSent') {
        await client.append(path, Buffer.from(data.raw, 'base64'), ['\\Seen']);
        return { ok: true };
      }
      throw new HttpError(400, 'Unsupported mail action');
    });
  }

  // Repeating these can't change anything twice. Sending, moving and deleting are never retried:
  // a dropped connection doesn't prove the first attempt failed.
  const SAFE_TO_RETRY = new Set(['health', 'test', 'sync', 'fetch', 'fetchMany', 'workerStatus', 'flag']);

  async function bridgePost(action, data) {
    if (!settings.mailBridge.configured) throw new HttpError(503, 'PHP mail bridge is not configured');
    const url = new URL(settings.mailBridge.url);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new HttpError(500, 'MAIL_BRIDGE_URL must use HTTPS in production');
    const post = () => fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.mailBridge.token}` },
      body: JSON.stringify({ action, ...data }), signal: AbortSignal.timeout(45_000),
    });
    // Network failures and timeouts become errors the user can read, instead of a bare 500.
    const unreachable = (error) => {
      const reason = error.cause?.code || error.cause?.message || error.message;
      console.error(`[mail] PHP bridge ${action} failed: ${error.name}: ${reason}`);
      if (error.name === 'TimeoutError') {
        return new HttpError(504, action === 'sendRaw' || action === 'sendStagedRaw'
          ? 'The mail bridge didn’t answer in time. The message may still have been sent: check Sent before trying again.'
          : 'The mail bridge didn’t answer in time. Try again in a moment.');
      }
      return new HttpError(502, action === 'sendRaw' || action === 'sendStagedRaw'
        ? `Lost the connection to the mail bridge (${reason}). The message may still have been sent: check Sent before trying again.`
        : `Couldn’t reach the mail bridge (${reason}). Try again in a moment.`);
    };
    let response;
    try {
      response = await post();
    } catch (error) {
      // After a quiet period the bridge's web server has usually closed the reused connection
      // ("fetch failed: other side closed"); a second attempt opens a new one.
      if (!SAFE_TO_RETRY.has(action) || error.name === 'TimeoutError') throw unreachable(error);
      try {
        response = await post();
      } catch (retryError) {
        throw unreachable(retryError);
      }
    }
    let result;
    try { result = await response.json(); } catch { throw new HttpError(502, 'Mail bridge returned an invalid response. Check the deployed PHP bridge and its server logs.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(502, 'Mail bridge returned an invalid response');
    // The bridge refusing this app (wrong token) is a server setup problem, not the user's session:
    // passing its 401 on would sign the user out of AliasMail.
    if (response.status === 401 || response.status === 403) {
      console.error(`[mail] PHP bridge refused the request (${response.status}): MAIL_BRIDGE_TOKEN differs from the bridge's aliasmail-settings.php`);
      throw new HttpError(502, 'The mail bridge rejected this app’s token. Ask the administrator to make MAIL_BRIDGE_TOKEN match on both servers.');
    }
    if (!response.ok || result.error) throw new HttpError(response.status >= 500 || response.ok ? 502 : response.status, result.error || `PHP mail bridge failed (${response.status})`);
    return result;
  }

  async function bridge(action, data) {
    // Large raw MIME JSON requests are rejected by some shared-hosting proxies. Stage the
    // decoded message in 128 KiB pieces, then trigger SMTP with a small request.
    if (action === 'sendRaw' && String(data.raw || '').length > 96 * 1024) {
      const raw = Buffer.from(data.raw, 'base64');
      const started = await bridgePost('startRaw', { size: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
      for (let offset = 0; offset < raw.length; offset += 128 * 1024) {
        await bridgePost('appendRaw', { rawId: started.rawId, chunk: raw.subarray(offset, offset + 128 * 1024).toString('base64') });
      }
      return bridgePost('sendStagedRaw', { rawId: started.rawId, envelope: data.envelope });
    }
    return bridgePost(action, data);
  }

  // Select and, in auto mode, probe before executing. Never retry a move/send via
  // another transport: a lost response does not mean the first operation failed.
  async function selected() {
    if (mode === 'bridge') return 'bridge';
    if (mode === 'direct') return 'direct';
    if (!settings.imap.auth.pass || Date.now() < directRetryAt) return 'bridge';
    try { await connection('foreground'); return 'direct'; }
    catch (error) {
      directRetryAt = Date.now() + 5 * 60_000;
      if (!settings.mailBridge.configured) throw error;
      console.warn('[mail] Direct IMAP unavailable; using PHP bridge for five minutes');
      return 'bridge';
    }
  }

  async function warm() {
    if (await selected() !== 'direct') return;
    await withFolder('inbox', true, async () => {});
    await withFolder('inbox', false, async () => {});
  }

  return {
    async request(action, data = {}) {
      if (settings.mailBridge.configured && ['startUpload', 'consumeUpload', 'deleteUpload', 'saveStagedSent'].includes(action)) return bridge(action, data);
      const transport = await selected();
      // A bridge can still send SMTP on hosts where only direct IMAP is enabled.
      if (transport === 'direct' && action === 'sendRaw' && settings.mailBridge.configured) return bridge(action, data);
      return transport === 'direct' ? direct(action, data) : bridge(action, data);
    },
    // Whether the PHP bridge's persistent read workers are running; null without a bridge.
    async workers() {
      if (!settings.mailBridge.configured) return null;
      return bridge('workerStatus', {});
    },
    onChange(callback) { notify = callback; },
    warm,
    async close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      smtp?.close();
      await Promise.allSettled([...sessions.values()].map(async ({ client, ready }) => {
        try { await ready; await client.logout(); } finally { client.close(); }
      }));
      sessions.clear();
    },
    get mode() { return mode; },
  };
}

export const mailTransport = createMailTransport(config);
