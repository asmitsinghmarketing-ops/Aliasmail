<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(403); exit('Command-line only'); }
ini_set('display_errors', '0');
ini_set('log_errors', '1');
require __DIR__ . '/bridge-core.php';
require __DIR__ . '/worker-common.php';

function worker_output(array $data): void {
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . PHP_EOL;
    flush();
}
function worker_prepare_dir(): string {
    $dir = aliasmail_worker_dir();
    if (is_link($dir)) throw new RuntimeException('Worker directory must not be a symlink');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Cannot create private worker directory');
    if (!@chmod($dir, 0700) || (fileperms($dir) & 0077)) throw new RuntimeException('Worker directory must be private to this account');
    return $dir;
}
function worker_locked(string $lane): bool {
    $path = aliasmail_worker_dir() . '/' . $lane . '.lock';
    if (!file_exists($path)) return false;
    $lock = @fopen($path, 'c');
    if (!$lock) throw new RuntimeException('Cannot inspect worker lock');
    try {
        if (!flock($lock, LOCK_EX | LOCK_NB)) return true;
        flock($lock, LOCK_UN);
        return false;
    } finally { fclose($lock); }
}
function worker_run(string $lane): void {
    if (PHP_OS_FAMILY === 'Windows' || !in_array('unix', stream_get_transports(), true)) throw new RuntimeException('Workers require Linux/Unix local socket support');
    if (!function_exists('imap_open')) throw new RuntimeException('PHP CLI must have the IMAP extension enabled');
    if (config_value('MAIL_USER') === '' || config_value('MAIL_PASSWORD') === '' || config_value('MAIL_BRIDGE_TOKEN') === '') throw new RuntimeException('Private bridge settings are missing');
    umask(0077);
    $dir = worker_prepare_dir();
    if (file_exists($dir . '/disabled')) return;
    $lock = fopen($dir . '/' . $lane . '.lock', 'c');
    if (!$lock) throw new RuntimeException('Cannot open worker lock');
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        worker_output(['event' => 'already-running', 'lane' => $lane]);
        return;
    }
    $path = aliasmail_worker_socket($lane);
    $server = false;
    $pool = new AliasMailImapPool(
        static fn(string $folder) => imap_connect_folder($folder, true),
        static fn($imap) => @imap_ping($imap),
        static function ($imap): void { @imap_close($imap); },
        static fn() => microtime(true)
    );
    $GLOBALS['aliasmailImapPool'] = $pool;
    $cleaned = false;
    $cleanup = static function () use (&$cleaned, &$server, $path, $lock, $pool): void {
        if ($cleaned) return;
        $cleaned = true;
        if (is_resource($server)) fclose($server);
        $pool->close();
        @unlink($path);
        flock($lock, LOCK_UN);
        fclose($lock);
        unset($GLOBALS['aliasmailImapPool']);
    };
    register_shutdown_function($cleanup);
    try {
        // Holding the lock makes it safe to replace a socket left after a crash.
        if (file_exists($path)) unlink($path);
        $server = @stream_socket_server('unix://' . $path, $errno, $errstr, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN);
        if (!$server) throw new RuntimeException('Cannot bind local worker socket');
        chmod($path, 0600);
        stream_set_blocking($server, false);
        @set_time_limit(0);
        $running = true;
        if (function_exists('pcntl_async_signals') && function_exists('pcntl_signal')) {
            pcntl_async_signals(true);
            $stop = static function () use (&$running): void { $running = false; };
            pcntl_signal(SIGTERM, $stop);
            pcntl_signal(SIGINT, $stop);
        }
        $started = time();
        $requests = 0;
        $status = static function () use ($lane, $started, &$requests, $pool): array {
            return ['running' => true, 'lane' => $lane, 'pid' => getmypid(), 'uptimeSeconds' => time() - $started, 'requests' => $requests] + $pool->stats();
        };
        worker_output(['event' => 'started', 'lane' => $lane, 'pid' => getmypid()]);
        try { $pool->get('inbox'); } catch (Throwable $error) { error_log('[AliasMail worker] Initial IMAP connection unavailable; reconnect will be attempted'); }
        $nextMaintenance = microtime(true) + 30;
        while ($running && !file_exists($dir . '/disabled')) {
            $read = [$server]; $write = null; $except = null;
            $ready = @stream_select($read, $write, $except, 1);
            if ($ready) {
                $client = @stream_socket_accept($server, 0);
                if ($client) {
                    try {
                        stream_set_blocking($client, true);
                        stream_set_timeout($client, 5);
                        $request = aliasmail_frame_read($client, ALIASMAIL_WORKER_MAX_REQUEST);
                        $result = aliasmail_worker_dispatch(
                            $request, config_value('MAIL_BRIDGE_TOKEN'),
                            static function (array $body) use (&$requests, $pool): array {
                                $requests++;
                                try { return handle($body); }
                                catch (Throwable $error) {
                                    $pool->invalidate((string)($body['folder'] ?? 'inbox'));
                                    throw $error;
                                }
                            },
                            $status,
                            static function () use (&$running): void { $running = false; }
                        );
                        stream_set_timeout($client, 12);
                        aliasmail_frame_write($client, $result, ALIASMAIL_WORKER_MAX_RESPONSE);
                    } catch (Throwable $error) {
                        error_log('[AliasMail worker] Client request failed: ' . get_class($error));
                    } finally {
                        fclose($client);
                        // Clear c-client notices so a long-lived process does not accumulate them.
                        imap_errors(); imap_alerts();
                    }
                }
            }
            if (microtime(true) >= $nextMaintenance) {
                $pool->maintain();
                imap_errors(); imap_alerts();
                $nextMaintenance = microtime(true) + 30;
            }
        }
        worker_output(['event' => 'stopped', 'lane' => $lane]);
    } finally { $cleanup(); }
}

