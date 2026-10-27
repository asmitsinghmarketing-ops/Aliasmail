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
  const attachments = (mail.attachments || []).map((a) => ({ ...a, encoding: 'base64' }));

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
    attachments: attachments.map((f, index) => ({ index, filename: f.filename, contentType: f.contentType, size: Buffer.byteLength(f.content, 'base64') })),
  });
  save();
  return messageId;
}

const MAX_ATTEMPTS = 3;
let busy = false;

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
        item.attempts = (item.attempts || 0) + 1;
        item.error = err.message;
        if (item.attempts >= MAX_ATTEMPTS) item.failed = true;
        console.warn(`[scheduled] ${item.id} failed (attempt ${item.attempts}):`, err.message);
      }
      save();
    }
  } finally {
    busy = false;
  }
}
