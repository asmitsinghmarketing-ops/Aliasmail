// Notifications API: the public key browsers subscribe with, and turning them on, off or
// changing them per device (the device is identified by its push endpoint). See push.js.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { personOf } from '../team.js';
import { deviceFor, devicesOf, notify, publicKey, subscribe, unsubscribe, updateDevice } from '../push.js';

const router = Router();
router.use(requireAuth());

/** The key to subscribe with, and this device's settings if it already gets notifications. */
router.post('/status', (req, res) => {
  const me = personOf(req.user);
  const device = req.body?.endpoint ? deviceFor(me, String(req.body.endpoint)) : null;
  res.json({
    publicKey: publicKey(),
    device: device ? { mail: device.mail, notes: device.notes, tasks: device.tasks, calls: device.calls } : null,
    devices: devicesOf(me).length,
  });
});

router.post('/subscribe', (req, res) => {
  res.status(201).json(subscribe(personOf(req.user), req.body ?? {}));
});

router.post('/unsubscribe', (req, res) => {
  unsubscribe(personOf(req.user), String(req.body?.endpoint || ''));
  res.json({ ok: true });
});

router.patch('/device', (req, res) => {
  res.json(updateDevice(personOf(req.user), String(req.body?.endpoint || ''), req.body ?? {}));
});

/** A test notification to every device of the signed-in person. */
router.post('/test', async (req, res) => {
  const sent = await notify(personOf(req.user), 'mail', {
    kind: 'test',
    title: 'Nextspace notifications work',
    body: 'You’ll be told about new mail and instant notes here.',
    url: '/',
    tag: 'test',
  });
  if (!sent) throw new HttpError(400, 'No device got it. Turn notifications on first, or try again.');
  res.json({ ok: true, sent });
});

export default router;
