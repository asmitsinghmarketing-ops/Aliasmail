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

export function authorizationUrl({ state, nonce, challenge, redirectUri }) {
  const url = new URL(config.google.authUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return url.toString();
}

/** Trade the code for the ID token and return its checked claims: { sub, email, name }. */
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
  return checkIdToken(data.id_token, nonce);
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
