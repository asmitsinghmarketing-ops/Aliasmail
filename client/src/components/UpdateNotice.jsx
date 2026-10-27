// A page left open (a phone tab, the home-screen app) keeps running the code it loaded. After a
// new deployment, offer a reload instead of silently running the old version.
import { useEffect, useState } from 'react';

const CHECK_EVERY_MS = 5 * 60 * 1000;
const BUNDLE = /\/assets\/index-[\w-]+\.js/;

const loadedBundle = () => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src')?.match(BUNDLE)?.[0];

export default function UpdateNotice() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const current = loadedBundle();
    if (!current) return undefined; // development server: nothing to compare
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const html = await (await fetch('/', { cache: 'no-store', credentials: 'same-origin' })).text();
        const live = html.match(BUNDLE)?.[0];
        if (live && live !== current) setReady(true);
      } catch {
        /* offline: try again later */
      }
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    check();
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, []);

  if (!ready) return null;
  return (
    <div className="update-notice" role="status">
      <span>A new version of AliasMail is ready.</span>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
