<?php
declare(strict_types=1);
require dirname(__DIR__) . '/worker-common.php';
$passed = 0;
function check(bool $condition, string $message): void {
    global $passed;
    if (!$condition) throw new RuntimeException('FAIL: ' . $message);
    $passed++; echo 'PASS: ' . $message . PHP_EOL;
}
function rejects(Closure $callback, string $message): void {
    try { $callback(); } catch (Throwable $error) { check(true, $message); return; }
    check(false, $message);
}

$stream = fopen('php://temp', 'w+');
aliasmail_frame_write($stream, ['id' => 'one', 'raw' => str_repeat('x', 100000)], ALIASMAIL_WORKER_MAX_RESPONSE);
aliasmail_frame_write($stream, ['id' => 'two'], ALIASMAIL_WORKER_MAX_RESPONSE);
rewind($stream);
check(strlen(aliasmail_frame_read($stream, ALIASMAIL_WORKER_MAX_RESPONSE)['raw']) === 100000, 'large response framing');
check(aliasmail_frame_read($stream, ALIASMAIL_WORKER_MAX_RESPONSE)['id'] === 'two', 'consecutive frames');
fclose($stream);
$stream = fopen('php://temp', 'w+');
fwrite($stream, pack('N', 999)); rewind($stream);
rejects(static fn() => aliasmail_frame_read($stream, 10), 'oversized frame rejected before reading body');
fclose($stream);
$stream = fopen('php://temp', 'w+');
fwrite($stream, pack('N', 20) . '{}'); rewind($stream);
rejects(static fn() => aliasmail_frame_read($stream, 100), 'truncated frame rejected');
fclose($stream);

$opened = 0; $closed = 0; $now = 100; $fail = false;
$pool = new AliasMailImapPool(
    static function ($folder) use (&$opened, &$fail): array {
        if ($fail) throw new RuntimeException('Connection refused');
        $opened++;
        return [(object)['alive' => true, 'id' => $opened], $folder];
    },
    static fn($handle) => $handle->alive,
    static function ($handle) use (&$closed): void { $closed++; },
    static function () use (&$now) { return $now; }
);
$first = $pool->get('inbox');
check($pool->get('inbox')[0] === $first[0] && $opened === 1, 'multiple requests share one IMAP login');
$first[0]->alive = false;
$next = $pool->get('inbox');
check($opened === 2 && $closed === 1 && $next[0] !== $first[0], 'disconnected session is replaced');
$next[0]->alive = false; $fail = true;
rejects(static fn() => $pool->get('inbox'), 'failed reconnect is reported');
$fail = false;
rejects(static fn() => $pool->get('inbox'), 'reconnect backoff prevents login storm');
$now += 10;
$pool->maintain();
check($opened === 3 && $pool->stats()['connections'] === 1, 'keepalive reconnects when backoff expires');
$pool->close();
check($closed === 3, 'shutdown closes pooled connections');

$calls = 0; $stopped = false;
$handle = static function ($body) use (&$calls): array { $calls++; return ['raw' => 'test']; };
$status = static fn() => ['running' => true];
$stop = static function () use (&$stopped): void { $stopped = true; };
$dispatch = static fn($request) => aliasmail_worker_dispatch($request, 'secret', $handle, $status, $stop);
$reply = $dispatch(['id' => '1', 'token' => 'wrong', 'body' => ['action' => 'fetch']]);
check(!$reply['ok'] && $calls === 0, 'unauthorized local requests cannot read mail');
foreach (['sendRaw', 'delete', 'move', 'saveSent'] as $action) {
    $reply = $dispatch(['id' => $action, 'token' => 'secret', 'body' => ['action' => $action]]);
    check(!$reply['ok'] && $calls === 0, 'worker refuses mutation: ' . $action);
}
$reply = $dispatch(['id' => 'ok', 'token' => 'secret', 'body' => ['action' => 'fetch']]);
check($reply['ok'] && $reply['id'] === 'ok' && $calls === 1, 'authenticated read is dispatched');
$reply = $dispatch(['id' => 'status', 'token' => 'secret', 'body' => ['action' => '__status']]);
check($reply['result']['running'] && $calls === 1, 'status does not fetch mail');
$dispatch(['id' => 'stop', 'token' => 'secret', 'body' => ['action' => '__stop']]);
check($stopped, 'authenticated stop request');

