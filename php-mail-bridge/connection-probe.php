<?php
declare(strict_types=1);

// Run over SSH/Terminal, never as an HTTP request. Reads no message bodies and
// changes no flags. Uses the same private settings as the existing mail bridge.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Command-line only');
}
ini_set('display_errors', '0');
ini_set('log_errors', '1');

function probe_output(array $data): void {
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . PHP_EOL;
    flush();
}
$options = getopt('', ['seconds:', 'interval:', 'help']);
if (isset($options['help'])) {
    echo 'Usage: php connection-probe.php --seconds=300 --interval=30' . PHP_EOL;
    echo 'Keeps one read-only IMAP session open; does not fetch message bodies.' . PHP_EOL;
    exit(0);
}
$seconds = filter_var($options['seconds'] ?? '300', FILTER_VALIDATE_INT);
$interval = filter_var($options['interval'] ?? '30', FILTER_VALIDATE_INT);
if ($seconds === false || $seconds < 1 || $seconds > 3600 ||
    $interval === false || $interval < 1 || $interval > 300 || $interval > $seconds) {
    probe_output(['event' => 'error', 'error' => 'Use seconds=1..3600 and interval=1..300, with interval <= seconds']);
    exit(2);
}
if (!extension_loaded('imap')) {
    probe_output(['event' => 'unsupported', 'error' => 'PHP CLI IMAP extension is missing. The CLI and website can use different PHP configurations.']);
    exit(2);
}
require __DIR__ . '/settings.php';
$setting = static function (string $name, string $fallback = ''): string {
    $value = ($GLOBALS['aliasmailSettings'] ?? [])[$name] ?? getenv($name);
    return (string)(($value === false || $value === null || $value === '') ? $fallback : $value);
};
if ($setting('MAIL_USER') === '' || $setting('MAIL_PASSWORD') === '') {
    probe_output(['event' => 'error', 'error' => 'Configure the existing private bridge settings for CLI PHP']);
    exit(2);
}
@set_time_limit(0);
imap_timeout(IMAP_OPENTIMEOUT, 10);
imap_timeout(IMAP_READTIMEOUT, 15);
imap_timeout(IMAP_WRITETIMEOUT, 15);
$host = $setting('IMAP_HOST', 'imap.secureserver.net');
$port = $setting('IMAP_PORT', '993');
$flags = $setting('IMAP_SECURE', 'true') === 'true' ? '/imap/ssl' : '/imap/notls';
$box = '{' . $host . ':' . $port . $flags . '}' . $setting('MAIL_INBOX_FOLDER', 'INBOX');
$start = microtime(true);
$imap = @imap_open($box, $setting('MAIL_USER'), $setting('MAIL_PASSWORD'), OP_READONLY, 1);
if (!$imap) {
    imap_errors(); imap_alerts();
    probe_output(['event' => 'error', 'error' => 'IMAP login failed. Check the CLI configuration and outbound connectivity.']);
    exit(1);
}
register_shutdown_function(static function () use ($imap): void {
    @imap_close($imap);
    imap_errors(); imap_alerts();
});
$loginMs = (int)round((microtime(true) - $start) * 1000);
probe_output(['event' => 'connected', 'pid' => getmypid(), 'loginMs' => $loginMs, 'logins' => 1, 'durationSeconds' => $seconds]);
$connectedAt = microtime(true);
$checks = 0;
$totalCheckMs = 0;
do {
    $remaining = $seconds - (microtime(true) - $connectedAt);
    if ($remaining <= 0) break;
    usleep((int)min($interval * 1000000, $remaining * 1000000));
    $checkStart = microtime(true);
    if (!@imap_ping($imap)) {
        imap_errors(); imap_alerts();
        probe_output(['event' => 'disconnected', 'elapsedSeconds' => (int)round(microtime(true) - $connectedAt), 'successfulChecks' => $checks]);
        exit(1);
    }
    $checkMs = (int)round((microtime(true) - $checkStart) * 1000);
    $totalCheckMs += $checkMs;
    $checks++;
    probe_output(['event' => 'alive', 'elapsedSeconds' => (int)round(microtime(true) - $connectedAt), 'checkMs' => $checkMs, 'logins' => 1]);
} while (microtime(true) - $connectedAt < $seconds);
probe_output(['event' => 'complete', 'elapsedSeconds' => (int)round(microtime(true) - $connectedAt), 'successfulChecks' => $checks,
    'loginMs' => $loginMs, 'averageCheckMs' => $checks ? (int)round($totalCheckMs / $checks) : 0, 'logins' => 1,
    'note' => 'A successful finite probe does not prove that hosting permits a 24/7 worker.']);
