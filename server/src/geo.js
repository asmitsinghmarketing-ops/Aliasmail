// Where a sign-in came from, shown beside sessions and in the activity log.
//  - locate(ip): approximate place and internet provider from the IP, looked up once per IP per
//    day at ipapi.co. IP databases often name the provider's hub city (e.g. "New Delhi" for many
//    Indian broadband users), so the app labels this "approximate". Private and local
//    addresses are never sent. IP_LOCATION=off turns lookups off.
//  - placeAt(lat, lon): the town/city for coordinates the user chose to share from their device,
//    via OpenStreetMap Nominatim. Only the place name is kept, never the coordinates.
// Failures leave the location blank.
import config from './config.js';

const DAY = 24 * 3600e3;
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;
const join = (...parts) => [...new Set(parts.filter(Boolean))].join(', ') || null;
// "AS133982 Excitel Broadband Private Limited" -> "Excitel Broadband"
const shortIsp = (org) =>
  String(org || '').replace(/^AS\d+\s+/i, '').replace(/\b(private|pvt\.?|limited|ltd\.?|llc|inc\.?|corporation|corp\.?)\b/gi, '').replace(/[\s,.]+$/, '').replace(/\s{2,}/g, ' ').trim() || null;

function cached(maxEntries) {
  const map = new Map();
  return {
    get: (key) => {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < DAY ? hit : null;
    },
    set: (key, value) => {
      map.set(key, { at: Date.now(), value });
      if (map.size > maxEntries) map.delete(map.keys().next().value);
    },
  };
}

export function createLocator({ enabled = true, fetcher = (...args) => fetch(...args), maxEntries = 2000 } = {}) {
  const cache = cached(maxEntries);
  /** { place, isp } for a public IP, or null. */
  return async function locate(ip) {
    if (!enabled || !ip || PRIVATE.test(ip)) return null;
    const hit = cache.get(ip);
    if (hit) return hit.value;
    try {
      const res = await fetcher(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        headers: { Accept: 'application/json', 'User-Agent': 'AliasMail' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.error) return null;
      const value = { place: join(data.city, data.region, data.country_name), isp: shortIsp(data.org) };
      if (!value.place && !value.isp) return null;
      cache.set(ip, value);
      return value;
    } catch {
      return null;
    }
  };
}

export function createPlaceFinder({ fetcher = (...args) => fetch(...args), maxEntries = 2000 } = {}) {
  const cache = cached(maxEntries);
  /** "Town, State, Country" for coordinates, or null. */
  return async function placeAt(lat, lon) {
    // ~1 km grid: enough for a town name, and nothing more precise is ever sent or kept.
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit) return hit.value;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
      const res = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'AliasMail self-hosted webmail' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const a = (await res.json()).address || {};
      const value = join(a.city || a.town || a.village || a.suburb || a.county || a.state_district, a.state, a.country);
      if (value) cache.set(key, value);
      return value;
    } catch {
      return null;
    }
  };
}

export const locate = createLocator({ enabled: config.ipLocation });
export const placeAt = createPlaceFinder();
