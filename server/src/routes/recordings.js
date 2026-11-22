// Call recordings kept by Nextspace. The recording browser mixes the call into one video and sends
// it here in pieces while recording (so closing the tab loses at most the last few seconds). The
// pieces sit beside other uploaded files (app_files in the database, or the data folder), small
// enough for shared-hosting database limits. Everyone on the team who was in the call can watch
// it; when the recorder has connected Google Drive, a copy goes to their Drive too.
//
// Recordings are deleted RECORDING_KEEP_DAYS after the meeting (15 by default), and the oldest
// first once all of them together pass RECORDING_MAX_MB.
import crypto from 'node:crypto';
import { once } from 'node:events';
import express, { Router } from 'express';
import config from '../config.js';
import { requireAuth } from '../auth.js';
import { HttpError, describeError } from '../errors.js';
import { db, save } from '../store.js';
import { persistence } from '../persist.js';
import { personOf, teammates } from '../team.js';
import { driveTokenFor } from '../google-drive.js';
import { createNotification } from '../notifications.js';
import { callWithPeer, liveCall, namesIn, teamIn } from './calls.js';

const router = Router();
router.use(requireAuth());

const MAX_PART = 6 * 1024 * 1024; // one piece; browsers send about 2 MB
const STALE_MS = 15 * 60_000; // no new piece for this long: the recording window closed or crashed
const CALL_OVER_GRACE_MS = 60_000; // after the call ends, time for the recorder's last pieces to arrive
const DRIVE_CHUNK = 8 * 1024 * 1024; // a multiple of 256 KB, as Drive's resumable upload requires
const TYPE = /^video\/(webm|mp4)(;[\w=.,\s-]*)?$/i;

const partId = (id, n) => `rec_${id}_${n}`;
const recordings = () => db().recordings;
const nameOf = (address) => teammates().find((member) => member.address === address)?.name || address;
const baseType = (rec) => rec.type.split(';')[0];
const fileName = (rec) => `call-recording-${rec.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.${baseType(rec).endsWith('mp4') ? 'mp4' : 'webm'}`;
const usedBytes = () => recordings().reduce((sum, rec) => sum + (rec.size || 0), 0);

function titleOf(rec) {
  if (rec.meetingTitle) return rec.meetingTitle;
  const others = rec.names.filter((name) => name !== nameOf(rec.recorder));
  return others.length ? `Call with ${others.join(', ')}` : `Call recorded by ${nameOf(rec.recorder)}`;
}

function view(rec, req) {
  const me = personOf(req.user);
  const mine = rec.recorder === me;
  return {
    id: rec.id,
    title: titleOf(rec),
    status: rec.status,
    type: baseType(rec),
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    size: rec.size,
    // Deleted automatically this long after the meeting (RECORDING_KEEP_DAYS).
    deletesAt: new Date(Date.parse(rec.startedAt) + config.calls.recordingKeepDays * 86_400_000).toISOString(),
    recorder: { address: rec.recorder, name: nameOf(rec.recorder) },
    people: rec.names,
    mine,
    canDelete: mine || req.user.role === 'admin',
    // The Drive copy is in the recorder's own Drive: only they can open it from here.
    drive: mine ? rec.drive : null,
  };
}

/** A recording this person may watch: they were in the call, or they're the admin. */
function visible(req) {
  const rec = recordings().find((item) => item.id === req.params.id);
  if (!rec || (req.user.role !== 'admin' && !rec.people.includes(personOf(req.user)))) throw new HttpError(404, 'Recording not found');
  return rec;
}

function recorderOnly(req) {
  const rec = recordings().find((item) => item.id === req.params.id);
  if (!rec || rec.recorder !== personOf(req.user)) throw new HttpError(404, 'Recording not found');
  return rec;
}

/** People keep joining while recording: whoever was there at any point can watch it. */
function catchUp(rec) {
  const call = liveCall(rec.callId);
  if (!call) return;
  rec.people = [...new Set([...rec.people, ...teamIn(call)])];
  rec.names = [...new Set([...rec.names, ...namesIn(call)])];
}

