// How often the mailbox is checked. While someone has AliasMail open (a live-update connection
// is listening), the INBOX is checked every LIVE_SYNC_SECONDS so new mail shows up within
// seconds; otherwise everything syncs every SYNC_INTERVAL_SECONDS. A full sync (Sent too) still
// runs at the slower pace. Repeated failures back off instead of retrying every few seconds.
import config from './config.js';
import { describeError } from './errors.js';
import { mailEvents } from './mail-events.js';
import { keepWarm, syncInbox } from './mailbox.js';

const MAX_BACKOFF_MS = 5 * 60_000;
const ACTIVE_FOR_MS = 2 * 60_000;

// Someone counts as "here" while a live-update stream is open, or for two minutes after any
// mailbox request. Some hosting proxies hold the stream back, so requests alone also count.
let lastActivity = 0;
export const noteActivity = () => {
  lastActivity = Date.now();
};
const someoneHere = () => mailEvents.listenerCount('changed') > 0 || Date.now() - lastActivity < ACTIVE_FOR_MS;

export function createLiveSync({ sync = syncInbox, warm = keepWarm, watching = someoneHere, liveMs, fullMs, log = console.warn }) {
  let timer = null;
  let dueAt = 0;
  let lastFull = 0;
  let lastCheck = 0;
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
      lastCheck = Date.now();
      if (full) lastFull = lastCheck;
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
    /** For the admin overview: how fresh the mailbox copy is and how often it's checked. */
    status() {
      return {
        running: Boolean(timer) && !stopped,
        live: watching(),
        everySeconds: Math.round(delay() / 1000),
        lastCheckAt: lastCheck ? new Date(lastCheck).toISOString() : null,
        failing: failures > 0,
      };
    },
  };
}

export const liveSync = createLiveSync({ liveMs: config.liveSyncMs, fullMs: config.syncIntervalMs });
