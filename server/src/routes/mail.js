// Mailbox API. An alias sees only mail addressed to it (To, Cc, Bcc or delivery headers);
// the admin, as the main mailbox address, sees the whole mailbox. Read / starred / important /
// archived / snoozed / trashed / labels are kept per account.
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { db, save } from '../store.js';
import { EMAIL_RE, PALETTE, accountOf, aliasesOf, canOpenMailbox, findAlias, isOwner, isVisibleTo, messagesFor, normalize, setAvatar, updateAccount } from '../aliases.js';
import { avatarUrl, saveAvatar } from '../avatars.js';
import { signOutAccount } from '../sessions.js';
import { limiter } from '../security.js';
import { audit } from '../audit.js';

// Guessing the current password from a signed-in browser: 5 tries per 15 minutes.
const passwordChecks = limiter('password-change', { max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });
import { requireAuth } from '../auth.js';
import { attachmentLink, deleteFromServer, fetchParsed, noteSend, sendPart, warmAttachments, forwardableAttachment, moveMessages, prefetch, setServerSeen, startAttachmentUpload, syncInbox } from '../mailbox.js';
import { deliver, queueInOutbox, runScheduled } from '../outbox.js';
import { bodyOf, byDateDesc, matchesQuery, paginate, toUidList } from '../util.js';
import { HttpError, describeError } from '../errors.js';
import { announceChange, mailEvents } from '../mail-events.js';
import { liveSync, noteActivity } from '../live-sync.js';
import { driveEnabled } from '../google-auth.js';
import { driveTokenFor, readDriveRequest, shareWithRecipients } from '../google-drive.js';
import { findLoginCode, mightHaveCode, serviceName } from '../login-codes.js';

const router = Router();

router.use(requireAuth(), (req, res, next) => {
  noteActivity();
  liveSync.nudge();
  req.me = req.user.role === 'admin' ? config.mailbox : req.user.email;
  if (!req.me) throw new HttpError(503, 'Mailbox is not configured');
  // A group mailbox opened through the mailbox switcher. Checked on every request, so a
  // removed role or a disabled mailbox takes effect at once.
  const wanted = normalize(req.get('X-Mailbox'));
  if (wanted && wanted !== req.me) {
    if (!canOpenMailbox(req.user.role, req.user.email, wanted)) throw new HttpError(403, 'You don’t have access to that mailbox');
    req.me = wanted;
    req.shared = true;
  }
  // Changes (and opening a message, which marks it read) show up at once in other open
  // mailboxes, e.g. teammates in a shared mailbox, instead of on their next refresh.
  const opensMessage = req.method === 'GET' && /^\/(messages|sent|spam)\/[^/]+$/.test(req.path) && !req.query.peek;
  if (req.method !== 'GET' || opensMessage) {
    res.on('finish', () => res.statusCode < 400 && announceChange());
  }
  next();
});

/** Settings of a shared mailbox belong to the administrator. */
function ownMailboxOnly(req) {
  if (req.shared) throw new HttpError(403, 'Settings of a shared mailbox are managed by your administrator');
}

// Push invalidation only; lists and bodies still authorize the current session.
router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  // Some hosting proxies hold small writes until a few KB pile up; a padding comment pushes
  // each event through at once. Polling covers proxies that still hold it back.
  const pad = `:${' '.repeat(2048)}\n\n`;
  res.write(`retry: 3000\n\n${pad}`);
  const changed = () => { if (!res.writableEnded) res.write(`event: mail\ndata: {}\n\n${pad}`); };
  mailEvents.on('changed', changed);
  liveSync.nudge();
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  // Periodic reconnect rechecks revoked/expired sessions.
  const lifetime = setTimeout(() => res.end(), 60_000);
  const cleanup = () => {
    mailEvents.off('changed', changed);
    clearInterval(heartbeat);
    clearTimeout(lifetime);
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
});

/* ---------------------------------- helpers ---------------------------------- */

const stateOf = (m, me) => ({ read: Boolean(m.imapRead), ...(m.state[me] || {}) });
const isSnoozed = (s) => Boolean(s.snoozedUntil) && Date.parse(s.snoozedUntil) > Date.now();
const live = (s) => !s.trashed;

const FOLDERS = {
  inbox: (s) => !s.archived && live(s) && !isSnoozed(s),
  starred: (s) => s.starred && live(s),
  snoozed: (s) => isSnoozed(s) && live(s),
  important: (s) => s.important && live(s),
  all: live,
  trash: (s) => s.trashed,
};
const CATEGORIES = ['primary', 'promotions', 'social', 'updates'];

// How the account received the message, shown as "to me" / "cc me" / "bcc me".
const via = (m, me) => (m.to.some((a) => a.address === me) ? 'to' : m.cc.some((a) => a.address === me) ? 'cc' : isOwner(me) ? null : 'bcc');

const toSnippet = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const parseList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[,;]/)).map(normalize).filter(Boolean);
const asAddresses = (list) => list.map((address) => ({ name: '', address }));

