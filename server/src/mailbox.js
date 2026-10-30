// Everything that talks to the real mailbox: IMAP for reading / moving / deleting,
// SMTP for sending as an alias.
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import config from './config.js';
import { mailTransport } from './mail-transport.js';
import { messageCache } from './message-cache.js';
import { announceChange } from './mail-events.js';
import { db, save } from './store.js';
import { normalize } from './aliases.js';
import { HttpError, describeError } from './errors.js';

// Headers mail servers add with the address a message was actually delivered to.
// They catch aliases that were BCC'd or reached through a forward.
const ROUTING_HEADERS = ['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to'];
// Headers used to sort the inbox into Primary / Promotions / Social / Updates.
const EMAIL_IN_TEXT = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// Mail folders the app mirrors. Sent and Spam have provider-specific names, so they are
// found by their special-use flag.
const SYNCED_FOLDERS = ['inbox', 'sent'];

function assertConfigured() {
  if (!config.configured) throw new HttpError(503, 'Mailbox is not configured');
}
const bridge = (action, data = {}) => {
  assertConfigured();
  return mailTransport.request(action, data);
};

export function startAttachmentUpload(data) {
  return bridge('startUpload', data);
}

/** The local cache of a folder: { uidValidity, lastUid, messages } */
export function cacheOf(folder) {
  const data = db();
  return { sent: data.sentBox, spam: data.spamBox }[folder] || data.inbox;
}

const toAddress = (a) => ({ name: a?.name || '', address: normalize(a?.address) });

/** Raw header block → { name: [values] } (folded lines joined). */
function parseHeaders(buffer) {
  const map = {};
  const text = buffer ? buffer.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') : '';
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) (map[line.slice(0, i).trim().toLowerCase()] ||= []).push(line.slice(i + 1).trim());
  }
  return map;
}

const SOCIAL = /@([\w-]+\.)*(facebook|facebookmail|linkedin|twitter|x|instagram|pinterest|tiktok|youtube|reddit|quora|whatsapp|snapchat|discord|meetup|threads)\.(com|net)$/;
const UPDATE_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|billing|receipts?|invoices?|orders?|support|security|accounts?|mailer-daemon|postmaster)[@+.-]/;
const UPDATE_SUBJECT = /\b(receipt|invoice|order|statement|payment|password|verify|verification|confirm|delivery status|delivery failure|undeliverable|security alert|sign-?in|otp|shipped)\b/i;

/** Gmail-style inbox category from sender and list headers. */
function categorize(record, headers) {
  const from = record.from.address;
  if (SOCIAL.test(from)) return 'social';
  if (headers['auto-submitted']?.some((v) => !/^no\b/i.test(v)) || UPDATE_SENDER.test(from) || UPDATE_SUBJECT.test(record.subject)) return 'updates';
  if (headers['list-unsubscribe'] || headers['list-id'] || headers.precedence?.some((v) => /bulk|list/i.test(v))) return 'promotions';
  return 'primary';
}

async function recordFromSource(item) {
  const uid = item.uid;
  const encoded = item.raw;
  const source = Buffer.from(encoded, 'base64');
  const parsed = await simpleParser(source, { skipImageLinks: true });
  const headers = parseHeaders(source.subarray(0, source.indexOf('\r\n\r\n') < 0 ? source.length : source.indexOf('\r\n\r\n')));
  const addresses = (value) => (value?.value || []).map(toAddress);
  const from = addresses(parsed.from)[0] || { name: '', address: '' };
  const to = addresses(parsed.to); const cc = addresses(parsed.cc); const bcc = addresses(parsed.bcc);
  const routed = ROUTING_HEADERS.flatMap((h) => headers[h] || []).flatMap((v) => v.match(EMAIL_IN_TEXT) || []).map(normalize);
  const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.address).concat(routed).filter(Boolean))];
  const record = {
    uid: Number(uid), messageId: parsed.messageId || null, subject: parsed.subject || '', from,
    replyTo: addresses(parsed.replyTo)[0] || null, to, cc,
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : new Date().toISOString(),
    size: Number(item.size) || source.length, hasAttachments: Boolean(item.hasAttachments), recipients, state: {},
    snippet: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
  record.category = categorize(record, headers);
  return record;
}

