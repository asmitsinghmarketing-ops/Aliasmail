// Everything that talks to the real mailbox: IMAP for reading / moving / deleting,
// SMTP for sending as an alias.
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import config from './config.js';
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
  if (!config.configured) {
    throw new HttpError(503, 'Mailbox is not configured. Set MAIL_USER and the PHP mail bridge settings.');
  }
  if (!config.mailBridge.configured) throw new HttpError(503, 'PHP mail bridge is not configured. Set MAIL_BRIDGE_URL and MAIL_BRIDGE_TOKEN.');
}

async function bridge(action, data = {}) {
  assertConfigured();
  const bridgeUrl = new URL(config.mailBridge.url);
  if (process.env.NODE_ENV === 'production' && bridgeUrl.protocol !== 'https:') {
    throw new HttpError(500, 'MAIL_BRIDGE_URL must use HTTPS in production');
  }
  const response = await fetch(config.mailBridge.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.mailBridge.token}` },
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : response.status, result.error || `PHP mail bridge failed (${response.status})`);
  return result;
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

/** Update local metadata using raw messages fetched by the PHP IMAP service. */
async function syncFolder(folder, cache) {
  const knownUids = Object.keys(cache.messages).map(Number);
  const result = await bridge('sync', { folder, knownUids, knownUidValidity: cache.uidValidity });
  const uidValidity = String(result.uidValidity || '');
  if (cache.uidValidity !== uidValidity) {
    cache.messages = {}; cache.lastUid = 0; cache.uidValidity = uidValidity;
  }
  for (const item of result.messages || []) cache.messages[item.uid] = await recordFromSource(item);
  const existing = new Set((result.uids || []).map(Number));
  for (const uid of Object.keys(cache.messages)) if (!existing.has(Number(uid))) delete cache.messages[uid];
  cache.lastUid = Math.max(0, ...existing);
}

let running = null;

/** Pull new INBOX and Sent messages into the local cache (and Spam, when it's switched on). */
export function syncInbox() {
  running ??= runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync() {
  const data = db();
  try {
    for (const folder of SYNCED_FOLDERS) {
      await syncFolder(folder, cacheOf(folder));
    }
    data.sync.lastError = null;
    // Warm the cache with the newest mail so opening it is instant.
    const newest = (folder, n) => Object.values(cacheOf(folder).messages).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n).map((m) => m.uid);
    prefetch(newest('inbox', 25), 'inbox');
    prefetch(newest('sent', 10), 'sent');
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

/** Fetch and parse a full message from 'inbox', 'sent' or 'spam'. Returns null if it no longer exists. */
export function fetchParsed(uid, folder = 'inbox') {
  uid = Number(uid);
  const key = `${folder}:${uid}`;
  const cached = recall(key);
  if (cached) return Promise.resolve(cached);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = bridge('fetch', { folder, uid })
    .then(async (result) => {
      if (!result.raw) return null;
      const source = Buffer.from(result.raw, 'base64');
      return { parsed: await simpleParser(source), size: source.length };
    })
    .then((result) => {
      if (!result) return null;
      remember(key, result.parsed, result.size);
      return result.parsed;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

let prefetchQueue = Promise.resolve();

/** Download and parse messages in the background (one IMAP command per batch) so they open instantly. */
export function prefetch(uids, folder = 'inbox') {
  const wanted = uids.map(Number).filter((uid) => {
    const record = cacheOf(folder).messages[uid];
    const key = `${folder}:${uid}`;
    return record && record.size <= PREFETCH_MAX_BYTES && !parsedCache.has(key) && !inFlight.has(key);
  });
  if (!wanted.length || !config.configured) return;

  prefetchQueue = prefetchQueue
    .then(async () => {
      for (const uid of wanted) {
        const key = `${folder}:${uid}`;
        const { raw } = await bridge('fetch', { folder, uid });
        if (raw && !parsedCache.has(key)) {
          const source = Buffer.from(raw, 'base64');
          const parsed = await simpleParser(source);
          remember(key, parsed, source.length);
          const record = cacheOf(folder).messages[uid];
          if (record) record.snippet = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        }
      }
      save();
    })
    .catch((err) => console.warn('[prefetch]', err.message));
}

function forget(folder, uids) {
  for (const uid of uids) {
    delete cacheOf(folder).messages[uid];
    const entry = parsedCache.get(`${folder}:${uid}`);
    if (entry) {
      cachedBytes -= entry.size;
      parsedCache.delete(`${folder}:${uid}`);
    }
  }
  save();
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

/** Send through SMTP; save the Sent copy in the background so it doesn't delay the send response. */
export async function sendMail(mail) {
  assertConfigured();
  const compiled = new MailComposer(mail).compile();
  const raw = await compiled.build();
  const encodedRaw = raw.toString('base64');
  const envelope = compiled.getEnvelope();
  await bridge('sendRaw', { raw: encodedRaw, envelope });
  void bridge('saveSent', { raw: encodedRaw })
    .catch((err) => console.warn('[mail] Sent copy save failed:', err.message))
    .finally(() => syncInbox().catch((err) => console.warn('[mail] post-send sync failed:', err.message)));

  return compiled.messageId();
}

/** Log in the interactive connection ahead of time (and keep it alive) so no click pays for the login. */
export function keepWarm() {
  // PHP shared hosting owns the IMAP connection and opens it per request.
}

export async function testConnection() {
  assertConfigured();
  // Report each side's failure to the admin; a bare 500 hides whether the host blocks IMAP or SMTP.
  try {
    return await bridge('test');
  } catch (err) {
    throw new HttpError(502, `PHP mail bridge connection failed - ${describeError(err)}`);
  }
}