const summary = (m, me) => {
  const s = stateOf(m, me);
  return {
    id: m.uid,
    kind: 'inbox',
    subject: m.subject,
    snippet: m.snippet || '',
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    hasAttachments: m.hasAttachments,
    category: m.category || 'primary',
    via: via(m, me),
    read: Boolean(s.read),
    starred: Boolean(s.starred),
    important: Boolean(s.important),
    archived: Boolean(s.archived),
    trashed: Boolean(s.trashed),
    snoozedUntil: isSnoozed(s) ? s.snoozedUntil : null,
    labels: s.labels || [],
  };
};

const plainSummary = (kind, fields) => ({ read: true, starred: false, labels: [], hasAttachments: false, ...fields, kind });

/** Messages whose snooze ran out come back to the inbox as unread, like Gmail. */
function wakeSnoozed(me) {
  let woke = false;
  for (const m of messagesFor(me)) {
    const s = stateOf(m, me);
    if (s.snoozedUntil && !isSnoozed(s)) {
      m.state[me] = { ...s, snoozedUntil: null, read: false, archived: false };
      woke = true;
    }
  }
  if (woke) save();
}

function ownMessage(req) {
  const msg = db().messages[req.params.uid];
  if (!msg || !isVisibleTo(msg, req.me)) throw new HttpError(404, 'Message not found');
  return msg;
}

function setState(msg, address, patch) {
  msg.state[address] = { ...msg.state[address], ...patch };
}

/**
 * Whether other mail apps should show the message as read: once every alias it reached has
 * read it, so one person reading shared mail doesn't hide it from the others. Mail that
 * reached no alias follows the owner's read state.
 */
function readByEveryone(msg) {
  const accounts = aliasesOf(msg).map((a) => a.address);
  if (!accounts.length) accounts.push(config.mailbox);
  return accounts.every((address) => stateOf(msg, address).read);
}

/** Mirror read state to the mail server in the background (Titan, Gmail and phones see it). */
function syncSeenToServer(msgs) {
  const want = (seen) => msgs.filter((m) => readByEveryone(m) === seen && Boolean(m.imapRead) !== seen).map((m) => m.uid);
  void setServerSeen(want(true), true);
  void setServerSeen(want(false), false);
}

/**
 * Remove messages for good. A message that also reached another alias is only hidden for
 * this account, so one person can't delete someone else's copy.
 */
async function deleteForever(me, uids) {
  const removeFromServer = [];
  for (const uid of uids) {
    const msg = db().messages[uid];
    if (!msg || !isVisibleTo(msg, me)) continue;
    if (aliasesOf(msg).some((a) => a.address !== me)) setState(msg, me, { hidden: true });
    else removeFromServer.push(uid);
  }
  save();
  await deleteFromServer(removeFromServer);
}

/* ----- Sent: the mailbox's real Sent folder (ids "s<uid>"), plus app-sent mail until its copy syncs ----- */

const SENT_ID = /^s(\d+)$/;
const SPAM_ID = /^j(\d+)$/;

const sentBoxSummary = (m) =>
  plainSummary('sent', { id: `s${m.uid}`, subject: m.subject, snippet: m.snippet || '', from: m.from, to: m.to, cc: m.cc, date: m.date, hasAttachments: m.hasAttachments });
const sentLogSummary = (s) =>
  plainSummary('sent', { id: s.id, subject: s.subject, snippet: toSnippet(s.text), from: s.from, to: s.to, cc: s.cc, bcc: s.bcc || [], date: s.date, hasAttachments: s.attachments.length > 0 });

function sentItems(me) {
  const mine = (address) => isOwner(me) || address === me;
  const seen = new Set();
  const items = [];
  for (const m of Object.values(db().sentBox.messages)) {
    if (!mine(m.from.address) || (m.messageId && seen.has(m.messageId))) continue;
    if (m.messageId) seen.add(m.messageId);
    items.push(sentBoxSummary(m));
  }
  for (const s of db().sent) {
    if (mine(s.from.address) && !seen.has(s.messageId)) items.push(sentLogSummary(s));
  }
  return items;
}

function ownSent(req) {
  const msg = db().sentBox.messages[req.params.id.match(SENT_ID)?.[1]];
  if (!msg || !(isOwner(req.me) || msg.from.address === req.me)) throw new HttpError(404, 'Message not found');
  return msg;
}

/* ----- Spam: the mailbox's Junk folder (ids "j<uid>") ----- */

const spamSummary = (m) =>
  plainSummary('spam', { id: `j${m.uid}`, subject: m.subject, snippet: m.snippet || '', from: m.from, to: m.to, cc: m.cc, date: m.date, hasAttachments: m.hasAttachments });

function ownSpam(req) {
  const msg = db().spamBox.messages[req.params.id.match(SPAM_ID)?.[1]];
  if (!msg || !isVisibleTo(msg, req.me)) throw new HttpError(404, 'Message not found');
  return msg;
}

