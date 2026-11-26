// Firebase HTTP v1 delivery for the native Android app. It uses a short-lived Google OAuth token
// made from the organization-owned service account; no Firebase secret is ever sent to the app.
import crypto from 'node:crypto';
import config from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cached = null;

const encoded = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export const firebaseEnabled = () => Boolean(config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey);

async function accessToken() {
  if (cached?.expiresAt > Date.now() + 60_000) return cached.value;
  const now = Math.floor(Date.now() / 1000);
  const header = encoded({ alg: 'RS256', typ: 'JWT' });
  const claims = encoded({ iss: config.firebase.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const unsigned = `${header}.${claims}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), config.firebase.privateKey).toString('base64url')}`;
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error(`Firebase authentication failed (${response.status})`);
  cached = { value: result.access_token, expiresAt: Date.now() + Math.max(300, Number(result.expires_in) || 3600) * 1000 };
  return cached.value;
}

const dataValues = (payload) => Object.fromEntries(Object.entries(payload || {})
  .filter(([, value]) => value !== undefined && value !== null)
  .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));

export async function sendFirebase(token, payload) {
  if (!firebaseEnabled()) return false;
  const bearer = await accessToken();
  const call = payload?.kind === 'call';
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.firebase.projectId)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: dataValues(payload),
        android: { priority: call ? 'HIGH' : 'NORMAL', ttl: call ? '90s' : '3600s', collapse_key: String(payload?.tag || payload?.kind || 'nextspace').slice(0, 64) },
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (response.ok) return true;
  const result = await response.json().catch(() => ({}));
  const status = result?.error?.status || '';
  const error = new Error(`Firebase delivery failed (${response.status}${status ? ` ${status}` : ''})`);
  error.gone = response.status === 404 || status === 'UNREGISTERED';
  throw error;
}
