// The sign-in lives in an httpOnly cookie the page can't read, so nothing secret is kept in
// browser storage. Every request carries X-Requested-With, which the server requires for
// changes (another website can't add it, which stops cross-site request forgery).
export const LOGOUT_EVENT = 'aliasmail:logout';

async function request(path, { method = 'GET', body, signInFlow = false } = {}) {
  const headers = { 'X-Requested-With': 'AliasMail' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Signed out elsewhere, expired, or idle too long: go back to the sign-in page.
  if (res.status === 401 && !signInFlow) window.dispatchEvent(new Event(LOGOUT_EVENT));
  return res;
}

/** `signInFlow: true` for sign-in requests, whose 401s are shown on the form instead. */
export async function api(path, options) {
  const res = await request(path, options);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export const signOut = () => api('/auth/logout', { method: 'POST', signInFlow: true }).catch(() => {});

// Opened / preloaded messages, so showing one again (or one preloaded on hover) is instant.
// Loaded with ?peek=1, which doesn't mark the message read - opening it does that separately.
const messageCache = new Map();
const MESSAGE_CACHE_SIZE = 60;

export function getMessage(path) {
  if (!messageCache.has(path)) {
    const request = api(`${path}?peek=1`).catch((err) => {
      messageCache.delete(path);
      throw err;
    });
    messageCache.set(path, request);
    if (messageCache.size > MESSAGE_CACHE_SIZE) messageCache.delete(messageCache.keys().next().value);
  }
  return messageCache.get(path);
}

export const preloadMessage = (path) => getMessage(path).catch(() => {});

export async function download(path, filename) {
  const res = await request(path);
  if (!res.ok) throw new Error('Download failed');
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
