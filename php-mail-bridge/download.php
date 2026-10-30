<?php
// An attachment, straight to the browser: the app hands out a short-lived link (partLink) and
// the file comes from here, without passing through the app. Uses a running worker's open
// mailbox when there is one, otherwise logs in itself.
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
require __DIR__ . '/bridge-core.php';
require __DIR__ . '/worker-common.php';
require __DIR__ . '/upload-common.php';

header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

// Shown in the browser tab only when something goes wrong.
function download_fail(int $status, string $message): never {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

// Types a browser may show inline (never HTML or SVG, which could run scripts on this domain).
const DOWNLOAD_INLINE = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'];

try {
    $link = download_link_read((string)($_GET['id'] ?? ''));
    $bytes = null;
    $request = ['action' => 'fetchPartBytes', 'folder' => $link['folder'], 'uid' => $link['uid'], 'part' => $link['part']];
    if (config_value('MAIL_WORKER_ENABLED', 'true') === 'true') {
        try {
            $result = aliasmail_worker_request('foreground', $request, 60);
            if (is_array($result) && is_string($result['bytes'] ?? null)) $bytes = base64_decode($result['bytes'], true);
        } catch (Throwable $error) {
            error_log('[AliasMail download] Worker unavailable; reading the mailbox directly');
        }
    }
    if (!is_string($bytes)) {
        $result = handle($request);
        $bytes = is_string($result['bytes'] ?? null) ? base64_decode($result['bytes'], true) : null;
    }
    if (!is_string($bytes)) download_fail(404, 'This message was deleted from the mailbox.');

    $type = strtolower(trim(explode(';', $link['contentType'])[0]));
    $inline = !empty($_GET['inline']) && in_array($type, DOWNLOAD_INLINE, true);
    $name = $link['filename'];
    $ascii = preg_replace('/[^\x20-\x7e]|["\\\\]/', '_', $name);
    header('Content-Type: ' . ($inline ? ($type === 'text/plain' ? 'text/plain; charset=utf-8' : $type) : 'application/octet-stream'));
    header('Content-Length: ' . strlen($bytes));
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name));
    echo $bytes;
} catch (Throwable $error) {
    error_log('[AliasMail download] ' . $error->getMessage());
    download_fail(410, $error->getMessage());
}
