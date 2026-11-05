// The Assistant's API: chats (answers stream as Server-Sent Events), cards the person settles,
// and for the admin, this month's usage and the spending limits. See assistant.js.
import { Router } from 'express';
import config from '../config.js';
import { save } from '../store.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { personOf, teammates } from '../team.js';
import { meetEnabled } from '../google-auth.js';
import { audit } from '../audit.js';
import { describeSettings, settings, updateSettings } from '../assistant-settings.js';
import { assistantEnabled, modelName, provider, chatsOf, checkLimits, findChat, friendly, monthUsage, newChat, runTurn, settleCard, store, testConnection } from '../assistant.js';

const router = Router();
router.use(requireAuth());

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function uploadedImage(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object') throw new HttpError(400, 'The attached image is invalid');
  const mediaType = String(value.mediaType || '').toLowerCase();
  const data = String(value.data || '').replace(/\s/g, '');
  const name = String(value.name || 'image').replace(/[\u0000-\u001f]/g, '').slice(0, 160) || 'image';
  if (!IMAGE_TYPES.has(mediaType)) throw new HttpError(400, 'Use a JPG, PNG or WebP image');
  if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new HttpError(400, 'The attached image is invalid or larger than 4 MB');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'The image must be 4 MB or smaller');
  const matches = mediaType === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mediaType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!matches) throw new HttpError(400, 'The image contents do not match its file type');
  return { name, mediaType, data };
}

// Why the Assistant is off, for the person trying to use it.
const notSetUp = () =>
  provider() === 'openrouter' && settings().openrouterKey
    ? 'The Assistant needs a model: the admin picks a free model that supports tools in Admin console → Assistant → AI settings → OpenRouter.'
    : 'The Assistant isn’t set up yet. The admin adds an AI key in Admin console → Assistant → AI settings.';

