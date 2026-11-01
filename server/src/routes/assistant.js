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
import { assistantEnabled, chatsOf, checkLimits, findChat, friendly, monthUsage, newChat, runTurn, settleCard, store } from '../assistant.js';

const router = Router();
router.use(requireAuth());

const running = new Set(); // chat ids answering right now

const listView = (c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt });

router.get('/status', (req, res) => {
  const me = personOf(req.user);
  const usage = monthUsage();
  res.json({
    enabled: assistantEnabled(),
    model: config.assistant.model,
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
  if (!assistantEnabled()) throw new HttpError(503, 'The Assistant isn’t set up yet. The admin needs to add ANTHROPIC_API_KEY.');
  res.status(201).json(listView(newChat(personOf(req.user))));
});

router.get('/chats/:id', (req, res) => {
  const chat = findChat(personOf(req.user), req.params.id);
  res.json({ ...listView(chat), items: chat.items, running: running.has(chat.id) });
});

router.delete('/chats/:id', (req, res) => {
  const chat = findChat(personOf(req.user), req.params.id);
  if (running.has(chat.id)) throw new HttpError(409, 'Wait for the answer to finish');
  store().chats.splice(store().chats.indexOf(chat), 1);
  save();
  res.json({ ok: true });
});

/** Ask something: { message, now, timeZone }. The answer streams back as events. */
router.post('/chats/:id/messages', async (req, res) => {
  if (!assistantEnabled()) throw new HttpError(503, 'The Assistant isn’t set up yet. The admin needs to add ANTHROPIC_API_KEY.');
  const me = personOf(req.user);
  const chat = findChat(me, req.params.id);
  if (running.has(chat.id)) throw new HttpError(409, 'Still answering the last message');
  checkLimits(me);

  running.add(chat.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  // Some hosting proxies hold small writes back; text is sent in short batches, each padded.
  const pad = `:${' '.repeat(2048)}\n\n`;
  let pending = '';
  let timer = null;
  const write = (event, data) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n${pad}`);
  const flushText = () => {
    clearTimeout(timer);
    timer = null;
    if (pending) write('delta', { text: pending });
    pending = '';
  };
  const emit = (event, data) => {
    if (event === 'delta') {
      pending += data.text;
      timer ||= setTimeout(flushText, 150);
      return;
    }
    flushText();
    write(event, data);
  };
  const abort = new AbortController();
  res.on('close', () => !res.writableFinished && abort.abort());

  try {
    const body = req.body ?? {};
    const name = teammates().find((p) => p.address === me)?.name || '';
    await runTurn({ chat, person: me, name, message: body.message, now: body.now, timeZone: body.timeZone, emit, signal: abort.signal });
    flushText();
    write('done', { spentUsd: monthUsage().people[me]?.usd || 0, title: chat.title });
  } catch (err) {
    if (!abort.signal.aborted) {
      const error = friendly(err);
      if (!(err instanceof HttpError)) console.warn('[assistant]', error);
      chat.items.at(-1)?.parts?.push({ type: 'error', text: error });
      save();
      flushText();
      write('error', { error, final: true });
    }
  } finally {
    clearTimeout(timer);
    running.delete(chat.id);
    res.end();
  }
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
    model: config.assistant.model,
    effort: config.assistant.effort,
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
