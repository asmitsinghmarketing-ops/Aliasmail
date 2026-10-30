// Sending, shared by "send now" and scheduled send, plus the scheduled-send timer.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { accountOf } from './aliases.js';
import { sendMail } from './mailbox.js';
import { shareWithRecipients } from './google-drive.js';

const asAddresses = (list) => list.map((address) => ({ name: '', address }));

/** Send `mail` (to/cc/bcc as address arrays, base64 attachments) from `address` and log it. */
export async function deliver(address, mail) {
  const account = accountOf(address);
  if (!account) throw new Error('This account no longer exists');
  const from = { name: account.displayName || '', address };
  const attachments = (mail.attachments || []).map((a) => ({ ...a, ...(a.content && { encoding: 'base64' }) }));

  const messageId = await sendMail({ ...mail, from, attachments });

  // Shown in Sent until the copy saved to the mailbox's Sent folder is synced.
  db().sent.push({
    id: crypto.randomUUID(),
    messageId,
    from,
    to: asAddresses(mail.to),
    cc: asAddresses(mail.cc),
    bcc: asAddresses(mail.bcc),
    subject: mail.subject,
    text: mail.text,
    date: new Date().toISOString(),
    attachments: attachments.map((f, index) => ({ index, filename: f.filename, contentType: f.contentType, size: f.size || Buffer.byteLength(f.content || '', 'base64') })),
  });
  save();
  return messageId;
}

const MAX_ATTEMPTS = 4;
// Minutes to wait before each automatic retry of a message in the Outbox.
const RETRY_AFTER_MINUTES = [1, 5, 15];
let busy = false;

/**
 * Why a send failed, for the Outbox: `uncertain` when it may have gone out anyway (never retried
 * automatically, so nothing is sent twice), `permanent` when the mail server refused it (5xx, e.g.
 * "classified as SPAM", or a bad recipient), otherwise temporary and worth retrying.
 */
export function sendFailure(err) {
  const reason = String(err?.message || err || 'Sending failed');
  const uncertain = /may still have been sent/i.test(reason);
  const permanent = !uncertain && (/\b5\d\d\b/.test(reason) || (err?.status >= 400 && err?.status < 500));
  return { reason, uncertain, permanent };
}

function markFailed(item, err) {
  const { reason, uncertain, permanent } = sendFailure(err);
  item.outbox = true;
  item.attempts = (item.attempts || 0) + 1;
  item.error = reason;
  item.uncertain = uncertain;
  item.failed = uncertain || permanent || item.attempts >= MAX_ATTEMPTS;
  if (!item.failed) item.sendAt = new Date(Date.now() + RETRY_AFTER_MINUTES[Math.min(item.attempts, RETRY_AFTER_MINUTES.length) - 1] * 60_000).toISOString();
  return item;
}

/** A message that couldn't be sent right now waits in the Outbox (retried, or kept as failed). */
export function queueInOutbox(alias, mail, drive, err) {
  const item = markFailed({ id: crypto.randomUUID(), alias, sendAt: new Date().toISOString(), createdAt: new Date().toISOString(), mail, ...(drive && { drive }) }, err);
  db().scheduled.push(item);
  save();
  return item;
}

/** Send scheduled messages that are due. Failures are retried, then kept with the error. */
export async function runScheduled() {
  if (busy) return;
  busy = true;
  try {
    const due = db().scheduled.filter((s) => !s.failed && Date.parse(s.sendAt) <= Date.now());
    for (const item of due) {
      try {
        await deliver(item.alias, item.mail);
        db().scheduled = db().scheduled.filter((s) => s.id !== item.id);
        if (item.drive) {
          const { mail, drive } = item;
          void shareWithRecipients(drive.by.role, drive.by.email, drive, [...mail.to, ...mail.cc, ...mail.bcc]);
        }
      } catch (err) {
        // A scheduled message that fails moves to the Outbox too, like Gmail.
        markFailed(item, err);
        console.warn(`[outbox] ${item.id} failed (attempt ${item.attempts}${item.failed ? ', not retrying' : ''}):`, err.message);
      }
      save();
    }
  } finally {
    busy = false;
  }
}
