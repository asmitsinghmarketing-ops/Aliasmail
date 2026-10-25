<?php
$GLOBALS['aliasmailSettings'] = [];
$localSettings = getenv('ALIASMAIL_SETTINGS_FILE') ?: __DIR__ . '/settings.local.php';
if (!is_file($localSettings)) $localSettings = dirname(dirname(__DIR__)) . '/aliasmail-settings.php';
if (is_file($localSettings)) require $localSettings;
