<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
require __DIR__ . '/bridge-core.php';
require __DIR__ . '/worker-common.php';
require __DIR__ . '/upload-common.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $status, array $data): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
foreach (['MAIL_USER', 'MAIL_PASSWORD', 'MAIL_BRIDGE_TOKEN'] as $required) {
    if (config_value($required) === '') reply(503, ['error' => 'PHP mail bridge is missing required configuration']);
}
$expected = config_value('MAIL_BRIDGE_TOKEN');
$provided = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
if (!hash_equals('Bearer ' . $expected, $provided)) reply(401, ['error' => 'Unauthorized']);
if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['error' => 'Method not allowed']);
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) reply(400, ['error' => 'Invalid JSON']);
try {
    $action = (string)($body['action'] ?? '');
    if ($action === 'workerStatus') reply(200, aliasmail_worker_status());
    if ($action === 'startUpload') reply(200, upload_start($body));
    if ($action === 'consumeUpload') reply(200, upload_consume((string)($body['uploadId'] ?? ''), (string)($body['owner'] ?? '')));
    if ($action === 'deleteUpload') reply(200, upload_delete((string)($body['uploadId'] ?? ''), (string)($body['owner'] ?? '')));
    if ($action === 'startRaw') reply(200, raw_start((int)($body['size'] ?? 0), (string)($body['sha256'] ?? '')));
    if ($action === 'appendRaw') reply(200, raw_append((string)($body['rawId'] ?? ''), (string)($body['chunk'] ?? '')));
    if ($action === 'sendStagedRaw') {
        $rawId = (string)($body['rawId'] ?? '');
        $timing = smtp_send_raw(raw_read($rawId), (array)($body['envelope'] ?? []));
        reply(200, ['ok' => true, 'rawId' => $rawId, 'timing' => $timing]);
    }
    // A message whose attachments were uploaded here: the files are put in on this side, sent,
    // then deleted. The finished message is kept briefly for saveStagedSent (the Sent copy).
    if ($action === 'sendWithUploads') {
        $stagedId = (string)($body['rawId'] ?? '');
        $raw = $stagedId !== '' ? raw_read($stagedId) : base64_decode((string)($body['raw'] ?? ''), true);
        if ($raw === false || $raw === '') throw new RuntimeException('Invalid message');
        $owner = (string)($body['owner'] ?? ''); $uploads = array_map('strval', (array)($body['uploads'] ?? []));
        $spliceStart = microtime(true);
        $full = upload_splice($raw, $uploads, $owner);
        $spliceMs = (int)round((microtime(true) - $spliceStart) * 1000);
        $timing = ['attachMs' => $spliceMs] + smtp_send_raw($full, (array)($body['envelope'] ?? []));
        if ($stagedId !== '') raw_delete($stagedId);
        foreach ($uploads as $uploadId) { try { upload_delete($uploadId, $owner); } catch (Throwable $ignored) {} }
        reply(200, ['ok' => true, 'rawId' => raw_store($full), 'uploadsDeleted' => true, 'timing' => $timing]);
    }
    // Forwarding a large attachment: copied from the mailbox straight into an upload here, so
    // it is attached by sendWithUploads without travelling to the app and back.
    if ($action === 'uploadFromPart') {
        [$imap] = imap_open_folder((string)($body['folder'] ?? 'inbox'));
        try { $bytes = imap_part_bytes($imap, (int)($body['uid'] ?? 0), (string)($body['part'] ?? '')); }
        finally { imap_release($imap); }
        if ($bytes === null) throw new RuntimeException('This message was deleted from the mailbox');
        reply(200, upload_store_completed($bytes, (string)($body['owner'] ?? ''), (string)($body['filename'] ?? ''), (string)($body['contentType'] ?? '')));
    }
    // A short-lived link for the browser to download one attachment straight from download.php.
    if ($action === 'partLink') {
        reply(200, download_link_create((string)($body['folder'] ?? 'inbox'), (int)($body['uid'] ?? 0), (string)($body['part'] ?? ''),
            (string)($body['filename'] ?? ''), (string)($body['contentType'] ?? '')));
    }
    if ($action === 'saveStagedSent') {
        $rawId = (string)($body['rawId'] ?? ''); $raw = raw_read($rawId);
        [$imap] = imap_open_folder('sent', false);
        try {
            $box = '{'.config_value('IMAP_HOST','imap.secureserver.net').':'.config_value('IMAP_PORT','993').'/imap/ssl}'.mailbox_name('sent');
            if (!imap_append($imap, $box, $raw, '\\Seen')) throw new RuntimeException('Could not append message to Sent: '.(imap_last_error() ?: 'unknown error'));
        } finally { imap_release($imap); }
        raw_delete($rawId); reply(200, ['ok' => true]);
    }
    // Only idempotent reads can fall back after a worker timeout. Mutations and
    // SMTP stay on the original bridge, so a lost response never duplicates them.
    if (config_value('MAIL_WORKER_ENABLED', 'true') === 'true' && in_array($action, ['sync', 'fetch', 'fetchMany', 'fetchLite', 'fetchPart'], true)) {
        // Opening a message and the quick every-few-seconds inbox check are foreground, so new mail
        // never waits behind preloading; full syncs, prefetch and anything marked background are not.
        $lane = (in_array($action, ['fetch', 'fetchLite', 'fetchPart'], true) && empty($body['background'])) || ($action === 'sync' && !empty($body['quick']))
            ? 'foreground' : 'background';
        try {
            $result = aliasmail_worker_request($lane, $body);
            if ($result !== null) reply(200, $result + ['transport' => 'worker', 'workerLane' => $lane]);
        } catch (Throwable $error) {
            error_log('[AliasMail worker] Read unavailable; falling back to regular bridge');
        }
    }
    reply(200, handle($body));
} catch (Throwable $error) {
    error_log('[AliasMail bridge] ' . $error->getMessage());
    reply(502, ['error' => $error->getMessage()]);
}
