// Profile pictures, stored under random names in the data folder or the database (persist.js).
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { persistence } from './persist.js';

export const AVATAR_FILE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

const MAX_BYTES = 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
// Check the file really is the image type it claims to be.
const SIGNATURES = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

export const avatarUrl = (file) => (file ? `/api/avatars/${file}` : null);

/** Save a `data:image/...;base64,` upload; returns the stored file name. */
export async function saveAvatar(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) throw new HttpError(400, 'Upload a JPG, PNG or WebP image');
  const ext = EXTENSIONS[match[1]];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'That image is too large (max 1 MB)');
  if (!SIGNATURES[ext](bytes)) throw new HttpError(400, 'That file is not a valid image');

  const file = `${crypto.randomUUID()}.${ext}`;
  await persistence().putFile(file, match[1], bytes);
  return file;
}

/** The stored picture, or null: { type, data } */
export async function readAvatar(file) {
  if (!AVATAR_FILE.test(file)) return null;
  const stored = await persistence().getFile(file);
  return stored && { type: TYPES[file.split('.').pop()], data: stored.data };
}

export function removeAvatar(file) {
  if (file && AVATAR_FILE.test(file)) {
    persistence()
      .deleteFile(file)
      .catch((err) => console.warn('[avatars] could not delete', file, err.message));
  }
}
