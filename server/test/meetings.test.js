import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// Meeting links (teammates straight in, guests through a lobby) and recordings kept by the app.
const PORT = 9500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };
const PEOPLE = ['john', 'mary', 'omar'];

let server;
let dir;
const cookies = {};
const closers = [];

const call = (who, p, body, method) => fetch(`${BASE}/api${p}`, {
  method: method || (body === undefined ? 'GET' : 'POST'),
  headers: { ...HEADERS, ...(who && { Cookie: cookies[who] }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (who, p, body) => (await call(who, p, body)).json();
const guestCall = (code, guest, p, body) => fetch(`${BASE}/api/meet/${code}${p}`, {
  method: 'POST',
  headers: { ...HEADERS, 'X-Guest-Id': guest.guestId, 'X-Guest-Token': guest.token },
  body: JSON.stringify(body || {}),
});

function listen(who) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/live`, { headers: { Cookie: cookies[who], Origin: BASE } });
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw)));
  closers.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ got }));
    ws.on('error', reject);
  });
}

/** A guest's event stream, collected as it arrives. */
async function guestStream(code, guest) {
  const controller = new AbortController();
  closers.push(() => controller.abort());
  const res = await fetch(`${BASE}/api/meet/${code}/events?guest=${guest.guestId}&token=${encodeURIComponent(guest.token)}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const got = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
          if (data) got.push(JSON.parse(data));
        }
      }
    } catch { /* closed */ }
  })();
  return { got };
}

