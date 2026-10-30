<?php
// All bridge settings live in one private file, aliasmail-settings.php, outside public_html:
// the home folder on the server (~/aliasmail-settings.php), the project folder locally.
// ALIASMAIL_SETTINGS_FILE points somewhere else instead. See settings.example.php.
$GLOBALS['aliasmailSettings'] = [];
$aliasmailSettingsFile = getenv('ALIASMAIL_SETTINGS_FILE') ?: '';
if ($aliasmailSettingsFile === '') {
    // One or two folders up, never a file inside the web root.
    foreach ([dirname(__DIR__), dirname(__DIR__, 2)] as $dir) {
        if (basename($dir) !== 'public_html' && is_file($dir . '/aliasmail-settings.php')) {
            $aliasmailSettingsFile = $dir . '/aliasmail-settings.php';
            break;
        }
    }
}
if ($aliasmailSettingsFile !== '' && is_file($aliasmailSettingsFile)) require $aliasmailSettingsFile;
if (!is_array($GLOBALS['aliasmailSettings'])) $GLOBALS['aliasmailSettings'] = [];
unset($aliasmailSettingsFile);
