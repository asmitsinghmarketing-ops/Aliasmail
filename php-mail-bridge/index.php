<?php
declare(strict_types=1);

// Private AliasMail transport bridge. Keep this file outside the web root when possible and
// expose it only over HTTPS. Configure credentials in the hosting control panel, not in Git.
require __DIR__ . '/settings.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $status, array $data): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function config_value(string $key, string $fallback = ''): string {
    $settings = $GLOBALS['aliasmailSettings'] ?? [];
    $value = $settings[$key] ?? getenv($key);
    return (string)(($value === false || $value === null || $value === '') ? $fallback : $value);
}

foreach (['MAIL_USER', 'MAIL_PASSWORD', 'MAIL_BRIDGE_TOKEN'] as $required) {
    if (config_value($required) === '') reply(503, ['error' => 'PHP mail bridge is missing required configuration']);
}

function mailbox_name(string $folder): string {
    $key = match ($folder) {
        'inbox' => 'MAIL_INBOX_FOLDER', 'sent' => 'MAIL_SENT_FOLDER',
        'spam' => 'MAIL_SPAM_FOLDER', 'trash' => 'MAIL_TRASH_FOLDER',
        default => '',
    };
    if ($key === '') throw new RuntimeException('Unknown mail folder');
    return config_value($key, match ($folder) { 'inbox' => 'INBOX', 'sent' => 'Sent', 'spam' => 'Junk', 'trash' => 'Trash' });
}

function imap_open_folder(string $folder, bool $readOnly = true) {
    if (!function_exists('imap_open')) throw new RuntimeException('PHP IMAP extension is not enabled');
    $host = config_value('IMAP_HOST', 'imap.secureserver.net');
    $port = config_value('IMAP_PORT', '993');
    $flags = config_value('IMAP_SECURE', 'true') === 'true' ? '/imap/ssl' : '/imap/notls';
    $box = '{' . $host . ':' . $port . $flags . '}' . mailbox_name($folder);
    $stream = @imap_open($box, config_value('MAIL_USER'), config_value('MAIL_PASSWORD'), $readOnly ? OP_READONLY : 0, 1);
    if (!$stream) throw new RuntimeException('IMAP login failed: ' . (imap_last_error() ?: 'unknown error'));
    return [$stream, $box];
}

function connect_imap(): array {
    return imap_open_folder('inbox');
}

function structure_has_attachments($part): bool {
    if (!$part) return false;
    if (isset($part->disposition) && strtolower((string)$part->disposition) === 'attachment') return true;
    foreach ($part->parameters ?? [] as $parameter) if (in_array(strtolower((string)$parameter->attribute), ['name', 'filename'], true)) return true;
    foreach ($part->dparameters ?? [] as $parameter) if (in_array(strtolower((string)$parameter->attribute), ['name', 'filename'], true)) return true;
    foreach ($part->parts ?? [] as $child) if (structure_has_attachments($child)) return true;
    return false;
}

function smtp_command($socket, string $command, array $codes): string {
    if ($command !== '') fwrite($socket, $command . "\r\n");
    $reply = '';
    do {
        $line = fgets($socket, 2048);
        if ($line === false) throw new RuntimeException('SMTP connection closed');
        $reply .= $line;
    } while (strlen($line) >= 4 && $line[3] === '-');
    $code = (int)substr($reply, 0, 3);
    if (!in_array($code, $codes, true)) throw new RuntimeException('SMTP rejected command: ' . trim($reply));
    return $reply;
}

