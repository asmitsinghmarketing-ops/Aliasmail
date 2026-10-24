// Security activity log: sign-ins, failures, lockouts and security changes, shown to the admin.
import { db, save } from './store.js';
import { clientIp, describeAgent } from './security.js';

const MAX_ENTRIES = 2000;

export function audit(req, event, account = '', detail = '') {
  const log = db().audit;
  log.push({
    at: new Date().toISOString(),
    event,
    account,
    ip: req ? clientIp(req) : '',
    agent: req ? describeAgent(req.headers['user-agent']) : '',
    detail,
  });
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  save();
}
