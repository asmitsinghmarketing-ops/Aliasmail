import { api } from './api.js';

const base64 = (value) => {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const hex = (value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// The hosting's bot check can answer in the bridge's place with a web page ("One moment,
// please…") and status 200: that is a failed upload, not a successful one.
const BLOCKED = 'The mail server’s security check held up the upload. Wait a minute and send again.';

async function responseJson(response) {
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Attachment upload failed (${response.status})`);
  if (!data?.ok) throw new Error(BLOCKED);
  return data;
}

// One piece of a file, sent with XMLHttpRequest because fetch can't report upload progress.
function sendPiece(url, headers, body, onBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) resolve(data);
      else if (xhr.status >= 200 && xhr.status < 300) reject(new Error(BLOCKED));
      else reject(new Error(data?.error || `Attachment upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new TypeError('Attachment upload failed: network error'));
    xhr.send(body);
  });
}

export async function uploadAttachment(file, onProgress = () => {}) {
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sendPiece(`${session.uploadUrl}?action=chunk`, headers(index), body, (sent) => onProgress(offset + sent));
        break;
      } catch (error) {
        if (attempt || !(error instanceof TypeError)) throw error; // retry a dropped connection once
      }
    }
    onProgress(offset + body.size);
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
const uploadedSoFar = new WeakMap(); // item -> bytes sent

/** Bytes of these attachments already uploaded, for the Outbox's progress bar. */
export function uploadProgress(files) {
  let loaded = 0;
  let total = 0;
  for (const item of files) {
    if (!item._file) continue;
    total += item.size || 0;
    loaded += item.uploadId ? item.size || 0 : Math.min(uploadedSoFar.get(item) || 0, item.size || 0);
  }
  return { loaded, total };
}

/** Start uploading an attached file in the background; errors surface when sending. */
export function preuploadAttachment(item) {
  if (!item._file || item.uploadId || pending.has(item)) return;
  const upload = uploadAttachment(item._file, (bytes) => uploadedSoFar.set(item, bytes));
  upload.then(() => uploadedSoFar.set(item, item.size || 0), () => uploadedSoFar.delete(item));
  pending.set(item, upload);
}

export async function uploadAttachments(files) {
  return Promise.all(files.map(async (item) => {
    if (!item._file || item.uploadId) return item;
    try {
      const done = await (pending.get(item) || uploadAttachment(item._file, (bytes) => uploadedSoFar.set(item, bytes)));
      uploadedSoFar.set(item, item.size || 0);
      return done;
    } catch (err) {
      pending.delete(item); // the next Send tries this file again
      if (!(item._file instanceof File)) throw err;
      // The direct upload didn't get through (for example the hosting's bot check answered):
      // send the file through the app instead, as attachments went before direct uploads.
      console.warn('Direct attachment upload failed, sending it through the app:', err.message);
      uploadedSoFar.set(item, item.size || 0);
      return { filename: item.filename, contentType: item.contentType, size: item.size, content: base64(await item._file.arrayBuffer()) };
    }
  }));
}