/* ----- Drafts and scheduled mail (kept in the app, per account) ----- */

const draftSummary = (d) =>
  plainSummary('draft', {
    id: d.id,
    subject: d.subject,
    snippet: toSnippet(d.text),
    from: { name: '', address: d.alias },
    to: asAddresses(parseList(d.to)),
    cc: asAddresses(parseList(d.cc)),
    date: d.updatedAt,
  });

const scheduledSummary = (s) =>
  plainSummary('scheduled', {
    id: s.id,
    subject: s.mail.subject,
    snippet: toSnippet(s.mail.text),
    from: { name: '', address: s.alias },
    to: asAddresses(s.mail.to),
    cc: asAddresses(s.mail.cc),
    date: s.sendAt,
    sendAt: s.sendAt,
    error: s.failed ? s.error : null,
    hasAttachments: s.mail.attachments.length > 0,
    // Outbox: a send that failed, being retried (lastError, next try at sendAt) or given up on.
    ...(s.outbox && { outbox: true, failed: Boolean(s.failed), uncertain: Boolean(s.uncertain), lastError: s.error || null, attempts: s.attempts || 0 }),
  });

const DRAFT_FIELDS = ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo'];

const myLabels = (me) => db().labels.filter((l) => l.alias === me);

/* ---------------------------------- folders ---------------------------------- */

router.get('/folders', (req, res) => {
  const me = req.me;
  wakeSnoozed(me);
  const msgs = messagesFor(me);
  const count = (test) => msgs.filter((m) => test(stateOf(m, me), m)).length;
  const unread = (folder) => count((s) => FOLDERS[folder](s) && !s.read);

  res.json({
    inbox: unread('inbox'),
    starred: count(FOLDERS.starred),
    snoozed: count(FOLDERS.snoozed),
    important: unread('important'),
    sent: sentItems(me).length,
    scheduled: db().scheduled.filter((s) => s.alias === me && !s.outbox).length,
    outbox: db().scheduled.filter((s) => s.alias === me && s.outbox).length,
    drafts: db().drafts.filter((d) => d.alias === me).length,
    all: unread('all'),
    spam: messagesFor(me, db().spamBox.messages).length,
    trash: count(FOLDERS.trash),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, count((s, m) => FOLDERS.inbox(s) && !s.read && (m.category || 'primary') === c)])),
    labels: Object.fromEntries(myLabels(me).map((l) => [l.id, count((s) => live(s) && !s.read && (s.labels || []).includes(l.id))])),
  });
});

router.post('/refresh', async (req, res) => {
  try {
    await syncInbox();
  } catch (err) {
    // Say why (bridge unreachable, login refused, ...) instead of a bare 500.
    const reason = err instanceof HttpError ? err.message : describeError(err);
    console.warn('[sync] refresh failed:', reason);
    throw new HttpError(502, `Couldn’t check for new mail: ${reason}`);
  }
  res.json({ ok: true });
});

router.get('/messages', (req, res) => {
  const me = req.me;
  const { folder = 'inbox', category, q, page } = req.query;
  wakeSnoozed(me);

  let items;
  if (folder === 'sent') items = sentItems(me);
  else if (folder === 'drafts') items = db().drafts.filter((d) => d.alias === me).map(draftSummary);
  else if (folder === 'scheduled') items = db().scheduled.filter((s) => s.alias === me && !s.outbox).map(scheduledSummary);
  else if (folder === 'outbox') items = db().scheduled.filter((s) => s.alias === me && s.outbox).map(scheduledSummary);
  else if (folder === 'spam') items = messagesFor(me, db().spamBox.messages).map(spamSummary);
  else {
    const labelId = folder.startsWith('label:') ? folder.slice(6) : null;
    const inFolder = labelId ? (s) => live(s) && (s.labels || []).includes(labelId) : FOLDERS[folder] || FOLDERS.inbox;
    items = messagesFor(me)
      .filter((m) => inFolder(stateOf(m, me)))
      .filter((m) => !(folder === 'inbox' && CATEGORIES.includes(category) && !q) || (m.category || 'primary') === category)
      .map((m) => summary(m, me));
  }

  const sorted = items.filter((i) => matchesQuery(i, q)).sort(byDateDesc);
  if (folder === 'scheduled') sorted.reverse(); // soonest first
  const result = paginate(sorted, page);
  res.json(result);

  // Get the first screenful ready in the background, so opening any of it is instant.
  const top = result.items.slice(0, 20);
  prefetch(top.filter((i) => i.kind === 'inbox').map((i) => i.id), 'inbox');
  prefetch(top.map((i) => SENT_ID.exec(String(i.id))?.[1]).filter(Boolean), 'sent');
});

