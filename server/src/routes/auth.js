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
import { clientIp, cookieOptions, hashBackupCode, limiter, newBackupCodes, newTotpSecret, otpauthUrl, readCookie, seal, unseal, verifyTotp } from '../security.js';
import { DRIVE_SCOPE, authorizationUrl, driveEnabled, exchangeCode, googleEnabled, newAttempt, revokeToken } from '../google-auth.js';
import { driveAccess } from '../google-drive.js';
import {
  SESSION_COOKIE,
  currentSession,
  endSessions,
  forgetTrustedDevices,
  isTrustedDevice,
  sessionsOf,
  signOutAccount,
  setDeviceLocation,
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
router.get('/info', (req, res) => res.json({ domain: config.mailbox.split('@')[1] || '', google: googleEnabled(), drive: driveEnabled() }));

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

/* ---------------------------------- sign in with Google ---------------------------------- */
//
// /google/start?mode=link (signed in, Settings) connects a Google account to the account;
// /google/start?mode=login signs in with a connected one. Only a Google account connected from
// inside AliasMail can sign in: matching on the email address alone would let someone who left
// keep signing in with a personal Google account that uses their old company address.
//
// After Google, the browser lands on the sign-in page, which POSTs /google/finish. That request
// comes from this site, so it carries the strict session and trusted-device cookies, and 2-step
// verification works exactly as after a password.

const GOOGLE_COOKIE = 'am_google';
const GOOGLE_RESULT_COOKIE = 'am_google_result';
const googleCookie = (req, maxAge) => ({ ...cookieOptions(req, maxAge), sameSite: 'lax', path: '/api/auth/google' });

/** Where a Google account is connected: { role, email, holder }, or null. */
function accountForGoogle(sub) {
  if (db().owner.google?.sub === sub && config.admin.email) return { role: 'admin', email: config.admin.email, holder: db().owner };
  const alias = db().aliases.find((a) => a.google?.sub === sub);
  return alias ? { role: 'user', email: alias.address, holder: alias } : null;
}

const redirectUriFor = (req) => `${config.appUrl || `${req.protocol}://${req.get('host')}`}/api/auth/google/callback`;
const backTo = (res, outcome) => res.redirect(303, `/?google=${outcome}`);

// mode=drive connects Google Drive (files picked with AliasMail only) for the signed-in account,
// connecting the Google account too if it isn't yet.
router.get('/google/start', (req, res) => {
  if (!googleEnabled()) throw new HttpError(404, 'Google sign-in is not set up');
  const mode = ['link', 'drive'].includes(req.query.mode) ? req.query.mode : 'login';
  if (mode === 'drive' && !driveEnabled()) throw new HttpError(404, 'Google Drive is not set up');
  const session = mode === 'login' ? null : currentSession(req);
  if (mode !== 'login' && !session) return backTo(res, 'signin-first');
  const attempt = newAttempt();
  const redirectUri = redirectUriFor(req);
  const pending = jwt.sign(
    { purpose: 'google', mode, state: attempt.state, nonce: attempt.nonce, verifier: attempt.verifier, sid: session?.id || null, redirectUri },
    config.jwtSecret,
    { expiresIn: '10m', algorithm: 'HS256' },
  );
  const loginHint = session ? holderOf(session.role, session.email)?.google?.email || '' : '';
  res.cookie(GOOGLE_COOKIE, pending, googleCookie(req, 10 * 60e3));
  res.redirect(303, authorizationUrl({ ...attempt, redirectUri, drive: mode === 'drive', loginHint }));
});

router.get('/google/callback', async (req, res) => {
  res.clearCookie(GOOGLE_COOKIE, { path: '/api/auth/google' });
  let pending;
  try {
    pending = jwt.verify(readCookie(req, GOOGLE_COOKIE) || '', config.jwtSecret, JWT_OPTIONS);
  } catch {
    return backTo(res, 'expired');
  }
  if (pending.purpose !== 'google' || !req.query.state || req.query.state !== pending.state) return backTo(res, 'error');
  if (req.query.error) return backTo(res, 'cancelled');

  let google;
  try {
    google = await exchangeCode({ code: String(req.query.code || ''), verifier: pending.verifier, redirectUri: pending.redirectUri, nonce: pending.nonce });
  } catch (err) {
    console.warn('[google] sign-in failed:', err.message);
    return backTo(res, 'error');
  }

  if (pending.mode === 'link' || pending.mode === 'drive') {
    const session = db().sessions.find((s) => s.id === pending.sid && Date.parse(s.expiresAt) > Date.now());
    if (!session) return backTo(res, 'signin-first');
    const other = accountForGoogle(google.sub);
    if (other && !(other.role === session.role && other.email === session.email)) {
      audit(req, 'google-link-refused', session.email, `already connected to ${other.email}`);
      return backTo(res, 'in-use');
    }
    const holder = holderOf(session.role, session.email);
    if (!holder) return backTo(res, 'error');
    const same = holder.google?.sub === google.sub;
    if (pending.mode === 'drive' && holder.google && !same) return backTo(res, 'drive-other-account');
    if (pending.mode === 'drive' && (!google.refreshToken || !google.scope.split(' ').includes(DRIVE_SCOPE))) return backTo(res, 'drive-denied');

    const previousDrive = same ? holder.google.drive : null;
    holder.google = {
      sub: google.sub, email: google.email, name: google.name,
      linkedAt: same ? holder.google.linkedAt : new Date().toISOString(),
      ...(pending.mode === 'drive'
        ? { drive: { refresh: seal(google.refreshToken), connectedAt: new Date().toISOString() } }
        : previousDrive && { drive: previousDrive }),
    };
    driveAccess.delete(`${session.role}:${session.email}`);
    save();
    audit(req, pending.mode === 'drive' ? 'google-drive-connected' : 'google-connected', session.email, google.email);
    return backTo(res, pending.mode === 'drive' ? 'drive-linked' : 'linked');
  }

  const found = accountForGoogle(google.sub);
  if (!found) {
    audit(req, 'sign-in-failed', google.email, 'Google account not connected');
    return backTo(res, 'not-linked');
  }
  if (found.role === 'user' && (!found.holder.active || typeOf(found.holder) === 'group')) {
    audit(req, 'sign-in-failed', found.email, 'alias disabled (Google)');
    return backTo(res, 'disabled');
  }
  const result = jwt.sign({ purpose: 'google-result', role: found.role, email: found.email, jti: crypto.randomUUID() }, config.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
  res.cookie(GOOGLE_RESULT_COOKIE, result, googleCookie(req, 5 * 60e3));
  backTo(res, 'continue');
});

/** Called by the sign-in page after Google: same answers as POST /login. */
router.post('/google/finish', (req, res) => {
  res.clearCookie(GOOGLE_RESULT_COOKIE, { path: '/api/auth/google' });
  let result;
  try {
    result = jwt.verify(readCookie(req, GOOGLE_RESULT_COOKIE) || '', config.jwtSecret, JWT_OPTIONS);
  } catch {
    throw new HttpError(401, 'Your Google sign-in expired. Try again.');
  }
  if (result.purpose !== 'google-result' || usedTickets.has(result.jti)) throw new HttpError(401, 'Your Google sign-in expired. Try again.');
  consumeTicket(result);
  const account = { role: result.role, email: result.email };
  const holder = holderOf(account.role, account.email);
  if (!holder || (account.role === 'user' && (!holder.active || typeOf(holder) === 'group' || !holder.google))) {
    throw new HttpError(403, 'This account can’t sign in with Google any more');
  }
  if (mfaEnabled(holder)) {
    if (isTrustedDevice(req, account.role, account.email)) return finishSignIn(req, res, account, 'google + trusted device');
    return res.json({ mfa: 'verify', ticket: issueTicket(account, 'verify'), email: account.email });
  }
  if (db().security.requireMfa) return res.json({ mfa: 'setup', ticket: issueTicket(account, 'setup'), email: account.email });
  finishSignIn(req, res, account, 'google');
});

/** Stop AliasMail's Drive access: tell Google to forget the token, then drop it. */
function dropDrive(req, holder) {
  if (!holder?.google?.drive) return;
  try {
    void revokeToken(unseal(holder.google.drive.refresh));
  } catch {
    /* unreadable token: nothing to revoke */
  }
  delete holder.google.drive;
  driveAccess.delete(`${req.user.role}:${req.user.email}`);
}

router.post('/google/disconnect', requireAuth(), (req, res) => {
  const holder = holderOf(req.user.role, req.user.email);
  if (holder?.google) {
    audit(req, 'google-disconnected', req.user.email, holder.google.email);
    dropDrive(req, holder);
    delete holder.google;
    save();
  }
  res.json({ ok: true });
});

router.post('/google/drive/disconnect', requireAuth(), (req, res) => {
  const holder = holderOf(req.user.role, req.user.email);
  if (holder?.google?.drive) {
    dropDrive(req, holder);
    save();
    audit(req, 'google-drive-disconnected', req.user.email);
  }
  res.json({ ok: true });
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
    googleEnabled: googleEnabled(),
    driveEnabled: driveEnabled(),
    google: holder?.google
      ? { email: holder.google.email, name: holder.google.name, linkedAt: holder.google.linkedAt, drive: Boolean(holder.google.drive), driveConnectedAt: holder.google.drive?.connectedAt || null }
      : null,
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
    .map(({ id, agent, kind, ip, location, locationSource, isp, createdAt, lastSeenAt, method }) => ({
      id, agent, kind, ip, location, locationSource, isp, createdAt, lastSeenAt, method, current: id === req.session.id,
    }))
    .sort((a, b) => (a.current ? -1 : b.current ? 1 : a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  res.json(list);
});

// IP-based locations can name the internet provider's hub city; the user may share this device's
// real location instead. Only the resulting place name is stored.
const deviceLocations = limiter('device-location', { max: 10, windowMs: 60 * 60e3, lockMs: 60 * 60e3 });
router.post('/sessions/current/location', requireAuth(), async (req, res) => {
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'Location not recognised');
  const key = `${req.user.role}:${req.user.email}`;
  deviceLocations.check(key);
  deviceLocations.fail(key);
  const place = await setDeviceLocation(req.session, lat, lon);
  if (!place) throw new HttpError(502, 'Couldn’t look up a place name for this location. Try again later.');
  res.json({ location: place });
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
