<?php
// Copy to aliasmail-settings.php in your home folder (on cPanel: /home/YOUR_ACCOUNT/, two levels
// above this folder and outside public_html) and fill in the values. It is the only settings file:
// keep it private and never commit it. For another location, set ALIASMAIL_SETTINGS_FILE.
$GLOBALS['aliasmailSettings'] = [
    'MAIL_USER' => 'mailbox@example.com',
    'MAIL_PASSWORD' => 'replace-with-mailbox-password',
    'MAIL_BRIDGE_TOKEN' => 'replace-with-a-long-random-token',
    'IMAP_HOST' => 'imap.secureserver.net',
    'IMAP_PORT' => '993',
    'IMAP_SECURE' => 'true',
    // On cPanel hosting, send through the server's own mail relay (port 465 is often blocked).
    'SMTP_HOST' => 'localhost',
    'SMTP_PORT' => '25',
    'SMTP_SECURE' => 'false',
    'SMTP_AUTH' => 'false',
    'MAIL_INBOX_FOLDER' => 'INBOX',
    'MAIL_SENT_FOLDER' => 'Sent',
    'MAIL_SPAM_FOLDER' => 'Junk',
    'MAIL_TRASH_FOLDER' => 'Trash',
    // Attachment uploads go from the browser straight to upload.php beside the bridge. Same domain
    // as MAIL_BRIDGE_URL; the directory must stay outside public_html.
    'MAIL_UPLOAD_URL' => 'https://bridge.example.com/php-mail-bridge/upload.php',
    'MAIL_UPLOAD_ORIGIN' => 'https://mail.example.com',
    'MAIL_UPLOAD_DIR' => '/home/YOUR_ACCOUNT/.aliasmail-uploads',
    // Optional Linux CLI workers. Routing falls back when workers are unavailable.
    'MAIL_WORKER_ENABLED' => 'true',
    // Default: ~/.aliasmail-worker outside public_html.
    // 'MAIL_WORKER_DIR' => '/home/YOUR_ACCOUNT/.aliasmail-worker',
];
