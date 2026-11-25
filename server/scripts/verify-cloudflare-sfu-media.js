// Live diagnostic: publish synthetic browser media to Cloudflare Realtime SFU, subscribe through a
// second connection, and require inbound RTP packets. The App Secret stays in this Node process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudflareSfuEnabled, cloudflareSfuRequest, createCloudflareSfuSession } from '../src/cloudflare-sfu.js';

if (!cloudflareSfuEnabled()) throw new Error('Set CLOUDFLARE_SFU_APP_ID and CLOUDFLARE_SFU_APP_SECRET first');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserModule = fs.readFileSync(path.join(root, 'client', 'src', 'cloudflareSfu.js'), 'utf8');
const token = crypto.randomBytes(18).toString('hex');
const sessions = new Map();
let publication = null;
let finishDiagnostic;
const diagnostic = new Promise((resolve) => { finishDiagnostic = resolve; });

const readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Diagnostic request is too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const page = `<!doctype html><meta charset="utf-8"><title>SFU diagnostic</title><body id="result">RUNNING<script type="module">
import { createCloudflareSfu } from './cloudflareSfu.js';
const result = document.querySelector('#result');
const report = async (status, message) => {
  result.dataset.status = status; result.textContent = message;
  await fetch('./report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, message }) });
};
const post = async (path, body) => {
  const response = await fetch('./proxy' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Proxy request failed');
  return data;
};
const waitFor = async (test, timeout = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await test()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for SFU media');
};
try {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d'); let frame = 0;
  const drawing = setInterval(() => { context.fillStyle = frame++ % 2 ? '#1266f1' : '#16a36a'; context.fillRect(0, 0, 320, 180); }, 80);
  const video = canvas.captureStream(12).getVideoTracks()[0];
  const audioContext = new AudioContext(); await audioContext.resume();
  const destination = audioContext.createMediaStreamDestination(); const oscillator = audioContext.createOscillator();
  oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
  const audio = destination.stream.getAudioTracks()[0];
  let publishedCall;
  const publisher = createCloudflareSfu({ post, peerId: 'publisher', onCall: (call) => { publishedCall = call; } });
  await publisher.start({ audio, camera: video, screen: null });
  await waitFor(() => publishedCall?.peers?.[0]?.sfu);
  const received = [];
  const subscriber = createCloudflareSfu({ post, peerId: 'subscriber', onMedia: (_peer, name, track) => received.push({ name, track }) });
  await subscriber.sync(publishedCall);
  await waitFor(() => subscriber.peerConnections().some((pc) => pc.connectionState === 'connected'));
  await waitFor(async () => {
    for (const pc of subscriber.peerConnections()) for (const stat of (await pc.getStats()).values()) {
      if (stat.type === 'inbound-rtp' && Number(stat.packetsReceived) > 0) return true;
    }
    return false;
  });
  if (!received.some((item) => item.name === 'audio') || !received.some((item) => item.name === 'camera')) throw new Error('Expected audio and camera tracks');
  subscriber.close(); publisher.close(); clearInterval(drawing); oscillator.stop(); await audioContext.close();
  await report('PASS', 'Cloudflare SFU forwarded audio and video');
} catch (error) {
  await report('FAIL', error.message);
}
</script>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const base = `/${token}`;
    if (req.method === 'GET' && url.pathname === `${base}/`) return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === `${base}/cloudflareSfu.js`) return send(res, 200, browserModule, 'text/javascript; charset=utf-8');
    if (req.method === 'POST' && url.pathname === `${base}/report`) {
      const body = await readJson(req);
      finishDiagnostic({ status: body.status, message: body.message });
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST' || !url.pathname.startsWith(`${base}/proxy/sfu/`)) return send(res, 404, { error: 'Not found' });
    const operation = url.pathname.slice(`${base}/proxy/sfu/`.length);
    const body = await readJson(req);
    if (operation === 'session') {
      if (!['publish', 'subscribe'].includes(body.role)) return send(res, 400, { error: 'Invalid role' });
      const made = await createCloudflareSfuSession();
      sessions.set(made.sessionId, body.role);
      return send(res, 201, made);
    }
    const match = /^([^/]+)\/(tracks|renegotiate|ready)$/.exec(operation);
    if (!match || !sessions.has(match[1])) return send(res, 404, { error: 'Session not found' });
    const [, sessionId, action] = match;
    if (action === 'ready') {
      if (sessions.get(sessionId) !== 'publish') return send(res, 400, { error: 'Not a publisher' });
      publication = { sessionId, tracks: body.tracks };
      return send(res, 200, { id: 'diagnostic', media: 'sfu', peers: [{ id: 'publisher', sfu: publication }] });
    }
    const method = action === 'renegotiate' ? 'PUT' : 'POST';
    const data = await cloudflareSfuRequest(`sessions/${sessionId}/${action === 'tracks' ? 'tracks/new' : 'renegotiate'}`, { method, body });
    return send(res, 200, data);
  } catch (error) {
    return send(res, error.status || 500, { error: error.message });
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = candidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  server.close();
  throw new Error('Chrome was not found. Set CHROME_PATH to run the live SFU diagnostic.');
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nextspace-sfu-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/${token}/`,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let errors = '';
child.stderr.on('data', (chunk) => { errors += chunk; });
const closed = new Promise((resolve) => child.on('close', (code) => resolve({ status: 'FAIL', message: `Chrome exited ${code}` })));
let timeout;
const timedOut = new Promise((resolve) => { timeout = setTimeout(() => resolve({ status: 'FAIL', message: 'Timed out waiting for the browser SFU test' }), 35_000); });
const outcome = await Promise.race([diagnostic, closed, timedOut]);
clearTimeout(timeout);
if (child.exitCode === null) child.kill();
await new Promise((resolve) => child.exitCode === null ? child.once('close', resolve) : resolve());
server.close();
fs.rmSync(profile, { recursive: true, force: true });
if (outcome.status !== 'PASS') throw new Error(outcome.message || errors.split(/\r?\n/).find(Boolean) || 'SFU diagnostic failed');
console.log(outcome.message);
