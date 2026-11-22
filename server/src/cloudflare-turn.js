// Cloudflare Realtime TURN: the relay for calls on networks that block direct connections.
// Cloudflare hands out short-lived sign-ins through its API, so the server asks for one, keeps it,
// and asks for a fresh one well before it runs out. Every browser gets the current one with the call.
import config from './config.js';

const LIFETIME_S = 24 * 3600; // how long each sign-in from Cloudflare lasts
const RENEW_LEFT_MS = 12 * 3600_000; // renew while at least this much is left, so calls in progress keep working
const RETRY_MS = 5 * 60_000;

let servers = [];
let expiresAt = 0;
let nextTryAt = 0;
let pending = null;

export const cloudflareTurnEnabled = (settings = config.calls) => Boolean(settings.cloudflareTurnKeyId && settings.cloudflareTurnToken);

/** Cloudflare's answer, as RTCPeerConnection iceServers (port 53 left out: browsers stall on it). */
export function parseIceServers(body) {
  const list = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  return list
    .map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => typeof url === 'string' && !/:53(\?|$)/.test(url)),
    }))
    .filter((server) => server.urls.length);
}

async function fetchServers(settings) {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(settings.cloudflareTurnKeyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.cloudflareTurnToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: LIFETIME_S }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const found = parseIceServers(await res.json());
  if (!found.some((server) => server.username)) throw new Error('Cloudflare TURN sent no relay sign-in.');
  return found;
}

/** Fetch a fresh sign-in if the one kept is getting old. Safe to call often. */
export function renewCloudflareTurn(settings = config.calls, now = Date.now()) {
  if (!cloudflareTurnEnabled(settings) || pending) return pending;
  if (expiresAt - now > RENEW_LEFT_MS || now < nextTryAt) return null;
  pending = fetchServers(settings)
    .then((found) => {
      servers = found;
      expiresAt = Date.now() + LIFETIME_S * 1000;
    })
    .catch((err) => {
      nextTryAt = Date.now() + RETRY_MS;
      console.warn(`[calls] ${err.message}`);
    })
    .finally(() => { pending = null; });
  return pending;
}

/** The relay servers to give browsers now (empty until the first sign-in arrives). */
export function cloudflareTurnServers(now = Date.now()) {
  renewCloudflareTurn(undefined, now);
  return expiresAt > now ? servers : [];
}

/** Get the first sign-in at startup and keep it fresh. */
export function startCloudflareTurn() {
  if (!cloudflareTurnEnabled()) return;
  renewCloudflareTurn();
  setInterval(() => renewCloudflareTurn(), 30 * 60_000).unref();
}
