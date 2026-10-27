// Security primitives: authenticator-app codes (TOTP, RFC 6238), encryption of stored secrets,
// backup codes, attempt limiting and cookies. Built on node:crypto only.
import crypto from 'node:crypto';
import config from './config.js';
import { HttpError } from './errors.js';

/* ---------------------------------- base32 (authenticator secrets) ---------------------------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/* ---------------------------------- TOTP ---------------------------------- */

const STEP_SECONDS = 30;
const DIGITS = 6;

function hotp(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** Code for a time (used by tests). */
export const totpAt = (secretB32, ms = Date.now()) => hotp(base32Decode(secretB32), Math.floor(ms / 1000 / STEP_SECONDS));

/**
 * Check a 6-digit code, allowing one step of clock drift either way. Returns the matched time
 * step, or null. Steps at or before `lastStep` are refused so a code can't be used twice.
 */
export function verifyTotp(secretB32, code, lastStep = -1, ms = Date.now()) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(ms / 1000 / STEP_SECONDS);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(clean))) return step;
  }
  return null;
}

export const otpauthUrl = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

/* ---------------------------------- secrets at rest ---------------------------------- */

const sealKey = crypto.createHash('sha256').update(`${config.jwtSecret}:aliasmail-secrets`).digest();

/** AES-256-GCM encrypt a short string for storage in the data file. */
export function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function unseal(sealed) {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/* ---------------------------------- tokens & backup codes ---------------------------------- */

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function newBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const hashBackupCode = (code) => sha256(String(code).replace(/[\s-]/g, '').toLowerCase());

/* ---------------------------------- attempt limiting ---------------------------------- */

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if ((b.lockedUntil || b.first + 3600e3) < now) buckets.delete(key);
}, 10 * 60e3).unref();

/** Lock a key out for `lockMs` after `max` failures within `windowMs`. */
export function limiter(name, { max, windowMs, lockMs }) {
  const k = (key) => `${name}:${key}`;
  return {
    check(key) {
      const b = buckets.get(k(key));
      if (b?.lockedUntil > Date.now()) {
        const minutes = Math.ceil((b.lockedUntil - Date.now()) / 60e3);
        throw new HttpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
    },
    fail(key) {
      const now = Date.now();
      let b = buckets.get(k(key));
      if (!b || now - b.first > windowMs) b = { count: 0, first: now };
      b.count += 1;
      if (b.count >= max) b.lockedUntil = now + lockMs;
      buckets.set(k(key), b);
    },
    reset(key) {
      buckets.delete(k(key));
    },
  };
}

/* ---------------------------------- cookies & request info ---------------------------------- */

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const cookieOptions = (req, maxAge) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: req.secure || config.cookieSecure,
  path: '/',
  maxAge,
});

// "::ffff:203.0.113.7" is an IPv4 address written the IPv6 way; show it as "203.0.113.7".
export const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

const hint = (req, name) => String(req.headers?.[name] ?? '').replace(/^"|"$/g, '').trim();

/**
 * The device and browser behind a request, e.g. { label: 'Android phone (Samsung SM-S911B) · Chrome',
 * kind: 'phone' }. Chrome and Edge add the phone model and Windows version through client hints
 * (the app asks for them with Accept-CH); Safari and iPhones never reveal the exact model.
 */
export function describeDevice(req) {
  const ua = String(req.headers?.['user-agent'] || '');
  const browser = /Edg[A-Z]?\//.test(ua) ? 'Edge' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';

  // Reduced user agents say "Android 10; K"; a real model comes from the hint or older UAs.
  let model = hint(req, 'sec-ch-ua-model') || (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/)?.[1] ?? '');
  if (model === 'K' || /^(wv|Linux|Mobile)$/i.test(model)) model = '';
  if (/^SM-/i.test(model)) model = `Samsung ${model}`;

  let kind = 'computer';
  let device;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && hint(req, 'sec-ch-ua-mobile') === '?1')) [kind, device] = ['tablet', 'iPad'];
  else if (/iPhone|iPod/.test(ua)) [kind, device] = ['phone', 'iPhone'];
  else if (/Android/.test(ua)) {
    kind = /Mobile/.test(ua) || hint(req, 'sec-ch-ua-mobile') === '?1' ? 'phone' : 'tablet';
    device = `Android ${kind}${model ? ` (${model})` : ''}`;
  } else if (/Windows/.test(ua)) {
    // Windows 11 reports platform version 13 or higher; the user agent says "10" for both.
    const major = Number(hint(req, 'sec-ch-ua-platform-version').split('.')[0]);
    device = `Windows${major >= 13 ? ' 11' : major > 0 ? ' 10' : ''} computer`;
  } else if (/CrOS/.test(ua)) device = 'Chromebook';
  else if (/Mac OS X|Macintosh/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux computer';
  else device = 'Unknown device';
  return { label: `${device} · ${browser}`, kind };
}

export const describeAgent = (ua = '') => describeDevice({ headers: { 'user-agent': ua } }).label;
