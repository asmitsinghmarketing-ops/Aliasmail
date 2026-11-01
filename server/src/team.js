// The team: everyone who signs in to Nextspace (personal mailboxes and the admin). They can own
// conversations and send each other instant notes.
import config from './config.js';
import { db } from './store.js';
import { avatarUrl } from './avatars.js';

export function teammates() {
  const people = db().aliases
    .filter((a) => a.active !== false && (a.type || 'personal') === 'personal')
    .map((a) => ({ address: a.address, name: a.displayName || a.ownerName || '', color: a.color || null, avatarUrl: avatarUrl(a.avatar) }));
  if (config.mailbox) people.unshift({ address: config.mailbox, name: db().owner.displayName || '', color: null, avatarUrl: avatarUrl(db().owner.avatar) });
  return people;
}

/** The signed-in person's own address: their alias, or the main mailbox for the admin. */
export const personOf = (user) => (user.role === 'admin' ? config.mailbox : user.email);
