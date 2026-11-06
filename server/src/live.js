// The live WebSocket (/api/live): one connection per open Nextspace window. It tells the window
// when mail changes, carries instant notes both ways, and shares who is online and typing.
// Windows that can't open a socket use the Server-Sent Events stream (/api/mail/events) instead.
import { WebSocketServer } from 'ws';
import config from './config.js';
import { currentSession, endSessions } from './sessions.js';
import { findAlias, typeOf } from './aliases.js';
import { callEvents, mailEvents, noteEvents, notificationEvents } from './mail-events.js';
import { personOf, teammates } from './team.js';
import { createNote, groups, markGroupRead, markNotesRead } from './instant-notes.js';
import { describeError } from './errors.js';

const PATH = '/api/live';
const MAX_PAYLOAD = 72 * 1024 * 1024; // a note with five 10 MB files, base64
const HEARTBEAT_MS = 25_000; // under the CDN's idle timeout
const RECHECK_MS = 60_000; // a signed-out or disabled account is dropped within a minute
const FLOOD = { messages: 60, perMs: 10_000 };

const sockets = new Map(); // address -> Set of open sockets

/** Everyone with Nextspace open right now. */
export const onlinePeople = () => new Set([...sockets.keys()]);

/** The signed-in person behind an upgrade request, checked like requireAuth(); null if none. */
function userOf(req) {
  const session = currentSession(req);
  if (!session) return null;
  if (session.role === 'user') {
    const account = findAlias(session.email);
    if (!account?.active || typeOf(account) === 'group') {
      endSessions((s) => s.id === session.id);
      return null;
    }
  }
  if (config.multiTenant && session.organizationId !== config.organizationId) return null;
  return { role: session.role, email: session.email, organizationId: session.organizationId || null };
}

// Only Nextspace's own pages may open a socket (a browser sends cookies to any site's socket).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const allowed = [req.headers.host, forwarded, config.appUrl && new URL(config.appUrl).host].filter(Boolean);
  return allowed.includes(host);
}

const send = (ws, message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
const sendTo = (address, message) => sockets.get(address)?.forEach((ws) => send(ws, message));
const broadcast = (message) => sockets.forEach((set) => set.forEach((ws) => send(ws, message)));

function join(ws, who) {
  const first = !sockets.has(who);
  if (first) sockets.set(who, new Set());
  sockets.get(who).add(ws);
  if (first) broadcast({ type: 'presence', address: who, online: true });
}

function leave(ws, who) {
  const set = sockets.get(who);
  if (!set) return;
  set.delete(ws);
  if (!set.size) {
    sockets.delete(who);
    broadcast({ type: 'presence', address: who, online: false });
  }
}

/** Answer upgrade requests on /api/live; everything else on the server is left alone. */
export function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== PATH) return socket.destroy();
    const user = sameOrigin(req) ? userOf(req) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });

  wss.on('connection', (ws, req, user) => {
    const who = personOf(user);
    join(ws, who);
    send(ws, { type: 'hello', me: who, online: [...sockets.keys()] });

    const onMail = () => send(ws, { type: 'mail' });
    const onNote = (to, note) => to.includes(who) && send(ws, { type: 'note', note });
    const onNoteRead = (to, payload) => to.includes(who) && send(ws, { type: 'note-read', ...payload });
    mailEvents.on('changed', onMail);
    noteEvents.on('note', onNote);
    noteEvents.on('note-read', onNoteRead);
    // A group made, renamed, joined or left: its members' lists change.
    const onGroup = (to, payload) => to.includes(who) && send(ws, { type: 'group', ...payload });
    noteEvents.on('group', onGroup);
    const onNotification = (to, notification) => to === who && send(ws, { type: 'notification', notification });
    notificationEvents.on('notification', onNotification);
    const onCall = (to, call) => to === who && send(ws, { type: 'incoming-call', call });
    const onCallResponse = (to, response) => to === who && send(ws, { type: 'call-response', ...response });
    const onCallEnded = (to, response) => to === who && send(ws, { type: 'call-ended', ...response });
    callEvents.on('call', onCall);
    callEvents.on('response', onCallResponse);
    callEvents.on('ended', onCallEnded);

    // Heartbeat: a socket that stops answering pings is closed (the browser reconnects).
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    // Sessions end (sign-out, disabled account): close the socket too.
    const recheck = setInterval(() => {
      if (!userOf(req)) ws.close(4401, 'Signed out');
    }, RECHECK_MS);

    let window = { start: Date.now(), count: 0 };
    ws.on('message', async (raw) => {
      if (Date.now() - window.start > FLOOD.perMs) window = { start: Date.now(), count: 0 };
      if (++window.count > FLOOD.messages) return ws.close(4429, 'Too many messages');
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const ref = message?.ref;
      try {
        if (message.type === 'note') {
          send(ws, { type: 'sent', ref, note: await createNote(who, message) });
        } else if (message.type === 'read') {
          send(ws, { type: 'done', ref, changed: message.group ? markGroupRead(who, String(message.group)) : markNotesRead(who, message.with) });
        } else if (message.type === 'typing') {
          // Passed straight on: to a teammate, or to the rest of a group I'm in.
          if (message.group) {
            const group = groups().find((g) => g.id === String(message.group) && g.members.includes(who));
            for (const member of group?.members || []) if (member !== who) sendTo(member, { type: 'typing', from: who, group: group.id });
          } else {
            const to = String(message.to || '').toLowerCase();
            if (to !== who && teammates().some((p) => p.address === to)) sendTo(to, { type: 'typing', from: who });
          }
        }
      } catch (err) {
        if (ref) send(ws, { type: 'error', ref, error: err.status ? err.message : describeError(err) });
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(recheck);
      mailEvents.off('changed', onMail);
      noteEvents.off('note', onNote);
      noteEvents.off('note-read', onNoteRead);
      noteEvents.off('group', onGroup);
      notificationEvents.off('notification', onNotification);
      callEvents.off('call', onCall);
      callEvents.off('response', onCallResponse);
      callEvents.off('ended', onCallEnded);
      leave(ws, who);
    });
  });
  return wss;
}
