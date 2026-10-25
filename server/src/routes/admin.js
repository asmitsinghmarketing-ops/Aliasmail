// Admin console API: manage aliases and every message in the real mailbox.
import { Router } from 'express';
import config from '../config.js';
import { db, save } from '../store.js';
import { endSessions, signOutAccount } from '../sessions.js';
import { audit } from '../audit.js';
import { PALETTE, aliasesOf, createAlias, deleteAlias, findAliasById, updateAlias, withCounts } from '../aliases.js';
import { requireAuth } from '../auth.js';
import { cacheOf, deleteFromServer, fetchParsed, prefetch, syncInbox, testConnection } from '../mailbox.js';
import { bodyOf, byDateDesc, matchesQuery, paginate, sendAttachment, toUidList } from '../util.js';
import { HttpError, describeError } from '../errors.js';

const router = Router();
router.use(requireAuth('admin'));

// Inbox mail belongs to the aliases it was delivered to; sent mail to the alias it came from.
const ownersOf = (m, folder) => (folder === 'sent' ? db().aliases.filter((a) => a.address === m.from.address) : aliasesOf(m));
const folderParam = (value) => (value === 'sent' ? 'sent' : 'inbox');

const adminSummary = (m, folder = 'inbox') => ({
  id: m.uid,
  subject: m.subject,
  from: m.from,
  to: m.to,
  cc: m.cc,
  date: m.date,
  snippet: m.snippet || '',
  size: m.size,
  hasAttachments: m.hasAttachments,
  aliases: ownersOf(m, folder).map((a) => ({ address: a.address, color: a.color })),
});

function getAlias(req) {
  const alias = findAliasById(req.params.id);
  if (!alias) throw new HttpError(404, 'Alias not found');
  return alias;
}

router.get('/overview', (req, res) => {
  const msgs = Object.values(db().messages);
  res.json({
    mailbox: config.mailbox,
    configured: config.configured,
    sync: db().sync,
    palette: PALETTE,
    totals: {
      messages: msgs.length,
      aliases: db().aliases.length,
      unassigned: msgs.filter((m) => aliasesOf(m).length === 0).length,
      sent: Object.keys(db().sentBox.messages).length,
    },
    aliases: db().aliases.map(withCounts),
  });
});

router.post('/sync', async (req, res) => res.json(await syncInbox()));
/** Check mail access from PHP, where the provider permits the mailbox ports. */
router.get('/network-check', async (req, res) => {
  try {
    const result = await testConnection();
    res.json({ results: [
      { purpose: 'IMAP (PHP host)', target: `${config.imap.host}:${config.imap.port}`, ok: result.imap },
      { purpose: 'SMTP (PHP host)', target: `${config.smtp.host}:${config.smtp.port}`, ok: result.smtp },
    ], dns: [] });
  } catch (err) {
    res.json({ results: [{ purpose: 'PHP mail bridge', target: config.mailBridge.url || '(not configured)', ok: false, error: describeError(err) }], dns: [] });
  }
});

router.post('/test-connection', async (req, res) => {
  try {
    res.json(await testConnection());
  } catch (err) {
    throw new HttpError(502, `Connection failed: ${err instanceof HttpError ? err.message : describeError(err)}`);
  }
});

// Addresses on the mailbox's domain that are receiving mail but aren't registered yet -
// i.e. aliases already set up at GoDaddy that still need a login here.
router.get('/aliases/detected', (req, res) => {
  const domain = config.mailbox.split('@')[1];
  const registered = new Set(db().aliases.map((a) => a.address));
  const counts = {};
  for (const msg of Object.values(db().messages)) {
    for (const address of msg.recipients) {
      if (address.endsWith(`@${domain}`) && address !== config.mailbox && !registered.has(address)) {
        counts[address] = (counts[address] || 0) + 1;
      }
    }
  }
  res.json(Object.entries(counts).map(([address, messages]) => ({ address, messages })).sort((a, b) => b.messages - a.messages));
});

router.post('/aliases', async (req, res) => res.status(201).json(withCounts(await createAlias(req.body ?? {}))));