/** Update local metadata from the selected transport. */
async function syncFolder(folder, cache) {
  const knownUids = Object.keys(cache.messages).map(Number);
  const result = await bridge('sync', { folder, knownUids, knownUidValidity: cache.uidValidity });
  const uidValidity = String(result.uidValidity || '');
  if (cache.uidValidity !== uidValidity) {
    for (const uid of Object.keys(cache.messages)) evict(folder, Number(uid));
    cache.messages = {}; cache.lastUid = 0; cache.uidValidity = uidValidity;
  }
  const records = await Promise.all((result.messages || []).map(recordFromSource));
  let changed = records.length > 0;
  for (const record of records) cache.messages[record.uid] = record;
  if (Array.isArray(result.seenUids)) {
    const seen = new Set(result.seenUids.map(Number));
    for (const record of Object.values(cache.messages)) {
      const now = seen.has(record.uid);
      // Read or unread in another mail app (Titan, Gmail, phone): that change wins for every account.
      if (typeof record.imapRead === 'boolean' && record.imapRead !== now) {
        for (const state of Object.values(record.state || {})) state.read = now;
        changed = true;
      }
      record.imapRead = now;
    }
  }
  const existing = new Set((result.uids || []).map(Number));
  for (const uid of Object.keys(cache.messages)) {
    if (!existing.has(Number(uid))) {
      evict(folder, Number(uid));
      delete cache.messages[uid];
      changed = true;
    }
  }
  cache.lastUid = Math.max(0, ...existing);
  if (changed) {
    save();
    announceChange();
  }
  return { hasMore: result.hasMore === true, changed };
}

let running = null;
let continuation = null;

/**
 * Pull new INBOX and Sent messages into the local cache (and Spam, when it's switched on).
 * `{ inboxOnly: true }` is the quick check made every few seconds while someone has the app open.
 */
export function syncInbox({ inboxOnly = false } = {}) {
  running ??= runSync(inboxOnly ? ['inbox'] : SYNCED_FOLDERS).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(folders) {
  clearTimeout(continuation);
  let hasMore = false;
  let changed = false;
  const data = db();
  try {
    for (const folder of folders) {
      const result = await syncFolder(folder, cacheOf(folder));
      hasMore = result.hasMore || hasMore;
      changed = result.changed || changed;
    }
    data.sync.lastError = null;
    if (hasMore) {
      continuation = setTimeout(() => {
        syncInbox().catch((err) => console.warn('[sync] continuation failed:', describeError(err)));
      }, 1000);
      continuation.unref?.();
    }
    // Warm the cache with the newest mail so opening it is instant. Skipped on quick checks that
    // found nothing new, so frequent checks don't re-read cached messages for nothing.
    if (changed || folders.length > 1) {
      const newest = (folder, n) => Object.values(cacheOf(folder).messages).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n).map((m) => m.uid);
      prefetch(newest('inbox', 25), 'inbox');
      if (folders.includes('sent')) prefetch(newest('sent', 10), 'sent');
    }
  } catch (err) {
    data.sync.lastError = describeError(err);
    throw err;
  } finally {
    data.sync.lastSyncAt = new Date().toISOString();
    save();
  }
  return data.sync;
}

// Parsed messages kept in memory (newest use last), so opening one or downloading its
// attachments skips IMAP. Bounded by total size; very large messages are not kept.
const parsedCache = new Map(); // "folder:uid" -> { parsed, size }
const CACHE_TOTAL_BYTES = 150 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const PREFETCH_MAX_BYTES = 2 * 1024 * 1024;
let cachedBytes = 0;

function remember(key, parsed, size) {
  if (size > CACHE_MAX_ENTRY_BYTES) return;
  if (parsedCache.has(key)) cachedBytes -= parsedCache.get(key).size;
  parsedCache.delete(key);
  parsedCache.set(key, { parsed, size });
  cachedBytes += size;
  for (const [oldest, entry] of parsedCache) {
    if (cachedBytes <= CACHE_TOTAL_BYTES) break;
    parsedCache.delete(oldest);
    cachedBytes -= entry.size;
  }
}

function recall(key) {
  const entry = parsedCache.get(key);
  if (!entry) return null;
  parsedCache.delete(key); // move to the newest end
  parsedCache.set(key, entry);
  return entry.parsed;
}

// The same message requested twice at once (a prefetch and a click) is downloaded once.
const inFlight = new Map();

const identityOf = (folder, uid) => ({ folder, uidValidity: cacheOf(folder).uidValidity, uid: Number(uid) });
const cacheKey = (folder, uid) => JSON.stringify([folder, cacheOf(folder).uidValidity, Number(uid)]);

