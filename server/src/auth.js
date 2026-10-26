import crypto from 'node:crypto';
import { findAlias, typeOf } from './aliases.js';
import { HttpError } from './errors.js';
import { currentSession, endSessions } from './sessions.js';

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Require a signed-in session; `role` limits the route to 'admin' or 'user'. */
export function requireAuth(role) {
  return (req, res, next) => {
    const session = currentSession(req);
    if (!session) throw new HttpError(401, 'Please sign in again');
    const account = session.role === 'user' ? findAlias(session.email) : null;
    if (session.role === 'user' && (!account?.active || typeOf(account) === 'group')) {
      endSessions((s) => s.id === session.id);
      throw new HttpError(401, 'This alias has been disabled');
    }
    if (role && session.role !== role) throw new HttpError(403, 'Not allowed');
    req.user = { role: session.role, email: session.email };
    req.session = session;
    next();
  };
}
