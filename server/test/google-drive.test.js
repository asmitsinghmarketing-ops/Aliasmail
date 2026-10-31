import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The real server with stand-ins for Google's token endpoint, the Drive and Calendar APIs and the mail bridge.
const PORT = 5200 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'owner@example.com', password: 'admin-password-123' };
const CLIENT_ID = 'drive-client.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CHAT_SCOPE = ['chat.spaces.readonly', 'chat.spaces.create', 'chat.memberships'].map((s) => `https://www.googleapis.com/auth/${s}`).join(' ');

let server;
let fake;
let dir;
const nonces = new Map();
const fakeState = { grantDrive: true, revoked: false, shares: [], revokes: [], events: [], setups: [] };

test.before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'refresh_token') {
          if (fakeState.revoked || form.get('refresh_token') !== 'refresh-1') return send(400, { error: 'invalid_grant' });
          return send(200, { access_token: 'access-1', expires_in: 3600 });
        }
        const nonce = nonces.get(form.get('code'));
        const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce, sub: 'g-john', email: 'john@example.com', email_verified: true };
        return send(200, {
          id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`,
          refresh_token: 'refresh-1',
          scope: fakeState.grantDrive ? `openid email profile ${DRIVE_SCOPE} ${CALENDAR_SCOPE} ${CHAT_SCOPE}` : 'openid email profile',
        });
      }
      if (url.pathname === '/revoke') {
        fakeState.revokes.push(url.searchParams.get('token'));
        return send(200, {});
      }
      const share = url.pathname.match(/^\/drive\/files\/([^/]+)\/permissions$/);
      if (share) {
        const permission = JSON.parse(body);
        fakeState.shares.push({ file: share[1], ...permission, auth: req.headers.authorization, notify: url.searchParams.get('sendNotificationEmail') });
        if (share[1].startsWith('locked')) return send(403, { error: { message: 'The user does not have sufficient permissions for this file.' } });
        return send(200, { id: 'perm' });
      }
      if (url.pathname === '/calendar/calendars/primary/events') {
        const event = JSON.parse(body);
        fakeState.events.push({ ...event, auth: req.headers.authorization, query: Object.fromEntries(url.searchParams) });
        return send(200, { id: 'evt1', summary: event.summary, htmlLink: 'https://calendar.google.com/event?eid=evt1', hangoutLink: 'https://meet.google.com/abc-defg-hij' });
      }
      if (url.pathname === '/chat/spaces') {
        if (fakeState.chatWorkspaceOnly) return send(403, { error: { message: 'Google Chat API is only available to Google Workspace users.' } });
        return send(200, { spaces: [{ displayName: 'Team', spaceType: 'SPACE' }, { spaceType: 'DIRECT_MESSAGE' }] });
      }
      if (url.pathname === '/chat/spaces:setup') {
        const setup = JSON.parse(body);
        fakeState.setups.push(setup);
        if (fakeState.chatWorkspaceOnly) return send(403, { error: { message: 'Google Chat API is only available to Google Workspace users.' } });
        return send(200, { name: 'spaces/AAA', displayName: setup.space.displayName, spaceType: 'SPACE', spaceUri: 'https://chat.google.com/room/AAA' });
      }
      if (url.pathname === '/bridge') {
        const { action } = JSON.parse(body || '{}');
        if (action === 'sync') return send(200, { uidValidity: '1', uids: [], seenUids: [], messages: [] });
        return send(200, { ok: true, messages: [] });
      }
      send(404, {});
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${fake.address().port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aliasmail-drive-'));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), DATABASE_URL: '', NODE_ENV: 'test', IP_LOCATION: 'off',
      JWT_SECRET: 'drive-test-secret', MAIL_USER: ADMIN.email, MAIL_PASSWORD: '', MAIL_BRIDGE_URL: `${at}/bridge`, MAIL_BRIDGE_TOKEN: 'bridge-token', MAIL_TRANSPORT: 'bridge',
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_URL: `${at}/token`, GOOGLE_REVOKE_URL: `${at}/revoke`,
      GOOGLE_DRIVE_API_URL: `${at}/drive`, GOOGLE_CALENDAR_API_URL: `${at}/calendar`, GOOGLE_CHAT_API_URL: `${at}/chat`, GOOGLE_API_KEY: 'browser-key', GOOGLE_PROJECT_NUMBER: '123456789',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  server?.kill();
  fake?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function browser() {
  const jar = new Map();
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(method !== 'GET' && { 'X-Requested-With': 'AliasMail' }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k);
      else jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
  const connectDrive = async (mode = 'drive') => {
    const start = await call('GET', `/api/auth/google/start?mode=${mode}`);
    const sent = new URL(start.location);
    const code = `code-${Math.random()}`;
    nonces.set(code, sent.searchParams.get('nonce'));
    return { sent, back: await call('GET', `/api/auth/google/callback?code=${code}&state=${sent.searchParams.get('state')}`) };
  };
  return { call, connectDrive };
}

async function johnSignedIn() {
  const admin = browser();
  await admin.call('POST', '/api/auth/login', ADMIN);
  await admin.call('POST', '/api/admin/aliases', { address: 'john@example.com', password: 'john-password' });
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  return john;
}

test('Drive is connected from Settings, then picked files are shared with recipients on send', async () => {
  const john = await johnSignedIn();
  assert.equal((await john.call('POST', '/api/mail/drive/token')).status, 409);

  const { sent, back } = await john.connectDrive();
  assert.match(sent.searchParams.get('scope'), /drive\.file/);
  assert.equal(sent.searchParams.get('access_type'), 'offline');
  assert.equal(back.location, '/?google=drive-linked');
  assert.equal((await john.call('GET', '/api/auth/mfa')).data.google.drive, true);

  const token = (await john.call('POST', '/api/mail/drive/token')).data;
  assert.deepEqual([token.accessToken, token.apiKey, token.appId], ['access-1', 'browser-key', '123456789']);

  const result = await john.call('POST', '/api/mail/send', {
    to: 'priya@example.org', cc: 'ana@example.org', subject: 'Deck', text: 'See attached',
    drive: { files: [{ id: 'fileAAAAAAAAAA', name: 'Q4 deck' }, { id: 'locked-file-AAAA', name: 'Budget' }], access: 'comment' },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.drive.shared, 2);
  assert.deepEqual(result.data.drive.failed.map((f) => [f.file, f.to]), [['Budget', 'priya@example.org'], ['Budget', 'ana@example.org']]);
  const ok = fakeState.shares.filter((s) => s.file === 'fileAAAAAAAAAA');
  assert.deepEqual(ok.map((s) => [s.emailAddress, s.role, s.type, s.auth, s.notify]), [
    ['priya@example.org', 'commenter', 'user', 'Bearer access-1', 'false'],
    ['ana@example.org', 'commenter', 'user', 'Bearer access-1', 'false'],
  ]);
});

test('"don\'t change sharing" shares nothing, and junk file ids are ignored', async () => {
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  const before = fakeState.shares.length;
  await john.call('POST', '/api/mail/send', { to: 'x@example.org', subject: 's', text: 't', drive: { files: [{ id: 'fileBBBBBBBBBB', name: 'n' }], access: 'none' } });
  await john.call('POST', '/api/mail/send', { to: 'x@example.org', subject: 's', text: 't', drive: { files: [{ id: '../../etc', name: 'n' }], access: 'edit' } });
  assert.equal(fakeState.shares.length, before);
});

test('Drive refused on the Google screen, disconnected, or removed at Google', async () => {
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });

  fakeState.grantDrive = false;
  assert.equal((await john.connectDrive()).back.location, '/?google=drive-denied');
  fakeState.grantDrive = true;

  await john.call('POST', '/api/auth/google/drive/disconnect');
  assert.deepEqual(fakeState.revokes, ['refresh-1']);
  assert.equal((await john.call('GET', '/api/auth/mfa')).data.google.drive, false);
  assert.equal((await john.call('POST', '/api/mail/drive/token')).status, 409);

  // Reconnected, then the access is removed from the Google account itself.
  await john.connectDrive();
  fakeState.revoked = true;
  const gone = await john.call('POST', '/api/mail/drive/token');
  assert.equal(gone.status, 409);
  assert.match(gone.data.error, /Google Drive access was removed/);
  assert.equal((await john.call('GET', '/api/auth/mfa')).data.google.drive, false);
});

test('Google Meet: connected from Settings, then meetings are created in the person\'s calendar', async () => {
  fakeState.revoked = false;
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  assert.equal((await john.call('GET', '/api/auth/info')).data.meet, true);
  assert.equal((await john.call('POST', '/api/mail/meet', {})).status, 409);

  const { sent, back } = await john.connectDrive('meet');
  assert.match(sent.searchParams.get('scope'), /calendar\.events/);
  assert.doesNotMatch(sent.searchParams.get('scope'), /drive/);
  assert.equal(back.location, '/?google=meet-linked');
  assert.equal((await john.call('GET', '/api/auth/mfa')).data.google.meet, true);

  const now = await john.call('POST', '/api/mail/meet', {});
  assert.equal(now.status, 201);
  assert.equal(now.data.link, 'https://meet.google.com/abc-defg-hij');
  const quick = fakeState.events.at(-1);
  assert.deepEqual([quick.auth, quick.query.conferenceDataVersion, quick.query.sendUpdates], ['Bearer access-1', '1', 'none']);
  assert.equal(quick.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.equal(Date.parse(quick.end.dateTime) - Date.parse(quick.start.dateTime), 30 * 60e3);

  const start = new Date(Date.now() + 86400e3).toISOString();
  const later = await john.call('POST', '/api/mail/meet', { title: 'Kick-off', start, minutes: 45, guests: ['Priya@Example.org', 'ana@example.org'] });
  assert.equal(later.status, 201);
  const invite = fakeState.events.at(-1);
  assert.deepEqual([invite.summary, invite.query.sendUpdates, invite.start.dateTime], ['Kick-off', 'all', start]);
  assert.deepEqual(invite.attendees, [{ email: 'priya@example.org' }, { email: 'ana@example.org' }]);

  assert.equal((await john.call('POST', '/api/mail/meet', { guests: ['not-an-email'] })).status, 400);
  assert.equal((await john.call('POST', '/api/mail/meet', { start: 'soon' })).status, 400);

  // Disconnecting Meet leaves the Google sign-in alone.
  await john.call('POST', '/api/auth/google/meet/disconnect');
  const status = (await john.call('GET', '/api/auth/mfa')).data.google;
  assert.deepEqual([status.meet, Boolean(status.email)], [false, true]);
  assert.equal((await john.call('POST', '/api/mail/meet', {})).status, 409);
});

test('"Connect all" asks for Drive and Meet on one Google screen; disconnecting one keeps the other', async () => {
  fakeState.revoked = false;
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  const { sent, back } = await john.connectDrive('all');
  assert.match(sent.searchParams.get('scope'), /drive\.file/);
  assert.match(sent.searchParams.get('scope'), /calendar\.events/);
  assert.doesNotMatch(sent.searchParams.get('scope'), /chat/);
  assert.equal(back.location, '/?google=all-linked');
  let status = (await john.call('GET', '/api/auth/mfa')).data.google;
  assert.deepEqual([status.drive, status.meet], [true, true]);

  // Google keeps one grant per app: Drive goes here without revoking what Meet still uses.
  const revokes = fakeState.revokes.length;
  await john.call('POST', '/api/auth/google/drive/disconnect');
  assert.equal(fakeState.revokes.length, revokes);
  assert.equal((await john.call('POST', '/api/mail/meet', {})).status, 201);
  await john.call('POST', '/api/auth/google/meet/disconnect');
  assert.equal(fakeState.revokes.length, revokes + 1);
  status = (await john.call('GET', '/api/auth/mfa')).data.google;
  assert.deepEqual([status.drive, status.meet], [false, false]);
});

test('Google Chat on trial: the test lists conversations, or shows why Google refused', async () => {
  fakeState.revoked = false;
  const john = browser();
  await john.call('POST', '/api/auth/login', { email: 'john@example.com', password: 'john-password' });
  assert.equal((await john.call('GET', '/api/mail/chat/test')).status, 409);
  const { sent, back } = await john.connectDrive('chat');
  assert.match(sent.searchParams.get('scope'), /chat\.spaces\.readonly/);
  assert.equal(back.location, '/?google=chat-linked');

  const works = (await john.call('GET', '/api/mail/chat/test')).data;
  assert.deepEqual(works.spaces.map((s) => [s.name, s.type]), [['Team', 'SPACE'], ['Direct message', 'DIRECT_MESSAGE']]);

  const made = await john.call('POST', '/api/mail/chat/spaces', { name: 'Project team', members: ['Priya@gmail.com', 'ana@gmail.com', 'john@example.com'] });
  assert.equal(made.status, 201);
  assert.equal(made.data.space.link, 'https://chat.google.com/room/AAA');
  const setup = fakeState.setups.at(-1);
  assert.deepEqual(setup.space, { spaceType: 'SPACE', displayName: 'Project team' });
  assert.deepEqual(setup.memberships.map((m) => m.member.name), ['users/priya@gmail.com', 'users/ana@gmail.com']);
  assert.equal((await john.call('POST', '/api/mail/chat/spaces', { name: '', members: [] })).status, 400);
  assert.equal((await john.call('POST', '/api/mail/chat/spaces', { name: 'x', members: ['nope'] })).status, 400);
  fakeState.chatWorkspaceOnly = true;
  const refused = (await john.call('GET', '/api/mail/chat/test')).data;
  assert.deepEqual([refused.ok, refused.status], [false, 403]);
  assert.match(refused.reason, /Workspace/);
  const notAllowed = await john.call('POST', '/api/mail/chat/spaces', { name: 'Team', members: ['a@gmail.com'] });
  assert.deepEqual([notAllowed.status, notAllowed.data.ok, notAllowed.data.status], [200, false, 403]);
});
