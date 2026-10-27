import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from './config.js';
import { db, flush, load } from './store.js';
import { closeMailbox } from './mailbox.js';
import { liveSync } from './live-sync.js';
import { runScheduled } from './outbox.js';
import { readAvatar } from './avatars.js';
import { HttpError } from './errors.js';
import { driveEnabled } from './google-auth.js';
import authRoutes from './routes/auth.js';
import mailRoutes from './routes/mail.js';
import adminRoutes from './routes/admin.js';

// Log what kills the process, so the host's runtime logs show why requests got a 502.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => console.error('[error] unhandled rejection:', err));

await load();

// Marks which process owns the data folder (see checkDeployment).
const lockFile = path.join(path.dirname(config.dataFile), '.pid');

const app = express();
app.disable('x-powered-by');
// Real client IPs and HTTPS behind a proxy. TRUST_PROXY=true trusts one proxy hop of any kind.
// Otherwise only a proxy on this same machine (GoDaddy's, Passenger, a local nginx) is trusted:
// nobody outside can connect from loopback, so they can't forge X-Forwarded-For that way.
app.set('trust proxy', config.trustProxy ? 1 : 'loopback');

// Security headers. The CSP lets email HTML (shown in a sandboxed srcdoc frame, which inherits it)
// load images and inline styles, but no scripts other than the app's own.
// Google's Drive file picker (Insert from Drive) needs its loader script and its frames; only
// allowed when Drive is set up. Email bodies stay sandboxed without scripts either way.
const PICKER = driveEnabled() ? ' https://apis.google.com' : '';
const PICKER_FRAMES = driveEnabled() ? ' https://docs.google.com https://drive.google.com https://content.googleapis.com' : '';
const CSP = [
  "default-src 'self'",
  `script-src 'self'${PICKER}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  `connect-src 'self'${PICKER}`,
  `frame-src 'self' about:${PICKER_FRAMES}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

// FORCE_HTTPS=true: send plain-HTTP visitors to HTTPS (needs TRUST_PROXY=true behind GoDaddy's proxy).
if (config.forceHttps) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    res.status(403).json({ error: 'Use HTTPS' });
  });
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Location only for this site, and only when the user asks to share it (Security settings).
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) {
    if (!req.path.startsWith('/api/avatars/')) res.set('Cache-Control', 'no-store');
  } else {
    res.set('Content-Security-Policy', CSP);
    // Ask Chrome/Edge for the phone model and Windows version, shown in "Where you're signed in".
    res.set('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version');
  }
  next();
});

// Requests that change something must carry this header. Browsers won't let another website add
// it to a request sent to us, which (with SameSite=Strict cookies) blocks cross-site request forgery.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('X-Requested-With') === 'AliasMail') return next();
  res.status(403).json({ error: 'Request blocked' });
});

// Sign-in requests come from people who aren't signed in yet: keep them tiny. Only signed-in
// routes (sending mail with attachments) accept large bodies.
app.use('/api/auth', express.json({ limit: '16kb' }));
app.use(express.json({ limit: '35mb' }));

// Profile pictures. File names are random and change on every upload, so they cache forever.
app.get('/api/avatars/:file', async (req, res) => {
  const avatar = await readAvatar(req.params.file);
  if (!avatar) return res.status(404).end();
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.type(avatar.type).send(avatar.data);
});

app.use('/api/auth', authRoutes);
// Health check for the host (GoDaddy pings the site to see that the app started).
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/mail', mailRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app in production (npm run build in ../client).
if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(config.clientDist, 'index.html')) : next()));
}

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (!(err instanceof HttpError) && status >= 500) console.error(err);
  // Don't leak internal error details to the browser.
  const message = err instanceof HttpError || status < 500 ? err.message : 'Something went wrong on the server';
  res.status(status).json({ error: message || 'Something went wrong' });
});

app.listen(config.port, () => console.log(`AliasMail API running on http://localhost:${config.port}`));
checkDeployment();

if (config.configured) {
  liveSync.start();
  setInterval(runScheduled, 30_000);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    liveSync.stop();
    await closeMailbox();
    await flush();
    releaseLock();
    process.exit(0);
  });
}

/* ---------------------------------- deployment checks ---------------------------------- */

function releaseLock() {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.rmSync(lockFile);
  } catch {
    /* already gone */
  }
}

/** Loud warnings for settings that are unsafe on a public server. */
function checkDeployment() {
  const warn = (msg) => console.warn(`\n[SECURITY] ${msg}\n`);
  const appDir = path.resolve(path.dirname(config.dataFile), '..');

  // Anything inside public_html can be downloaded directly by Apache: .env, the data file, secrets.
  if (/[\\/]public_html([\\/]|$)/i.test(appDir) || /[\\/]public_html([\\/]|$)/i.test(config.dataFile)) {
    warn(`The app or its data is inside public_html (${appDir}). Move it outside public_html - otherwise .env and data/db.json can be downloaded from the web.`);
  }
  if (process.env.NODE_ENV === 'production') {
    if (!config.cookieSecure) warn('NODE_ENV=production but COOKIE_SECURE is not true. Serve over HTTPS and set COOKIE_SECURE=true.');
    if (!config.trustProxy) console.warn('[security] TRUST_PROXY is not set: client IPs are taken from a proxy on this machine only. If sign-in activity shows 127.0.0.1 or a private address for everyone, set TRUST_PROXY=true.');
  }
  if (config.forceHttps && !config.trustProxy) warn('FORCE_HTTPS=true without TRUST_PROXY=true can redirect forever behind a proxy.');
  if (config.admin.password && config.admin.password.length < 12) warn('ADMIN_PASSWORD is shorter than 12 characters. Use a long, unique password.');
  if (!db().owner.mfa?.enabled) console.warn('[security] The admin account has no 2-Step Verification yet (Mailbox → Settings → Security).');

  // The JSON data file must only be written by one process. Hosting that starts several copies
  // of the app (some Passenger setups) would overwrite each other's changes.
  try {
    const other = Number(fs.readFileSync(lockFile, 'utf8'));
    if (other && other !== process.pid) {
      process.kill(other, 0); // throws if that process is gone
      warn(`Another AliasMail process (pid ${other}) is using ${path.dirname(config.dataFile)}. Run only ONE instance, or data will be lost.`);
    }
  } catch {
    /* no lock, or a stale one */
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  process.on('exit', releaseLock);
}
