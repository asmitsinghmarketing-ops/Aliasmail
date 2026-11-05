import { EventEmitter } from 'node:events';

// Invalidation only; message data still goes through the authenticated API.
export const mailEvents = new EventEmitter();
mailEvents.setMaxListeners(0);

// Instant notes: emitted as (addresses, payload); each open window passes on the ones for its person.
export const noteEvents = new EventEmitter();
noteEvents.setMaxListeners(0);

// In-app notifications: emitted as (recipient, notification) for open windows.
export const notificationEvents = new EventEmitter();
notificationEvents.setMaxListeners(0);

// Instant team calls: emitted as (recipient, payload) for open windows.
export const callEvents = new EventEmitter();
callEvents.setMaxListeners(0);

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
