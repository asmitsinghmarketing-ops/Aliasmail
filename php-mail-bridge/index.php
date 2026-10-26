<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
require __DIR__ . '/bridge-core.php';
require __DIR__ . '/worker-common.php';

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
    // Only idempotent reads can fall back after a worker timeout. Mutations and
    // SMTP stay on the original bridge, so a lost response never duplicates them.
    if (config_value('MAIL_WORKER_ENABLED', 'true') === 'true' && in_array($action, ['sync', 'fetch', 'fetchMany'], true)) {
        $lane = $action === 'fetch' ? 'foreground' : 'background';
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
