import { EventEmitter } from 'node:events';

// Invalidation only; message data still goes through the authenticated API.
export const mailEvents = new EventEmitter();
mailEvents.setMaxListeners(0);

let pending = null;
/** Tell open mailboxes to refresh. Bursts (a bulk action, a sync batch) become one signal. */
export function announceChange() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    mailEvents.emit('changed');
  }, 250);
  pending.unref?.();
}
