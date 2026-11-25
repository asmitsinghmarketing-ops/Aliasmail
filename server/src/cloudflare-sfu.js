// Trusted-server boundary for Cloudflare Realtime SFU. Browser code must never receive the app
// secret or call this API directly; call routes authorize a participant before using this client.
import config from './config.js';

const BASE = 'https://rtc.live.cloudflare.com/v1';

export const cloudflareSfuEnabled = (settings = config.calls) => Boolean(settings.cloudflareSfuAppId && settings.cloudflareSfuAppSecret);

export async function cloudflareSfuRequest(path, { method = 'POST', body, settings = config.calls, fetcher = fetch } = {}) {
  if (!cloudflareSfuEnabled(settings)) throw Object.assign(new Error('Cloudflare Realtime SFU is not configured'), { status: 503 });
  const suffix = String(path || '').replace(/^\/+/, '');
  if (!suffix || suffix.includes('..')) throw Object.assign(new Error('Invalid SFU operation'), { status: 400 });
  const url = `${BASE}/apps/${encodeURIComponent(settings.cloudflareSfuAppId)}/${suffix}`;
  const res = await fetcher(url, {
    method,
    headers: { Authorization: `Bearer ${settings.cloudflareSfuAppSecret}`, 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    const detail = data.errorDescription || data.error || `Cloudflare Realtime SFU answered ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status >= 500 ? 502 : res.status, providerStatus: res.status });
  }
  return data;
}

export const createCloudflareSfuSession = (options) => cloudflareSfuRequest('sessions/new', options);

