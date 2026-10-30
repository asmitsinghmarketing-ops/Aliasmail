import { api } from './api.js';

const base64 = (value) => {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const hex = (value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function responseJson(response) {
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Attachment upload failed (${response.status})`);
  return data;
}

export async function uploadAttachment(file) {
  if (!(file instanceof File)) throw new Error('Choose the attachment again');
  const bytes = await file.arrayBuffer();
  const [digest, keys] = await Promise.all([
    crypto.subtle.digest('SHA-256', bytes),
    crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']),
  ]);
  const publicKey = base64(await crypto.subtle.exportKey('spki', keys.publicKey));
  const session = await api('/mail/attachments/start', {
    method: 'POST',
    body: { filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, sha256: hex(digest), publicKey },
  });
  if (!session.uploadUrl?.startsWith('https://') && location.protocol === 'https:') throw new Error('Attachment upload URL must use HTTPS');
  const headers = (index) => ({ 'Content-Type': 'application/octet-stream', 'X-Upload-Id': session.uploadId, 'X-Chunk-Index': String(index) });
  for (let offset = 0, index = 0; offset < file.size; offset += session.chunkBytes, index++) {
    const body = file.slice(offset, Math.min(offset + session.chunkBytes, file.size));
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = await fetch(`${session.uploadUrl}?action=chunk`, { method: 'POST', headers: headers(index), body }); break; }
      catch (error) { if (attempt) throw error; }
    }
    await responseJson(response);
  }
  const signature = base64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(session.manifest)));
  const completed = await fetch(`${session.uploadUrl}?action=finalize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Id': session.uploadId }, body: JSON.stringify({ signature }),
  });
  await responseJson(completed);
  return { uploadId: session.uploadId, filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, _file: file };
}

// Uploads start as soon as a file is attached (like Gmail), so Send usually finds them done.
const pending = new WeakMap();

/** Start uploading an attached file in the background; errors surface when sending. */
export function preuploadAttachment(item) {
  if (!item._file || item.uploadId || pending.has(item)) return;
  const upload = uploadAttachment(item._file);
  upload.catch(() => {});
  pending.set(item, upload);
}

export async function uploadAttachments(files) {
  return Promise.all(files.map(async (item) => {
    if (!item._file || item.uploadId) return item;
    try {
      return await (pending.get(item) || uploadAttachment(item._file));
    } catch (err) {
      pending.delete(item); // the next Send tries this file again
      throw err;
    }
  }));
}
