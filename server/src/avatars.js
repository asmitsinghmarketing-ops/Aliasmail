// Profile pictures, stored as files next to the data file under random names.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { HttpError } from './errors.js';

export const AVATAR_DIR = path.join(path.dirname(config.dataFile), 'avatars');
export const AVATAR_FILE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

const MAX_BYTES = 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Check the file really is the image type it claims to be.
const SIGNATURES = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

export const avatarUrl = (file) => (file ? `/api/avatars/${file}` : null);

/** Save a `data:image/...;base64,` upload; returns the stored file name. */
export function saveAvatar(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) throw new HttpError(400, 'Upload a JPG, PNG or WebP image');
  const ext = EXTENSIONS[match[1]];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'That image is too large (max 1 MB)');
  if (!SIGNATURES[ext](bytes)) throw new HttpError(400, 'That file is not a valid image');

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const file = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), bytes);
  return file;
}

export function removeAvatar(file) {
  if (file && AVATAR_FILE.test(file)) fs.rm(path.join(AVATAR_DIR, file), { force: true }, () => {});
}