async function parseSource(source, identity) {
  const parsed = await simpleParser(source);
  if (identity.uidValidity !== cacheOf(identity.folder).uidValidity || !cacheOf(identity.folder).messages[identity.uid]) {
    throw new HttpError(409, 'Mailbox changed. Refresh the message list.');
  }
  remember(cacheKey(identity.folder, identity.uid), parsed, source.length);
  const record = cacheOf(identity.folder).messages[identity.uid];
  record.snippet = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  record.hasAttachments = parsed.attachments.length > 0;
  return parsed;
}

// Larger messages are opened without their big attachments (see fetchLite in the bridge); each
// one comes down only when it is opened, through attachmentContent.
const LITE_MIN_BYTES = 512 * 1024;

async function download(folder, uid, background = false) {
  if (config.mailBridge.configured && cacheOf(folder).messages[uid]?.size > LITE_MIN_BYTES) {
    try {
      const { raw } = await bridge('fetchLite', { folder, uid, ...(background && { background: true }) });
      return raw ? Buffer.from(raw, 'base64') : null;
    } catch (err) {
      // A bridge from before fetchLite: download the whole message as before.
      if (!/Unsupported bridge action/.test(err.message)) throw err;
    }
  }
  const { raw } = await bridge('fetch', { folder, uid });
  return raw ? Buffer.from(raw, 'base64') : null;
}

const leftOutPart = (att) => /^([\d.]+);/.exec(String(att.headers?.get('x-aliasmail-part') || ''))?.[1];

/**
 * An attachment of a message, ready to send again (forwarding). One left out by fetchLite is
 * copied on the bridge into an upload, so it never travels to this app and back.
 */
export async function forwardableAttachment(att, uid, folder, owner) {
  const part = leftOutPart(att);
  if (part && config.mailBridge.configured) {
    try {
      const { uploadId, size } = await bridge('uploadFromPart', { folder, uid: Number(uid), part, owner, filename: att.filename || '', contentType: att.contentType || '' });
      return { uploadId, filename: att.filename || 'attachment', contentType: att.contentType, size };
    } catch (err) {
      // A bridge from before uploadFromPart: bring the file here instead.
      if (!/Unsupported bridge action/.test(err.message)) throw err;
    }
  }
  const full = await attachmentContent(att, uid, folder);
  return { filename: full.filename || 'attachment', contentType: full.contentType, content: full.content.toString('base64'), size: full.content.length };
}

/** An attachment with its content, downloading it now if the message was opened without it. */
export async function attachmentContent(att, uid, folder = 'inbox') {
  const part = leftOutPart(att);
  if (!part) return att;
  const { raw } = await bridge('fetchPart', { folder, uid: Number(uid), part });
  if (!raw) throw new HttpError(404, 'This message was deleted from the mailbox');
  const file = (await simpleParser(Buffer.from(raw, 'base64'))).attachments[0];
  if (!file) throw new HttpError(500, 'The attachment could not be read');
  return { ...att, content: file.content, size: file.content.length };
}

