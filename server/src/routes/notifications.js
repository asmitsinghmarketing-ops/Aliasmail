import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { personOf } from '../team.js';
import { clearReadNotifications, markNotificationsRead, notificationsFor } from '../notifications.js';

const router = Router();
router.use(requireAuth());

router.get('/', (req, res) => {
  const all = notificationsFor(personOf(req.user));
  res.json({ items: all.slice(0, 50), unread: all.filter((item) => !item.readAt).length });
});

router.post('/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : null;
  res.json({ ok: true, changed: markNotificationsRead(personOf(req.user), ids) });
});

router.delete('/read', (req, res) => {
  res.json({ ok: true, changed: clearReadNotifications(personOf(req.user)) });
});

export default router;
