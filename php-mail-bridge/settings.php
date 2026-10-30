<?php
$GLOBALS['aliasmailSettings'] = [];
$settingsFile = getenv('ALIASMAIL_SETTINGS_FILE') ?: __DIR__ . '/settings.local.php';
if (!is_file($settingsFile)) $settingsFile = dirname(__DIR__, 2) . '/aliasmail-settings.php';
if (is_file($settingsFile)) require $settingsFile;
if (!is_array($GLOBALS['aliasmailSettings'])) $GLOBALS['aliasmailSettings'] = [];