/** Read memory, then durable cache, and only then download from the mail server. */
export function fetchParsed(uid, folder = 'inbox', { background = false } = {}) {
  uid = Number(uid);
  const key = cacheKey(folder, uid);
  const cached = recall(key);
  if (cached) return Promise.resolve(cached);
  if (inFlight.has(key)) return inFlight.get(key);
  const identity = identityOf(folder, uid);
  const job = (async () => {
    let source = await messageCache.get(identity);
    const persisted = Boolean(source);
    if (!source) {
      source = await download(folder, uid, background);
      if (!source) return null;
    }
    const parsed = await parseSource(source, identity);
    if (!persisted) void messageCache.put(identity, source);
    return parsed;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

let prefetchQueue = Promise.resolve();
const prefetching = new Set();
const PREFETCH_BATCH_BYTES = 8 * 1024 * 1024;
const PREFETCH_BATCH_MESSAGES = 5;

/** Warm message bodies in small background batches without blocking foreground opens. */
export function prefetch(uids, folder = 'inbox') {
  const wanted = uids.map(Number).filter((uid) => {
    const record = cacheOf(folder).messages[uid];
    const key = cacheKey(folder, uid);
    return record && record.size <= PREFETCH_MAX_BYTES && !parsedCache.has(key) && !inFlight.has(key) && !prefetching.has(key);
  });
  // Bigger messages are preloaded without their attachments (fetchLite), so they open at once too.
  if (config.mailBridge.configured) {
    const large = uids.map(Number).filter((uid) => cacheOf(folder).messages[uid]?.size > PREFETCH_MAX_BYTES);
    for (const uid of large) {
      prefetchQueue = prefetchQueue.then(() => {
        const key = cacheKey(folder, uid);
        if (parsedCache.has(key) || inFlight.has(key) || !cacheOf(folder).messages[uid]) return undefined;
        return fetchParsed(uid, folder, { background: true }).catch((err) => console.warn('[prefetch]', err.message));
      });
    }
  }
  if (!wanted.length || !config.configured) return;

  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const uid of wanted) {
    const key = cacheKey(folder, uid);
    const size = cacheOf(folder).messages[uid].size || 0;
    if (batch.length && (batch.length >= PREFETCH_BATCH_MESSAGES || batchBytes + size > PREFETCH_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(uid);
    batchBytes += size;
    prefetching.add(key);
  }
  if (batch.length) batches.push(batch);

  prefetchQueue = prefetchQueue
    .then(async () => {
      for (const queued of batches) {
        let batch = queued.filter((uid) => {
          const key = cacheKey(folder, uid);
          if (!parsedCache.has(key) && !inFlight.has(key)) return true;
          prefetching.delete(key);
          return false;
        });
        const restored = await Promise.all(batch.map(async (uid) => {
          const identity = identityOf(folder, uid);
          const source = await messageCache.get(identity);
          if (!source) return false;
          await parseSource(source, identity);
          prefetching.delete(cacheKey(folder, uid));
          return true;
        }));
        batch = batch.filter((uid, index) => !restored[index] && !inFlight.has(cacheKey(folder, uid)));
        for (const uid of queued) if (!batch.includes(uid)) prefetching.delete(cacheKey(folder, uid));
        if (!batch.length) continue;
        const identities = new Map(batch.map((uid) => [uid, identityOf(folder, uid)]));
        const batchJob = bridge('fetchMany', { folder, uids: batch }).then(async (result) => {
          const parsedMessages = new Map();
          await Promise.all((result.messages || []).map(async ({ uid, raw }) => {
            const source = Buffer.from(raw, 'base64');
            const identity = identities.get(Number(uid));
            if (!identity) return;
            const parsed = await parseSource(source, identity);
            void messageCache.put(identity, source);
            parsedMessages.set(Number(uid), parsed);
          }));
          return parsedMessages;
        });

        // Background downloads must not block an explicit message open.
        // fetchParsed keeps its own deduplicated foreground request.
        try {
          await batchJob;
        } finally {
          for (const uid of batch) prefetching.delete(cacheKey(folder, uid));
        }
      }
      save();
    })
    .catch((err) => {
      for (const uid of wanted) prefetching.delete(cacheKey(folder, uid));
      console.warn('[prefetch]', err.message);
    });
}

function evict(folder, uid) {
  const key = cacheKey(folder, uid);
  const entry = parsedCache.get(key);
  if (entry) { cachedBytes -= entry.size; parsedCache.delete(key); }
  prefetching.delete(key);
  void messageCache.remove(identityOf(folder, uid));
}

function forget(folder, uids) {
  for (const uid of uids) {
    evict(folder, uid);
    delete cacheOf(folder).messages[uid];
  }
  save();
  announceChange();
}

/** Move messages to Trash, or expunge them when `permanent` (or no Trash folder exists). */
export async function deleteFromServer(uids, { permanent = false, folder = 'inbox' } = {}) {
  if (!uids.length) return;
  await bridge('delete', { folder, uids, permanent });
  forget(folder, uids);
}

/** Move messages between mirrored folders, e.g. inbox → spam ("Report spam") and back. */
export async function moveMessages(uids, from, to) {
  if (!uids.length) return;
  await bridge('move', { folder: from, to, uids });
  forget(from, uids);
  await syncInbox().catch(() => {});
}

let flagSupportWarned = false;

/**
 * Set or clear the mail server's \Seen flag so other mail apps show the same read state.
 * The local copy is updated first, so the next sync doesn't mistake our own change for one
 * made elsewhere. Never fails the caller: read state in the app is already saved.
 */
export async function setServerSeen(uids, seen, folder = 'inbox') {
  const cache = cacheOf(folder);
  const changed = uids.map(Number).filter((uid) => cache.messages[uid] && cache.messages[uid].imapRead !== seen);
  if (!changed.length || !config.configured) return;
  for (const uid of changed) cache.messages[uid].imapRead = seen;
  save();
  try {
    await bridge('flag', { folder, uids: changed, seen });
  } catch (err) {
    for (const uid of changed) if (cache.messages[uid]) cache.messages[uid].imapRead = !seen;
    save();
    if (/Unsupported/i.test(err.message)) {
      if (!flagSupportWarned) console.warn('[mail] The PHP bridge cannot set read flags yet - upload the latest bridge-core.php.');
      flagSupportWarned = true;
    } else {
      console.warn('[mail] Could not update read state on the mail server:', describeError(err));
    }
  }
}

/**
 * Attachments already uploaded to the bridge stay there: the message goes out with a placeholder
 * per file (the base64 of "AMU:<uploadId>", one short line) and the bridge puts the files in. That
 * saves downloading each file to this app and uploading it again.
 */
async function sendWithUploads(mail, uploadIds) {
  const attachments = mail.attachments.map((a) => (a.uploadId
    ? { filename: a.filename, contentType: a.contentType, content: Buffer.from(`AMU:${a.uploadId}`), contentTransferEncoding: 'base64' }
    : a));
  const compiled = new MailComposer({ ...mail, attachments }).compile();
  const raw = await compiled.build();
  const sent = await bridge('sendWithUploads', { raw: raw.toString('base64'), envelope: compiled.getEnvelope(), uploads: uploadIds, owner: mail.from.address });
  void bridge('saveStagedSent', { rawId: sent.rawId })
    .catch((err) => console.warn('[mail] Sent copy save failed:', err.message))
    .finally(() => syncInbox().catch((err) => console.warn('[mail] post-send sync failed:', err.message)));
  return compiled.messageId();
}

/** Send through SMTP; save the Sent copy in the background so it doesn't delay the send response. */
export async function sendMail(mail) {
  assertConfigured();
  const uploadIds = (mail.attachments || []).map((a) => a.uploadId).filter(Boolean);
  if (uploadIds.length) {
    try {
      return await sendWithUploads(mail, uploadIds);
    } catch (err) {
      // A bridge from before sendWithUploads: nothing was sent, so send the slower way below.
      if (!/Unsupported bridge action/.test(err.message)) throw err;
    }
  }
  const attachments = await Promise.all((mail.attachments || []).map(async (attachment) => {
    if (!attachment.uploadId) return attachment;
    const stored = await bridge('consumeUpload', { uploadId: attachment.uploadId, owner: mail.from.address });
    return { filename: stored.filename, contentType: stored.contentType, content: stored.content, encoding: 'base64' };
  }));
  const compiled = new MailComposer({ ...mail, attachments }).compile();
  const raw = await compiled.build();
  const encodedRaw = raw.toString('base64');
  const envelope = compiled.getEnvelope();
  const sent = await bridge('sendRaw', { raw: encodedRaw, envelope });
  await Promise.all(uploadIds.map((uploadId) => bridge('deleteUpload', { uploadId, owner: mail.from.address }).catch((err) => {
    console.warn('[mail] Temporary attachment cleanup failed:', err.message);
  })));
  const saveAction = sent.rawId ? 'saveStagedSent' : 'saveSent';
  const savePayload = sent.rawId ? { rawId: sent.rawId } : { raw: encodedRaw };
  void bridge(saveAction, savePayload)
    .catch((err) => console.warn('[mail] Sent copy save failed:', err.message))
    .finally(() => syncInbox().catch((err) => console.warn('[mail] post-send sync failed:', err.message)));

  return compiled.messageId();
}

/** Log in the interactive connection ahead of time (and keep it alive) so no click pays for the login. */
export function keepWarm() {
  void mailTransport.warm().catch((err) => console.warn('[mail] Warm connection failed:', describeError(err)));
}

export async function testConnection() {
  assertConfigured();
  // Report each side's failure to the admin; a bare 500 hides whether the host blocks IMAP or SMTP.
  let result;
  try {
    result = await bridge('test');
  } catch (err) {
    throw new HttpError(502, `Mail connection failed - ${describeError(err)}`);
  }
  // A bridge from before the workers were added answers "Unsupported bridge action".
  const workers = await mailTransport.workers().catch((err) => ({ error: describeError(err) }));
  return { ...result, workers };
}

// IMAP IDLE notifications are coalesced; periodic sync remains a fallback.
let idleSyncTimer;
mailTransport.onChange(() => {
  clearTimeout(idleSyncTimer);
  idleSyncTimer = setTimeout(() => {
    syncInbox().catch((err) => console.warn('[mail] IDLE sync failed:', describeError(err)));
  }, 250);
  idleSyncTimer.unref?.();
});

export async function closeMailbox() {
  clearTimeout(continuation);
  clearTimeout(idleSyncTimer);
  await mailTransport.close();
  await messageCache.drain();
}