// Login codes from the last 15 minutes, newest first, shown above the inbox (handy in a shared
// mailbox such as access@ where everyone with the role signs in to the same service).
const LOGIN_CODE_MS = 15 * 60e3;
router.get('/login-codes', async (req, res) => {
  const me = req.me;
  const since = new Date(Date.now() - LOGIN_CODE_MS).toISOString();
  const recent = messagesFor(me)
    .filter((m) => m.date >= since && FOLDERS.inbox(stateOf(m, me)) && mightHaveCode(m))
    .sort(byDateDesc)
    .slice(0, 5);
  const items = [];
  for (const m of recent) {
    let parsed = null;
    try {
      parsed = await fetchParsed(m.uid, 'inbox');
    } catch {
      // The preview is still worth a try.
    }
    const code = findLoginCode(m.subject, parsed ? parsed.text : m.snippet, parsed?.html);
    if (code) {
      items.push({
        id: m.uid, code, service: serviceName(m.from), from: m.from, subject: m.subject, date: m.date,
        expiresAt: new Date(Date.parse(m.date) + LOGIN_CODE_MS).toISOString(),
      });
    }
  }
  res.json({ items });
});

/* ---------------------------------- inbox messages ---------------------------------- */

router.get('/messages/:uid', async (req, res) => {
  const me = req.me;
  const msg = ownMessage(req);
  const parsed = await fetchParsed(msg.uid);
  if (!parsed) {
    delete db().messages[msg.uid];
    save();
    throw new HttpError(404, 'This message was deleted from the mailbox');
  }
  // ?peek=1 loads without marking read (used for preloading on hover).
  if (!req.query.peek) {
    setState(msg, me, { read: true });
    save();
    syncSeenToServer([msg]);
  }
  res.json({ ...summary(msg, me), replyTo: msg.replyTo, messageId: msg.messageId, ...bodyOf(parsed) });
});

// Called once a message is actually on screen (not on hover): its large attachments start
// downloading in the background so a click finds them ready.
router.get('/messages/:uid/warm', async (req, res) => {
  const msg = ownMessage(req);
  warmAttachments(await fetchParsed(msg.uid), msg.uid, 'inbox');
  res.json({ ok: true });
});
router.get('/sent/:id/warm', async (req, res) => {
  const msg = ownSent(req);
  warmAttachments(await fetchParsed(msg.uid, 'sent'), msg.uid, 'sent');
  res.json({ ok: true });
});

// A direct download link for a large attachment ({ url: null } means: use the route below).
router.get('/messages/:uid/attachments/:index/link', async (req, res) => {
  const msg = ownMessage(req);
  const att = (await fetchParsed(msg.uid))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  res.json({ url: await attachmentLink(att, msg.uid, 'inbox') });
});

router.get('/messages/:uid/attachments/:index', async (req, res) => {
  const msg = ownMessage(req);
  const att = (await fetchParsed(msg.uid))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  await sendPart(res, att, msg.uid, 'inbox');
});

/** Per-account state changes. Each returns a patch for one message's state. */
const ACTIONS = {
  read: () => () => ({ read: true }),
  unread: () => () => ({ read: false }),
  star: () => () => ({ starred: true }),
  unstar: () => () => ({ starred: false }),
  important: () => () => ({ important: true }),
  notImportant: () => () => ({ important: false }),
  archive: () => () => ({ archived: true }),
  inbox: () => () => ({ archived: false, trashed: false, snoozedUntil: null }),
  trash: () => () => ({ trashed: true, trashedAt: new Date().toISOString() }),
  restore: () => () => ({ trashed: false }),
  unsnooze: () => () => ({ snoozedUntil: null }),
  snooze: (body) => {
    const until = Date.parse(body.until);
    if (!until || until <= Date.now()) throw new HttpError(400, 'Pick a time in the future');
    return () => ({ snoozedUntil: new Date(until).toISOString(), archived: false });
  },
  addLabel: (body, me) => {
    const label = myLabels(me).find((l) => l.id === body.labelId);
    if (!label) throw new HttpError(404, 'Label not found');
    return (s) => ({ labels: [...new Set([...(s.labels || []), label.id])] });
  },
  removeLabel: (body) => (s) => ({ labels: (s.labels || []).filter((id) => id !== body.labelId) }),
};

/** Bulk action on inbox messages (see ACTIONS), plus 'delete' (forever) and 'spam' (report spam). */
router.post('/messages/action', async (req, res) => {
  const me = req.me;
  const body = req.body ?? {};
  const msgs = toUidList(body.ids)
    .map((uid) => db().messages[uid])
    .filter((m) => m && isVisibleTo(m, me));

  if (body.action === 'delete') {
    await deleteForever(me, msgs.map((m) => m.uid));
  } else if (body.action === 'spam') {
    await moveMessages(msgs.map((m) => m.uid), 'inbox', 'spam');
  } else if (ACTIONS[body.action]) {
    const patchFor = ACTIONS[body.action](body, me);
    for (const m of msgs) setState(m, me, patchFor(stateOf(m, me)));
    save();
    if (body.action === 'read' || body.action === 'unread') syncSeenToServer(msgs);
  } else {
    throw new HttpError(400, `Unknown action "${body.action}"`);
  }
  res.json({ ok: true, count: msgs.length });
});

