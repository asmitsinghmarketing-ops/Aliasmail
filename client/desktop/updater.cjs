'use strict';

// Background updates for the Windows shell. The page itself always loads the live site, so UI
// changes arrive without this; this keeps the native shell (calls, tray, notifications) current.
// The server publishes the newest installer's version and SHA-256 (written by
// scripts/release-desktop.mjs). A newer build is downloaded quietly, verified, then installed after
// the user agrees, and Nextspace restarts by itself.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, dialog, net } = require('electron');

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 3600_000;

/** True when version `a` (e.g. "1.2.0") is newer than `b`. */
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function startUpdater({ appUrl, getWindow, beforeInstall }) {
  let checking = false;
  let declined = null; // the version the user said "Later" to in this run
  let ready = null; // { version, file }

  async function download(manifest) {
    const file = path.join(app.getPath('temp'), `Nextspace-Update-${manifest.version}.exe`);
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === manifest.sha256) return file;
    const res = await net.fetch(new URL(manifest.url, appUrl).toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    if (sha256(data) !== String(manifest.sha256).toLowerCase()) throw new Error('downloaded installer failed its checksum');
    await fs.promises.writeFile(file, data);
    return file;
  }

  async function message(options) {
    const parent = getWindow();
    return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  async function offer(interactive = false) {
    if (!ready || (declined === ready.version && !interactive)) return;
    const options = {
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Nextspace update',
      message: `Nextspace ${ready.version} is ready to install.`,
      detail: 'Nextspace will close for a moment, update, and open again.',
    };
    const { response } = await message(options);
    if (response !== 0) {
      declined = ready.version;
      return;
    }
    beforeInstall();
    // Silent NSIS install into the existing folder; --force-run reopens Nextspace afterwards.
    spawn(ready.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }

  /**
   * Look for a newer build. `interactive` (the tray menu or Settings asked) also says when there is
   * nothing new or the check failed. Returns 'available' | 'current' | 'busy' | 'error' | 'dev'.
   */
  async function check({ interactive = false } = {}) {
    if (!app.isPackaged) {
      if (interactive) await message({ type: 'info', title: 'Nextspace', message: 'Updates are checked only in the installed app.' });
      return 'dev';
    }
    if (checking) return 'busy';
    checking = true;
    try {
      const res = await net.fetch(new URL('/api/app/desktop-update', appUrl).toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`the update server answered ${res.status}`);
      const manifest = await res.json();
      if (!manifest?.version || !manifest.sha256 || !manifest.url || !isNewer(manifest.version, app.getVersion())) {
        if (interactive) await message({ type: 'info', title: 'Nextspace', message: 'Nextspace is up to date.', detail: `You have version ${app.getVersion()}.` });
        return 'current';
      }
      if (ready?.version !== manifest.version) ready = { version: manifest.version, file: await download(manifest) };
      checking = false;
      await offer(interactive);
      return 'available';
    } catch (err) {
      console.warn(`[updater] ${err.message}`);
      if (interactive) await message({ type: 'warning', title: 'Nextspace', message: 'Couldn’t check for updates.', detail: `${err.message}. Check your connection and try again.` });
      return 'error';
    } finally {
      checking = false;
    }
  }

  if (app.isPackaged) {
    setTimeout(() => check(), FIRST_CHECK_MS);
    setInterval(() => check(), CHECK_EVERY_MS).unref?.();
  }
  return { check };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { startUpdater, isNewer };
