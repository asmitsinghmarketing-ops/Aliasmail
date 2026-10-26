<?php
declare(strict_types=1);
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__ && PHP_SAPI !== 'cli') {
    http_response_code(403); exit;
}

// Local socket protocol: bounded length-prefixed JSON, not an exposed HTTP port.
const ALIASMAIL_WORKER_MAX_REQUEST = 8 * 1024 * 1024;
const ALIASMAIL_WORKER_MAX_RESPONSE = 64 * 1024 * 1024;

function aliasmail_frame_write($stream, array $value, int $limit): void {
    $json = json_encode($value, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    if (strlen($json) > $limit) throw new RuntimeException('Worker message exceeds limit');
    $data = pack('N', strlen($json)) . $json;
    $offset = 0;
    while ($offset < strlen($data)) {
        $written = @fwrite($stream, substr($data, $offset, 65536));
        if (!$written) throw new RuntimeException('Worker socket write failed');
        $offset += $written;
    }
}

function aliasmail_read_exact($stream, int $length): string {
    $data = '';
    while (strlen($data) < $length) {
        $part = @fread($stream, min(65536, $length - strlen($data)));
        if ($part === false || $part === '') throw new RuntimeException('Worker socket closed or timed out');
        $data .= $part;
    }
    return $data;
}

function aliasmail_frame_read($stream, int $limit): array {
    $size = unpack('Nlength', aliasmail_read_exact($stream, 4))['length'];
    if ($size < 2 || $size > $limit) throw new RuntimeException('Invalid worker frame size');
    $value = json_decode(aliasmail_read_exact($stream, $size), true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($value)) throw new RuntimeException('Invalid worker message');
    return $value;
}

function aliasmail_worker_dir(): string {
    $default = dirname(__DIR__, 2) . '/.aliasmail-worker';
    $dir = rtrim(config_value('MAIL_WORKER_DIR', $default), '/');
    if ($dir === '' || $dir[0] !== '/') throw new RuntimeException('MAIL_WORKER_DIR must be an absolute Linux path outside public_html');
    $normalized = str_replace('\\', '/', $dir);
    if (str_contains($normalized, '/public_html/') || str_ends_with($normalized, '/public_html') ||
        preg_match('~/(?:\.\.?)(?:/|$)~', $normalized)) {
        throw new RuntimeException('Worker sockets and logs must be outside public_html');
    }
    return $dir;
}

function aliasmail_worker_socket(string $lane): string {
    if (!in_array($lane, ['foreground', 'background'], true)) throw new RuntimeException('Unknown worker lane');
    $socket = aliasmail_worker_dir() . '/' . $lane . '.sock';
    if (strlen($socket) > 100) throw new RuntimeException('MAIL_WORKER_DIR is too long for a Unix socket');
    return $socket;
}

function aliasmail_worker_request(string $lane, array $body, int $timeout = 12): ?array {
    if (PHP_OS_FAMILY === 'Windows') return null;
    $path = aliasmail_worker_socket($lane);
    if (!file_exists($path)) return null;
    $stream = @stream_socket_client('unix://' . $path, $errno, $errstr, 0.25, STREAM_CLIENT_CONNECT);
    if (!$stream) return null;
    try {
        stream_set_timeout($stream, $timeout);
        $id = bin2hex(random_bytes(12));
        aliasmail_frame_write($stream, ['token' => config_value('MAIL_BRIDGE_TOKEN'), 'id' => $id, 'body' => $body], ALIASMAIL_WORKER_MAX_REQUEST);
        $reply = aliasmail_frame_read($stream, ALIASMAIL_WORKER_MAX_RESPONSE);
        if (($reply['id'] ?? '') !== $id || !($reply['ok'] ?? false) || !is_array($reply['result'] ?? null)) {
            throw new RuntimeException('Mail worker returned an error');
        }
        return $reply['result'];
    } finally { fclose($stream); }
}

function aliasmail_worker_status(): array {
    $workers = [];
    foreach (['foreground', 'background'] as $lane) {
        try { $workers[$lane] = aliasmail_worker_request($lane, ['action' => '__status'], 2) ?? ['running' => false]; }
        catch (Throwable $error) { $workers[$lane] = ['running' => false, 'busyOrUnavailable' => true]; }
    }
    return ['enabled' => config_value('MAIL_WORKER_ENABLED', 'true') === 'true', 'workers' => $workers];
}

// Callback-based pool makes connection reuse/recovery testable without IMAP.
final class AliasMailImapPool {
    private array $sessions = [];
    private array $wanted = [];
    private array $failures = [];
    private array $retryAt = [];
    private int $logins = 0;
    private int $reconnects = 0;
    public function __construct(private Closure $open, private Closure $ping, private Closure $close, private Closure $clock) {}

    public function get(string $folder): array {
        $this->wanted[$folder] = true;
        if (isset($this->sessions[$folder])) {
            try { $alive = ($this->ping)($this->sessions[$folder][0]); } catch (Throwable $error) { $alive = false; }
            if ($alive) return $this->sessions[$folder];
            $this->discard($folder);
            $this->reconnects++;
        }
        if (($this->retryAt[$folder] ?? 0) > ($this->clock)()) throw new RuntimeException('IMAP reconnect is backing off');
        try {
            $session = ($this->open)($folder);
            $this->sessions[$folder] = $session;
            $this->failures[$folder] = 0;
            $this->retryAt[$folder] = 0;
            $this->logins++;
            return $session;
        } catch (Throwable $error) {
            $attempt = min(6, ($this->failures[$folder] ?? 0) + 1);
            $this->failures[$folder] = $attempt;
            $this->retryAt[$folder] = ($this->clock)() + min(60, 2 ** $attempt);
            throw $error;
        }
    }

    private function discard(string $folder): void {
        if (!isset($this->sessions[$folder])) return;
        try { ($this->close)($this->sessions[$folder][0]); } catch (Throwable $error) {}
        unset($this->sessions[$folder]);
    }
    public function invalidate(string $folder): void { $this->discard($folder); }
    public function maintain(): void {
        foreach (array_keys($this->wanted) as $folder) {
            try { $this->get($folder); } catch (Throwable $error) {}
        }
    }
    public function stats(): array {
        return ['connections' => count($this->sessions), 'logins' => $this->logins, 'reconnects' => $this->reconnects];
    }
    public function close(): void {
        foreach (array_keys($this->sessions) as $folder) $this->discard($folder);
    }
}

function aliasmail_worker_dispatch(array $request, string $token, Closure $handle, Closure $status, Closure $stop): array {
    $id = is_string($request['id'] ?? null) ? $request['id'] : '';
    if ($token === '' || !is_string($request['token'] ?? null) || !hash_equals($token, $request['token'])) {
        return ['id' => $id, 'ok' => false, 'error' => 'Unauthorized'];
    }
    $body = $request['body'] ?? [];
    if (!is_array($body)) return ['id' => $id, 'ok' => false, 'error' => 'Invalid request'];
    $action = $body['action'] ?? '';
    try {
        if ($action === '__status') $result = $status();
        elseif ($action === '__stop') { $stop(); $result = ['stopping' => true]; }
        elseif (in_array($action, ['sync', 'fetch', 'fetchMany'], true)) $result = $handle($body);
        else return ['id' => $id, 'ok' => false, 'error' => 'Worker only accepts mail reads'];
        return ['id' => $id, 'ok' => true, 'result' => $result];
    } catch (Throwable $error) {
        error_log('[AliasMail worker] Read failed: ' . get_class($error));
        return ['id' => $id, 'ok' => false, 'error' => 'Worker read failed'];
    }
}