async function remove(rec) {
  db().recordings = recordings().filter((item) => item !== rec);
  save();
  for (let n = 0; n < rec.parts.length; n++) await persistence().deleteFile(partId(rec.id, n)).catch(() => {});
}

/** Past the age or size limit: delete the oldest finished recordings. True if `needBytes` now fits. */
async function prune({ needBytes = 0 } = {}) {
  const { recordingKeepDays, recordingMaxMb } = config.calls;
  const cutoff = Date.now() - recordingKeepDays * 86_400_000;
  const maxBytes = recordingMaxMb * 1024 * 1024;
  const oldestFirst = () => recordings().filter((rec) => rec.status === 'ready').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const rec of oldestFirst()) if (Date.parse(rec.startedAt) < cutoff) await remove(rec);
  for (const rec of oldestFirst()) {
    if (usedBytes() + needBytes <= maxBytes) break;
    await remove(rec);
  }
  return usedBytes() + needBytes <= maxBytes;
}

/** Done recording: ready to watch, the people in it told, and a copy on its way to Drive. */
function finish(rec, durationMs) {
  if (rec.status !== 'recording') return;
  if (!rec.parts.length) {
    void remove(rec);
    return;
  }
  catchUp(rec);
  rec.status = 'ready';
  rec.endedAt = new Date().toISOString();
  const measured = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
  rec.durationMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, measured + 60_000) : measured;
  save();
  for (const address of rec.people) {
    if (address !== rec.recorder) createNotification({ to: address, type: 'recording', title: `${nameOf(rec.recorder)} recorded a call`, body: `${titleOf(rec)}. Watch it in Recordings.`, actor: rec.recorder });
  }
  void copyToDrive(rec);
}

/** A copy in the recorder's Google Drive, when they've connected it (Settings → Security). */
async function copyToDrive(rec) {
  let accessToken;
  try {
    ({ accessToken } = await driveTokenFor(rec.recorderRole, rec.recorderEmail));
  } catch {
    rec.drive = { status: 'not-connected' };
    save();
    return;
  }
  rec.drive = { status: 'uploading' };
  save();
  try {
    const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': baseType(rec),
        'X-Upload-Content-Length': String(rec.size),
      },
      body: JSON.stringify({ name: fileName(rec), mimeType: baseType(rec), description: `${titleOf(rec)} (Nextspace)` }),
    });
    const location = start.ok && start.headers.get('location');
    if (!location) throw new Error(`Google Drive answered ${start.status}`);

    // In 8 MB pieces, whatever size the stored pieces are, so memory stays small.
    let sent = 0;
    let pending = Buffer.alloc(0);
    let file = null;
    const upload = async (chunk, last) => {
      const res = await fetch(location, { method: 'PUT', headers: { 'Content-Range': `bytes ${sent}-${sent + chunk.length - 1}/${last ? rec.size : '*'}` }, body: chunk });
      if (last ? !res.ok : res.status !== 308) throw new Error(`Google Drive answered ${res.status}`);
      sent += chunk.length;
      if (last) file = await res.json();
    };
    for (let n = 0; n < rec.parts.length; n++) {
      const stored = await persistence().getFile(partId(rec.id, n));
      if (!stored) throw new Error(`piece ${n} is missing`);
      pending = Buffer.concat([pending, stored.data]);
      // Never send the very end here: the last piece has to say the total size.
      while (pending.length >= DRIVE_CHUNK && sent + DRIVE_CHUNK < rec.size) {
        await upload(pending.subarray(0, DRIVE_CHUNK), false);
        pending = pending.subarray(DRIVE_CHUNK);
      }
    }
    await upload(pending, true);
    rec.drive = { status: 'saved', fileId: file.id, link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
  } catch (err) {
    console.warn('[recordings] copy to Google Drive failed:', describeError(err));
    rec.drive = { status: 'failed' };
  }
  if (recordings().includes(rec)) save();
}

/**
 * Recordings whose window closed mid-way are finished with what arrived: soon after the call is
 * over (everyone left), or after a long silence while it carries on.
 */
export function finishAbandoned(now = Date.now()) {
  for (const rec of recordings()) {
    if (rec.status !== 'recording') continue;
    const quiet = now - rec.touchedAt;
    if (quiet > STALE_MS || (quiet > CALL_OVER_GRACE_MS && !liveCall(rec.callId))) finish(rec);
  }
}

