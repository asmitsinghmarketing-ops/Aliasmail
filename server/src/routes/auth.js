// Sign-in, 2-step verification (authenticator app + backup codes), sessions and devices.
//
// Sign-in: POST /login checks the password. If the account uses 2-step verification and this
// browser isn't a trusted device, it answers { mfa: 'verify', ticket } and the code goes to
// POST /mfa/verify. If an admin requires 2-step verification and the account has none yet, it
// answers { mfa: 'setup', ticket } and the account enrols via /mfa/setup/*. Only then is a
// session cookie set.
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { audit } from '../audit.js';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { db, save } from '../store.js';
import { findAlias, normalize, sharedMailboxesFor, typeOf } from '../aliases.js';
import { requireAuth, safeEqual } from '../auth.js';
import { avatarUrl } from '../avatars.js';
import { HttpError } from '../errors.js';
import { clientIp, hashBackupCode, limiter, newBackupCodes, newTotpSecret, otpauthUrl, seal, unseal, verifyTotp } from '../security.js';
import {
  SESSION_COOKIE,
  currentSession,
  endSessions,
  forgetTrustedDevices,
  isTrustedDevice,
  sessionsOf,
  signOutAccount,
  startSession,
  trustDevice,
  trustedDevicesOf,
} from '../sessions.js';

const router = Router();

// Wrong passwords: 5 per address from one IP, 20 per address from anywhere, and 30 from one IP
// across all addresses (password spraying) each lock sign-in for a while.
const loginByIpAndAccount = limiter('login-ip-account', { max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });
const loginByAccount = limiter('login-account', { max: 20, windowMs: 60 * 60e3, lockMs: 30 * 60e3 });
const loginByIp = limiter('login-ip', { max: 30, windowMs: 15 * 60e3, lockMs: 30 * 60e3 });
// 5 wrong codes lock 2-step verification for that account for 15 minutes.
const codeLimiter = limiter('mfa', { max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });

const ISSUER = () => `AliasMail (${config.mailbox.split('@')[1] || 'mail'})`;
// Compared against when the address is unknown (and for the admin), so every wrong sign-in takes
// the same time and response times don't reveal which addresses exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const JWT_OPTIONS = { algorithms: ['HS256'] };

/** Run a limiter check; log the lockout before refusing. */
function checkLimit(req, check, account) {
  try {
    check();
  } catch (err) {
    audit(req, 'locked-out', account, err.message);
    throw err;
  }
}

/* ---------------------------------- helpers ---------------------------------- */

/** Where an account's 2-step settings live: the alias record, or `owner` for the admin. */
const holderOf = (role, email) => (role === 'admin' ? db().owner : findAlias(email));
const mfaEnabled = (holder) => Boolean(holder?.mfa?.enabled);

/** Group mailboxes this account can switch to, for the mailbox switcher. */
const switchable = (role, email) =>
  sharedMailboxesFor(role, email).map(({ alias, roles }) => ({
    address: alias.address,
    displayName: alias.displayName,
    color: alias.color,
    avatarUrl: avatarUrl(alias.avatar),
    roles,
  }));

function profile({ role, email }) {
  if (role === 'admin') {
    const { displayName = '', avatar } = db().owner;
    return { role: 'admin', email, mailbox: config.mailbox, displayName, avatarUrl: avatarUrl(avatar), mailboxes: switchable(role, email) };
  }
  const alias = findAlias(email);
  return {
    role: 'user', email: alias.address, displayName: alias.displayName, color: alias.color, avatarUrl: avatarUrl(alias.avatar),
    mailboxes: switchable(role, email),
  };
}

