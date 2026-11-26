// A page left open (a phone tab, the home-screen app) keeps running the code it loaded. After a
// new deployment, offer a reload instead of silently running the old version.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  installNativeAppUpdate,
  installedNativeAppInfo,
  nativeAppUpdateDownloadStatus,
  nativeCallsAvailable,
  startNativeAppUpdate,
} from '../nativeCalls.js';

const CHECK_EVERY_MS = 5 * 60 * 1000;
const NATIVE_CHECK_EVERY_MS = 30 * 60 * 1000;
const DOWNLOAD_POLL_MS = 1000;
const BUNDLE = /\/assets\/index-[\w-]+\.js/;

const loadedBundle = () => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src')?.match(BUNDLE)?.[0];

const withDownload = (current, download) => ({
  ...current,
  status: download?.status === 'idle' ? 'available' : (download?.status || current.status),
  progress: Number(download?.progress || 0),
  error: download?.error || null,
});

export default function UpdateNotice() {
  const [update, setUpdate] = useState(null);

  useEffect(() => {
    if (nativeCallsAvailable()) {
      let stopped = false;
      let checking = false;
      let lastChecked = 0;
      const check = async () => {
        if (stopped || checking || document.visibilityState !== 'visible' || Date.now() - lastChecked < CHECK_EVERY_MS) return;
        checking = true;
        lastChecked = Date.now();
        try {
          const available = await api('/app/android-update');
          const candidate = {
            type: 'android',
            url: available.url,
            sha256: available.sha256,
            status: 'available',
          };
          let installed;
          try {
            installed = await installedNativeAppInfo();
          } catch {
            // One-time path for builds made before native background updating existed.
            if (!stopped && available?.url) setUpdate({ ...candidate, bootstrap: true });
            return;
          }
          if (installed?.sha256 && available?.sha256 && installed.sha256.toLowerCase() !== available.sha256.toLowerCase()) {
            let download = null;
            try {
              download = await nativeAppUpdateDownloadStatus(available.sha256);
            } catch {
              /* No saved download yet. */
            }
            if (!stopped) setUpdate(withDownload(candidate, download));
          } else if (!stopped) {
            setUpdate((current) => current?.type === 'android' ? null : current);
          }
        } catch {
          /* Offline: try again when the connection returns. */
        } finally {
          checking = false;
        }
      };
      const timer = setInterval(check, NATIVE_CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', check);
      window.addEventListener('online', check);
      check();
      return () => {
        stopped = true;
        clearInterval(timer);
        document.removeEventListener('visibilitychange', check);
        window.removeEventListener('online', check);
      };
    }
    const current = loadedBundle();
    if (!current) return undefined; // development server: nothing to compare
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const html = await (await fetch('/', { cache: 'no-store', credentials: 'same-origin' })).text();
        const live = html.match(BUNDLE)?.[0];
        if (live && live !== current) setUpdate({ type: 'web' });
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

  useEffect(() => {
    if (update?.type !== 'android' || update.bootstrap || !update.sha256 || !['starting', 'downloading', 'verifying'].includes(update.status)) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const download = await nativeAppUpdateDownloadStatus(update.sha256);
        if (!stopped) setUpdate((current) => current?.sha256 === update.sha256 ? withDownload(current, download) : current);
      } catch {
        /* DownloadManager continues in the background; poll again. */
      }
    };
    const timer = setInterval(poll, DOWNLOAD_POLL_MS);
    poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [update?.type, update?.bootstrap, update?.sha256, update?.status]);

  const startDownload = async () => {
    const selected = update;
    setUpdate((current) => ({ ...current, status: 'starting', error: null }));
    try {
      const download = await startNativeAppUpdate({
        url: new URL(selected.url, window.location.origin).href,
        sha256: selected.sha256,
      });
      setUpdate((current) => current?.sha256 === selected.sha256 ? withDownload(current, download) : current);
    } catch {
      setUpdate((current) => ({ ...current, status: 'failed', error: 'Could not start the download. Try again.' }));
    }
  };

  const installUpdate = async () => {
    setUpdate((current) => ({ ...current, installing: true, error: null }));
    try {
      const result = await installNativeAppUpdate();
      setUpdate((current) => ({
        ...current,
        installing: false,
        permissionRequired: Boolean(result?.permissionRequired),
      }));
    } catch {
      setUpdate((current) => ({ ...current, installing: false, error: 'Could not open the Android installer. Try again.' }));
    }
  };

  if (!update) return null;
  const downloading = ['starting', 'downloading', 'verifying'].includes(update.status);
  const message = update.type !== 'android'
    ? 'A new version of Nextspace is ready.'
    : update.permissionRequired
      ? 'Allow installs from Nextspace, then tap Install update again.'
      : update.status === 'verifying'
        ? 'Verifying the downloaded update?'
        : downloading
          ? `Downloading Nextspace update? ${Math.round(update.progress || 0)}%`
          : update.status === 'ready'
            ? 'The secure update is ready to install.'
            : update.error || 'A new version of Nextspace is ready.';

  return (
    <div className="update-notice" role="status" aria-live="polite">
      <span>{message}</span>
      {update.type !== 'android' ? (
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      ) : update.bootstrap ? (
        <a className="btn btn-primary" href={update.url} download="Nextspace-Android.apk">Update app</a>
      ) : update.status === 'ready' ? (
        <button type="button" className="btn btn-primary" disabled={update.installing} onClick={installUpdate}>
          {update.installing ? 'Opening?' : 'Install update'}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={downloading} onClick={startDownload}>
          {downloading ? 'Downloading?' : 'Update app'}
        </button>
      )}
    </div>
  );
}
