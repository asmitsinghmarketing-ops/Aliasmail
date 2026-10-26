import { EventEmitter } from 'node:events';

// Invalidation only; message data still goes through the authenticated API.
export const mailEvents = new EventEmitter();
mailEvents.setMaxListeners(0);
