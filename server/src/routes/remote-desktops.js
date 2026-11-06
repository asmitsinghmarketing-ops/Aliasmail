// Saved Remote Desktop (RDP) connections, per person. Browsers can't speak RDP, so Nextspace hands
// the connection to the computer's own Remote Desktop app as a .rdp file (client/src/rdpFile.js).
// Passwords are never asked for or kept: the Remote Desktop app asks when it connects.
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { save, db } from '../store.js';
import { personOf } from '../team.js';

const router = Router();
router.use(requireAuth());

const MAX_PER_PERSON = 30;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;
// A line in a .rdp file is a setting, so nothing here may start a new line or hold a control character.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export const validHost = (value) => HOST_NAME.test(value) || (value.includes(':') && IPV6.test(value));

const text = (value, label, max) => {
  const clean = String(value ?? '').trim();
  if (clean.length > max || CONTROL.test(clean)) throw new HttpError(400, `${label} isn't valid`);
  return clean;
};

function fields(body) {
  const host = text(body?.host, 'The computer address', 253).toLowerCase();
  if (!validHost(host)) throw new HttpError(400, 'Enter the computer’s name or IP address, like office-pc.example.com');
  const port = body?.port === undefined || body?.port === '' ? 3389 : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'The port must be a number from 1 to 65535');
  const gateway = text(body?.gateway, 'The gateway address', 253).toLowerCase();
  if (gateway && !validHost(gateway)) throw new HttpError(400, 'Enter the gateway’s name or IP address');
  return {
    name: text(body?.name, 'The name', 80) || host,
    host,
    port,
    username: text(body?.username, 'The user name', 120),
    domain: text(body?.domain, 'The domain', 120),
    gateway,
  };
}

const mine = (owner) => db().remoteDesktops.filter((item) => item.owner === owner);
const view = ({ owner, ...item }) => item;

/** One person's saved connection, or null: only ever their own. */
export const connectionFor = (owner, id) => mine(owner).find((item) => item.id === id) || null;

router.get('/', (req, res) => res.json(mine(personOf(req.user)).map(view)));

router.post('/', (req, res) => {
  const owner = personOf(req.user);
  if (mine(owner).length >= MAX_PER_PERSON) throw new HttpError(400, `You can save up to ${MAX_PER_PERSON} remote desktops`);
  const item = { id: crypto.randomUUID(), owner, ...fields(req.body), createdAt: new Date().toISOString() };
  db().remoteDesktops.push(item);
  save();
  res.status(201).json(view(item));
});

router.put('/:id', (req, res) => {
  const item = connectionFor(personOf(req.user), req.params.id);
  if (!item) throw new HttpError(404, 'Remote desktop not found');
  Object.assign(item, fields(req.body));
  save();
  res.json(view(item));
});

router.delete('/:id', (req, res) => {
  const item = connectionFor(personOf(req.user), req.params.id);
  if (!item) throw new HttpError(404, 'Remote desktop not found');
  db().remoteDesktops.splice(db().remoteDesktops.indexOf(item), 1);
  save();
  res.status(204).end();
});

export default router;
