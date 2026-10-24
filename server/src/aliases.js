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
export function publicAlias({ passwordHash, mfa, mfaPending, ...rest }) {
  return { ...rest, mfaEnabled: Boolean(mfa?.enabled) };
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
    const { displayName = '', signature = '', avatar = null } = db().owner;
    return { address, displayName, signature, avatar, owner: true };
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
  for (const key of ['displayName', 'signature']) {
    if (typeof changes[key] === 'string') db().owner[key] = changes[key].trim();
  }
  save();
  return accountOf(account.address);
}

export function withCounts(alias) {
  const msgs = messagesFor(alias.address);
  return {
    ...publicAlias(alias),
    total: msgs.length,
    unread: msgs.filter((m) => !m.state[alias.address]?.read && !m.state[alias.address]?.trashed).length,
  };
}

function validatePassword(password) {
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}

export async function createAlias({ address, displayName, ownerName, password, color }) {
  address = normalize(address);
  if (!EMAIL_RE.test(address)) throw new HttpError(400, 'Enter a valid alias address, e.g. john@abc.com');
  if (findAlias(address)) throw new HttpError(409, 'That alias already exists');
  if (isOwner(address)) throw new HttpError(400, 'That is the main mailbox address - sign in as admin to use it');
  validatePassword(password);

  const alias = {
    id: crypto.randomUUID(),
    address,
    displayName: String(displayName ?? '').trim(),
    ownerName: String(ownerName ?? '').trim(),
    color: color || PALETTE[db().aliases.length % PALETTE.length],
    active: true,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  db().aliases.push(alias);
  save();
  return alias;
}

export async function updateAlias(alias, changes) {
  for (const key of ['displayName', 'ownerName', 'color', 'signature']) {
    if (typeof changes[key] === 'string') alias[key] = changes[key].trim();
  }
  if (typeof changes.active === 'boolean') alias.active = changes.active;
  if (changes.password) {
    validatePassword(changes.password);
    alias.passwordHash = await hashPassword(changes.password);
  }
  save();
  return alias;
}

export function deleteAlias(alias) {
  const data = db();
  removeAvatar(alias.avatar);
  data.aliases = data.aliases.filter((a) => a.id !== alias.id);
  for (const msg of Object.values(data.messages)) delete msg.state[alias.address];
  save();
}