/** Password check. Returns { role, email } or throws. */
async function checkPassword(email, password) {
  if (config.admin.password && email === config.admin.email) {
    await bcrypt.compare(password, DUMMY_HASH); // same delay as an alias sign-in
    if (safeEqual(password, config.admin.password)) return { role: 'admin', email };
    return null;
  }
  const alias = findAlias(email);
  const ok = await bcrypt.compare(password, alias?.passwordHash || DUMMY_HASH);
  // Group mailboxes have no sign-in of their own; people reach them through roles.
  if (!alias || !ok || typeOf(alias) === 'group') return null;
  if (!alias.active) throw new HttpError(403, 'This alias has been disabled by the administrator');
  return { role: 'user', email: alias.address };
}

// A short-lived, single-use pass between the password step and the code step.
const usedTickets = new Map(); // ticket id -> expiry (ms)

const issueTicket = (account, stage) =>
  jwt.sign({ purpose: 'mfa', stage, role: account.role, email: account.email, jti: crypto.randomUUID() }, config.jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });

function readTicket(ticket, stage) {
  try {
    const t = jwt.verify(String(ticket ?? ''), config.jwtSecret, JWT_OPTIONS);
    if (t.purpose === 'mfa' && t.stage === stage && !usedTickets.has(t.jti)) return { role: t.role, email: t.email, jti: t.jti, exp: t.exp };
  } catch {
    /* fall through */
  }
  throw new HttpError(401, 'Your sign-in expired. Start again.');
}

function consumeTicket(t) {
  const now = Date.now();
  for (const [id, expires] of usedTickets) if (expires < now) usedTickets.delete(id);
  usedTickets.set(t.jti, t.exp * 1000);
}

const accountOfTicket = ({ role, email }) => ({ role, email });

/** Check an authenticator or backup code and consume it. Returns how it was verified, or null. */
function useSecondFactor(holder, code) {
  const mfa = holder.mfa;
  const clean = String(code ?? '').trim();
  const step = verifyTotp(unseal(mfa.secret), clean, mfa.lastStep ?? -1);
  if (step !== null) {
    mfa.lastStep = step;
    save();
    return 'authenticator';
  }
  const hash = hashBackupCode(clean);
  const index = (mfa.backupCodes || []).indexOf(hash);
  if (clean.length >= 10 && index >= 0) {
    mfa.backupCodes.splice(index, 1);
    save();
    return 'backup-code';
  }
  return null;
}

function verifyCodeOrThrow(req, account, holder, code) {
  const key = `${account.role}:${account.email}`;
  checkLimit(req, () => codeLimiter.check(key), account.email);
  const method = useSecondFactor(holder, code);
  if (!method) {
    codeLimiter.fail(key);
    audit(req, 'code-failed', account.email);
    throw new HttpError(400, 'Wrong code. Check your authenticator app and try again.');
  }
  codeLimiter.reset(key);
  if (method === 'backup-code') audit(req, 'backup-code-used', account.email, `${holder.mfa.backupCodes.length} left`);
  return method;
}

function finishSignIn(req, res, account, method) {
  startSession(req, res, { ...account, method });
  audit(req, 'signed-in', account.email, method);
  res.json({ user: profile(account) });
}

/* ---------------------------------- sign in ---------------------------------- */

// Public: lets the sign-in page show "Use your @domain account". Reveals only the domain.
router.get('/info', (req, res) => res.json({ domain: config.mailbox.split('@')[1] || '' }));

router.post('/login', async (req, res) => {
  const email = normalize(req.body?.email).slice(0, 254);
  const password = String(req.body?.password ?? '').slice(0, 256);
  const ip = clientIp(req);
  const ipKey = `${ip}|${email}`;
  checkLimit(req, () => {
    loginByIp.check(ip);
    loginByIpAndAccount.check(ipKey);
    loginByAccount.check(email);
  }, email);

  let account;
  try {
    account = await checkPassword(email, password);
  } catch (err) {
    audit(req, 'sign-in-failed', email, err.message);
    throw err;
  }
  if (!account) {
    loginByIp.fail(ip);
    loginByIpAndAccount.fail(ipKey);
    loginByAccount.fail(email);
    audit(req, 'sign-in-failed', email, 'wrong email or password');
    throw new HttpError(401, 'Wrong email or password');
  }
  loginByIpAndAccount.reset(ipKey);

  const holder = holderOf(account.role, account.email);
  if (mfaEnabled(holder)) {
    if (isTrustedDevice(req, account.role, account.email)) return finishSignIn(req, res, account, 'trusted-device');
    return res.json({ mfa: 'verify', ticket: issueTicket(account, 'verify') });
  }
  if (db().security.requireMfa) return res.json({ mfa: 'setup', ticket: issueTicket(account, 'setup') });
  finishSignIn(req, res, account, 'password');
});

