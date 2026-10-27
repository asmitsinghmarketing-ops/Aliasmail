// Security activity log: sign-ins, failures, lockouts and security changes, shown to the admin.
import { db, save } from './store.js';
import { clientIp, describeDevice } from './security.js';
import { locate } from './geo.js';

const MAX_ENTRIES = 2000;

export function audit(req, event, account = '', detail = '') {
  const log = db().audit;
  const entry = {
    at: new Date().toISOString(),
    event,
    account,
    ip: req ? clientIp(req) : '',
    agent: req ? describeDevice(req).label : '',
    location: null,
    detail,
  };
  log.push(entry);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  save();
  // Approximate location, filled in when the lookup answers (cached per IP).
  if (entry.ip) {
    void locate(entry.ip).then((found) => {
      if (found) {
        entry.location = found.place;
        entry.isp = found.isp;
        save();
      }
    });
  }
}
