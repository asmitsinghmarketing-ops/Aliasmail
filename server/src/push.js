// Phone and desktop notifications (Web Push): new mail and instant notes, even when Nextspace
// isn't open. Each browser that allows notifications sends its subscription here; the server
// sends through the browser's push service (Google, Apple, Mozilla), end-to-end encrypted.
// The signing keys (VAPID) are made once and kept in the database, the private one encrypted.
import crypto from 'node:crypto';
import webpush from 'web-push';
import config from './config.js';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { seal, unseal } from './secret-box.js';
import { isVisibleTo } from './aliases.js';
import { mailEvents, noteEvents } from './mail-events.js';

const PURPOSE = 'nextspace-push-key';
const MAX_DEVICES = 10; // per person
const FRESH_MS = 30 * 60e3; // only mail that arrived in the last half hour (not an import of old mail)

// How notifications are sent; tests swap in their own.
let send = (...args) => webpush.sendNotification(...args);
export const useSender = (fn) => { send = fn; };

const state = () => {
  const p = (db().push ||= {});
  p.subscriptions ||= [];
  return p;
};

/** The signing keys, made on first use. */
function keys() {
  const p = state();
  let privateKey = p.vapid ? unseal(p.vapid.privateKey, PURPOSE) : '';
  if (!privateKey) {
    const made = webpush.generateVAPIDKeys();
    p.vapid = { publicKey: made.publicKey, privateKey: seal(made.privateKey, PURPOSE) };
    privateKey = made.privateKey;
    // Subscriptions made with old keys no longer work.
    p.subscriptions = [];
    save();
  }
  return { publicKey: p.vapid.publicKey, privateKey };
}

export const publicKey = () => keys().publicKey;

const contact = () => (config.appUrl ? config.appUrl : `mailto:${config.mailbox || 'admin@localhost'}`);

const view = (s) => ({ id: s.id, device: s.device, createdAt: s.createdAt, mail: s.mail, notes: s.notes });

/** This browser allows notifications: { subscription: { endpoint, keys: { p256dh, auth } }, device }. */
export function subscribe(person, input = {}) {
  const sub = input.subscription || {};
  const endpoint = String(sub.endpoint || '');
  const { p256dh, auth } = sub.keys || {};
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'Invalid subscription');
  }
  if (url.protocol !== 'https:' || !p256dh || !auth || String(p256dh).length > 200 || String(auth).length > 100) throw new HttpError(400, 'Invalid subscription');
  const p = state();
  // The same browser again (or now signed in as someone else): replace it.
  p.subscriptions = p.subscriptions.filter((s) => s.endpoint !== endpoint);
  const entry = {
    id: crypto.randomUUID(),
    person,
    endpoint,
    keys: { p256dh: String(p256dh), auth: String(auth) },
    device: String(input.device || 'Browser').slice(0, 80),
    createdAt: new Date().toISOString(),
    mail: input.mail !== false,
    notes: input.notes !== false,
  };
  p.subscriptions.push(entry);
  const mine = p.subscriptions.filter((s) => s.person === person);
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_DEVICES))) p.subscriptions.splice(p.subscriptions.indexOf(old), 1);
  save();
  return view(entry);
}

/** This browser stops notifications (or changes what it gets): by endpoint. */
export function unsubscribe(person, endpoint) {
  const p = state();
  p.subscriptions = p.subscriptions.filter((s) => !(s.person === person && s.endpoint === endpoint));
  save();
}

export function updateDevice(person, endpoint, prefs = {}) {
  const s = state().subscriptions.find((x) => x.person === person && x.endpoint === endpoint);
  if (!s) throw new HttpError(404, 'This device doesn’t get notifications');
  if ('mail' in prefs) s.mail = Boolean(prefs.mail);
  if ('notes' in prefs) s.notes = Boolean(prefs.notes);
  save();
  return view(s);
}

export const devicesOf = (person) => state().subscriptions.filter((s) => s.person === person).map(view);
export const deviceFor = (person, endpoint) => state().subscriptions.find((s) => s.person === person && s.endpoint === endpoint);

/** Send one notification to every device of `person` that wants this kind. */
export async function notify(person, kind, payload) {
  const targets = state().subscriptions.filter((s) => s.person === person && s[kind] !== false);
  if (!targets.length) return 0;
  const { publicKey: pub, privateKey } = keys();
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try {
      await send({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: contact(), publicKey: pub, privateKey },
        TTL: kind === 'mail' ? 6 * 3600 : 3600,
        urgency: 'high',
        topic: payload.tag?.replace(/[^\w-]/g, '').slice(0, 32) || undefined,
      });
      sent++;
    } catch (err) {
      // Gone (uninstalled, permission withdrawn): forget it. Other errors: try again next time.
      if (err.statusCode === 404 || err.statusCode === 410) {
        state().subscriptions = state().subscriptions.filter((x) => x !== s);
        save();
      } else {
        console.warn(`[push] couldn’t notify a device: ${err.statusCode || ''} ${String(err.body || err.message).slice(0, 120)}`);
      }
    }
  }));
  return sent;
}

const short = (text, n) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const senderName = (m) => m.from?.name || m.from?.address || 'Someone';

/** New mail: one notification per person and batch ("Prince Singh: Re: Proposal" or "3 new emails"). */
export function notifyNewMail(records) {
  const fresh = records.filter((r) => !r.arrivedAt || Date.now() - Date.parse(r.arrivedAt) < FRESH_MS);
  if (!fresh.length || fresh.length > 50) return; // nothing new, or a mailbox import: no flood
  const people = [...new Set(state().subscriptions.filter((s) => s.mail !== false).map((s) => s.person))];
  for (const person of people) {
    const theirs = fresh.filter((m) => isVisibleTo(m, person) && m.from?.address !== person && m.category !== 'promotions');
    if (!theirs.length) continue;
    const payload = theirs.length === 1
      ? { title: senderName(theirs[0]), body: short(theirs[0].subject || '(no subject)', 120), url: `/?message=${theirs[0].uid}`, tag: `mail-${theirs[0].uid}` }
      : { title: `${theirs.length} new emails`, body: short(theirs.slice(0, 3).map(senderName).join(', '), 120), url: '/', tag: 'mail-batch' };
    void notify(person, 'mail', { kind: 'mail', ...payload });
  }
}

let started = false;
/** Listen for new mail and instant notes (once, at startup). */
export function startPush() {
  if (started) return;
  started = true;
  mailEvents.on('arrived', notifyNewMail);
  noteEvents.on('note', (to, note) => {
    const files = note.files?.length ? `${note.files.length === 1 ? 'A file' : `${note.files.length} files`}` : '';
    const sender = note.fromName || note.from;
    for (const recipient of to.filter((a) => a !== note.from)) {
      void notify(recipient, 'notes', note.group
        ? {
          kind: 'note',
          title: note.groupName || 'Group note',
          body: short(`${sender}: ${note.text || files || 'New note'}`, 140),
          url: `/?notes=${encodeURIComponent(`group:${note.group}`)}`,
          tag: `note-group-${note.group}`,
        }
        : {
          kind: 'note',
          title: `Note from ${sender}`,
          body: short(note.text || files || 'New note', 140),
          url: `/?notes=${encodeURIComponent(note.from)}`,
          tag: `note-${note.from}`,
        });
    }
  });
}