async function waitFor(got, match, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = got.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out; got: ${JSON.stringify(got.map((m) => m.type + (m.status ? `:${m.status}` : '')))}`);
}

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-meetings-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'meetings-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: '', MAIL_BRIDGE_TOKEN: '', MAIL_TRANSPORT: 'direct',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = async (credentials) => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: HEADERS, body: JSON.stringify(credentials) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  cookies.admin = await login(ADMIN);
  for (const name of PEOPLE) {
    const made = await call('admin', '/admin/aliases', { address: `${name}@example.com`, displayName: name, password: 'long-password-123' });
    assert.equal(made.status, 201);
    cookies[name] = await login({ email: `${name}@example.com`, password: 'long-password-123' });
  }
});

test.after(async () => {
  closers.forEach((close) => close());
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a meeting link: teammates join straight in, guests wait until someone lets them in', async () => {
  const john = await listen('john');
  const started = await json('john', '/calls', { to: [], video: true, meeting: true });
  const { code } = started.call;
  assert.match(code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal(started.call.status, 'active');

  // The join page learns whose meeting it is, nothing more.
  const page = await (await fetch(`${BASE}/api/meet/${code}`)).json();
  assert.deepEqual(page, { code, hostName: 'john', video: true, title: null, started: true });
  assert.equal((await fetch(`${BASE}/api/meet/aaa-bbbb-ccc`)).status, 404);

  // A guest knocks: John sees them waiting; they are not in the call yet.
  const knock = await fetch(`${BASE}/api/meet/${code}/knock`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: '  Priya   Shah ' }) });
  assert.equal(knock.status, 201);
  const priya = await knock.json();
  const priyaEvents = await guestStream(code, priya);
  await waitFor(priyaEvents.got, (m) => m.type === 'lobby' && m.status === 'waiting');
  const waiting = await waitFor(john.got, (m) => m.type === 'call-room' && m.call.lobby.length === 1);
  assert.equal(waiting.call.lobby[0].name, 'Priya Shah');
  assert.equal((await guestCall(code, priya, '/state', { muted: true })).status, 404);
  // A wrong token gets nowhere.
  assert.equal((await guestCall(code, { ...priya, token: 'nope' }, '/leave')).status, 200);
  assert.equal((await fetch(`${BASE}/api/meet/${code}/events?guest=${priya.guestId}&token=nope`)).status, 404);
  assert.equal((await call('omar', `/calls/${started.call.id}/admit`, { peerId: 'x', guestId: priya.guestId, allow: true })).status, 404);

  // Mary has the link: straight in, no lobby.
  const mary = await json('mary', `/calls/code/${code}/join`, {});
  assert.equal(mary.call.peers.length, 2);

  // Mary lets Priya in. Priya gets her place in the call and connection details.
  const let_in = await call('mary', `/calls/${started.call.id}/admit`, { peerId: mary.peerId, guestId: priya.guestId, allow: true });
  assert.equal(let_in.status, 200);
  const admitted = await waitFor(priyaEvents.got, (m) => m.type === 'lobby' && m.status === 'admitted');
  assert.ok(admitted.peerId);
  assert.ok(admitted.iceServers.length);
  // A guest sees people by name only: no addresses, no lobby, nobody else rung.
  assert.deepEqual(admitted.call.peers.map((peer) => peer.address).filter(Boolean), [`guest:${priya.guestId}`]);
  assert.deepEqual([admitted.call.invited, admitted.call.lobby, admitted.call.from], [[], [], '']);
  assert.ok(!JSON.stringify(admitted).includes('example.com'));

  // Priya talks to John's window through the server, and can't claim to be recording.
  const sent = await guestCall(code, priya, '/signal', { to: started.peerId, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.equal(sent.status, 204);
  const signal = await waitFor(john.got, (m) => m.type === 'call-signal' && m.from === admitted.peerId);
  assert.equal(signal.data.description.sdp, 'x');
  await guestCall(code, priya, '/state', { muted: true, recording: true });
  const room = await waitFor(john.got, (m) => m.type === 'call-room' && m.call.peers.some((peer) => peer.guest && peer.muted));
  const priyaInRoom = room.call.peers.find((peer) => peer.guest);
  assert.deepEqual([priyaInRoom.name, priyaInRoom.recording], ['Priya Shah', false]);

  // A second guest is turned away.
  const sam = await (await fetch(`${BASE}/api/meet/${code}/knock`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: 'Sam' }) })).json();
  const samEvents = await guestStream(code, sam);
  await waitFor(john.got, (m) => m.type === 'call-room' && m.call.lobby.some((g) => g.name === 'Sam'));
  await call('john', `/calls/${started.call.id}/admit`, { peerId: started.peerId, guestId: sam.guestId, allow: false });
  await waitFor(samEvents.got, (m) => m.type === 'lobby' && m.status === 'denied');
  assert.equal((await fetch(`${BASE}/api/meet/${code}/knock`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: '' }) })).status, 400);

  // When the last teammate leaves, the meeting ends for the guests too.
  await call('mary', `/calls/${started.call.id}/leave`, { peerId: mary.peerId });
  await call('john', `/calls/${started.call.id}/leave`, { peerId: started.peerId });
  await waitFor(priyaEvents.got, (m) => m.type === 'call-room' && m.call.status === 'ended');
  assert.equal((await fetch(`${BASE}/api/meet/${code}`)).status, 404);
});

test('a meeting with a link stays open while its host waits alone', async () => {
  const started = await json('john', '/calls', { to: [], meeting: true });
  const state = await json('john', `/calls/${started.call.id}/state`, { peerId: started.peerId, muted: true });
  assert.equal(state.status, 'active');
  assert.equal((await fetch(`${BASE}/api/meet/${started.call.code}`)).status, 200);
  // An ordinary call with nobody to ring is still refused.
  assert.equal((await call('john', '/calls', { to: [] })).status, 400);
  // A link can be added to an ordinary call by someone in it.
  const ordinary = await json('john', '/calls', { to: 'mary@example.com' });
  const link = await json('john', `/calls/${ordinary.call.id}/link`, { peerId: ordinary.peerId });
  assert.match(link.code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal((await call('mary', `/calls/${ordinary.call.id}/link`, { peerId: started.peerId })).status, 404);
  await call('john', `/calls/${started.call.id}/leave`, { peerId: started.peerId });
  await call('john', `/calls/${ordinary.call.id}/leave`, { peerId: ordinary.peerId });
});

test('a scheduled meeting: invitees see it, its link waits for the team, and the first teammate starts it', async () => {
  const mary = await listen('mary');
  const startAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const made = await call('john', '/meetings', { title: 'Weekly review', startAt, durationMin: 45, invitees: ['mary@example.com'], description: 'Agenda' });
  assert.equal(made.status, 201);
  const meeting = await made.json();
  assert.match(meeting.code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.deepEqual([meeting.title, meeting.durationMin, meeting.mine, meeting.canEdit, meeting.live], ['Weekly review', 45, true, true, false]);
  // Mary is told and sees it; Omar, not invited, doesn't.
  await waitFor(mary.got, (m) => m.type === 'notification' && m.notification.title.includes('Weekly review'));
  const marys = (await json('mary', '/meetings')).items;
  assert.deepEqual(marys.map((item) => [item.id, item.mine, item.canEdit]), [[meeting.id, false, false]]);
  assert.equal((await json('omar', '/meetings')).items.length, 0);
  assert.equal((await call('mary', `/meetings/${meeting.id}`, undefined, 'DELETE')).status, 403);
  // Bad times, lengths and invitees are refused.
  assert.equal((await call('john', '/meetings', { title: 'x', startAt: new Date(Date.now() - 86_400_000).toISOString(), durationMin: 30 })).status, 400);
  assert.equal((await call('john', '/meetings', { title: 'x', startAt, durationMin: 7 })).status, 400);
  assert.equal((await call('john', '/meetings', { title: 'x', startAt, durationMin: 30, invitees: ['stranger@else.com'] })).status, 400);

  // Before anyone from the team opens it, a guest sees when it starts and can't knock yet.
  const page = await (await fetch(`${BASE}/api/meet/${meeting.code}`)).json();
  assert.deepEqual([page.title, page.started, page.startAt, page.hostName], ['Weekly review', false, startAt, 'john']);
  assert.equal((await fetch(`${BASE}/api/meet/${meeting.code}/knock`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: 'Early' }) })).status, 409);

  // Mary opens the link first: that starts it, under the same code and title.
  const started = await call('mary', `/calls/code/${meeting.code}/join`, {});
  assert.equal(started.status, 201);
  const live = await started.json();
  assert.deepEqual([live.call.code, live.call.title, live.call.peers.length], [meeting.code, 'Weekly review', 1]);
  assert.equal((await json('john', '/meetings')).items[0].live, true);
  const john = await json('john', `/calls/code/${meeting.code}/join`, {});
  assert.equal(john.call.peers.length, 2);
  assert.equal((await (await fetch(`${BASE}/api/meet/${meeting.code}`)).json()).started, true);

  // Renaming during the meeting is fine; moving it into the past isn't.
  const renamed = await call('john', `/meetings/${meeting.id}`, { title: 'Weekly review (moved)' }, 'PATCH');
  assert.equal((await renamed.json()).title, 'Weekly review (moved)');
  assert.equal((await call('john', `/meetings/${meeting.id}`, { startAt: new Date(Date.now() - 86_400_000).toISOString() }, 'PATCH')).status, 400);

  // When everyone leaves, the link can start it again later; cancelling it ends that.
  await call('mary', `/calls/${live.call.id}/leave`, { peerId: live.peerId });
  await call('john', `/calls/${live.call.id}/leave`, { peerId: john.peerId });
  assert.equal((await (await fetch(`${BASE}/api/meet/${meeting.code}`)).json()).started, false);
  assert.equal((await call('john', `/meetings/${meeting.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await fetch(`${BASE}/api/meet/${meeting.code}`)).status, 404);
  assert.equal((await call('mary', `/calls/code/${meeting.code}/join`, {})).status, 404);
});