// Clean up every minute; old recordings are deleted too.
setInterval(() => {
  finishAbandoned();
  prune().catch((err) => console.warn('[recordings] clean-up failed:', describeError(err)));
}, 60_000).unref?.();

router.get('/', (req, res) => {
  const me = personOf(req.user);
  const admin = req.user.role === 'admin';
  const items = recordings()
    .filter((rec) => admin || rec.people.includes(me))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((rec) => view(rec, req));
  res.json({ items, keepDays: config.calls.recordingKeepDays });
});

/** Start keeping a recording of a call this window is in. */
router.post('/', (req, res) => {
  const me = personOf(req.user);
  const call = callWithPeer(req.body?.callId, me, req.body?.peerId);
  const type = String(req.body?.type || 'video/webm').slice(0, 100);
  if (!TYPE.test(type)) throw new HttpError(400, 'Unsupported recording format');
  const rec = {
    id: crypto.randomUUID(), callId: call.id, recorder: me, recorderRole: req.user.role, recorderEmail: req.user.email,
    meetingTitle: call.title || null, people: teamIn(call), names: namesIn(call), startedAt: new Date().toISOString(), endedAt: null, durationMs: 0,
    type, parts: [], size: 0, status: 'recording', touchedAt: Date.now(), drive: null,
  };
  recordings().push(rec);
  save();
  res.status(201).json({ id: rec.id });
});

/** One piece of the video, in order. Sending a piece again replaces it (a retry after a timeout). */
router.put('/:id/parts/:n', express.raw({ type: () => true, limit: MAX_PART }), async (req, res) => {
  const rec = recorderOnly(req);
  if (rec.status !== 'recording') throw new HttpError(409, 'This recording has already finished');
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n > rec.parts.length) throw new HttpError(400, 'Recording pieces must arrive in order');
  const data = Buffer.isBuffer(req.body) ? req.body : null;
  if (!data?.length) throw new HttpError(400, 'Empty recording piece');
  const growth = data.length - (rec.parts[n] || 0);
  if (growth > 0 && !(await prune({ needBytes: growth }))) {
    throw new HttpError(507, 'Recording storage is full. Delete old recordings, or ask your administrator to raise RECORDING_MAX_MB.');
  }
  await persistence().putFile(partId(rec.id, n), baseType(rec), data);
  rec.parts[n] = data.length;
  rec.size = rec.parts.reduce((sum, size) => sum + size, 0);
  rec.touchedAt = Date.now();
  catchUp(rec);
  save();
  res.json({ ok: true });
});

router.post('/:id/finish', (req, res) => {
  const rec = recorderOnly(req);
  finish(rec, Number(req.body?.durationMs));
  res.json(recordings().includes(rec) ? view(rec, req) : null);
});

/** Play or download. Byte ranges, so the player can jump around in long recordings. */
router.get('/:id/video', async (req, res) => {
  const rec = visible(req);
  const total = rec.size;
  let start = 0;
  let end = total - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('Range') || '');
  if (range && total && (range[1] || range[2])) {
    if (range[1] === '') start = Math.max(0, total - Number(range[2]));
    else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`);
  }
  res.set({
    'Content-Type': baseType(rec),
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${fileName(rec)}"`,
  });
  if (req.method === 'HEAD' || !total) return res.end();
  let offset = 0;
  for (let n = 0; n < rec.parts.length && offset <= end; n++) {
    const size = rec.parts[n];
    if (offset + size > start) {
      const stored = await persistence().getFile(partId(rec.id, n));
      if (!stored || res.destroyed) return res.destroy();
      const piece = stored.data.subarray(Math.max(0, start - offset), Math.min(size, end - offset + 1));
      // Wait for the viewer to take it, unless they've closed the player.
      if (!res.write(piece)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
    offset += size;
  }
  res.end();
});

router.delete('/:id', async (req, res) => {
  const rec = visible(req);
  if (rec.recorder !== personOf(req.user) && req.user.role !== 'admin') throw new HttpError(403, 'Only the person who recorded it can delete it');
  await remove(rec);
  res.json({ ok: true });
});

export default router;
