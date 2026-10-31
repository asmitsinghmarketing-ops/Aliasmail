import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import config from './config.js';
import { removeAvatar } from './avatars.js';

export const PALETTE = ['#e8590c', '#2b8a3e', '#7048e8', '#d6336c', '#0c8599', '#f08c00', '#c92a2a', '#5c940d', '#ae3ec9', '#1971c2'];
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalize = (value) => String(value ?? '').trim().toLowerCase();

export const findAlias = (address) => db().aliases.find((a) => a.address === normalize(address));
export const findAliasById = (id) => db().aliases.find((a) => a.id === id);

/** An alias without its password hash or authenticator secrets. */
export function publicAlias({ passwordHash, mfa, mfaPending, google, ...rest }) {
  return { ...rest, mfaEnabled: Boolean(mfa?.enabled), googleEmail: google ? google.email || 'connected' : null };
}

const BCRYPT_ROUNDS = 12;
export const hashPassword = (password) => bcrypt.hash(String(password), BCRYPT_ROUNDS);

// The main mailbox address (signed in as admin) owns the whole mailbox and sees every message;
// an alias sees only mail delivered to it.
export const isOwner = (address) => Boolean(address) && address === config.mailbox;

export const isVisibleTo = (msg, address) => (isOwner(address) || msg.recipients.includes(address)) && !msg.state[address]?.hidden;
export const messagesFor = (address, messages = db().messages) => Object.values(messages).filter((m) => isVisibleTo(m, address));
export const aliasesOf = (msg) => db().aliases.filter((a) => msg.recipients.includes(a.address));

/** The signed-in account: an alias, or a stand-in record for the main mailbox address. */
export function accountOf(address) {
  if (isOwner(address)) {
    const { displayName = '', signature = '', signatureHtml = '', avatar = null } = db().owner;
    return { address, displayName, signature, signatureHtml, avatar, owner: true };
  }
  return findAlias(address);
}

/** Replace (or with `file` null, remove) an account's profile picture. */
export function setAvatar(account, file) {
  const record = account.owner ? db().owner : findAlias(account.address);
  removeAvatar(record.avatar);
  record.avatar = file;
  save();
}

export async function updateAccount(account, changes) {
  if (!account.owner) return updateAlias(findAlias(account.address), changes);
  if (changes.password) throw new HttpError(400, 'The admin password is set in server/.env (ADMIN_PASSWORD)');
  for (const key of ['displayName', 'signature', 'signatureHtml']) {
    if (typeof changes[key] === 'string') db().owner[key] = changes[key].trim();
  }
  save();
  return accountOf(account.address);
}

export function withCounts(alias) {
  const msgs = messagesFor(alias.address);
  return {
    ...publicAlias(alias),
    type: typeOf(alias),
    roles: rolesOf(alias),
    total: msgs.length,
    unread: msgs.filter((m) => !m.state[alias.address]?.read && !m.state[alias.address]?.trashed).length,
  };
}

function validatePassword(password) {
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}

/* ---------------------------------- mailbox types ---------------------------------- */

// personal: one person signs in and only they (and the admin) see its mail.
// group: a shared mailbox with no sign-in of its own; people open it through a role.
export const ALIAS_TYPES = ['personal', 'group'];
export const typeOf = (alias) => (alias?.type === 'group' ? 'group' : 'personal');

function parseType(value) {
  const type = value === undefined ? 'personal' : value;
  if (!ALIAS_TYPES.includes(type)) throw new HttpError(400, 'Mailbox type must be personal or group');
  return type;
}

export async function createAlias({ address, displayName, ownerName, password, color, type }) {
  address = normalize(address);
  type = parseType(type);
  if (!EMAIL_RE.test(address)) throw new HttpError(400, 'Enter a valid alias address, e.g. john@abc.com');
  if (findAlias(address)) throw new HttpError(409, 'That alias already exists');
  if (isOwner(address)) throw new HttpError(400, 'That is the main mailbox address - sign in as admin to use it');
  if (type === 'personal') validatePassword(password);

  const alias = {
    id: crypto.randomUUID(),
    address,
    type,
    displayName: String(displayName ?? '').trim(),
    ownerName: String(ownerName ?? '').trim(),
    color: color || PALETTE[db().aliases.length % PALETTE.length],
    active: true,
    passwordHash: type === 'personal' ? await hashPassword(password) : null,
    createdAt: new Date().toISOString(),
  };
  db().aliases.push(alias);
  save();
  return alias;
}

