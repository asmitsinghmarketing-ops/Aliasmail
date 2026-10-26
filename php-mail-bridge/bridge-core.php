<?php
declare(strict_types=1);
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__ && PHP_SAPI !== 'cli') {
    http_response_code(403); exit;
}
require_once __DIR__ . '/settings.php';

function config_value(string $key, string $fallback = ''): string {
    $settings = $GLOBALS['aliasmailSettings'] ?? [];
    $value = $settings[$key] ?? getenv($key);
    return (string)(($value === false || $value === null || $value === '') ? $fallback : $value);
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
    mailbox_name($folder);
    if (isset($GLOBALS['aliasmailImapPool'])) {
        if (!$readOnly) throw new RuntimeException('Worker connections are read-only');
        return $GLOBALS['aliasmailImapPool']->get($folder);
    }
    return imap_connect_folder($folder, $readOnly);
}

function imap_connect_folder(string $folder, bool $readOnly = true) {
    if (!function_exists('imap_open')) throw new RuntimeException('PHP IMAP extension is not enabled');
    imap_timeout(IMAP_OPENTIMEOUT, 10);
    imap_timeout(IMAP_READTIMEOUT, 15);
    imap_timeout(IMAP_WRITETIMEOUT, 15);
    $host = config_value('IMAP_HOST', 'imap.secureserver.net');
    $port = config_value('IMAP_PORT', '993');
    $flags = config_value('IMAP_SECURE', 'true') === 'true' ? '/imap/ssl' : '/imap/notls';
    $box = '{' . $host . ':' . $port . $flags . '}' . mailbox_name($folder);
    $stream = @imap_open($box, config_value('MAIL_USER'), config_value('MAIL_PASSWORD'), $readOnly ? OP_READONLY : 0, 1);
    if (!$stream) throw new RuntimeException('IMAP login failed: ' . (imap_last_error() ?: 'unknown error'));
    return [$stream, $box];
}

function imap_release($imap): void {
    if (!isset($GLOBALS['aliasmailImapPool'])) imap_close($imap);
}

function connect_imap(): array {
    return imap_open_folder('inbox');
}

function imap_search_uids($imap, string $criteria): array {
    imap_errors();
    $uids = imap_search($imap, $criteria, SE_UID);
    if ($uids === false) {
        if (imap_errors()) throw new RuntimeException('IMAP search failed; mailbox cache was not changed');
        return [];
    }
    return array_map('intval', $uids);
}

