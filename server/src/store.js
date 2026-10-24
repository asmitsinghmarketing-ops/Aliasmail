// Tiny JSON-file store. Holds aliases, metadata caches of the INBOX and Sent folders,
// per-alias message state (read / starred / archived / trashed), drafts and app-sent mail.
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const emptyFolder = () => ({ uidValidity: null, lastUid: 0, messages: {} });

const empty = () => ({
  aliases: [],
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
  audit: [], // security activity log
  sync: { lastSyncAt: null, lastError: null },
});

let data = withMessagesAlias(empty());
let timer = null;

// `db().messages` is shorthand for the INBOX cache. Not enumerable, so it isn't saved twice.
function withMessagesAlias(obj) {
  Object.defineProperty(obj, 'messages', { get: () => obj.inbox.messages, enumerable: false, configurable: true });
  return obj;
}

export function load() {
  try {
    const { messages, ...stored } = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    data = { ...empty(), ...stored, sync: { ...empty().sync, ...stored.sync } };
    // Files from before the Sent folder sync kept the INBOX cache at the top level.
    if (!stored.inbox && messages) {
      data.inbox = { uidValidity: stored.sync?.uidValidity ?? null, lastUid: stored.sync?.lastUid ?? 0, messages };
    }
    withMessagesAlias(data);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return data;
}

export const db = () => data;

export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 200);
}

export function flush() {
  clearTimeout(timer);
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const tmp = `${config.dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, config.dataFile);
}