router.post('/mfa/verify', (req, res) => {
  const ticket = readTicket(req.body?.ticket, 'verify');
  const account = accountOfTicket(ticket);
  const holder = holderOf(account.role, account.email);
  if (!mfaEnabled(holder)) throw new HttpError(400, 'Start again');
  const method = verifyCodeOrThrow(req, account, holder, req.body?.code);
  consumeTicket(ticket);
  if (req.body?.remember) {
    trustDevice(req, res, account.role, account.email);
    audit(req, 'device-trusted', account.email);
  }
  finishSignIn(req, res, account, method);
});

/* ----- enrolling an authenticator: during a required sign-in (ticket) or from Settings (session) ----- */

function enrollingAccount(req) {
  if (req.body?.ticket) return readTicket(req.body.ticket, 'setup');
  return null;
}

function startEnrollment(account) {
  const holder = holderOf(account.role, account.email);
  if (mfaEnabled(holder)) throw new HttpError(400, '2-step verification is already on');
  const secret = newTotpSecret();
  holder.mfaPending = { secret: seal(secret), createdAt: new Date().toISOString() };
  save();
  return { secret, otpauthUrl: otpauthUrl(secret, account.email, ISSUER()) };
}

function confirmEnrollment(req, account, code) {
  const holder = holderOf(account.role, account.email);
  const pending = holder?.mfaPending;
  if (!pending || Date.now() - Date.parse(pending.createdAt) > 30 * 60e3) throw new HttpError(400, 'Setup expired. Start again.');
  const key = `${account.role}:${account.email}`;
  checkLimit(req, () => codeLimiter.check(key), account.email);
  const secret = unseal(pending.secret);
  const step = verifyTotp(secret, code);
  if (step === null) {
    codeLimiter.fail(key);
    throw new HttpError(400, 'That code didn’t match. Make sure you scanned the latest QR code and try the next code.');
  }
  codeLimiter.reset(key);
  const backupCodes = newBackupCodes();
  holder.mfa = { enabled: true, secret: seal(secret), lastStep: step, backupCodes: backupCodes.map(hashBackupCode), enabledAt: new Date().toISOString() };
  delete holder.mfaPending;
  save();
  audit(req, '2-step-turned-on', account.email);
  return backupCodes;
}

const sessionOrTicket = (req, res, next) => (req.body?.ticket ? next() : requireAuth()(req, res, next));

router.post('/mfa/setup/start', sessionOrTicket, (req, res) => {
  const ticket = enrollingAccount(req);
  res.json(startEnrollment(ticket ? accountOfTicket(ticket) : req.user));
});

router.post('/mfa/setup/confirm', sessionOrTicket, (req, res) => {
  const ticket = enrollingAccount(req);
  const account = ticket ? accountOfTicket(ticket) : req.user;
  const backupCodes = confirmEnrollment(req, account, req.body?.code);

  if (ticket) {
    // Required setup during sign-in: this device just proved the code, so trust it and sign in.
    consumeTicket(ticket);
    trustDevice(req, res, account.role, account.email);
    startSession(req, res, { ...account, method: 'authenticator' });
    audit(req, 'signed-in', account.email, 'authenticator (first setup)');
    return res.json({ backupCodes, user: profile(account) });
  }
  // From Settings: sign out everywhere else, since the account's security changed.
  signOutAccount(account.role, account.email, { keep: req.session.id });
  trustDevice(req, res, account.role, account.email);
  res.json({ backupCodes });
});