if (!extension_loaded('imap')) {
    // Exercise the real shared handle() against a deterministic IMAP fixture.
    foreach (['OP_READONLY', 'IMAP_OPENTIMEOUT', 'IMAP_READTIMEOUT', 'IMAP_WRITETIMEOUT',
              'FT_UID', 'FT_PEEK', 'FT_PREFETCHTEXT', 'SA_UIDVALIDITY', 'SA_MESSAGES', 'SE_UID'] as $index => $name) define($name, 1 << $index);
    $GLOBALS['testCloseCount'] = 0;
    function imap_errors() { $errors = $GLOBALS['fixtureErrors'] ?? []; $GLOBALS['fixtureErrors'] = []; return $errors; }
    function imap_timeout(...$arguments) { return true; }
    function imap_open(...$arguments) { return (object)['alive' => true]; }
    function imap_ping($handle) { return $handle->alive; }
    function imap_close($handle) { $GLOBALS['testCloseCount']++; return true; }
    function imap_msgno($handle, $uid) { return $uid; }
    function imap_uid($handle, $number) { return $number; }
    function imap_fetchheader($handle, $number, $flags = 0) { return "Subject: Test\r\n\r\n"; }
    function imap_body($handle, $number, $flags = 0) { check(($flags & FT_PEEK) !== 0 && ($flags & FT_UID) !== 0, 'body fetch uses stable UIDs without marking read'); return 'Message body'; }
    function imap_status($handle, $box, $flags) { return (object)['uidvalidity' => 123]; }
    function imap_search($handle, $query, $flags) {
        if ($GLOBALS['fixtureSearchFails'] ?? false) { $GLOBALS['fixtureErrors'] = ['Fixture disconnect']; return false; }
        return $query === 'SEEN' ? [1] : [1, 2];
    }
    function imap_fetch_overview($handle, $uids, $flags) { return [(object)['msgno' => 1, 'uid' => 1, 'size' => 30], (object)['msgno' => 2, 'uid' => 2, 'size' => 30]]; }
    function imap_fetchstructure(...$arguments) { return (object)[]; }
    require dirname(__DIR__) . '/bridge-core.php';
    $GLOBALS['aliasmailSettings'] = ['MAIL_USER' => 'test', 'MAIL_PASSWORD' => 'test', 'MAIL_BRIDGE_TOKEN' => 'test'];
    $realPool = new AliasMailImapPool(
        static fn($folder) => imap_connect_folder($folder),
        static fn($handle) => imap_ping($handle),
        static function ($handle): void { imap_close($handle); },
        static fn() => microtime(true)
    );
    $GLOBALS['aliasmailImapPool'] = $realPool;
    handle(['action' => 'fetch', 'uid' => 1]);
    handle(['action' => 'fetch', 'uid' => 2]);
    check($GLOBALS['testCloseCount'] === 0 && $realPool->stats()['logins'] === 1, 'real bridge reads release without closing worker session');
    $synced = handle(['action' => 'sync', 'knownUidValidity' => '123', 'knownUids' => [1, 2]]);
    check($synced['seenUids'] === [1] && $synced['messages'] === [], 'worker sync preserves read-flag response contract');
    rejects(static fn() => imap_open_folder('inbox', false), 'pooled sessions cannot be opened for writes');
    $GLOBALS['fixtureSearchFails'] = true;
    rejects(static fn() => handle(['action' => 'sync']), 'search failure cannot masquerade as an empty mailbox');
    $GLOBALS['fixtureSearchFails'] = false;
    $realPool->close();
    unset($GLOBALS['aliasmailImapPool']);
    $before = $GLOBALS['testCloseCount'];
    handle(['action' => 'fetch', 'uid' => 1]);
    check($GLOBALS['testCloseCount'] === $before + 1, 'regular bridge still closes its own IMAP connection');
}
echo "Completed $passed checks" . PHP_EOL;