test('recordings are kept in pieces, watchable by the people in the call, and deletable by the recorder', async () => {
  const started = await json('john', '/calls', { to: 'mary@example.com', video: true });
  const mary = await json('mary', `/calls/${started.call.id}/join`, {});
  // Only someone in the call, with their own window, can record it.
  assert.equal((await call('omar', '/recordings', { callId: started.call.id, peerId: started.peerId })).status, 404);
  assert.equal((await call('mary', '/recordings', { callId: started.call.id, peerId: started.peerId })).status, 404);
  const made = await call('john', '/recordings', { callId: started.call.id, peerId: started.peerId, type: 'video/webm;codecs=vp9,opus' });
  assert.equal(made.status, 201);
  const { id } = await made.json();

  const pieces = [Buffer.from('first-'), Buffer.from('second-'), Buffer.from('third')];
  const put = (who, n, data) => fetch(`${BASE}/api/recordings/${id}/parts/${n}`, {
    method: 'PUT', headers: { 'X-Requested-With': 'AliasMail', 'Content-Type': 'video/webm', Cookie: cookies[who] }, body: data,
  });
  assert.equal((await put('john', 1, pieces[1])).status, 400); // out of order
  assert.equal((await put('mary', 0, pieces[0])).status, 404); // not hers
  for (const [n, data] of pieces.entries()) assert.equal((await put('john', n, data)).status, 200);
  assert.equal((await put('john', 1, pieces[1])).status, 200); // a retry replaces the piece

  const finished = await json('john', `/recordings/${id}/finish`, { durationMs: 4200 });
  assert.equal(finished.status, 'ready');
  assert.equal(finished.size, Buffer.concat(pieces).length);
  assert.equal(finished.title, 'Call with mary');
  assert.equal((await put('john', 3, pieces[0])).status, 409);

  // Mary was in it: she sees it and can play it, whole or from the middle. Omar can't.
  const list = await json('mary', '/recordings');
  assert.deepEqual(list.items.map((item) => [item.id, item.mine, item.canDelete, item.drive]), [[id, false, false, null]]);
  assert.equal((await json('omar', '/recordings')).items.length, 0);
  assert.equal((await call('omar', `/recordings/${id}/video`)).status, 404);
  const whole = await call('mary', `/recordings/${id}/video`);
  assert.equal(whole.headers.get('content-type'), 'video/webm');
  assert.equal(await whole.text(), 'first-second-third');
  const middle = await fetch(`${BASE}/api/recordings/${id}/video`, { headers: { Cookie: cookies.mary, Range: 'bytes=3-9' } });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get('content-range'), `bytes 3-9/${finished.size}`);
  assert.equal(await middle.text(), 'st-seco');
  const tail = await fetch(`${BASE}/api/recordings/${id}/video`, { headers: { Cookie: cookies.mary, Range: 'bytes=-5' } });
  assert.equal(await tail.text(), 'third');
  assert.equal((await fetch(`${BASE}/api/recordings/${id}/video`, { headers: { Cookie: cookies.mary, Range: 'bytes=999-' } })).status, 416);
  const download = await call('mary', `/recordings/${id}/video?download=1`);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="call-recording-.+\.webm"$/);

  // John hasn't connected Google Drive, so no copy there.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await json('john', '/recordings')).items[0].drive.status, 'not-connected');
  // The admin can see everything.
  assert.equal((await json('admin', '/recordings')).items.length, 1);

  assert.equal((await call('mary', `/recordings/${id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await call('john', `/recordings/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await call('mary', `/recordings/${id}/video`)).status, 404);
  await call('john', `/calls/${started.call.id}/leave`, { peerId: started.peerId });
  await call('mary', `/calls/${started.call.id}/leave`, { peerId: mary.peerId });
});