router.post('/trash/empty', async (req, res) => {
  const me = req.me;
  const uids = messagesFor(me)
    .filter((m) => stateOf(m, me).trashed)
    .map((m) => m.uid);
  await deleteForever(me, uids);
  res.json({ ok: true, count: uids.length });
});

/* ---------------------------------- sent ---------------------------------- */

router.get('/sent/:id', async (req, res) => {
  if (SENT_ID.test(req.params.id)) {
    const msg = ownSent(req);
    const parsed = await fetchParsed(msg.uid, 'sent');
    if (!parsed) throw new HttpError(404, 'This message was deleted from the mailbox');
    const bcc = (parsed.bcc?.value || []).map((a) => ({ name: a.name, address: a.address }));
    return res.json({ ...sentBoxSummary(msg), bcc, messageId: msg.messageId, ...bodyOf(parsed) });
  }
  const record = db().sent.find((s) => s.id === req.params.id && (isOwner(req.me) || s.from.address === req.me));
  if (!record) throw new HttpError(404, 'Message not found');
  res.json({
    ...sentLogSummary(record),
    messageId: record.messageId,
    html: null,
    text: record.text,
    attachments: record.attachments.map((a) => ({ ...a, unavailable: true })),
  });
});

router.get('/sent/:id/attachments/:index/link', async (req, res) => {
  const msg = ownSent(req);
  const att = (await fetchParsed(msg.uid, 'sent'))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  res.json({ url: await attachmentLink(att, msg.uid, 'sent') });
});

router.get('/sent/:id/attachments/:index', async (req, res) => {
  const msg = ownSent(req);
  const att = (await fetchParsed(msg.uid, 'sent'))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  await sendPart(res, att, msg.uid, 'sent');
});

router.post('/sent/delete', async (req, res) => {
  const me = req.me;
  const ids = (req.body?.ids ?? []).map(String);
  const uids = ids
    .map((id) => id.match(SENT_ID)?.[1])
    .filter((uid) => uid && db().sentBox.messages[uid] && (isOwner(me) || db().sentBox.messages[uid].from.address === me))
    .map(Number);
  await deleteFromServer(uids, { folder: 'sent' });

  const remove = new Set(ids);
  db().sent = db().sent.filter((s) => !((isOwner(me) || s.from.address === me) && remove.has(s.id)));
  save();
  res.json({ ok: true });
});

/* ---------------------------------- spam ---------------------------------- */

router.get('/spam/:id', async (req, res) => {
  const msg = ownSpam(req);
  const parsed = await fetchParsed(msg.uid, 'spam');
  if (!parsed) throw new HttpError(404, 'This message was deleted from the mailbox');
  // Attachments in spam are not offered for download.
  const body = bodyOf(parsed);
  res.json({ ...spamSummary(msg), ...body, attachments: body.attachments.map((a) => ({ ...a, unavailable: true })) });
});

router.post('/spam/action', async (req, res) => {
  const me = req.me;
  const uids = (req.body?.ids ?? [])
    .map((id) => String(id).match(SPAM_ID)?.[1])
    .filter((uid) => uid && db().spamBox.messages[uid] && isVisibleTo(db().spamBox.messages[uid], me))
    .map(Number);

  if (req.body?.action === 'notSpam') await moveMessages(uids, 'spam', 'inbox');
  else if (req.body?.action === 'delete') await deleteFromServer(uids, { folder: 'spam', permanent: true });
  else throw new HttpError(400, 'Unknown action');
  res.json({ ok: true, count: uids.length });
});

/* ---------------------------------- labels ---------------------------------- */

router.get('/labels', (req, res) => res.json(myLabels(req.me)));

router.post('/labels', (req, res) => {
  const me = req.me;
  const name = String(req.body?.name ?? '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Give the label a name');
  if (myLabels(me).some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'You already have that label');
  const label = { id: crypto.randomUUID(), alias: me, name, color: req.body?.color || PALETTE[myLabels(me).length % PALETTE.length] };
  db().labels.push(label);
  save();
  res.status(201).json(label);
});

router.patch('/labels/:id', (req, res) => {
  const label = myLabels(req.me).find((l) => l.id === req.params.id);
  if (!label) throw new HttpError(404, 'Label not found');
  if (typeof req.body?.name === 'string' && req.body.name.trim()) label.name = req.body.name.trim().slice(0, 40);
  if (typeof req.body?.color === 'string') label.color = req.body.color;
  save();
  res.json(label);
});

router.delete('/labels/:id', (req, res) => {
  const me = req.me;
  const id = req.params.id;
  db().labels = db().labels.filter((l) => !(l.alias === me && l.id === id));
  for (const m of Object.values(db().messages)) {
    const s = m.state[me];
    if (s?.labels?.includes(id)) s.labels = s.labels.filter((l) => l !== id);
  }
  save();
  res.status(204).end();
});

/* ---------------------------------- drafts ---------------------------------- */

