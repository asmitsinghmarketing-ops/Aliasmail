import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const env = (key, fallback = '') => process.env[key]?.trim() || fallback;
const bool = (key, fallback) => {
  const value = env(key);
  return value ? value.toLowerCase() === 'true' : fallback;
};

const mailUser = env('MAIL_USER');
const mailPassword = env('MAIL_PASSWORD');

// Without a JWT_SECRET, generate one once and keep it beside the data file, so sign-ins and
// encrypted secrets survive restarts.
function jwtSecret(dataFile) {
  const fromEnv = env('JWT_SECRET');
  if (fromEnv && fromEnv !== 'change-me') return fromEnv;
  const file = path.join(path.dirname(dataFile), '.secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    console.warn(`[config] JWT_SECRET not set - generated one in ${file}`);
    return secret;
  }
}

const dataFile = path.resolve(root, env('DATA_FILE', 'data/db.json'));

const config = {
  port: Number(env('PORT', '4000')),
  jwtSecret: jwtSecret(dataFile),
  admin: {
    email: env('ADMIN_EMAIL', mailUser).toLowerCase(),
    password: env('ADMIN_PASSWORD'),
  },
  mailbox: mailUser.toLowerCase(),
  configured: Boolean(mailUser && mailPassword),
  imap: {
    host: env('IMAP_HOST', 'imap.secureserver.net'),
    port: Number(env('IMAP_PORT', '993')),
    secure: bool('IMAP_SECURE', true),
    auth: { user: mailUser, pass: mailPassword },
    logger: false,
  },
  smtp: {
    host: env('SMTP_HOST', 'smtpout.secureserver.net'),
    port: Number(env('SMTP_PORT', '465')),
    secure: bool('SMTP_SECURE', true),
    // SMTP_AUTH=false for GoDaddy shared hosting's local relay (SMTP_HOST=localhost, port 25),
    // which accepts mail from the server without a login.
    ...(bool('SMTP_AUTH', true) && { auth: { user: mailUser, pass: mailPassword } }),
  },
  syncIntervalMs: Number(env('SYNC_INTERVAL_SECONDS', '60')) * 1000,
  // Sign-in lifetime: sessions end after SESSION_DAYS, or after SESSION_IDLE_HOURS without use.
  sessionDays: Number(env('SESSION_DAYS', '7')),
  sessionIdleHours: Number(env('SESSION_IDLE_HOURS', '24')),
  // How long "don't ask again on this device" skips the authenticator code.
  mfaTrustDays: Number(env('MFA_TRUST_DAYS', '30')),
  // Set true when served over HTTPS (cookies are then Secure even behind a proxy).
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', false),
  forceHttps: bool('FORCE_HTTPS', false),
  dataFile,
  clientDist: path.resolve(root, '../client/dist'),
};

if (!config.configured) console.warn('[config] MAIL_USER / MAIL_PASSWORD missing - mailbox sync is disabled.');
if (!config.admin.password) console.warn('[config] ADMIN_PASSWORD missing - admin login is disabled.');

export default config;
