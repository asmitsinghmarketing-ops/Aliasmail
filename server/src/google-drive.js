// Google Drive for "Insert from Drive": short-lived access tokens from the stored (encrypted)
// refresh token, and sharing picked files with an email's recipients. Drive access is limited
// to files the person picked with AliasMail (drive.file scope).
import { findAlias } from './aliases.js';
import { HttpError } from './errors.js';
import { refreshAccess, shareDriveFile } from './google-auth.js';
import { unseal } from './security.js';
import { db, save } from './store.js';

export const driveAccess = new Map(); // "role:email" -> { accessToken, expiresAt }
const holderOf = (role, email) => (role === 'admin' ? db().owner : findAlias(email));

/** A usable access token for this account's Drive: { accessToken, expiresAt }. */
export async function driveTokenFor(role, email) {
  const key = `${role}:${email}`;
  const hit = driveAccess.get(key);
  if (hit && hit.expiresAt - Date.now() > 60_000) return hit;
  const holder = holderOf(role, email);
  const drive = holder?.google?.drive;
  if (!drive) throw new HttpError(409, 'Connect Google Drive first, in Settings → Security.');
  let fresh;
  try {
    fresh = await refreshAccess(unseal(drive.refresh));
  } catch (err) {
    // Removed from the Google account's "third-party access": forget the dead token.
    if (err.revoked) {
      delete holder.google.drive;
      save();
    }
    throw err;
  }
  driveAccess.set(key, fresh);
  return fresh;
}

export const DRIVE_ACCESS = { view: 'reader', comment: 'commenter', edit: 'writer' };
const FILE_ID = /^[\w-]{10,200}$/;

/** Checked { files: [{ id, name, url }], access } from a send request, or null. */
export function readDriveRequest(input) {
  if (!input || !Array.isArray(input.files) || !input.files.length) return null;
  const files = input.files.slice(0, 20).filter((f) => FILE_ID.test(String(f?.id || ''))).map((f) => ({
    id: String(f.id),
    name: String(f.name || 'Drive file').slice(0, 200),
  }));
  if (!files.length) return null;
  return { files, access: DRIVE_ACCESS[input.access] ? input.access : 'none' };
}

/** Share files with every recipient. Never throws: returns { shared, failed: [{ file, to, reason }] }. */
export async function shareWithRecipients(role, email, drive, recipients) {
  if (!drive || drive.access === 'none' || !recipients.length) return { shared: 0, failed: [] };
  let accessToken;
  try {
    ({ accessToken } = await driveTokenFor(role, email));
  } catch (err) {
    return { shared: 0, failed: drive.files.map((f) => ({ file: f.name, to: 'everyone', reason: err.message })) };
  }
  const failed = [];
  let shared = 0;
  for (const file of drive.files) {
    for (const to of recipients) {
      try {
        await shareDriveFile(accessToken, file.id, to, DRIVE_ACCESS[drive.access]);
        shared++;
      } catch (err) {
        failed.push({ file: file.name, to, reason: err.message });
      }
    }
  }
  if (failed.length) console.warn(`[drive] ${failed.length} share(s) failed for ${email}`);
  return { shared, failed };
}
