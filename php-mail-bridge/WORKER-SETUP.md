# Deploy the persistent PHP mail worker

This optional release keeps IMAP sessions open on the existing PHP bridge host.
The Node app still uses MAIL_TRANSPORT=bridge and the same HTTPS bridge URL/token.
No Node or database configuration change is needed for this worker release.

## 1. Back up and upload the PHP files

Back up the current bridge index.php and .htaccess. Extract php-mail-worker.zip.
Upload ALL files from its php-mail-bridge folder into:
  ~/public_html/php-mail-bridge/

Files: index.php, bridge-core.php, worker-common.php, worker.php, settings.php,
.htaccess, and WORKER-SETUP.md. Ensure hidden .htaccess is included.

Preserve your EXISTING settings.local.php or external aliasmail-settings.php.
The package deliberately excludes credentials. settings.php is only the existing
loader for your private settings. Do not replace your private settings with examples.

Upload bridge-core.php and worker-common.php before replacing index.php, so a
request cannot encounter index.php without its required libraries. Start the worker
only after all files are present. Without a running worker, reads use the original
IMAP bridge path.

The default private directory is ~/.aliasmail-worker (outside public_html).
The web PHP process and CLI process must run as the same account and both be allowed
to access this directory. MAIL_WORKER_DIR may override this with an absolute Linux
path outside public_html. Keep the directory 0700 and sockets 0600. No public port
is opened.

## 2. Start workers through GoDaddy Terminal/SSH

  cd ~/public_html/php-mail-bridge
  php worker.php start

Wait a few seconds for the first IMAP logins, then:

  php worker.php status

Both foreground and background should report running:true. Status shows pid,
uptimeSeconds, requests, connections, logins and reconnects. A busy worker can
temporarily report busyOrUnavailable; check again after its request finishes.

Each worker warms an INBOX login. Other folders open lazily and are reused.
Foreground handles message opens. Background handles sync and prefetch.
Keepalive checks run about every 30 seconds. Disconnects trigger reconnection with
backoff. Sessions are read-only; SMTP, moves, deletes and saving Sent copies stay
on the regular bridge. The worker uses keepalive polling, not server-pushed IDLE.

If start fails:
  tail -n 30 ~/.aliasmail-worker/foreground.log
  tail -n 30 ~/.aliasmail-worker/background.log

If PHP exec() is disabled but your terminal allows background jobs, start manually:

  mkdir -p "$HOME/.aliasmail-worker"
  chmod 700 "$HOME/.aliasmail-worker"
  nohup php worker.php run --lane=foreground >> "$HOME/.aliasmail-worker/foreground.log" 2>&1 < /dev/null &
  nohup php worker.php run --lane=background >> "$HOME/.aliasmail-worker/background.log" 2>&1 < /dev/null &

If you previously ran stop, use start to clear the disabled marker before launching
manually. If exec remains disabled, remove ONLY ~/.aliasmail-worker/disabled to
re-enable manually; leave the lock files alone. For a custom MAIL_WORKER_DIR,
substitute that private path in the commands above.

## 3. Check performance and actual reuse

  php worker.php bench

This performs read-only inbox sync and message-fetch tests and prints timings,
not message contents. Run it twice and compare status: logins should stay stable
unless a server disconnect occurred. The authenticated HTTPS bridge also accepts
action=workerStatus. Successful HTTP reads served by a worker include transport=worker
and workerLane; ordinary fallback responses do not.

Open the web mailbox and confirm messages and read/unread state work. Keeping
sessions open removes repeated IMAP logins but does not remove all network delays.

## 4. Check that it survives logout

Record the PIDs shown by status, close SSH, wait several minutes, reconnect and run:

  cd ~/public_html/php-mail-bridge
  php worker.php status

The same PIDs and increasing uptime confirm that those workers survived logout.
A five-minute foreground probe alone does not prove this.

## 5. Add a cron watchdog

Print a command containing this host's actual PHP binary and script paths:

  php worker.php cron

In cPanel -> Cron Jobs, add the printed command with every field set to * (once
per minute). Do not paste the JSON wrapper: copy only the command value.
ensure starts missing workers and file locks prevent duplicate instances.
It honors the disabled marker created by stop.

If start is disabled by hosting, the automatic ensure command cannot start it
either. Confirm hosting worker support or use a VPS; do not repeatedly launch
overlapping infinite jobs. Cron recovery can leave up to a minute of downtime,
during which the HTTP bridge falls back to its existing per-request IMAP path.

## Stop, update or roll back

  php worker.php stop

This disables cron restarts and requests clean shutdown. Wait for both status
entries to stop before updating worker code. A request already in progress may
need time to finish.

To re-enable after an update:
  php worker.php start

To bypass workers without changing the Node app, set MAIL_WORKER_ENABLED=false
in the private PHP settings, then stop the workers. The complete current PHP
package works without workers.

For a full rollback, restore your backed-up original index.php and .htaccess.
Keep all private settings unchanged. Never delete or replace database data or
JWT_SECRET as part of this worker deployment.

## Validation limits

Local tests cover connection pooling/recovery, bounded framing, authentication,
read-only routing, UID addressing, error handling and HTTP fallback. Local PHP
lacks IMAP and Windows lacks the production Unix socket transport. The real
long-running workers must therefore be validated on the GoDaddy Linux host.
Hosting may still kill detached processes; that restriction cannot be overridden
by application code.
