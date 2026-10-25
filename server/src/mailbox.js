// Everything that talks to the real mailbox: IMAP for reading / moving / deleting,
// SMTP for sending as an alias.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import config from './config.js';
import { db, save } from './store.js';
import { normalize } from './aliases.js';
import { HttpError, describeError } from './errors.js';

// Headers mail servers add with the address a message was actually delivered to.
// They catch aliases that were BCC'd or reached through a forward.
const ROUTING_HEADERS = ['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to'];
// Headers used to sort the inbox into Primary / Promotions / Social / Updates.
const CATEGORY_HEADERS = ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'];
const EMAIL_IN_TEXT = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// Mail folders the app mirrors. Sent and Spam have provider-specific names, so they are
// found by their special-use flag.
const FOLDERS = { inbox: 'INBOX', sent: '\\Sent', spam: '\\Junk' };

const transport = nodemailer.createTransport(config.smtp);

function assertConfigured() {
  if (!config.configured) {
    throw new HttpError(503, 'Mailbox is not configured. Set MAIL_USER and MAIL_PASSWORD in server/.env');
  }
}

// Long-lived IMAP connections: logging in to GoDaddy takes seconds, so they are reused and
// re-opened when the server drops them. ImapFlow runs one command at a time per connection, so
// background work (sync, prefetch) gets its own "lane" and never makes a user's click wait.
const connections = {}; // lane -> { client, ready }

function connect(lane) {
  if (connections[lane]) return connections[lane];
  const client = new ImapFlow({ ...config.imap });
  client.on('error', (err) => console.warn(`[imap:${lane}]`, describeError(err)));
  client.on('close', () => {
    if (connections[lane]?.client === client) delete connections[lane];
  });
  const ready = client.connect().then(
    () => client,
    (err) => {
      delete connections[lane];
      throw err;
    },
  );
  connections[lane] = { client, ready };
  return connections[lane];
}

async function withClient(fn, { lane = 'main', retry = true } = {}) {
  assertConfigured();
  const client = await connect(lane).ready;
  try {
    return await fn(client);
  } catch (err) {
    // The connection died mid-request (idle timeout, network blip): reconnect and try once more.
    if (retry && !client.usable) {
      if (connections[lane]?.client === client) delete connections[lane];
      return withClient(fn, { lane, retry: false });
    }
    throw err;
  }
}

async function folderPath(client, folder) {
  const target = FOLDERS[folder];
  if (!target?.startsWith('\\')) return target;
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === target)?.path;
}

async function trashPath(client) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === '\\Trash')?.path;
}

/** Run `fn(client, path)` with a folder ('inbox' | 'sent' | 'spam') selected. path is null if it doesn't exist. */
function withFolder(folder, fn, lane = 'main') {
  return withClient(async (client) => {
    const path = await folderPath(client, folder);
    if (!path) return fn(client, null);
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client, path);
    } finally {
      lock.release();
    }
  }, { lane });
}

/** The local cache of a folder: { uidValidity, lastUid, messages } */
export function cacheOf(folder) {
  const data = db();
  return { sent: data.sentBox, spam: data.spamBox }[folder] || data.inbox;
}

const toAddress = (a) => ({ name: a?.name || '', address: normalize(a?.address) });

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

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

function toRecord(msg) {
  const env = msg.envelope || {};
  const headers = parseHeaders(msg.headers);
  const to = (env.to || []).map(toAddress);
  const cc = (env.cc || []).map(toAddress);
  const bcc = (env.bcc || []).map(toAddress);
  const routed = ROUTING_HEADERS.flatMap((h) => headers[h] || []).flatMap((v) => v.match(EMAIL_IN_TEXT) || []).map(normalize);
  const date = new Date(env.date || msg.internalDate || Date.now());

  const record = {
    uid: msg.uid,
    messageId: env.messageId || null,
    subject: env.subject || '',
    from: toAddress(env.from?.[0]),
    replyTo: env.replyTo?.[0] ? toAddress(env.replyTo[0]) : null,
    to,
    cc,
    date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    size: msg.size || 0,
    hasAttachments: hasAttachment(msg.bodyStructure),
    recipients: [...new Set([...to, ...cc, ...bcc].map((a) => a.address).concat(routed).filter(Boolean))],
    state: {},
  };
  record.category = categorize(record, headers);
  return record;
}

