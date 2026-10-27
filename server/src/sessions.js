// Server-side sign-in sessions (one per signed-in browser) and devices trusted to skip the
// authenticator code. The browser only holds httpOnly cookies; the records live here, so any
// session can be listed and signed out.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from './config.js';
import { db, save } from './store.js';
import { clientIp, cookieOptions, describeDevice, randomToken, readCookie, sha256 } from './security.js';
import { locate } from './geo.js';

export const SESSION_COOKIE = 'am_session';
const DAY = 24 * 3600e3;
const accountKey = (role, email) => `${role}:${email}`;
const trustCookie = (role, email) => `am_trust_${sha256(accountKey(role, email)).slice(0, 16)}`;

function prune() {
  const now = Date.now();
  db().sessions = db().sessions.filter((s) => Date.parse(s.expiresAt) > now && now - Date.parse(s.lastSeenAt) < config.sessionIdleHours * 3600e3);
  db().devices = db().devices.filter((d) => Date.parse(d.expiresAt) > now);
}

/** Start a session for a fully verified sign-in and set its cookie. */
/** Fill in the session's approximate location in the background; sign-in never waits for it. */
function locateSession(session) {
  const ip = session.ip;
  void locate(ip).then((location) => {
    if (location && session.ip === ip) {
      session.location = location;
      save();
    }
  });
}

export function startSession(req, res, { role, email, method }) {
  prune();
  const now = new Date();
  const device = describeDevice(req);
  const session = {
    id: crypto.randomUUID(),
    account: accountKey(role, email),
    role,
    email,
    method, // 'password' | 'authenticator' | 'backup-code' | 'trusted-device'
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.sessionDays * DAY).toISOString(),
    ip: clientIp(req),
    agent: device.label,
    kind: device.kind,
    location: null,
  };
  db().sessions.push(session);
  save();
  locateSession(session);
  const token = jwt.sign({ sid: session.id }, config.jwtSecret, { expiresIn: `${config.sessionDays}d`, algorithm: 'HS256' });
  res.cookie(SESSION_COOKIE, token, cookieOptions(req, config.sessionDays * DAY));
  return session;
}

/** The live session behind this request's cookie, or null (expired, idle too long, or signed out). */
export function currentSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const session = db().sessions.find((s) => s.id === payload.sid);
  if (!session) return null;

  const now = Date.now();
  if (Date.parse(session.expiresAt) < now || now - Date.parse(session.lastSeenAt) > config.sessionIdleHours * 3600e3) {
    endSessions((s) => s.id === session.id);
    return null;
  }
  if (now - Date.parse(session.lastSeenAt) > 60e3) {
    session.lastSeenAt = new Date(now).toISOString();
    // Same browser; refreshed so older sign-ins pick up the device model once hints arrive.
    const device = describeDevice(req);
    session.agent = device.label;
    session.kind = device.kind;
    const ip = clientIp(req);
    // A phone moving from Wi-Fi to mobile data gets a new IP, and maybe a new location.
    if (ip !== session.ip || (!session.location && !session.locatedAt)) {
      session.ip = ip;
      session.location = null;
      session.locatedAt = new Date(now).toISOString();
      locateSession(session);
    }
    save();
  }
  return session;
}

export function endSessions(predicate) {
  const before = db().sessions.length;
  db().sessions = db().sessions.filter((s) => !predicate(s));
  if (db().sessions.length !== before) save();
  return before - db().sessions.length;
}

export const sessionsOf = (role, email) => db().sessions.filter((s) => s.account === accountKey(role, email));

/** Sign an account out everywhere (optionally keeping one session) and forget its trusted devices. */
export function signOutAccount(role, email, { keep = null, forgetDevices = true } = {}) {
  const account = accountKey(role, email);
  endSessions((s) => s.account === account && s.id !== keep);
  if (forgetDevices) forgetTrustedDevices(role, email);
}

/* ---------------------------------- trusted devices ---------------------------------- */

export function trustDevice(req, res, role, email) {
  const token = randomToken();
  const ttl = config.mfaTrustDays * DAY;
  db().devices.push({
    id: crypto.randomUUID(),
    account: accountKey(role, email),
    tokenHash: sha256(token),
    agent: describeDevice(req).label,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  });
  save();
  res.cookie(trustCookie(role, email), token, cookieOptions(req, ttl));
}

export function isTrustedDevice(req, role, email) {
  const token = readCookie(req, trustCookie(role, email));
  if (!token) return false;
  const hash = sha256(token);
  return db().devices.some((d) => d.account === accountKey(role, email) && d.tokenHash === hash && Date.parse(d.expiresAt) > Date.now());
}

export const trustedDevicesOf = (role, email) => db().devices.filter((d) => d.account === accountKey(role, email) && Date.parse(d.expiresAt) > Date.now());

export function forgetTrustedDevices(role, email) {
  const account = accountKey(role, email);
  db().devices = db().devices.filter((d) => d.account !== account);
  save();
}
