// Nextspace notifications and offline app shell. Private API responses are never cached.
const SHELL_CACHE = 'nextspace-shell-v3';
const ASSET_LIMIT = 80;
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))));
  event.waitUntil(self.clients.claim());
});

// Built files have a hash in their name, so each release adds new ones: keep the newest only.
async function keepAsset(request, response) {
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(request, response);
  const assets = (await cache.keys()).filter((key) => new URL(key.url).pathname.startsWith('/assets/'));
  await Promise.all(assets.slice(0, -ASSET_LIMIT).map((key) => cache.delete(key)));
}

async function keepShellFile(key, response) {
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(key, response);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: the network first. Only the app's own page may become the offline copy, never another
  // page such as /privacy.html, and never an error.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && url.pathname === '/') event.waitUntil(keepShellFile('/', response.clone()));
      return response;
    }).catch(() => caches.match('/')));
    return;
  }

  // Built files never change, so a cached copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) event.waitUntil(keepAsset(request, response.clone()));
      return response;
    })));
    return;
  }

  // Everything else keeps its name when it changes (the manifest, icons): the network first.
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && SHELL_ASSETS.includes(url.pathname)) event.waitUntil(keepShellFile(url.pathname, response.clone()));
    return response;
  }).catch(() => caches.match(request)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Nextspace', body: event.data?.text() || '' };
  }
  event.waitUntil((async () => {
    // Nextspace is open and in front: it shows its own pop-up, so don't ring twice.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!['test', 'call'].includes(data.kind) && windows.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'Nextspace', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/', callId: data.callId || null },
      requireInteraction: data.kind === 'call',
      silent: false,
      actions: data.kind === 'call' ? [
        { action: 'accept-call', title: 'Accept' },
        { action: 'decline-call', title: 'Decline' },
      ] : [],
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  const callId = event.notification.data?.callId;
  event.waitUntil((async () => {
    if (callId && ['accept-call', 'decline-call'].includes(event.action)) {
      try {
        const answer = event.action === 'accept-call' ? 'accept' : 'decline';
        const response = await fetch(`/api/calls/${encodeURIComponent(callId)}/respond`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
          body: JSON.stringify({ answer }),
        });
        if (!response.ok) throw new Error('Call has ended');
        const call = await response.json();
        if (answer === 'accept') await self.clients.openWindow(call.link);
        return;
      } catch {
        // The session may have expired or the call may have ended. Open AliasMail so the person
        // gets the current state instead of silently losing their click.
      }
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
