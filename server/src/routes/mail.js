// Mailbox API. An alias sees only mail addressed to it (To, Cc, Bcc or delivery headers);
// the admin, as the main mailbox address, sees the whole mailbox. Read / starred / important /
// archived / snoozed / trashed / labels are kept per account.
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { db, save } from '../store.js';
import { EMAIL_RE, PALETTE, accountOf, aliasesOf, findAlias, isOwner, isVisibleTo, messagesFor, normalize, setAvatar, updateAccount } from '../aliases.js';
import { avatarUrl, saveAvatar } from '../avatars.js';
import { signOutAccount } from '../sessions.js';
import { limiter } from '../security.js';
import { audit } from '../audit.js';

// Guessing the current password from a signed-in browser: 5 tries per 15 minutes.
const passwordChecks = limiter('password-change', { max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });
import { requireAuth } from '../auth.js';
import { deleteFromServer, fetchParsed, moveMessages, prefetch, syncInbox } from '../mailbox.js';
import { deliver } from '../outbox.js';
import { bodyOf, byDateDesc, matchesQuery, paginate, sendAttachment, toUidList } from '../util.js';
import { HttpError } from '../errors.js';
import { mailEvents } from '../mail-events.js';

const router = Router();

router.use(requireAuth(), (req, res, next) => {
  req.me = req.user.role === 'admin' ? config.mailbox : req.user.email;
  if (!req.me) throw new HttpError(503, 'Mailbox is not configured');
  next();
});

// Push invalidation only; lists and bodies still authorize the current session.
router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const changed = () => { if (!res.writableEnded) res.write('event: mail\ndata: {}\n\n'); };
  mailEvents.on('changed', changed);
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
  });

const DRAFT_FIELDS = ['to', 'cc', 'bcc', 'subject', 'text', 'inReplyTo'];

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
    scheduled: db().scheduled.filter((s) => s.alias === me).length,
    drafts: db().drafts.filter((d) => d.alias === me).length,
    all: unread('all'),
    spam: messagesFor(me, db().spamBox.messages).length,
    trash: count(FOLDERS.trash),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, count((s, m) => FOLDERS.inbox(s) && !s.read && (m.category || 'primary') === c)])),
    labels: Object.fromEntries(myLabels(me).map((l) => [l.id, count((s) => live(s) && !s.read && (s.labels || []).includes(l.id))])),
  });
});

router.post('/refresh', async (req, res) => {
  await syncInbox();
  res.json({ ok: true });
});

router.get('/messages', (req, res) => {
  const me = req.me;
  const { folder = 'inbox', category, q, page } = req.query;
  wakeSnoozed(me);

  let items;
  if (folder === 'sent') items = sentItems(me);
  else if (folder === 'drafts') items = db().drafts.filter((d) => d.alias === me).map(draftSummary);
  else if (folder === 'scheduled') items = db().scheduled.filter((s) => s.alias === me).map(scheduledSummary);
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
  }
  res.json({ ...summary(msg, me), replyTo: msg.replyTo, messageId: msg.messageId, ...bodyOf(parsed) });
});

router.get('/messages/:uid/attachments/:index', async (req, res) => {
  const msg = ownMessage(req);
  const att = (await fetchParsed(msg.uid))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  sendAttachment(res, att);
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

router.get('/sent/:id/attachments/:index', async (req, res) => {
  const msg = ownSent(req);
  const att = (await fetchParsed(msg.uid, 'sent'))?.attachments[Number(req.params.index)];
  if (!att) throw new HttpError(404, 'Attachment not found');
  sendAttachment(res, att);
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
    html: null,
    text: item.mail.text,
    attachments: item.mail.attachments.map((a, index) => ({ index, filename: a.filename, size: Buffer.byteLength(a.content, 'base64'), unavailable: true })),
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
      inReplyTo: mail.inReplyTo || '',
      references: mail.references || [],
      updatedAt: new Date().toISOString(),
    });
  }
  db().scheduled = db().scheduled.filter((s) => !(s.alias === me && ids.has(s.id)));
  save();
  res.json({ ok: true });
});

/* ---------------------------------- send ---------------------------------- */

router.post('/send', async (req, res) => {
  const me = req.me;
  const body = req.body ?? {};
  const to = parseList(body.to);
  const cc = parseList(body.cc);
  const bcc = parseList(body.bcc);

  if (!to.length && !cc.length && !bcc.length) throw new HttpError(400, 'Add at least one recipient');
  const invalid = [...to, ...cc, ...bcc].find((a) => !EMAIL_RE.test(a));
  if (invalid) throw new HttpError(400, `"${invalid}" is not a valid email address`);

  const mail = {
    to,
    cc,
    bcc,
    subject: String(body.subject ?? ''),
    text: String(body.text ?? ''),
    inReplyTo: body.inReplyTo || undefined,
    references: Array.isArray(body.references) ? body.references.map(String) : undefined,
    attachments: (body.attachments || []).map((a) => ({
      filename: String(a.filename || 'file'),
      contentType: a.contentType || 'application/octet-stream',
      content: String(a.content || ''),
    })),
  };
  const removeDraft = () => {
    if (body.draftId) db().drafts = db().drafts.filter((d) => !(d.id === body.draftId && d.alias === me));
  };

  if (body.sendAt) {
    const sendAt = Date.parse(body.sendAt);
    if (!sendAt || sendAt <= Date.now()) throw new HttpError(400, 'Pick a time in the future');
    const item = { id: crypto.randomUUID(), alias: me, sendAt: new Date(sendAt).toISOString(), createdAt: new Date().toISOString(), mail };
    db().scheduled.push(item);
    removeDraft();
    save();
    return res.status(201).json(scheduledSummary(item));
  }

  try {
    await deliver(me, mail);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Pass on the mail server's reason (e.g. "sender address rejected").
    throw new HttpError(502, `The mail server didn't accept the message: ${err.response || err.message}`);
  }
  removeDraft();
  save();
  res.status(201).json({ ok: true });
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
  const account = accountOf(req.me);
  setAvatar(account, await saveAvatar(req.body?.image));
  res.json(settingsOf(accountOf(req.me)));
});

router.delete('/settings/avatar', (req, res) => {
  setAvatar(accountOf(req.me), null);
  res.json(settingsOf(accountOf(req.me)));
});

/** Profile pictures of everyone on this mail system, by address (shown beside their messages). */
router.get('/people', (req, res) => {
  const people = {};
  for (const a of db().aliases) if (a.avatar) people[a.address] = avatarUrl(a.avatar);
  if (db().owner.avatar && config.mailbox) people[config.mailbox] = avatarUrl(db().owner.avatar);
  res.json(people);
});

router.patch('/settings', async (req, res) => {
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
