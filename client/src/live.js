// The live connection to the server: one WebSocket (/api/live) per window, shared by everything
// that listens. It says when mail changes, carries instant notes both ways, and shares who is
// online and typing. Where a socket can't connect (some proxies block them), the Server-Sent
// Events stream (/api/mail/events) delivers mail and notes instead, and the socket keeps
// retrying in the background.
const listeners = new Set();
const pending = new Map(); // ref -> { resolve, reject, timer }
const ACK_MS = 60_000; // a note with large files can take a while to arrive
let ws = null;
let sse = null;
let retryTimer = null;
let attempts = 0;
let seq = 0;
let online = null; // addresses with Nextspace open; null while the socket is down

const emit = (message) => {
  if (message.type === 'hello') online = new Set(message.online);
  else if (message.type === 'closed') online = null;
  else if (message.type === 'presence' && online) {
    if (message.online) online.add(message.address);
    else online.delete(message.address);
  }
  listeners.forEach((fn) => fn(message));
};

/** Who is online right now (a copy), or null when unknown. */
export const onlineNow = () => (online ? new Set(online) : null);

function offline() {
  const err = new Error('Not connected');
  err.offline = true;
  return err;
}

function connect() {
  clearTimeout(retryTimer);
  if (!listeners.size || ws) return;
  let opened = false;
  let socket;
  try {
    socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/live`);
  } catch {
    startEvents();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    opened = true;
    attempts = 0;
    stopEvents();
    emit({ type: 'open', via: 'socket' });
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const waiting = message.ref && pending.get(message.ref);
    if (waiting) {
      pending.delete(message.ref);
      clearTimeout(waiting.timer);
      if (message.type === 'error') waiting.reject(new Error(message.error));
      else waiting.resolve(message);
    }
    emit(message);
  };
  socket.onclose = (event) => {
    if (ws !== socket) return; // closed on purpose and already replaced
    ws = null;
    // Already sent, so not retried another way (a note could arrive twice).
    for (const [ref, waiting] of pending) {
      pending.delete(ref);
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The connection dropped. Check whether it arrived before sending again.'));
    }
    emit({ type: 'closed' });
    if (!listeners.size || event.code === 4401) return; // nobody listening, or signed out
    // Two failed tries in a row: deliver through Server-Sent Events while the socket retries.
    if (!opened && ++attempts >= 2) startEvents();
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) * (0.75 + Math.random() / 2);
    retryTimer = setTimeout(connect, delay);
  };
}

function startEvents() {
  if (sse || !window.EventSource) return;
  sse = new EventSource('/api/mail/events');
  sse.addEventListener('open', () => emit({ type: 'open', via: 'events' }));
  sse.addEventListener('mail', () => emit({ type: 'mail' }));
  sse.addEventListener('note', (event) => emit({ type: 'note', note: JSON.parse(event.data) }));
  sse.addEventListener('note-read', (event) => emit({ type: 'note-read', ...JSON.parse(event.data) }));
  sse.addEventListener('incoming-call', (event) => emit({ type: 'incoming-call', call: JSON.parse(event.data) }));
  sse.addEventListener('call-ended', (event) => emit({ type: 'call-ended', ...JSON.parse(event.data) }));
  sse.addEventListener('call-room', (event) => emit({ type: 'call-room', call: JSON.parse(event.data) }));
  sse.addEventListener('call-signal', (event) => emit({ type: 'call-signal', ...JSON.parse(event.data) }));
  sse.addEventListener('call-desktop', (event) => emit({ type: 'call-desktop', shared: JSON.parse(event.data) }));
  sse.addEventListener('notification', (event) => emit({ type: 'notification', notification: JSON.parse(event.data) }));
}

function stopEvents() {
  sse?.close();
  sse = null;
}

/** Listen to everything that arrives. Returns a function that stops listening. */
export function subscribe(fn) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size) return;
    clearTimeout(retryTimer);
    stopEvents();
    ws?.close();
    ws = null;
  };
}

/** True while the socket itself is open (not the fallback). */
export const isLive = () => ws?.readyState === WebSocket.OPEN;

/** Send a request and wait for its answer; rejects with err.offline when it couldn't be sent. */
export function request(message) {
  if (!isLive()) return Promise.reject(offline());
  const ref = `r${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(ref);
      reject(new Error('No answer from the server. Check whether it arrived before sending again.'));
    }, ACK_MS);
    pending.set(ref, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...message, ref }));
  });
}

/** Send something that needs no answer (typing). Dropped when there is no socket. */
export function notify(message) {
  if (isLive()) ws.send(JSON.stringify(message));
}
