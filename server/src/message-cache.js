import crypto from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import config from './config.js';
import { persistence } from './persist.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

// Raw MIME preserves attachments and parser behavior across restarts. It is
// compressed, encrypted, and kept outside the public/static file directories.
export function createMessageCache(settings, backend = persistence) {
  const encryptionKey = crypto.createHash('sha256').update('aliasmail-message-cache\0' + settings.jwtSecret).digest();
  const pending = new Map();
  let pruneAt = 0;
  const limits = settings.messageCache || { enabled: true, maxBytes: 250 * 1024 * 1024, maxAgeMs: 30 * 86400_000 };

  const idFor = ({ folder, uidValidity, uid }) => {
    if (!uidValidity || !Number.isSafeInteger(Number(uid)) || Number(uid) < 1) return null;
    return crypto.createHash('sha256').update(JSON.stringify([
      settings.imap.host, settings.imap.port, settings.mailbox, folder, String(uidValidity), Number(uid),
    ])).digest('hex');
  };

  return {
    async get(identity) {
      const id = idFor(identity);
      if (!limits.enabled || !id) return null;
      try {
        await pending.get(id);
        const stored = await backend().getMessage(id, limits);
        if (!stored) return null;
        if (stored.length < 29 || stored[0] !== 1) throw new Error('Invalid cache entry');
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, stored.subarray(1, 13));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(stored.subarray(13, 29));
        const zipped = Buffer.concat([decipher.update(stored.subarray(29)), decipher.final()]);
        return await decompress(zipped, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        console.warn('[mail-cache] Cached message unavailable:', error.code || error.name);
        await backend().deleteMessage(id).catch(() => {});
        return null;
      }
    },
    put(identity, source) {
      const id = idFor(identity);
      if (!limits.enabled || !id || source.length > MAX_ENTRY_BYTES) return Promise.resolve();
      if (pending.has(id)) return pending.get(id);
      const job = (async () => {
        const zipped = await compress(source);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(Buffer.from(id));
        const encrypted = Buffer.concat([cipher.update(zipped), cipher.final()]);
        await backend().putMessage(id, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]));
        if (Date.now() >= pruneAt) {
          pruneAt = Date.now() + 60_000;
          await backend().pruneMessages(limits);
        }
      })().catch((error) => {
        console.warn('[mail-cache] Could not persist message:', error.code || error.name);
      }).finally(() => pending.delete(id));
      pending.set(id, job);
      return job;
    },
    async remove(identity) {
      const id = idFor(identity);
      if (!id) return;
      await pending.get(id);
      await backend().deleteMessage(id).catch((error) => console.warn('[mail-cache] Could not remove message:', error.code || error.name));
    },
    async drain() { await Promise.allSettled([...pending.values()]); },
  };
}

export const messageCache = createMessageCache(config);