async function snippetOf(source) {
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true });
    return (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Bring one selected folder's cache up to date. */
async function syncFolder(client, cache) {
  const uidValidity = String(client.mailbox.uidValidity);
  if (cache.uidValidity !== uidValidity) {
    cache.messages = {};
    cache.lastUid = 0;
    cache.uidValidity = uidValidity;
  }
  if (!client.mailbox.exists) {
    cache.messages = {};
    return;
  }

  const from = cache.lastUid + 1;
  const query = { uid: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: [...ROUTING_HEADERS, ...CATEGORY_HEADERS] };
  for await (const msg of client.fetch(`${from}:*`, query, { uid: true })) {
    if (msg.uid < from) continue; // "N:*" always returns the newest message
    cache.messages[msg.uid] = toRecord(msg);
    cache.lastUid = Math.max(cache.lastUid, msg.uid);
  }

  // Backfill what older cache entries lack. Snippets need only the first 48 KB of the message.
  const backfill = async (missing, query, apply) => {
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100).join(',');
      for await (const msg of client.fetch(batch, { uid: true, ...query }, { uid: true })) {
        if (cache.messages[msg.uid]) await apply(cache.messages[msg.uid], msg);
      }
    }
  };
  const all = Object.values(cache.messages);
  await backfill(all.filter((m) => m.snippet === undefined).map((m) => m.uid), { source: { start: 0, maxLength: 48 * 1024 } }, async (record, msg) => {
    record.snippet = await snippetOf(msg.source);
  });
  await backfill(all.filter((m) => m.category === undefined).map((m) => m.uid), { headers: CATEGORY_HEADERS }, (record, msg) => {
    record.category = categorize(record, parseHeaders(msg.headers));
  });

  // Prune messages deleted elsewhere (webmail, phone). search() returns false on failure.
  const uids = await client.search({ all: true }, { uid: true });
  if (Array.isArray(uids)) {
    const onServer = new Set(uids);
    for (const uid of Object.keys(cache.messages)) {
      if (!onServer.has(Number(uid))) delete cache.messages[uid];
    }
  }
}

let running = null;

/** Pull new INBOX, Sent and Spam messages into the local cache. */
export function syncInbox() {
  running ??= runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync() {
  const data = db();
  try {
    for (const folder of ['inbox', 'sent', 'spam']) {
      await withFolder(folder, (client, path) => path && syncFolder(client, cacheOf(folder)), 'background');
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

  const job = withFolder(folder, async (client, path) => {
    if (!path) return null;
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    return msg?.source ? { parsed: await simpleParser(msg.source), size: msg.source.length } : null;
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
    .then(() =>
      withFolder(
        folder,
        async (client, path) => {
          if (!path) return;
          const sources = [];
          for await (const msg of client.fetch(wanted.join(','), { uid: true, source: true }, { uid: true })) {
            if (msg.source) sources.push([msg.uid, msg.source]);
          }
          for (const [uid, source] of sources) {
            const key = `${folder}:${uid}`;
            if (!parsedCache.has(key)) remember(key, await simpleParser(source), source.length);
          }
        },
        'background',
      ),
    )
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
  await withFolder(folder, async (client, path) => {
    if (!path) return;
    const range = uids.join(',');
    const trash = permanent ? null : await trashPath(client);
    if (trash) await client.messageMove(range, trash, { uid: true });
    else await client.messageDelete(range, { uid: true });
  });
  forget(folder, uids);
}

/** Move messages between mirrored folders, e.g. inbox → spam ("Report spam") and back. */
export async function moveMessages(uids, from, to) {
  if (!uids.length) return;
  await withFolder(from, async (client, path) => {
    const target = await folderPath(client, to);
    if (!path || !target) throw new HttpError(400, `This mailbox has no ${to} folder`);
    await client.messageMove(uids.join(','), target, { uid: true });
  });
  forget(from, uids);
  await syncInbox().catch(() => {});
}

/** Send through the main account's SMTP with the alias as From, then keep a copy in Sent. */
export async function sendMail(mail) {
  assertConfigured();
  const compiled = new MailComposer(mail).compile();
  const raw = await compiled.build();
  await transport.sendMail({ envelope: compiled.getEnvelope(), raw });

  withClient(async (client) => {
    const sent = await folderPath(client, 'sent');
    if (sent) await client.append(sent, raw, ['\\Seen']);
  })
    .then(() => syncInbox())
    .catch((err) => console.warn('[mail] could not save a copy to Sent:', err.message));

  return compiled.messageId();
}

/** Log in the interactive connection ahead of time (and keep it alive) so no click pays for the login. */
export function keepWarm() {
  return withClient((client) => client.noop()).catch((err) => console.warn('[imap:main] keep-alive failed:', describeError(err)));
}

export async function testConnection() {
  assertConfigured();
  // Report each side's failure to the admin; a bare 500 hides whether the host blocks IMAP or SMTP.
  let folders;
  try {
    folders = await withClient(async (client) => (await client.list()).map((b) => b.path));
  } catch (err) {
    throw new HttpError(502, `IMAP ${config.imap.host}:${config.imap.port} failed - ${describeError(err)}`);
  }
  try {
    await transport.verify();
  } catch (err) {
    throw new HttpError(502, `SMTP ${config.smtp.host}:${config.smtp.port} failed - ${describeError(err)}`);
  }
  return { imap: true, smtp: true, folders };
}
