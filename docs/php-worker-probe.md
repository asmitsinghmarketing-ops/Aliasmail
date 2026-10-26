# Test PHP connection reuse on the bridge host

This is a diagnostic only. It does not change the running bridge or install a worker.
The local Windows PHP CLI is missing IMAP; the host's PHP CLI must have the IMAP
extension even if its web PHP already does.

1. Upload connection-probe.php beside the existing PHP bridge settings.php.
   Update .htaccess too; the script is also restricted to command-line PHP.
   Preserve settings.local.php or the external private aliasmail-settings.php.
2. Use SSH/cPanel Terminal, preferably with the script and private settings outside
   public_html. Run: php connection-probe.php --seconds=300 --interval=30
   If CLI uses a different PHP binary, use the hosting-supported IMAP-enabled binary.
   Use ALIASMAIL_SETTINGS_FILE if CLI needs the explicit path to private settings.
3. Wait for the complete event. The probe logs one login and periodic NOOP timings;
   it never reads message bodies or alters flags. Stop it with Ctrl+C if needed.
4. A disconnected result or missing complete line may mean a network disconnect or
   a hosting process/time limit. Check the terminal and hosting logs.
5. A completed five-minute test proves short-term reuse, not permission or reliability
   for a 24/7 daemon. Confirm worker support with the hosting provider before deployment.

If only cron is available, a finite worker can be tested there, but cron alone does
not guarantee continuous execution. Do not launch overlapping infinite PHP jobs.
The optional worker release now supplies connection pooling, private local sockets,
single-instance locks, reconnect behavior and cron restart support; see php-worker.md.
The original bridge still opens an IMAP session per HTTP request until that worker
package is uploaded and its worker processes are started.