router.patch('/aliases/:id', async (req, res) => {
  const alias = await updateAlias(getAlias(req), req.body ?? {});
  // A new password or disabling the alias signs that person out everywhere.
  if (req.body?.password || req.body?.active === false) signOutAccount('user', alias.address);
  if (req.body?.password) audit(req, 'admin-set-password', alias.address, `by ${req.user.email}`);
  if (typeof req.body?.active === 'boolean') audit(req, req.body.active ? 'admin-enabled-alias' : 'admin-disabled-alias', alias.address, `by ${req.user.email}`);
  res.json(withCounts(alias));
});

router.delete('/aliases/:id', (req, res) => {
  const alias = getAlias(req);
  signOutAccount('user', alias.address);
  deleteAlias(alias);
  audit(req, 'admin-deleted-alias', alias.address, `by ${req.user.email}`);
  res.status(204).end();
});

/** For someone who lost their phone: turn their 2-step verification off and sign them out. */
router.post('/aliases/:id/reset-mfa', (req, res) => {
  const alias = getAlias(req);
  delete alias.mfa;
  delete alias.mfaPending;
  save();
  signOutAccount('user', alias.address);
  audit(req, 'admin-reset-2-step', alias.address, `by ${req.user.email}`);
  res.json(withCounts(alias));
});

/* ----- security settings ----- */

router.get('/security', (req, res) => {
  res.json({
    requireMfa: Boolean(db().security.requireMfa),
    adminMfaEnabled: Boolean(db().owner.mfa?.enabled),
    activeSessions: db().sessions.length,
  });
});

router.patch('/security', (req, res) => {
  if (typeof req.body?.requireMfa === 'boolean') {
    db().security.requireMfa = req.body.requireMfa;
    audit(req, req.body.requireMfa ? 'admin-required-2-step' : 'admin-made-2-step-optional', req.user.email);
  }
  save();
  res.json({ requireMfa: db().security.requireMfa });
});

/** Sign every alias user out (the admin's own session stays). */
router.post('/security/sign-out-all', (req, res) => {
  const ended = endSessions((s) => s.id !== req.session.id);
  audit(req, 'admin-signed-everyone-out', req.user.email, `${ended} sessions`);
  res.json({ ended });
});

/** Recent security activity, newest first. ?failures=1 for failures and lockouts only. */
router.get('/security/activity', (req, res) => {
  const failures = /failed|locked/;
  let entries = db().audit.slice().reverse();
  if (req.query.failures) entries = entries.filter((e) => failures.test(e.event));
  res.json(entries.slice(0, Math.min(Number(req.query.limit) || 100, 500)));
});

router.get('/messages', (req, res) => {
  const { alias, q, page } = req.query;
  const folder = folderParam(req.query.folder);
  let msgs = Object.values(cacheOf(folder).messages);
  if (alias === 'unassigned') msgs = msgs.filter((m) => ownersOf(m, folder).length === 0);
  else if (alias) msgs = msgs.filter((m) => (folder === 'sent' ? m.from.address === alias : m.recipients.includes(alias)));
  const result = paginate(msgs.map((m) => adminSummary(m, folder)).filter((m) => matchesQuery(m, q)).sort(byDateDesc), page);
  res.json(result);
  prefetch(result.items.slice(0, 20).map((m) => m.id), folder);
});

// /messages/:uid reads the INBOX, /sent/:uid the Sent folder.
for (const [route, folder] of [['messages', 'inbox'], ['sent', 'sent']]) {
  router.get(`/${route}/:uid`, async (req, res) => {
    const msg = cacheOf(folder).messages[req.params.uid];
    if (!msg) throw new HttpError(404, 'Message not found');
    const parsed = await fetchParsed(msg.uid, folder);
    if (!parsed) throw new HttpError(404, 'This message was deleted from the mailbox');
    res.json({ ...adminSummary(msg, folder), kind: folder === 'sent' ? 'sent' : 'inbox', replyTo: msg.replyTo, ...bodyOf(parsed) });
  });

  router.get(`/${route}/:uid/attachments/:index`, async (req, res) => {
    const att = (await fetchParsed(req.params.uid, folder))?.attachments[Number(req.params.index)];
    if (!att) throw new HttpError(404, 'Attachment not found');
    sendAttachment(res, att);
  });
}

router.post('/messages/delete', async (req, res) => {
  const folder = folderParam(req.body?.folder);
  const uids = toUidList(req.body?.ids).filter((uid) => cacheOf(folder).messages[uid]);
  await deleteFromServer(uids, { permanent: Boolean(req.body?.permanent), folder });
  res.json({ deleted: uids.length });
});

export default router;