router.get('/drafts/:id', (req, res) => {
  const draft = db().drafts.find((d) => d.id === req.params.id && d.alias === req.me);
  if (!draft) throw new HttpError(404, 'Draft not found');
  res.json(draft);
});

router.put('/drafts/:id', (req, res) => {
  const me = req.me;
  const id = String(req.params.id);
  if (!/^[\w-]{8,64}$/.test(id)) throw new HttpError(400, 'Invalid draft id');

  let draft = db().drafts.find((d) => d.id === id);
  if (draft && draft.alias !== me) throw new HttpError(404, 'Draft not found');
  if (!draft) {
    draft = { id, alias: me };
    db().drafts.push(draft);
  }
  for (const key of DRAFT_FIELDS) draft[key] = String(req.body?.[key] ?? '').slice(0, 500_000);
  draft.references = Array.isArray(req.body?.references) ? req.body.references.map(String) : [];
  draft.updatedAt = new Date().toISOString();
  save();
  res.json(draftSummary(draft));
});

router.post('/drafts/delete', (req, res) => {
  const me = req.me;
  const remove = new Set((req.body?.ids ?? []).map(String));
  db().drafts = db().drafts.filter((d) => !(d.alias === me && remove.has(d.id)));
  save();
  res.json({ ok: true });
});

/* ---------------------------------- scheduled ---------------------------------- */

router.get('/scheduled/:id', (req, res) => {
  const item = db().scheduled.find((s) => s.id === req.params.id && s.alias === req.me);
  if (!item) throw new HttpError(404, 'Message not found');
  res.json({
    ...scheduledSummary(item),
    bcc: asAddresses(item.mail.bcc),
    html: item.mail.html || null,
    text: item.mail.text,
    attachments: item.mail.attachments.map((a, index) => ({ index, filename: a.filename, size: a.size || Buffer.byteLength(a.content || '', 'base64'), unavailable: true })),
  });
});

/** Cancel scheduled sends; like Gmail, each one goes back to Drafts. */
router.post('/scheduled/cancel', (req, res) => {
  const me = req.me;
  const ids = new Set((req.body?.ids ?? []).map(String));
  for (const item of db().scheduled.filter((s) => s.alias === me && ids.has(s.id))) {
    const { mail } = item;
    db().drafts.push({
      id: item.id,
      alias: me,
      to: mail.to.join(', '),
      cc: mail.cc.join(', '),
      bcc: mail.bcc.join(', '),
      subject: mail.subject,
      text: mail.text,
      html: mail.html || '',
      inReplyTo: mail.inReplyTo || '',
      references: mail.references || [],
      updatedAt: new Date().toISOString(),
    });
  }
  db().scheduled = db().scheduled.filter((s) => !(s.alias === me && ids.has(s.id)));
  save();
  res.json({ ok: true });
});

/** Outbox: try failed messages again now. */
router.post('/outbox/retry', (req, res) => {
  const ids = new Set((req.body?.ids ?? []).map(String));
  const items = db().scheduled.filter((s) => s.alias === req.me && s.outbox && ids.has(s.id));
  for (const item of items) Object.assign(item, { failed: false, uncertain: false, attempts: 0, sendAt: new Date().toISOString() });
  save();
  void runScheduled();
  res.json({ ok: true, retrying: items.length });
});

/** Outbox: delete messages that won't be sent. */
router.post('/outbox/delete', (req, res) => {
  const ids = new Set((req.body?.ids ?? []).map(String));
  db().scheduled = db().scheduled.filter((s) => !(s.alias === req.me && s.outbox && ids.has(s.id)));
  save();
  res.json({ ok: true });
});

/* ---------------------------------- send ---------------------------------- */

router.post('/attachments/start', async (req, res) => {
  const size = Number(req.body?.size);
  const filename = String(req.body?.filename || '').trim();
  const contentType = String(req.body?.contentType || 'application/octet-stream');
  const sha256 = String(req.body?.sha256 || '').toLowerCase();
  const publicKey = String(req.body?.publicKey || '');
  if (!filename || filename.length > 255 || !Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024) throw new HttpError(400, 'Invalid attachment');
  if (!/^[a-f0-9]{64}$/.test(sha256) || publicKey.length > 1000) throw new HttpError(400, 'Invalid attachment signature');
  res.json(await startAttachmentUpload({ owner: req.me, filename, contentType, size, sha256, publicKey }));
});

/**
 * An attachment of a message being forwarded ({ kind: 'inbox' | 'sent', id, index }), checked
 * against what this account may open, the same way as downloading it.
 */
async function forwardedAttachment(me, from) {
  let uid;
  let folder;
  if (from?.kind === 'inbox') {
    const msg = db().messages[from.id];
    if (!msg || !isVisibleTo(msg, me)) throw new HttpError(404, 'A forwarded attachment is no longer available');
    [uid, folder] = [msg.uid, 'inbox'];
  } else if (from?.kind === 'sent' && SENT_ID.test(String(from.id))) {
    const msg = db().sentBox.messages[String(from.id).match(SENT_ID)[1]];
    if (!msg || !(isOwner(me) || msg.from.address === me)) throw new HttpError(404, 'A forwarded attachment is no longer available');
    [uid, folder] = [msg.uid, 'sent'];
  } else {
    throw new HttpError(400, 'This attachment can’t be forwarded');
  }
  const att = (await fetchParsed(uid, folder))?.attachments[Number(from.index)];
  if (!att) throw new HttpError(404, 'A forwarded attachment is no longer in the mailbox');
  return forwardableAttachment(att, uid, folder, me);
}