function worker_start(bool $ensure): void {
    if (!function_exists('imap_open')) throw new RuntimeException('PHP CLI must have the IMAP extension enabled');
    if (PHP_OS_FAMILY === 'Windows') throw new RuntimeException('Run this command on the Linux PHP bridge host');
    $dir = worker_prepare_dir();
    if ($ensure && file_exists($dir . '/disabled')) {
        worker_output(['event' => 'disabled', 'note' => 'Use start to re-enable workers']);
        return;
    }
    if (!$ensure && file_exists($dir . '/disabled')) unlink($dir . '/disabled');
    foreach (['foreground', 'background'] as $lane) {
        if (worker_locked($lane)) continue;
        if (!function_exists('exec')) throw new RuntimeException('exec is disabled; use the manual nohup commands in WORKER-SETUP.md');
        $log = $dir . '/' . $lane . '.log';
        $command = 'nohup ' . escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) .
            ' run --lane=' . escapeshellarg($lane) . ' >> ' . escapeshellarg($log) . ' 2>&1 < /dev/null &';
        exec($command, $output, $exitCode);
        if ($exitCode !== 0) throw new RuntimeException('Could not launch worker. Check hosting process restrictions.');
    }
    // Starting can include cold IMAP logins; status also reports a busy worker.
    usleep(500000);
    worker_output(aliasmail_worker_status());
}

try {
    $command = $argv[1] ?? 'help';
    $lane = 'foreground';
    foreach (array_slice($argv, 2) as $argument) {
        if (str_starts_with($argument, '--lane=')) $lane = substr($argument, 7);
        else throw new RuntimeException('Unknown option');
    }
    if (!in_array($lane, ['foreground', 'background'], true)) throw new RuntimeException('Lane must be foreground or background');
    if ($command === 'run') worker_run($lane);
    elseif ($command === 'start' || $command === 'ensure') worker_start($command === 'ensure');
    elseif ($command === 'status') worker_output(aliasmail_worker_status());
    elseif ($command === 'stop') {
        $dir = worker_prepare_dir();
        if (file_put_contents($dir . '/disabled', "Stopped by operator\n") === false) throw new RuntimeException('Cannot disable automatic restart');
        foreach (['foreground', 'background'] as $name) {
            try { aliasmail_worker_request($name, ['action' => '__stop'], 2); } catch (Throwable $error) {}
        }
        worker_output(['event' => 'stop-requested', 'note' => 'Cron ensure is disabled until start is run']);
    } elseif ($command === 'cron') {
        $dir = worker_prepare_dir();
        worker_output(['schedule' => '* * * * *', 'command' => escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) .
            ' ensure >> ' . escapeshellarg($dir . '/supervisor.log') . ' 2>&1']);
    } elseif ($command === 'bench') {
        $start = microtime(true);
        $first = aliasmail_worker_request('background', ['action' => 'sync', 'folder' => 'inbox', 'knownUids' => []], 25);
        if ($first === null) throw new RuntimeException('Background worker is not running');
        worker_output(['event' => 'first-batch', 'milliseconds' => (int)round((microtime(true) - $start) * 1000), 'messages' => count($first['messages'] ?? [])]);
        $start = microtime(true);
        $second = aliasmail_worker_request('background', ['action' => 'sync', 'folder' => 'inbox', 'knownUids' => $first['uids'], 'knownUidValidity' => $first['uidValidity']], 25);
        if ($second === null) throw new RuntimeException('Background worker stopped');
        worker_output(['event' => 'steady-sync', 'milliseconds' => (int)round((microtime(true) - $start) * 1000)]);
        $uids = $first['uids'] ?? [];
        if ($uids) {
            $start = microtime(true);
            $body = aliasmail_worker_request('foreground', ['action' => 'fetch', 'folder' => 'inbox', 'uid' => max($uids)], 25);
            if ($body === null) throw new RuntimeException('Foreground worker is not running');
            worker_output(['event' => 'message-fetch', 'milliseconds' => (int)round((microtime(true) - $start) * 1000), 'found' => !empty($body['raw'])]);
        }
        worker_output(aliasmail_worker_status());
    } elseif ($command === 'help' || $command === '--help') {
        echo "Usage: php worker.php start|status|bench|stop|ensure|cron\n";
        echo "Manual foreground process: php worker.php run --lane=foreground\n";
        echo "Manual background process: php worker.php run --lane=background\n";
    } else throw new RuntimeException('Unknown command; run php worker.php help');
} catch (Throwable $error) {
    worker_output(['event' => 'error', 'error' => $error->getMessage()]);
    exit(1);
}
