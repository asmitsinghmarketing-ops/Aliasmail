// Approximate location (city, region, country) of a sign-in IP, shown beside sessions and in the
// activity log. Looked up once per IP per day at ipapi.co (HTTPS, no key); private and local
// addresses are never sent. IP_LOCATION=off turns lookups off. Failures just leave it blank.
import config from './config.js';

const DAY = 24 * 3600e3;
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;

export function createLocator({ enabled = true, fetcher = (...args) => fetch(...args), maxEntries = 2000 } = {}) {
  const cache = new Map(); // ip -> { at, label }
  return async function locate(ip) {
    if (!enabled || !ip || PRIVATE.test(ip)) return null;
    const hit = cache.get(ip);
    if (hit && Date.now() - hit.at < DAY) return hit.label;
    try {
      const res = await fetcher(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        headers: { Accept: 'application/json', 'User-Agent': 'AliasMail' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.error) return null;
      const label = [...new Set([data.city, data.region, data.country_name].filter(Boolean))].join(', ') || null;
      cache.set(ip, { at: Date.now(), label });
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return label;
    } catch {
      return null;
    }
  };
}

export const locate = createLocator({ enabled: config.ipLocation });
