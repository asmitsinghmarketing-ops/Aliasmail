// Installing Nextspace from the /install link. Browsers only let a site offer its own Install button
// after they fire `beforeinstallprompt`, and each person has to confirm. Apple offers no such thing,
// so iPhones and iPads get steps to follow instead.
export const isInstallPage = () => window.location.pathname.replace(/\/$/, '') === '/install';

let offer = null;
let installed = false;
const watchers = new Set();
const changed = () => watchers.forEach((fn) => fn());

export const watchInstall = (fn) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};
export const canOfferInstall = () => Boolean(offer);
export const justInstalled = () => installed;

/** Show the browser's own install question. True if they said yes. */
export async function askToInstall() {
  if (!offer) return false;
  const current = offer;
  offer = null; // A browser's offer can only be used once.
  await current.prompt();
  const { outcome } = await current.userChoice;
  changed();
  return outcome === 'accepted';
}

// Only on the install page: everywhere else the browser's own install suggestions stay as they are.
if (isInstallPage()) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    offer = event;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    offer = null;
    changed();
  });
}

/** What this person is using, which decides what the install page shows them. */
export function detectDevice(userAgent, { standalone = false, touchPoints = 0 } = {}) {
  if (standalone) return 'installed';
  const ua = String(userAgent);
  // iPads running recent versions say they are Macs; only their touch screen gives them away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const android = /Android/.test(ua);
  // Links opened inside these apps run in a built-in browser, which can't install anything.
  const inApp = /; wv\)|FBAN|FBAV|FB_IAB|Instagram|Line\/|LinkedInApp|Snapchat|TikTok|musical_ly|MicroMessenger|WhatsApp|Twitter/i.test(ua);
  if (ios) return inApp || !/Safari/.test(ua) ? 'ios-in-app' : 'ios';
  if (android) return inApp ? 'android-in-app' : 'android';
  if (/Firefox\//.test(ua)) return 'desktop-firefox';
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'desktop-safari';
  return 'desktop';
}