function imap_raw_message($imap, int $uid): ?string {
    if (!imap_msgno($imap, $uid)) return null;
    // UID addressing stays correct if another client expunges a preceding message.
    $header = imap_fetchheader($imap, $uid, FT_UID | FT_PREFETCHTEXT);
    $body = imap_body($imap, $uid, FT_UID | FT_PEEK);
    if ($header === false || $body === false) throw new RuntimeException('IMAP message download failed');
    return $header . "\r\n" . $body;
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

function smtp_capabilities(string $reply): array {
    $capabilities = [];
    foreach (preg_split('/\r?\n/', trim($reply)) as $line) {
        if (preg_match('/^250[- ]([A-Za-z0-9][A-Za-z0-9-]*)(?:\s+(.*))?$/', trim($line), $match)) {
            $capabilities[strtoupper($match[1])] = isset($match[2])
                ? preg_split('/\s+/', strtoupper(trim($match[2])))
                : [];
        }
    }
    return $capabilities;
}

function smtp_open(?array &$capabilities = null) {
    $host = config_value('SMTP_HOST', 'smtpout.secureserver.net');
    $port = (int)config_value('SMTP_PORT', '465');
    $secure = config_value('SMTP_SECURE', 'true') === 'true';
    $target = ($secure && $port === 465 ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $socket = @stream_socket_client($target, $errno, $errstr, 15, STREAM_CLIENT_CONNECT);
    if (!$socket) throw new RuntimeException("SMTP connection failed: $errstr ($errno)");
    stream_set_timeout($socket, 15);
    smtp_command($socket, '', [220]);
    $capabilities = smtp_capabilities(smtp_command($socket, 'EHLO aliasmail.local', [250]));
    if (!$secure && $port !== 25) {
        smtp_command($socket, 'STARTTLS', [220]);
        if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('SMTP TLS negotiation failed');
        $capabilities = smtp_capabilities(smtp_command($socket, 'EHLO aliasmail.local', [250]));
    }
    if (config_value('SMTP_AUTH', 'true') === 'true') {
        if (in_array('PLAIN', $capabilities['AUTH'] ?? [], true)) {
            $plain = base64_encode("\0" . config_value('MAIL_USER') . "\0" . config_value('MAIL_PASSWORD'));
            $reply = smtp_command($socket, 'AUTH PLAIN ' . $plain, [235, 334]);
            if ((int)substr($reply, 0, 3) === 334) smtp_command($socket, $plain, [235]);
        } else {
            smtp_command($socket, 'AUTH LOGIN', [334]);
            smtp_command($socket, base64_encode(config_value('MAIL_USER')), [334]);
            smtp_command($socket, base64_encode(config_value('MAIL_PASSWORD')), [235]);
        }
    }
    return $socket;
}

function smtp_send_raw(string $raw, array $envelope): void {
    $capabilities = [];
    $socket = smtp_open($capabilities);
    try {
        $from = str_replace(['<', '>', "\r", "\n"], '', (string)($envelope['from'] ?? config_value('MAIL_USER')));
        $commands = [['MAIL FROM:<' . $from . '>', [250]]];
        foreach (array_unique($envelope['to'] ?? []) as $recipient) {
            $recipient = str_replace(['<', '>', "\r", "\n"], '', (string)$recipient);
            $commands[] = ['RCPT TO:<' . $recipient . '>', [250, 251]];
        }
        if (count($commands) === 1) throw new RuntimeException('No recipients in SMTP envelope');
        if (isset($capabilities['PIPELINING'])) {
            $payload = implode("\r\n", array_column($commands, 0)) . "\r\n";
            if (fwrite($socket, $payload) === false) throw new RuntimeException('SMTP envelope write failed');
            foreach ($commands as [, $codes]) smtp_command($socket, '', $codes);
        } else {
            foreach ($commands as [$command, $codes]) smtp_command($socket, $command, $codes);
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
        imap_release($imap);
        $smtp = smtp_open();
        smtp_command($smtp, 'QUIT', [221]); fclose($smtp);
        return ['imap' => true, 'smtp' => true, 'folders' => array_map(fn($f) => preg_replace('/^\{[^}]+\}/', '', $f->name), $folders)];
    }
    if ($action === 'sync') {
        $folder = (string)($body['folder'] ?? 'inbox');
        [$imap, $box] = imap_open_folder($folder);
        $status = imap_status($imap, $box, SA_UIDVALIDITY | SA_MESSAGES);
        if ($status === false) throw new RuntimeException('Could not read IMAP mailbox status');
        $known = (string)($body['knownUidValidity'] ?? '') === (string)$status->uidvalidity
            ? array_fill_keys(array_map('intval', $body['knownUids'] ?? []), true)
            : [];
        $all = imap_search_uids($imap, 'ALL');
        $messages = [];
        $newUids = array_values(array_filter(array_map('intval', $all), fn($uid) => $uid > 0 && !isset($known[$uid])));
        // Fetch newest headers first and finish large mailbox imports over short requests.
        rsort($newUids, SORT_NUMERIC);
        $batchUids = array_slice($newUids, 0, 20);
        $syncStarted = microtime(true);
        if ($batchUids) {
            $overview = imap_fetch_overview($imap, implode(',', $batchUids), FT_UID) ?: [];
        } else {
            $overview = [];
        }
        usort($overview, fn($a, $b) => (int)$b->uid <=> (int)$a->uid);
        foreach ($overview as $item) {
            if ($messages && microtime(true) - $syncStarted > 8) break;
            $number = (int)($item->msgno ?? 0);
            $uid = (int)($item->uid ?? ($number ? imap_uid($imap, $number) : 0));
            if (!$uid || !$number) continue;
            $header = imap_fetchheader($imap, $uid, FT_UID);
            if ($header === false) throw new RuntimeException('IMAP header download failed');
            $messages[] = [
                'uid' => $uid, 'raw' => base64_encode($header), 'size' => (int)($item->size ?? strlen($header)),
                'hasAttachments' => structure_has_attachments(@imap_fetchstructure($imap, $uid, FT_UID)),
            ];
        }
        $seenUids = imap_search_uids($imap, 'SEEN');
        imap_release($imap);
        return ['hasMore' => count($newUids) > count($messages), 'seenUids' => array_map('intval', $seenUids), 'uidValidity' => (string)$status->uidvalidity, 'uids' => array_map('intval', $all), 'messages' => $messages];
    }
    if ($action === 'fetchMany') {
        $uids = array_values(array_unique(array_filter(array_map('intval', $body['uids'] ?? []), fn($uid) => $uid > 0)));
        if (count($uids) > 20) throw new RuntimeException('Too many messages in one fetch');
        [$imap] = imap_open_folder((string)($body['folder'] ?? 'inbox'));
        $messages = [];
        try {
            foreach ($uids as $uid) {
                $raw = imap_raw_message($imap, $uid);
                if ($raw === null) continue;
                $messages[] = ['uid' => $uid, 'raw' => base64_encode($raw)];
            }
        } finally {
            imap_release($imap);
        }
        return ['messages' => $messages];
    }
    if ($action === 'fetch') {
        [$imap] = imap_open_folder((string)($body['folder'] ?? 'inbox'));
        $uid = (int)($body['uid'] ?? 0);
        try {
            $raw = imap_raw_message($imap, $uid);
            return ['raw' => $raw === null ? null : base64_encode($raw)];
        } finally { imap_release($imap); }
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
        imap_release($imap); return ['ok' => true];
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
            imap_release($imap);
        } catch (Throwable $e) {
            if (isset($imap) && is_resource($imap)) imap_release($imap);
            throw $e;
        }
        return ['ok' => true];
    }
    throw new RuntimeException('Unsupported bridge action');
}

