# Mail loading and hosting

## Current bridge hosting

Keep MAIL_TRANSPORT=bridge on the live Node host because its IMAP port is blocked.
Keep the existing MAIL_BRIDGE_URL and MAIL_BRIDGE_TOKEN. The mailbox password can
remain only on the PHP host.

The app now persists compressed, encrypted raw message bodies, including their
attachments, so a message opened before a Node restart can be read without another
bridge request. It first checks memory, then persistent storage, then the mail
server. Background prefetch also uses this cache. Messages above 5 MB bypass this
cache; MESSAGE_CACHE_MB (default 250) and MESSAGE_CACHE_DAYS (default 30) control
retention. Limits are pruned periodically as messages are saved, so storage can
briefly exceed the configured budget between cleanup passes.

Keep JWT_SECRET stable: it encrypts message bodies as well as authenticator data.
Keep DATABASE_URL configured on hosts that replace local files during deployment.
The SQL backend creates app_mail_cache alongside the existing tables; local mode
stores private files in mail-cache/ beside DATA_FILE, outside the static client.
Deletion and UIDVALIDITY changes invalidate matching cache entries. The existing
message routes still check alias ownership before returning cached content.

Folder lists are reused in browser memory and refreshed in the background. The
server sends invalidation events after sync so active mailboxes refresh without
waiting for the browser's 30-second poll. Polling remains available if the hosting
proxy buffers streaming responses. Bridge-mode new mail still depends on the
configured server sync interval.

A regular PHP request cannot keep its IMAP session open between HTTP requests.
The optional PHP worker release reuses sessions through private local sockets on
the PHP host; see php-worker.md. Without that worker, first-time downloads still
incur the bridge's login and connection latency. The Node host remains in bridge mode.

## Optional direct IMAP on suitable hosting

For a VPS or another host that permits outbound IMAP, set MAIL_TRANSPORT=direct
and configure MAIL_USER, MAIL_PASSWORD and the IMAP settings on the Node host.
The service reuses two authenticated sessions: background INBOX work/IDLE and
foreground work. Disconnects trigger reconnect with backoff. UID/flag changes
from the inbox session schedule a sync; the periodic sync is retained. Connections
close on application shutdown. No mail server guarantees a connection never closes.

MAIL_TRANSPORT=auto tries direct access and falls back to the configured bridge
for five minutes when connection/login fails. Keep MAIL_TRANSPORT=bridge on the
current restricted host to avoid failed connection attempts. Send/move/delete
operations are not retried through a second transport after an ambiguous failure.
When a bridge is configured, SMTP continues through it.

## Deploy and verify

Deploy the updated Node source and built client together; keep existing environment,
database, credentials and private PHP settings. No PHP bridge change is required
for this cache release. Restart Node and hard-refresh the browser.

Run npm test --prefix server and npm run build --prefix client locally. After
deployment, open a message, restart Node, and open the same message again. The
second open should use persistent storage. Initial uncached messages still need
the bridge. Live database and hosting latency must be checked after deployment.