router.post('/send', async (req, res) => {
  const me = req.me;
  const body = req.body ?? {};
  // Hop timing (admin overview → delivery timings): the browser's part comes with the request.
  const received = Date.now();
  const timing = {};
  const client = body.clientTiming && typeof body.clientTiming === 'object' ? body.clientTiming : {};
  const sendEntry = () => ({
    at: new Date(received).toISOString(), from: me, recipients: parseList(body.to).length + parseList(body.cc).length + parseList(body.bcc).length,
    attachments: Array.isArray(body.attachments) ? body.attachments.length : 0,
    browser: { undoMs: Number(client.undoMs) || 0, uploadWaitMs: Number(client.uploadWaitMs) || 0 },
    appMs: Date.now() - received, timing,
  });
  const to = parseList(body.to);
  const cc = parseList(body.cc);
  const bcc = parseList(body.bcc);

  if (!to.length && !cc.length && !bcc.length) throw new HttpError(400, 'Add at least one recipient');
  const invalid = [...to, ...cc, ...bcc].find((a) => !EMAIL_RE.test(a));
  if (invalid) throw new HttpError(400, `"${invalid}" is not a valid email address`);
  const attachmentInput = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachmentInput.reduce((total, a) => total + (Number(a.size) || Buffer.byteLength(String(a.content || ''), 'base64')), 0) > 20 * 1024 * 1024) {
    throw new HttpError(413, 'Attachments are larger than 20 MB in total');
  }
  if (attachmentInput.some((a) => a.uploadId && !/^[a-f0-9]{48}$/.test(String(a.uploadId)))) throw new HttpError(400, 'Invalid attachment ID');

  const mail = {
    to,
    cc,
    bcc,
    subject: String(body.subject ?? ''),
    text: String(body.text ?? ''),
    // Formatted version from the editor; the text above goes along for plain-text mail apps.
    html: typeof body.html === 'string' && body.html.trim() ? body.html.slice(0, 2_000_000) : undefined,
    inReplyTo: body.inReplyTo || undefined,
    references: Array.isArray(body.references) ? body.references.map(String) : undefined,
    attachments: await Promise.all(attachmentInput.map((a) => (a.forward
      ? forwardedAttachment(me, a.forward)
      : {
          filename: String(a.filename || 'file'),
          contentType: a.contentType || 'application/octet-stream',
          ...(a.uploadId ? { uploadId: String(a.uploadId), size: Number(a.size) || 0 } : { content: String(a.content || '') }),
        }))),
  };
  const removeDraft = () => {
    if (body.draftId) db().drafts = db().drafts.filter((d) => !(d.id === body.draftId && d.alias === me));
  };
  // Drive files picked in Compose are shared from the sender's own Drive (not the mailbox's)
  // once the message has actually gone out.
  const drive = readDriveRequest(body.drive);
  const driveFrom = drive && { ...drive, by: { role: req.user.role, email: req.user.email } };

  if (body.sendAt) {
    const sendAt = Date.parse(body.sendAt);
    if (!sendAt || sendAt <= Date.now()) throw new HttpError(400, 'Pick a time in the future');
    const item = { id: crypto.randomUUID(), alias: me, sendAt: new Date(sendAt).toISOString(), createdAt: new Date().toISOString(), mail, ...(driveFrom && { drive: driveFrom }) };
    db().scheduled.push(item);
    removeDraft();
    save();
    return res.status(201).json(scheduledSummary(item));
  }

  try {
    await deliver(me, mail, timing);
  } catch (err) {
    // A connection that failed on every address (localhost is both ::1 and 127.0.0.1) has no
    // message of its own, only the per-address errors.
    const reason = err.response || err.message || (err.errors || []).map((e) => e.message).filter(Boolean).join('; ') || err.code || err.name;
    // Only the browser saw the reason before; keep it in the host's log too (no message content).
    console.warn(`[send] from ${me} to ${to.length + cc.length + bcc.length} recipient(s) failed via ${config.mailBridge.configured ? 'PHP bridge' : `direct SMTP ${config.smtp.host}:${config.smtp.port}`}: ${reason}`);
    // Nothing is lost: the message waits in the Outbox, retried automatically unless the mail
    // server refused it or it may have gone out already. The mail server's reason (e.g. "sender
    // address rejected") is shown with it.
    const failure = err instanceof HttpError ? err : Object.assign(new Error(`The mail server didn't accept the message: ${reason}`), { status: err.status });
    const item = queueInOutbox(me, mail, driveFrom, failure);
    removeDraft();
    save();
    return res.status(202).json({ queued: true, retrying: !item.failed, uncertain: Boolean(item.uncertain), error: item.error, outbox: scheduledSummary(item) });
  }
  removeDraft();
  save();
  const shared = driveFrom ? await shareWithRecipients(driveFrom.by.role, driveFrom.by.email, driveFrom, [...to, ...cc, ...bcc]) : null;
  noteSend(sendEntry());
  res.status(201).json({ ok: true, timing: { ...timing, appMs: Date.now() - received }, ...(shared && { drive: shared }) });
});

