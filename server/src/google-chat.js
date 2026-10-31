// Google Chat, on trial: Google documents its API for Workspace accounts only, so every call
// returns Google's own answer when it refuses instead of throwing: { ok: false, status, reason }.
import config from './config.js';
import { HttpError } from './errors.js';
import { googleTokenFor, holderOf } from './google-drive.js';

const VALID_EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_MEMBERS = 49; // spaces.setup takes the creator plus up to 49 people

async function chatRequest(role, email, path, { method = 'GET', body } = {}) {
  const { accessToken } = await googleTokenFor('chat', role, email);
  const answer = await fetch(`${config.google.chatApiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const data = answer ? await answer.json().catch(() => ({})) : {};
  if (answer?.ok) return { ok: true, data };
  let reason = data.error?.message || (answer ? `Google answered ${answer.status}` : 'Google Chat didn’t answer');
  if (/insufficient authentication scopes/i.test(reason)) reason = 'Chat was connected before creating spaces was added. Disconnect Chat and connect it again in Settings → Google apps.';
  return { ok: false, status: answer?.status || 0, reason };
}

const spaceView = (s) => ({
  id: s.name,
  name: s.displayName || (s.spaceType === 'DIRECT_MESSAGE' ? 'Direct message' : 'Conversation'),
  type: s.spaceType || '',
  link: s.spaceUri || '',
});

/** A few of the account's conversations: whether Google allows Chat for it at all. */
export async function listSpaces(role, email) {
  const result = await chatRequest(role, email, '/spaces?pageSize=20');
  return result.ok ? { ok: true, spaces: (result.data.spaces || []).map(spaceView) } : result;
}

/** Checked { name, members } from a request. */
export function readSpace(input = {}) {
  const name = String(input.name || '').trim().slice(0, 128);
  if (!name) throw new HttpError(400, 'Give the space a name');
  const members = [...new Set((Array.isArray(input.members) ? input.members : String(input.members || '').split(/[,;\s]+/))
    .map((m) => String(m).trim().toLowerCase())
    .filter(Boolean))];
  const bad = members.find((m) => !VALID_EMAIL.test(m));
  if (bad) throw new HttpError(400, `“${bad.slice(0, 80)}” isn’t a valid email address`);
  if (members.length > MAX_MEMBERS) throw new HttpError(400, `Up to ${MAX_MEMBERS} people at a time`);
  return { name, members };
}

/** Create a named space with these people in it (the creator joins automatically). */
export async function createSpace(role, email, { name, members }) {
  const result = await chatRequest(role, email, '/spaces:setup', {
    method: 'POST',
    body: {
      space: { spaceType: 'SPACE', displayName: name },
      memberships: members.filter((m) => m !== email && m !== holderOf(role, email)?.google?.email?.toLowerCase()).map((m) => ({ member: { name: `users/${m}`, type: 'HUMAN' } })),
    },
  });
  return result.ok ? { ok: true, space: spaceView(result.data), members } : result;
}
