// "Sign in with Google" (OpenID Connect, authorization-code flow with PKCE). Only the basic
// openid/email/profile scopes are requested, so Google shows no "unverified app" warning.
// The ID token comes straight from Google's token endpoint over TLS, so its signature doesn't
// need checking (OpenID Connect Core 3.1.3.7); its issuer, audience, expiry and nonce do.
import crypto from 'node:crypto';
import config from './config.js';
import { HttpError } from './errors.js';

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const base64url = (buf) => Buffer.from(buf).toString('base64url');

export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

/** A fresh state, nonce and PKCE verifier/challenge for one sign-in attempt. */
export function newAttempt() {
  const verifier = base64url(crypto.randomBytes(48));
  return {
    state: base64url(crypto.randomBytes(24)),
    nonce: base64url(crypto.randomBytes(24)),
    verifier,
    challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
  };
}

// Drive access is limited to files the person picks with this app (non-sensitive scope, no review).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const driveEnabled = () => googleEnabled() && Boolean(config.google.apiKey && config.google.appId);
// Google Meet: meetings are events AliasMail creates in the person's own Google Calendar.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const meetEnabled = () => googleEnabled() && config.google.meet;
// Google Chat (on trial): see the person's conversations, create spaces and add people to them.
export const CHAT_SCOPE = ['chat.spaces.readonly', 'chat.spaces.create', 'chat.memberships']
  .map((s) => `https://www.googleapis.com/auth/${s}`)
  .join(' ');
export const chatEnabled = () => googleEnabled() && config.google.chat;

/** `scope` (Drive or Calendar) is asked for on top of sign-in, with a refresh token to use it later. */
export function authorizationUrl({ state, nonce, challenge, redirectUri, scope = '', loginHint = '' }) {
  const url = new URL(config.google.authUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    scope: scope ? `openid email profile ${scope}` : 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(scope
      ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', ...(loginHint && { login_hint: loginHint }) }
      : { prompt: 'select_account' }),
  });
  return url.toString();
}

async function tokenRequest(params, fetcher) {
  const res = await fetcher(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: config.google.clientId, client_secret: config.google.clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** A fresh access token from a stored refresh token: { accessToken, expiresAt }. */
export async function refreshAccess(refreshToken, what = 'Google Drive', fetcher = (...args) => fetch(...args)) {
  const { ok, status, data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, fetcher);
  if (!ok || !data.access_token) {
    const error = new HttpError(data.error === 'invalid_grant' ? 409 : 502, data.error === 'invalid_grant' ? `${what} access was removed. Connect it again in Settings → Security.` : `${what} is unavailable (${data.error || status})`);
    error.revoked = data.error === 'invalid_grant';
    throw error;
  }
  return { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

/** Ask Google to forget a refresh token (best effort). */
export async function revokeToken(token, fetcher = (...args) => fetch(...args)) {
  await fetcher(`${config.google.revokeUrl}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** Share a Drive file with someone; quiet (Google sends no email of its own). */
export async function shareDriveFile(accessToken, fileId, email, role, fetcher = (...args) => fetch(...args)) {
  const url = `${config.google.driveApiUrl}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role, emailAddress: email }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Drive answered ${res.status}`);
  }
}

/**
 * Trade the code for the ID token and return its checked claims: { sub, email, name }, plus
 * `refreshToken` and `scope` when Drive was asked for.
 */
export async function exchangeCode({ code, verifier, redirectUri, nonce }, fetcher = (...args) => fetch(...args)) {
  const res = await fetcher(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new HttpError(502, `Google sign-in failed: ${data.error_description || data.error || res.status}`);
  return { ...checkIdToken(data.id_token, nonce), refreshToken: data.refresh_token || '', scope: String(data.scope || '') };
}

export function checkIdToken(idToken, nonce) {
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(502, 'Google sign-in failed: unreadable ID token');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(claims.iss)) throw new HttpError(401, 'Google sign-in failed: wrong issuer');
  if (!audience.includes(config.google.clientId)) throw new HttpError(401, 'Google sign-in failed: token is for another app');
  if (!(Number(claims.exp) * 1000 > Date.now())) throw new HttpError(401, 'Google sign-in failed: token expired');
  if (!nonce || claims.nonce !== nonce) throw new HttpError(401, 'Google sign-in failed: token does not match this sign-in');
  if (!claims.sub) throw new HttpError(401, 'Google sign-in failed: no account id');
  return { sub: String(claims.sub), email: claims.email_verified === false ? '' : String(claims.email || ''), name: String(claims.name || '') };
}
