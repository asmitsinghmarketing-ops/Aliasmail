// Encrypts secrets kept in the database (AI keys, the notification signing key) with a key
// derived from the app's secret (JWT_SECRET). AES-256-GCM: a changed value can't be read back.
import crypto from 'node:crypto';
import config from './config.js';

const keyFor = (purpose) => crypto.createHash('sha256').update(`${purpose}:${config.jwtSecret}`).digest();

/** Encrypt `text` for `purpose` (each purpose gets its own key). */
export function seal(text, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** The text back, or '' when it can't be read (e.g. the app's secret changed). */
export function unseal(sealed, purpose) {
  try {
    const [version, iv, tag, data] = String(sealed).split(':');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