/* ---------------------------------- Google Drive ---------------------------------- */

/** A short-lived token for Google's file picker, for the signed-in person's own Drive. */
router.post('/drive/token', async (req, res) => {
  if (!driveEnabled()) throw new HttpError(404, 'Google Drive is not set up');
  const { accessToken, expiresAt } = await driveTokenFor(req.user.role, req.user.email);
  res.json({ accessToken, expiresAt, apiKey: config.google.apiKey, appId: config.google.appId });
});

/* ---------------------------------- settings ---------------------------------- */

const settingsOf = (account) => ({
  address: account.address,
  displayName: account.displayName || '',
  signature: account.signature || '',
  avatarUrl: avatarUrl(account.avatar),
  owner: Boolean(account.owner),
});

router.get('/settings', (req, res) => res.json(settingsOf(accountOf(req.me))));

/** Upload a profile picture: { image: "data:image/jpeg;base64,..." } */
router.post('/settings/avatar', async (req, res) => {
  ownMailboxOnly(req);
  const account = accountOf(req.me);
  setAvatar(account, await saveAvatar(req.body?.image));
  res.json(settingsOf(accountOf(req.me)));
});

router.delete('/settings/avatar', (req, res) => {
  ownMailboxOnly(req);
  setAvatar(accountOf(req.me), null);
  res.json(settingsOf(accountOf(req.me)));
});

/** Profile pictures of everyone on this mail system, by address (shown beside their messages). */
/**
 * Address suggestions for Compose: the team's mailboxes, then everyone this account has written
 * to or heard from, most frequent first (writing to someone counts more than hearing from them).
 */
router.get('/contacts', (req, res) => {
  const me = req.me;
  const people = new Map(); // address -> { address, name, score, team }
  const add = (person, weight) => {
    const address = normalize(person?.address);
    if (!EMAIL_RE.test(address) || address === me) return;
    const entry = people.get(address) || { address, name: '', score: 0, team: false };
    if (!entry.name && person.name) entry.name = String(person.name).slice(0, 120);
    entry.score += weight;
    people.set(address, entry);
  };
  for (const a of db().aliases) {
    if (a.disabled) continue;
    add({ address: a.address, name: a.displayName }, 1);
    const entry = people.get(a.address);
    if (entry) entry.team = true;
  }
  if (config.mailbox) add({ address: config.mailbox, name: db().owner?.displayName }, 1);
  for (const m of messagesFor(me)) add(m.from, 1);
  for (const m of Object.values(db().sentBox.messages)) {
    if (isOwner(me) || m.from.address === me) for (const p of [...(m.to || []), ...(m.cc || [])]) add(p, 3);
  }
  for (const s of db().sent) {
    if (isOwner(me) || s.from.address === me) for (const p of [...s.to, ...s.cc, ...(s.bcc || [])]) add(p, 3);
  }
  const list = [...people.values()].sort((a, b) => b.score - a.score || a.address.localeCompare(b.address)).slice(0, 500);
  res.json(list.map(({ address, name, team }) => ({ address, name, team })));
});

router.get('/people', (req, res) => {
  const people = {};
  for (const a of db().aliases) if (a.avatar) people[a.address] = avatarUrl(a.avatar);
  if (db().owner.avatar && config.mailbox) people[config.mailbox] = avatarUrl(db().owner.avatar);
  res.json(people);
});

router.patch('/settings', async (req, res) => {
  ownMailboxOnly(req);
  const account = accountOf(req.me);
  const { displayName, signature, currentPassword, newPassword } = req.body ?? {};

  if (newPassword) {
    if (account.owner) throw new HttpError(400, 'The admin password is set in server/.env (ADMIN_PASSWORD)');
    passwordChecks.check(req.me);
    if (!(await bcrypt.compare(String(currentPassword ?? '').slice(0, 256), findAlias(req.me).passwordHash))) {
      passwordChecks.fail(req.me);
      audit(req, 'password-check-failed', req.me);
      throw new HttpError(400, 'Current password is wrong');
    }
    passwordChecks.reset(req.me);
  }
  const updated = await updateAccount(account, { displayName, signature, password: newPassword || undefined });
  // A new password signs the account out on every other device.
  if (newPassword) {
    signOutAccount('user', req.me, { keep: req.session.id });
    audit(req, 'password-changed', req.me);
  }
  res.json(settingsOf(accountOf(updated.address)));
});

export default router;