function smtp_open() {
    $host = config_value('SMTP_HOST', 'smtpout.secureserver.net');
    $port = (int)config_value('SMTP_PORT', '465');
    $secure = config_value('SMTP_SECURE', 'true') === 'true';
    $target = ($secure && $port === 465 ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $socket = @stream_socket_client($target, $errno, $errstr, 15, STREAM_CLIENT_CONNECT);
    if (!$socket) throw new RuntimeException("SMTP connection failed: $errstr ($errno)");
    stream_set_timeout($socket, 15);
    smtp_command($socket, '', [220]);
    smtp_command($socket, 'EHLO aliasmail.local', [250]);
    if (!$secure && $port !== 25) {
        smtp_command($socket, 'STARTTLS', [220]);
        if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('SMTP TLS negotiation failed');
        smtp_command($socket, 'EHLO aliasmail.local', [250]);
    }
    if (config_value('SMTP_AUTH', 'true') === 'true') {
        smtp_command($socket, 'AUTH LOGIN', [334]);
        smtp_command($socket, base64_encode(config_value('MAIL_USER')), [334]);
        smtp_command($socket, base64_encode(config_value('MAIL_PASSWORD')), [235]);
    }
    return $socket;
}

function smtp_send_raw(string $raw, array $envelope): void {
    $socket = smtp_open();
    try {
        smtp_command($socket, 'MAIL FROM:<' . str_replace(['<','>','\r','\n'], '', (string)($envelope['from'] ?? config_value('MAIL_USER'))) . '>', [250]);
        foreach (array_unique($envelope['to'] ?? []) as $recipient) {
            smtp_command($socket, 'RCPT TO:<' . str_replace(['<','>','\r','\n'], '', (string)$recipient) . '>', [250, 251]);
        }
        smtp_command($socket, 'DATA', [354]);
        $raw = preg_replace('/(?m)^\./', '..', str_replace(["\r\n", "\r"], "\n", $raw));
        fwrite($socket, str_replace("\n", "\r\n", rtrim($raw, "\n")) . "\r\n.\r\n");
        smtp_command($socket, '', [250]);
        smtp_command($socket, 'QUIT', [221]);
    } finally { fclose($socket); }
}

function handle(array $body): array {
    $action = (string)($body['action'] ?? '');
    if ($action === 'health') return ['ok' => true, 'imapExtension' => function_exists('imap_open')];
    if ($action === 'test') {
        [$imap] = connect_imap();
        $folders = imap_getmailboxes($imap, '{' . config_value('IMAP_HOST', 'imap.secureserver.net') . ':' . config_value('IMAP_PORT', '993') . '/imap/ssl}', '*') ?: [];
        imap_close($imap);
        $smtp = smtp_open();
        smtp_command($smtp, 'QUIT', [221]); fclose($smtp);
        return ['imap' => true, 'smtp' => true, 'folders' => array_map(fn($f) => preg_replace('/^\{[^}]+\}/', '', $f->name), $folders)];
    }
    if ($action === 'sync') {
        $folder = (string)($body['folder'] ?? 'inbox');
        [$imap, $box] = imap_open_folder($folder);
        $status = imap_status($imap, $box, SA_UIDVALIDITY | SA_MESSAGES);
        $known = (string)($body['knownUidValidity'] ?? '') === (string)$status->uidvalidity
            ? array_fill_keys(array_map('intval', $body['knownUids'] ?? []), true)
            : [];
        $all = imap_search($imap, 'ALL', SE_UID) ?: [];
        $messages = [];
        $overview = imap_fetch_overview($imap, '1:*') ?: [];
        foreach ($overview as $item) {
            $number = (int)$item->msgno; $uid = (int)imap_uid($imap, $number);
            if (!$uid || isset($known[$uid])) continue;
            $header = imap_fetchheader($imap, $number);
            $messages[] = [
                'uid' => $uid, 'raw' => base64_encode($header), 'size' => (int)($item->size ?? strlen($header)),
                'hasAttachments' => structure_has_attachments(@imap_fetchstructure($imap, $number)),
            ];
        }
        imap_close($imap);
        return ['uidValidity' => (string)$status->uidvalidity, 'uids' => array_map('intval', $all), 'messages' => $messages];
    }
    if ($action === 'fetch') {
        [$imap] = imap_open_folder((string)($body['folder'] ?? 'inbox'));
        $uid = (int)($body['uid'] ?? 0); $number = imap_msgno($imap, $uid);
        if (!$number) { imap_close($imap); return ['raw' => null]; }
        $raw = imap_fetchheader($imap, $number) . "\r\n" . imap_body($imap, $number, FT_PEEK);
        imap_close($imap); return ['raw' => base64_encode($raw)];
    }
    if ($action === 'delete' || $action === 'move') {
        $folder = (string)($body['folder'] ?? $body['from'] ?? 'inbox');
        [$imap] = imap_open_folder($folder, false);
        $uids = array_values(array_filter(array_map('intval', $body['uids'] ?? []), fn($n) => $n > 0));
        if ($uids) {
            if ($action === 'move' || empty($body['permanent'])) {
                $target = $action === 'move' ? (string)$body['to'] : 'trash';
                if (!imap_mail_move($imap, implode(',', $uids), mailbox_name($target), CP_UID)) throw new RuntimeException('IMAP move failed: ' . (imap_last_error() ?: 'unknown error'));
            } else {
                foreach ($uids as $uid) if (!imap_delete($imap, (string)$uid, FT_UID)) throw new RuntimeException('IMAP delete failed');
            }
            imap_expunge($imap);
        }
        imap_close($imap); return ['ok' => true];
    }
    if ($action === 'sendRaw') {
        $raw = base64_decode((string)($body['raw'] ?? ''), true);
        if ($raw === false) throw new RuntimeException('Invalid message payload');
        smtp_send_raw($raw, (array)($body['envelope'] ?? []));
        return ['ok' => true];
    }
    if ($action === 'saveSent') {
        $raw = base64_decode((string)($body['raw'] ?? ''), true);
        if ($raw === false) throw new RuntimeException('Invalid message payload');
        try {
            [$imap] = imap_open_folder('sent', false);
            if (!imap_append($imap, '{' . config_value('IMAP_HOST', 'imap.secureserver.net') . ':' . config_value('IMAP_PORT', '993') . '/imap/ssl}' . mailbox_name('sent'), $raw, '\Seen')) {
                throw new RuntimeException('Could not append message to Sent: ' . (imap_last_error() ?: 'unknown error'));
            }
            imap_close($imap);
        } catch (Throwable $e) {
            if (isset($imap) && is_resource($imap)) imap_close($imap);
            throw $e;
        }
        return ['ok' => true];
    }
    throw new RuntimeException('Unsupported bridge action');
}

$expected = config_value('MAIL_BRIDGE_TOKEN');
$provided = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
if ($expected === '' || !hash_equals('Bearer ' . $expected, $provided)) reply(401, ['error' => 'Unauthorized']);
if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['error' => 'Method not allowed']);
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) reply(400, ['error' => 'Invalid JSON']);
try { reply(200, handle($body)); }
catch (Throwable $e) { error_log('[AliasMail bridge] ' . $e->getMessage()); reply(502, ['error' => $e->getMessage()]); }
