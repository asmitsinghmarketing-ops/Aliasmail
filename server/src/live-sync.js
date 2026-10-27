// How often the mailbox is checked. While someone has AliasMail open (a live-update connection
// is listening), the INBOX is checked every LIVE_SYNC_SECONDS so new mail shows up within
// seconds; otherwise everything syncs every SYNC_INTERVAL_SECONDS. A full sync (Sent too) still
// runs at the slower pace. Repeated failures back off instead of retrying every few seconds.
import config from './config.js';
import { describeError } from './errors.js';
import { mailEvents } from './mail-events.js';
import { keepWarm, syncInbox } from './mailbox.js';

const MAX_BACKOFF_MS = 5 * 60_000;

export function createLiveSync({ sync = syncInbox, warm = keepWarm, watching = () => mailEvents.listenerCount('changed') > 0, liveMs, fullMs, log = console.warn }) {
  let timer = null;
  let dueAt = 0;
  let lastFull = 0;
  let failures = 0;
  let stopped = false;

  const delay = () => {
    const base = watching() ? liveMs : fullMs;
    return failures ? Math.min(MAX_BACKOFF_MS, Math.max(base, liveMs * 2 ** failures)) : base;
  };

  async function run() {
    timer = null;
    const full = !watching() || Date.now() - lastFull >= fullMs;
    try {
      warm();
      await sync(full ? {} : { inboxOnly: true });
      if (full) lastFull = Date.now();
      if (failures) log('[sync] working again');
      failures = 0;
    } catch (err) {
      failures++;
      // Log the first failure and then every tenth, not every few seconds.
      if (failures === 1 || failures % 10 === 0) log(`[sync] failed (${failures}x):`, describeError(err));
    }
    if (!stopped) schedule(delay());
  }

  function schedule(ms) {
    clearTimeout(timer);
    dueAt = Date.now() + ms;
    timer = setTimeout(run, ms);
  }

  return {
    start() {
      stopped = false;
      run();
    },
    /**
     * Someone just opened the app: check soon instead of waiting out a long interval. Only when
     * the next check is further off than the live pace, so reconnecting screens can't make it
     * check more often than that.
     */
    nudge() {
      if (stopped || !timer || failures || dueAt - Date.now() <= liveMs) return;
      schedule(500);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export const liveSync = createLiveSync({ liveMs: config.liveSyncMs, fullMs: config.syncIntervalMs });