/* ---------------------------------- signed-in account security ---------------------------------- */

router.get('/me', requireAuth(), (req, res) => res.json(profile(req.user)));

router.get('/mfa', requireAuth(), (req, res) => {
  const { role, email } = req.user;
  const holder = holderOf(role, email);
  res.json({
    enabled: mfaEnabled(holder),
    enabledAt: holder?.mfa?.enabledAt || null,
    backupCodesLeft: holder?.mfa?.backupCodes?.length ?? 0,
    required: Boolean(db().security.requireMfa) && role === 'user',
    trustedDevices: trustedDevicesOf(role, email).map(({ id, agent, createdAt, expiresAt }) => ({ id, agent, createdAt, expiresAt })),
    thisDeviceTrusted: isTrustedDevice(req, role, email),
  });
});

/** Re-confirm identity for sensitive changes: the password, plus a code when 2-step is on. */
async function confirmIdentity(req) {
  const { role, email } = req.user;
  const key = `${role}:${email}`;
  checkLimit(req, () => codeLimiter.check(key), email);
  const account = await checkPassword(email, String(req.body?.password ?? '').slice(0, 256)).catch(() => null);
  if (!account) {
    codeLimiter.fail(key);
    audit(req, 'password-check-failed', email);
    throw new HttpError(400, 'Wrong password');
  }
  const holder = holderOf(role, email);
  if (mfaEnabled(holder)) verifyCodeOrThrow(req, req.user, holder, req.body?.code);
  return holder;
}

router.post('/mfa/disable', requireAuth(), async (req, res) => {
  const { role, email } = req.user;
  if (role === 'user' && db().security.requireMfa) throw new HttpError(403, 'Your administrator requires 2-step verification');
  const holder = await confirmIdentity(req);
  delete holder.mfa;
  delete holder.mfaPending;
  save();
  signOutAccount(role, email, { keep: req.session.id });
  audit(req, '2-step-turned-off', email);
  res.json({ ok: true });
});

router.post('/mfa/backup-codes', requireAuth(), async (req, res) => {
  const holder = await confirmIdentity(req);
  if (!mfaEnabled(holder)) throw new HttpError(400, '2-step verification is off');
  const backupCodes = newBackupCodes();
  holder.mfa.backupCodes = backupCodes.map(hashBackupCode);
  save();
  audit(req, 'backup-codes-renewed', req.user.email);
  res.json({ backupCodes });
});

router.post('/mfa/forget-devices', requireAuth(), (req, res) => {
  forgetTrustedDevices(req.user.role, req.user.email);
  audit(req, 'trusted-devices-forgotten', req.user.email);
  res.json({ ok: true });
});

router.get('/sessions', requireAuth(), (req, res) => {
  const list = sessionsOf(req.user.role, req.user.email)
    .map(({ id, agent, ip, createdAt, lastSeenAt, method }) => ({ id, agent, ip, createdAt, lastSeenAt, method, current: id === req.session.id }))
    .sort((a, b) => (a.current ? -1 : b.current ? 1 : a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  res.json(list);
});

router.delete('/sessions/:id', requireAuth(), (req, res) => {
  const mine = sessionsOf(req.user.role, req.user.email).some((s) => s.id === req.params.id);
  if (!mine) throw new HttpError(404, 'Session not found');
  endSessions((s) => s.id === req.params.id);
  audit(req, 'device-signed-out', req.user.email);
  res.json({ ok: true });
});

router.post('/sessions/sign-out-others', requireAuth(), (req, res) => {
  signOutAccount(req.user.role, req.user.email, { keep: req.session.id, forgetDevices: false });
  audit(req, 'signed-out-other-devices', req.user.email);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const session = currentSession(req);
  if (session) {
    endSessions((s) => s.id === session.id);
    audit(req, 'signed-out', session.email);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

export default router;