export async function updateAlias(alias, changes) {
  const type = changes.type === undefined ? typeOf(alias) : parseType(changes.type);
  if (type === 'personal' && !alias.passwordHash && !changes.password) {
    throw new HttpError(400, 'Set a password so the person can sign in to this personal mailbox');
  }
  for (const key of ['displayName', 'ownerName', 'color', 'signature', 'signatureHtml']) {
    if (typeof changes[key] === 'string') alias[key] = changes[key].trim();
  }
  if (typeof changes.active === 'boolean') alias.active = changes.active;
  if (type === 'group') {
    // A shared mailbox has no sign-in: drop its password, 2-step setup and role memberships.
    alias.passwordHash = null;
    delete alias.mfa;
    delete alias.mfaPending;
    delete alias.google;
    for (const role of db().roles) role.members = role.members.filter((id) => id !== alias.id);
  } else {
    for (const role of db().roles) role.mailboxes = role.mailboxes.filter((id) => id !== alias.id);
    if (changes.password) {
      validatePassword(changes.password);
      alias.passwordHash = await hashPassword(changes.password);
    }
  }
  alias.type = type;
  save();
  return alias;
}

export function deleteAlias(alias) {
  const data = db();
  removeAvatar(alias.avatar);
  data.aliases = data.aliases.filter((a) => a.id !== alias.id);
  for (const role of data.roles) {
    role.mailboxes = role.mailboxes.filter((id) => id !== alias.id);
    role.members = role.members.filter((id) => id !== alias.id);
  }
  for (const msg of Object.values(data.messages)) delete msg.state[alias.address];
  save();
}

/* ---------------------------------- roles ---------------------------------- */

const findRole = (id) => db().roles.find((r) => r.id === id);

/** Role names an alias belongs to (members) or is shared through (mailboxes). */
export const rolesOf = (alias) =>
  db().roles.filter((r) => r.members.includes(alias.id) || r.mailboxes.includes(alias.id)).map((r) => r.name);

/**
 * Group mailboxes an account may switch to: for a person, those in their roles; for the
 * admin (who owns the whole mailbox), every group mailbox. Disabled mailboxes are left out.
 */
export function sharedMailboxesFor(role, address) {
  const groups = db().aliases.filter((a) => typeOf(a) === 'group' && a.active);
  if (role === 'admin') return groups.map((a) => ({ alias: a, roles: rolesOf(a) }));
  const me = findAlias(address);
  if (!me || typeOf(me) !== 'personal') return [];
  const mine = db().roles.filter((r) => r.members.includes(me.id));
  return groups
    .map((a) => ({ alias: a, roles: mine.filter((r) => r.mailboxes.includes(a.id)).map((r) => r.name) }))
    .filter((m) => m.roles.length > 0);
}

export const canOpenMailbox = (role, address, mailbox) =>
  sharedMailboxesFor(role, address).some((m) => m.alias.address === normalize(mailbox));

function roleFields(input, existing) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Give the role a name');
  if (db().roles.some((r) => r.id !== existing?.id && r.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, 'A role with that name already exists');
  }
  const ids = (list, type, what) => {
    const wanted = [...new Set((Array.isArray(list) ? list : []).map(String))];
    for (const id of wanted) {
      const alias = findAliasById(id);
      if (!alias || typeOf(alias) !== type) throw new HttpError(400, `Only ${what} can be added here`);
    }
    return wanted;
  };
  return {
    name,
    mailboxes: input.mailboxes === undefined ? existing?.mailboxes || [] : ids(input.mailboxes, 'group', 'group mailboxes'),
    members: input.members === undefined ? existing?.members || [] : ids(input.members, 'personal', 'personal accounts'),
  };
}

export function createRole(input) {
  const role = { id: crypto.randomUUID(), ...roleFields(input), createdAt: new Date().toISOString() };
  db().roles.push(role);
  save();
  return role;
}

export function updateRole(id, input) {
  const role = findRole(id);
  if (!role) throw new HttpError(404, 'Role not found');
  Object.assign(role, roleFields(input, role));
  save();
  return role;
}

export function deleteRole(id) {
  if (!findRole(id)) throw new HttpError(404, 'Role not found');
  db().roles = db().roles.filter((r) => r.id !== id);
  save();
}
