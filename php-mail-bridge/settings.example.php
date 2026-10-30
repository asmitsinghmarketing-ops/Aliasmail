<?php
// Copy to settings.local.php in the PHP service folder. Keep this file private and never commit it.
$GLOBALS['aliasmailSettings'] = [
    'MAIL_USER' => 'mailbox@example.com',
    'MAIL_PASSWORD' => 'replace-with-mailbox-password',
    'MAIL_BRIDGE_TOKEN' => 'replace-with-a-long-random-token',
    // Direct signed attachment uploads. The directory must stay outside public_html.
    'MAIL_UPLOAD_URL' => 'https://api.example.com/aliasmail-bridge/upload.php',
    'MAIL_UPLOAD_ORIGIN' => 'https://mail.example.com',
    // 'MAIL_UPLOAD_DIR' => '/home/YOUR_ACCOUNT/.aliasmail-uploads',
    'IMAP_HOST' => 'imap.secureserver.net',
    'IMAP_PORT' => '993',
    'IMAP_SECURE' => 'true',
    'SMTP_HOST' => 'smtpout.secureserver.net',
    'SMTP_PORT' => '465',
    'SMTP_SECURE' => 'true',
    'SMTP_AUTH' => 'true',
    'MAIL_INBOX_FOLDER' => 'INBOX',
    'MAIL_SENT_FOLDER' => 'Sent',
    'MAIL_SPAM_FOLDER' => 'Junk',
    'MAIL_TRASH_FOLDER' => 'Trash',
    // Optional Linux CLI workers. Routing falls back when workers are unavailable.
    'MAIL_WORKER_ENABLED' => 'true',
    // Default: ~/.aliasmail-worker outside public_html.
    // 'MAIL_WORKER_DIR' => '/home/YOUR_ACCOUNT/.aliasmail-worker',
];