// At most this many messages per person per hour, whatever the AI costs: free models count as
// $0, so the spending limits alone wouldn't stop one person (or a stuck script) using up the
// team's free quota.
const PER_HOUR = 60;
const sent = new Map(); // person -> times of their recent messages
function countMessage(person) {
  const hourAgo = Date.now() - 3600e3;
  const recent = (sent.get(person) || []).filter((t) => t > hourAgo);
  if (recent.length >= PER_HOUR) {
    const minutes = Math.max(1, Math.ceil((recent[0] - hourAgo) / 60e3));
    throw new HttpError(429, `That’s ${PER_HOUR} messages to the Assistant in the last hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  recent.push(Date.now());
  sent.set(person, recent);
}

const running = new Map(); // chat id -> AbortController, while answering

const listView = (c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt });

router.get('/status', (req, res) => {
  const me = personOf(req.user);
  const usage = monthUsage();
  res.json({
    enabled: assistantEnabled(),
    provider: provider(),
    model: modelName(),
    meet: meetEnabled(),
    me,
    name: teammates().find((p) => p.address === me)?.name || '',
    spentUsd: usage.people[me]?.usd || 0,
    limits: store().limits,
  });
});

router.get('/chats', (req, res) => {
  res.json(chatsOf(personOf(req.user)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(listView));
});

router.post('/chats', (req, res) => {
  if (!assistantEnabled()) throw new HttpError(503, notSetUp());
  res.status(201).json(listView(newChat(personOf(req.user))));
});

router.get('/chats/:id', (req, res) => {
  const chat = findChat(personOf(req.user), req.params.id);
  const me = personOf(req.user);
  res.json({ ...listView(chat), items: chat.items, running: running.has(chat.id), spentUsd: monthUsage().people[me]?.usd || 0 });
});

router.delete('/chats/:id', (req, res) => {
  const chat = findChat(personOf(req.user), req.params.id);
  if (running.has(chat.id)) throw new HttpError(409, 'Wait for the answer to finish');
  store().chats.splice(store().chats.indexOf(chat), 1);
  save();
  res.json({ ok: true });
});

/**
 * Ask something: { message, now, timeZone }. Answers 202 at once; the answer is written into
 * the chat as it comes, and the browser reads it with GET /chats/:id (`running` until done).
 * No long-lived response, so hosting proxies that hold streamed responses back don't matter.
 */
router.post('/chats/:id/messages', (req, res) => {
  if (!assistantEnabled()) throw new HttpError(503, notSetUp());
  const me = personOf(req.user);
  const chat = findChat(me, req.params.id);
  if (running.has(chat.id)) throw new HttpError(409, 'Still answering the last message');
  checkLimits(me);
  const body = req.body ?? {};
  const image = uploadedImage(body.image);
  if (!String(body.message || '').trim() && !image) throw new HttpError(400, 'Write a message or attach an image');
  countMessage(me);

  const abort = new AbortController();
  running.set(chat.id, abort);
  const name = teammates().find((p) => p.address === me)?.name || '';
  runTurn({ chat, person: me, name, message: body.message, image, now: body.now, timeZone: body.timeZone, emit: () => {}, signal: abort.signal })
    .catch((err) => {
      const error = abort.signal.aborted ? 'Stopped.' : friendly(err);
      if (!abort.signal.aborted && !(err instanceof HttpError)) console.warn('[assistant]', error);
      const last = chat.items.at(-1);
      if (last?.role === 'assistant') last.parts.push({ type: 'error', text: error });
      else chat.items.push({ role: 'assistant', parts: [{ type: 'error', text: error }], at: new Date().toISOString() });
      save();
    })
    .finally(() => running.delete(chat.id));
  res.status(202).json({ ok: true });
});

/** Stop the answer being written. */
router.post('/chats/:id/stop', (req, res) => {
  const chat = findChat(personOf(req.user), req.params.id);
  running.get(chat.id)?.abort();
  res.json({ ok: true });
});

/** The person pressed Send / Create, or Cancel: { status: 'done' | 'cancelled', detail }. */
router.post('/chats/:id/cards/:cardId', (req, res) => {
  const status = req.body?.status === 'done' ? 'done' : 'cancelled';
  res.json(settleCard(personOf(req.user), req.params.id, req.params.cardId, status, req.body?.detail || ''));
});

/* ---------------------------------- admin ---------------------------------- */

router.get('/usage', requireAuth('admin'), (req, res) => {
  const usage = monthUsage();
  const names = Object.fromEntries(teammates().map((p) => [p.address, p.name]));
  res.json({
    enabled: assistantEnabled(),
    provider: provider(),
    model: modelName(),
    effort: provider() === 'anthropic' ? settings().effort : null,
    limits: store().limits,
    month: usage.month,
    total: usage.total,
    people: Object.entries(usage.people).map(([address, u]) => ({ address, name: names[address] || '', ...u })).sort((a, b) => b.usd - a.usd),
  });
});

/** The AI provider, keys (only whether set and their last 4 characters) and models. */
router.get('/settings', requireAuth('admin'), (req, res) => {
  res.json({ ...describeSettings(), inUse: { provider: provider(), model: modelName(), enabled: assistantEnabled() } });
});

/** Change them: { provider, keys: { anthropic|gemini|openrouter: string | null }, model, effort, ... }. */
router.put('/settings', requireAuth('admin'), (req, res) => {
  const body = req.body ?? {};
  const saved = updateSettings(body);
  const keys = Object.entries(body.keys || {}).map(([p, v]) => `${p} key ${v ? 'set' : 'removed'}`);
  audit(req, 'assistant-settings', req.user.email, [body.provider !== undefined && `provider ${body.provider || 'automatic'}`, ...keys].filter(Boolean).join(', ') || 'models');
  res.json({ ...saved, inUse: { provider: provider(), model: modelName(), enabled: assistantEnabled() } });
});

/** Send one tiny request with the current settings and say how it went. */
router.post('/settings/test', requireAuth('admin'), async (req, res) => {
  if (!assistantEnabled()) throw new HttpError(400, notSetUp());
  try {
    res.json({ ok: true, ...(await testConnection()) });
  } catch (err) {
    res.json({ ok: false, provider: provider(), model: modelName(), error: friendly(err) });
  }
});

router.put('/limits', requireAuth('admin'), (req, res) => {
  const amount = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, 'Enter an amount between 0 and 100000 (0 = no limit)');
    return Math.round(n * 100) / 100;
  };
  store().limits = { monthlyUsd: amount(req.body?.monthlyUsd), perPersonUsd: amount(req.body?.perPersonUsd) };
  save();
  audit(req, 'assistant-limits', req.user.email, `company $${store().limits.monthlyUsd}, person $${store().limits.perPersonUsd}`);
  res.json(store().limits);
});

export default router;
