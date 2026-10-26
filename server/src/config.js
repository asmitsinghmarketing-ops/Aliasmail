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
const mailBridgeUrl = env('MAIL_BRIDGE_URL').replace(/\/$/, '');
const mailBridgeToken = env('MAIL_BRIDGE_TOKEN');

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

// Hosting providers name database settings differently: accept a full URL under common names,
// or build one from separate host / user / password / name variables.
function findDatabaseUrl() {
  for (const key of ['DATABASE_URL', 'MYSQL_URL', 'MYSQL_DATABASE_URL', 'DB_URL', 'POSTGRES_URL', 'PG_URL']) {
    if (env(key)) return env(key);
  }
  for (const prefix of ['DB_', 'MYSQL_', 'DATABASE_']) {
    const host = env(`${prefix}HOST`);
    const user = env(`${prefix}USER`) || env(`${prefix}USERNAME`);
    const name = env(`${prefix}NAME`) || env(`${prefix}DATABASE`) || (prefix === 'MYSQL_' ? '' : env(`${prefix}DB`));
    if (!host || !user || !name) continue;
    const password = env(`${prefix}PASSWORD`) || env(`${prefix}PASS`);
    const scheme = /^(postgres|pg)/i.test(env(`${prefix}DIALECT`) || env(`${prefix}TYPE`) || env(`${prefix}CONNECTION`)) ? 'postgres' : 'mysql';
    const port = env(`${prefix}PORT`, scheme === 'postgres' ? '5432' : '3306');
    const e = encodeURIComponent;
    return `${scheme}://${e(user)}:${e(password)}@${host}:${port}/${e(name)}`;
  }
  return '';
}

// Refuse an ephemeral production store instead of silently recreating accounts.
const databaseUrl = findDatabaseUrl();
if (databaseUrl) {
  let protocol;
  try { protocol = new URL(databaseUrl).protocol; } catch { throw new Error('DATABASE_URL must be a valid MySQL or PostgreSQL connection URL'); }
  if (!['mysql:', 'postgres:', 'postgresql:'].includes(protocol)) throw new Error('DATABASE_URL must use mysql://, postgres://, or postgresql://');
}
if (process.env.NODE_ENV === 'production') {
  if (!databaseUrl && !bool('ALLOW_FILE_STORAGE', false)) {
    // Names only, never values, so the host's log shows what the provider actually set.
    const seen = Object.keys(process.env).filter((k) => /DB|DATABASE|MYSQL|POSTGRES|^PG/i.test(k));
    throw new Error(`Persistent storage is required: set DATABASE_URL (or DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) in the hosting environment. Database-related variables found: ${seen.join(', ') || 'none'}. Local files may be erased on redeploy. Use ALLOW_FILE_STORAGE=true only with a persistent DATA_FILE volume.`);
  }
  if (!env('JWT_SECRET') || env('JWT_SECRET') === 'change-me') {
    throw new Error('Set a stable JWT_SECRET in the hosting environment before deploying. A generated local secret does not survive rebuilds.');
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
  configured: Boolean(mailUser && (mailPassword || (mailBridgeUrl && mailBridgeToken))),
  mailBridge: { url: mailBridgeUrl, token: mailBridgeToken, configured: Boolean(mailBridgeUrl && mailBridgeToken) },
  // Existing bridge installations stay on the bridge until direct access is enabled.
  mailTransport: env('MAIL_TRANSPORT', mailBridgeUrl && mailBridgeToken ? 'bridge' : 'direct').toLowerCase(),
  folders: { inbox: env('MAIL_INBOX_FOLDER', 'INBOX'), sent: env('MAIL_SENT_FOLDER'), spam: env('MAIL_SPAM_FOLDER'), trash: env('MAIL_TRASH_FOLDER') },
  messageCache: {
    enabled: bool('MESSAGE_CACHE_ENABLED', true),
    maxBytes: Math.max(1, Number(env('MESSAGE_CACHE_MB', '250')) || 250) * 1024 * 1024,
    maxAgeMs: Math.max(1, Number(env('MESSAGE_CACHE_DAYS', '30')) || 30) * 86400_000,
  },
  imap: {
    host: env('IMAP_HOST', 'imap.secureserver.net'),
    port: Number(env('IMAP_PORT', '993')),
    secure: bool('IMAP_SECURE', true),
    auth: { user: mailUser, pass: mailPassword },
    logger: false,
    // Fail fast when the host blocks the port, instead of outlasting the proxy (which shows 502).
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  },
  smtp: {
    host: env('SMTP_HOST', 'smtpout.secureserver.net'),
    port: Number(env('SMTP_PORT', '465')),
    secure: bool('SMTP_SECURE', true),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
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
  // mysql://user:pass@host:3306/db or postgres://user:pass@host:5432/db. Unset: use dataFile.
  databaseUrl,
  databaseSsl: bool('DATABASE_SSL', false),
  clientDist: path.resolve(root, '../client/dist'),
};

if (!['bridge', 'direct', 'auto'].includes(config.mailTransport)) throw new Error('MAIL_TRANSPORT must be bridge, direct, or auto');

if (!config.configured) console.warn('[config] MAIL_USER or PHP mail bridge settings missing - mailbox sync is disabled.');
if (!config.admin.password) console.warn('[config] ADMIN_PASSWORD missing - admin login is disabled.');

export default config;
