// In-memory store, saved to a JSON file or a database (see persist.js). Holds aliases, metadata
// caches of the INBOX and Sent folders, per-alias message state (read / starred / archived /
// trashed), drafts and app-sent mail.
import { initPersistence, persistence } from './persist.js';

const emptyFolder = () => ({ uidValidity: null, lastUid: 0, messages: {} });

const empty = () => ({
  aliases: [], // each { type: 'personal' | 'group' }; group mailboxes are opened through roles
  roles: [], // { id, name, mailboxes: [group alias ids], members: [personal alias ids] }
  inbox: emptyFolder(),
  sentBox: emptyFolder(),
  spamBox: emptyFolder(),
  owner: { displayName: '', signature: '' }, // settings of the main mailbox address (the admin)
  labels: [],
  drafts: [],
  scheduled: [],
  sent: [],
  sessions: [], // signed-in browsers
  devices: [], // browsers trusted to skip the authenticator code
  security: { requireMfa: false },
  sending: { gateway: false, gatewayReplies: false }, // outside mail through GoDaddy's Node gateway (Admin → Speed)
  audit: [], // security activity log
  sync: { lastSyncAt: null, lastError: null },
});

let data = withMessagesAlias(empty());
let timer = null;
let writing = Promise.resolve();
const written = {}; // key -> JSON last saved, so a database write only touches changed keys

// `db().messages` is shorthand for the INBOX cache. Not enumerable, so it isn't saved twice.
function withMessagesAlias(obj) {
  Object.defineProperty(obj, 'messages', { get: () => obj.inbox.messages, enumerable: false, configurable: true });
  return obj;
}

export async function load() {
  const backend = await initPersistence();
  const raw = await backend.readState();
  if (raw) {
    const { messages, ...stored } = raw;
    data = { ...empty(), ...stored, sync: { ...empty().sync, ...stored.sync } };
    // Files from before the Sent folder sync kept the INBOX cache at the top level.
    if (!stored.inbox && messages) {
      data.inbox = { uidValidity: stored.sync?.uidValidity ?? null, lastUid: stored.sync?.lastUid ?? 0, messages };
    }
    withMessagesAlias(data);
    for (const [k, v] of Object.entries(data)) written[k] = JSON.stringify(v);
  }
  return data;
}

export const db = () => data;

export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 200);
}

/** Write pending changes now. Writes run one at a time; the promise settles when this one is done. */
export function flush() {
  clearTimeout(timer);
  writing = writing.then(write).catch((err) => console.error('[store] save failed:', err.message));
  return writing;
}

async function write() {
  const changed = Object.entries(data)
    .map(([k, v]) => [k, JSON.stringify(v)])
    .filter(([k, json]) => written[k] !== json);
  if (!changed.length) return;
  await persistence().writeState(changed, data);
  for (const [k, json] of changed) written[k] = json;
}
