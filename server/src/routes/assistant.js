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
import { assistantEnabled, modelName, provider, chatsOf, checkLimits, findChat, friendly, monthUsage, newChat, runTurn, settleCard, store } from '../assistant.js';

const router = Router();
router.use(requireAuth());

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
  if (!assistantEnabled()) throw new HttpError(503, 'The Assistant isn’t set up yet. The admin needs to add ANTHROPIC_API_KEY (or GEMINI_API_KEY for testing).');
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
  if (!assistantEnabled()) throw new HttpError(503, 'The Assistant isn’t set up yet. The admin needs to add ANTHROPIC_API_KEY (or GEMINI_API_KEY for testing).');
  const me = personOf(req.user);
  const chat = findChat(me, req.params.id);
  if (running.has(chat.id)) throw new HttpError(409, 'Still answering the last message');
  checkLimits(me);
  const body = req.body ?? {};
  if (!String(body.message || '').trim()) throw new HttpError(400, 'Write a message');

  const abort = new AbortController();
  running.set(chat.id, abort);
  const name = teammates().find((p) => p.address === me)?.name || '';
  runTurn({ chat, person: me, name, message: body.message, now: body.now, timeZone: body.timeZone, emit: () => {}, signal: abort.signal })
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
    effort: provider() === 'gemini' ? null : config.assistant.effort,
    limits: store().limits,
    month: usage.month,
    total: usage.total,
    people: Object.entries(usage.people).map(([address, u]) => ({ address, name: names[address] || '', ...u })).sort((a, b) => b.usd - a.usd),
  });
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
