// The sign-in lives in an httpOnly cookie the page can't read, so nothing secret is kept in
// browser storage. Every request carries X-Requested-With, which the server requires for
// changes (another website can't add it, which stops cross-site request forgery).
export const LOGOUT_EVENT = 'aliasmail:logout';
export const MAILBOX_REVOKED_EVENT = 'aliasmail:mailbox-revoked';
const mailboxLists = new Map();
let accountEpoch = 0;
export const cachedMailboxList = (path) => mailboxLists.get(path) || null;
export function clearMailCaches() {
  accountEpoch++;
  mailboxLists.clear();
  messageCache.clear();
}
window.addEventListener(LOGOUT_EVENT, () => setActiveMailbox(null));

// A shared (group) mailbox opened through the switcher; null = the account's own mailbox.
// The server checks the account's roles on every request.
let activeMailbox = null;
export function setActiveMailbox(address) {
  activeMailbox = address || null;
  clearMailCaches();
}

// After the device sleeps or the host wakes the app up, the first requests can hit a network
// that isn't back yet, or the host's proxy answering 502-504. Reads retry after a short wait;
// changes (send, delete, ...) never retry, because the first attempt may have gone through.
const RETRY_DELAYS = [600, 2000];
const RETRY_STATUS = new Set([502, 503, 504]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { method = 'GET', body, signInFlow = false } = {}) {
  const headers = { 'X-Requested-With': 'AliasMail' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (activeMailbox && path.startsWith('/mail/')) headers['X-Mailbox'] = activeMailbox;
  const send = () =>
    fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const retries = method === 'GET' ? RETRY_DELAYS : [];
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await send();
      if (!RETRY_STATUS.has(res.status) || attempt >= retries.length) break;
    } catch (err) {
      if (attempt >= retries.length) {
        const offline = new Error(navigator.onLine === false ? 'You’re offline. AliasMail will catch up when you’re back online.' : 'Couldn’t reach AliasMail. Check your connection and try again.');
        offline.network = true;
        throw offline;
      }
    }
    await wait(retries[attempt]);
  }
  // Signed out elsewhere, expired, or idle too long: go back to the sign-in page.
  if (res.status === 401 && !signInFlow) window.dispatchEvent(new Event(LOGOUT_EVENT));
  return res;
}

/** `signInFlow: true` for sign-in requests, whose 401s are shown on the form instead. */
export async function api(path, options) {
  const epoch = accountEpoch;
  const res = await request(path, options);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (options?.signInFlow && res.ok) clearMailCaches();
  if (!res.ok) {
    const fallback = RETRY_STATUS.has(res.status) ? 'AliasMail is waking up. Try again in a moment.' : `Request failed (${res.status})`;
    const error = new Error(data?.error || fallback);
    error.status = res.status;
    // The role giving access to this shared mailbox was removed: go back to the own mailbox.
    if (res.status === 403 && activeMailbox && path.startsWith('/mail/') && /access to that mailbox/.test(error.message)) {
      window.dispatchEvent(new Event(MAILBOX_REVOKED_EVENT));
    }
    throw error;
  }
  if (epoch === accountEpoch && (!options?.method || options.method === 'GET') && path.startsWith('/mail/messages?')) {
    mailboxLists.delete(path);
    mailboxLists.set(path, data);
    if (mailboxLists.size > 30) mailboxLists.delete(mailboxLists.keys().next().value);
  } else if (options?.method && options.method !== 'GET') {
    mailboxLists.clear();
  }
  return data;
}

export const signOut = () => {
  clearMailCaches();
  return api('/auth/logout', { method: 'POST', signInFlow: true }).catch(() => {});
};

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

// Files that can be looked at in a new tab, by extension. Only types a browser shows without
// running anything: never HTML or SVG, which could run scripts as this site.
const PREVIEW_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/plain', log: 'text/plain' };
export const previewType = (filename) => PREVIEW_TYPES[String(filename).split('.').pop().toLowerCase()] || null;

// Large attachments come straight from the mail bridge through a short-lived link (no detour
// through the app, and the browser shows its own download progress). Null: fetch it here.
async function directLink(path) {
  try {
    const res = await request(`${path}/link`);
    if (!res.ok) return null;
    const url = (await res.json()).url;
    if (!url) return null;
    // The hosting's bot check ("One moment, please…") can answer in the bridge's place; then the
    // file comes through the app instead, slower but without the wait.
    const check = await fetch(`${url}&check=1`, { signal: AbortSignal.timeout(4000) });
    return check.ok && (await check.json().catch(() => null))?.ok ? url : null;
  } catch {
    return null;
  }
}

/** Open an attachment in a new tab (PDF, image, text) instead of downloading it. */
export async function preview(path, filename) {
  const type = previewType(filename);
  if (!type) return download(path, filename);
  // Opened now, inside the click, so it isn't blocked as a pop-up; filled once the file is here.
  const tab = window.open('', '_blank');
  try {
    const link = await directLink(path);
    if (link) {
      if (tab) tab.location.href = `${link}&inline=1`;
      else window.location.assign(`${link}&inline=1`);
      return;
    }
    const res = await request(path);
    if (!res.ok) throw new Error('Couldn’t open the attachment');
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export async function download(path, filename) {
  const link = await directLink(path);
  if (link) {
    // A normal browser download (Content-Disposition: attachment), with its own progress bar. In a
    // new tab, so a page shown instead (e.g. the hosting's bot check) never replaces AliasMail;
    // the browser closes the tab again once the download starts.
    Object.assign(document.createElement('a'), { href: link, rel: 'noreferrer', target: '_blank' }).click();
    return;
  }
  const res = await request(path);
  if (!res.ok) throw new Error('Download failed');
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
