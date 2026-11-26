package com.nexternconsultancy.nextspace;

import android.Manifest;
import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;

@CapacitorPlugin(
    name = "NativeCalls",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class NativeCallsPlugin extends Plugin {
    static final String PREFS = "nextspace_native_calls";
    static final String TOKEN = "fcm_token";
    static final String ACTION = "pending_action";
    static final String CALL_ID = "pending_call_id";
    static final String UPDATE_DOWNLOAD_ID = "update_download_id";
    static final String UPDATE_SHA256 = "update_sha256";
    static final String UPDATE_VERIFIED = "update_verified";
    private static WeakReference<NativeCallsPlugin> active = new WeakReference<>(null);

    @Override
    public void load() {
        active = new WeakReference<>(this);
        if (MainActivity.isForeground()) emitPending();
    }

    static void saveToken(Context context, String token) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply();
        NativeCallsPlugin plugin = active.get();
        if (plugin != null) {
            JSObject data = new JSObject();
            data.put("token", token);
            plugin.notifyListeners("token", data, true);
        }
    }

    static void deliver(Context context, String action, String callId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(ACTION, action).putString(CALL_ID, callId).apply();
        NativeCallsPlugin plugin = active.get();
        // Opening the camera or microphone while the Activity is still backgrounded is rejected
        // by recent Android versions. Keep the answer until onResume, then let JavaScript join
        // with the media type that was attached to the call.
        if (plugin != null && MainActivity.isForeground()) plugin.emitPending();
    }

    static void onForeground() {
        NativeCallsPlugin plugin = active.get();
        if (plugin != null) plugin.emitPending();
    }

    static void onPictureInPictureChanged(boolean activeMode) {
        NativeCallsPlugin plugin = active.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("active", activeMode);
        plugin.notifyListeners("pictureInPictureChanged", data, true);
    }

    static void acceptIntent(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("nextspace_call_action");
        String callId = intent.getStringExtra("nextspace_call_id");
        if (action != null && callId != null) deliver(context, action, callId);
        intent.removeExtra("nextspace_call_action");
        intent.removeExtra("nextspace_call_id");
    }

    private void emitPending() {
        Context context = getContext();
        String action = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ACTION, "");
        String callId = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CALL_ID, "");
        if (action.isEmpty() || callId.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("callId", callId);
        notifyListeners("callAction", data, true);
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void tokenResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("permission", allowed() ? "granted" : "prompt");
        String saved = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TOKEN, "");
        if (!saved.isEmpty()) result.put("token", saved);
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    saveToken(getContext(), task.getResult());
                    result.put("token", task.getResult());
                    result.put("configured", true);
                } else result.put("configured", false);
                call.resolve(result);
            });
        } catch (RuntimeException error) {
            result.put("configured", false);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        tokenResult(call);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        } else tokenResult(call);
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        tokenResult(call);
    }

    @PluginMethod
    public void consumeAction(PluginCall call) {
        // The JavaScript listener is installed while the WebView is booting, before onResume.
        // Leave the action queued until Android has actually foregrounded the Activity.
        if (!MainActivity.isForeground()) {
            call.resolve(new JSObject());
            return;
        }
        String action = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ACTION, "");
        String callId = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CALL_ID, "");
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ACTION).remove(CALL_ID).apply();
        JSObject result = new JSObject();
        if (!action.isEmpty() && !callId.isEmpty()) {
            result.put("action", action);
            result.put("callId", callId);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        String callId = call.getString("callId", "");
        ((NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE)).cancel(CallNotifications.id(callId));
        call.resolve();
    }

    @PluginMethod
    public void showOngoing(PluginCall call) {
        String callId = call.getString("callId", "");
        if (callId.isEmpty()) {
            call.reject("callId is required");
            return;
        }
        String title = call.getString("title", "Nextspace call");
        Boolean video = call.getBoolean("video", false);
        Long startedAt = call.getLong("startedAt", System.currentTimeMillis());
        CallNotifications.ongoing(getContext(), callId, title, Boolean.TRUE.equals(video), startedAt == null ? System.currentTimeMillis() : startedAt);
        call.resolve();
    }

    @PluginMethod
    public void setActiveCall(PluginCall call) {
        String callId = call.getString("callId", "");
        if (callId.isEmpty()) {
            call.reject("callId is required");
            return;
        }
        String title = call.getString("title", "Nextspace call");
        Boolean video = call.getBoolean("video", false);
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            activity.setActiveCall(callId, title, Boolean.TRUE.equals(video));
            JSObject result = new JSObject();
            result.put("supported", Build.VERSION.SDK_INT >= 26
                && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE));
            result.put("active", Build.VERSION.SDK_INT >= 26 && activity.isInPictureInPictureMode());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void clearActiveCall(PluginCall call) {
        String callId = call.getString("callId", "");
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            activity.clearActiveCall(callId);
            call.resolve();
        });
    }

    @PluginMethod
    public void enterPictureInPicture(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("entered", activity.enterCallPictureInPicture());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void getPictureInPictureStatus(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        JSObject result = new JSObject();
        boolean supported = activity != null && Build.VERSION.SDK_INT >= 26
            && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
        result.put("supported", supported);
        result.put("active", supported && activity.isInPictureInPictureMode());
        call.resolve(result);
    }

    @PluginMethod
    public void getInstalledAppInfo(PluginCall call) {
        new Thread(() -> {
            try {
                String source = getContext().getApplicationInfo().sourceDir;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[64 * 1024];
                try (FileInputStream input = new FileInputStream(source)) {
                    int read;
                    while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
                }
                StringBuilder sha256 = new StringBuilder(64);
                for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
                JSObject result = new JSObject();
                result.put("sha256", sha256.toString());
                result.put("packageName", getContext().getPackageName());
                result.put("versionName", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Unable to read the installed app checksum", error);
            }
        }, "Nextspace-update-check").start();
    }

    private SharedPreferences updatePrefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private DownloadManager downloadManager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private String streamSha256(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        StringBuilder value = new StringBuilder(64);
        for (byte part : digest.digest()) value.append(String.format("%02x", part & 0xff));
        return value.toString();
    }

    private void clearUpdateState() {
        updatePrefs().edit().remove(UPDATE_DOWNLOAD_ID).remove(UPDATE_SHA256).remove(UPDATE_VERIFIED).apply();
    }

    private JSObject currentUpdateStatus(String requestedSha256) throws Exception {
        JSObject result = new JSObject();
        SharedPreferences prefs = updatePrefs();
        long downloadId = prefs.getLong(UPDATE_DOWNLOAD_ID, -1);
        String expectedSha256 = prefs.getString(UPDATE_SHA256, "");
        if (downloadId < 0 || expectedSha256.isEmpty() || (!requestedSha256.isEmpty() && !expectedSha256.equalsIgnoreCase(requestedSha256))) {
            result.put("status", "idle");
            return result;
        }

        DownloadManager manager = downloadManager();
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (!cursor.moveToFirst()) {
                clearUpdateState();
                result.put("status", "idle");
                return result;
            }
            int nativeStatus = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            result.put("downloaded", Math.max(0, downloaded));
            result.put("total", Math.max(0, total));
            result.put("progress", total > 0 ? Math.min(100, Math.round(downloaded * 100f / total)) : 0);

            if (nativeStatus == DownloadManager.STATUS_PENDING || nativeStatus == DownloadManager.STATUS_RUNNING || nativeStatus == DownloadManager.STATUS_PAUSED) {
                result.put("status", "downloading");
                return result;
            }
            if (nativeStatus == DownloadManager.STATUS_FAILED) {
                result.put("status", "failed");
                result.put("reason", cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)));
                manager.remove(downloadId);
                clearUpdateState();
                return result;
            }
        }

        if (prefs.getBoolean(UPDATE_VERIFIED, false)) {
            result.put("status", "ready");
            result.put("progress", 100);
            return result;
        }
        Uri downloadedFile = manager.getUriForDownloadedFile(downloadId);
        if (downloadedFile == null) {
            result.put("status", "failed");
            clearUpdateState();
            return result;
        }
        result.put("status", "verifying");
        String actualSha256;
        try (InputStream input = getContext().getContentResolver().openInputStream(downloadedFile)) {
            if (input == null) throw new IllegalStateException("Downloaded update cannot be opened");
            actualSha256 = streamSha256(input);
        }
        if (!expectedSha256.equalsIgnoreCase(actualSha256)) {
            manager.remove(downloadId);
            clearUpdateState();
            result.put("status", "failed");
            result.put("error", "The downloaded update failed its security check.");
            return result;
        }
        prefs.edit().putBoolean(UPDATE_VERIFIED, true).apply();
        result.put("status", "ready");
        result.put("progress", 100);
        return result;
    }

    @PluginMethod
    public void startAppUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "").toLowerCase();
        Uri uri = Uri.parse(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !sha256.matches("[0-9a-f]{64}")) {
            call.reject("A secure update URL and SHA-256 checksum are required");
            return;
        }
        new Thread(() -> {
            try {
                SharedPreferences prefs = updatePrefs();
                long previousId = prefs.getLong(UPDATE_DOWNLOAD_ID, -1);
                String previousSha256 = prefs.getString(UPDATE_SHA256, "");
                if (previousId >= 0 && previousSha256.equalsIgnoreCase(sha256)) {
                    JSObject current = currentUpdateStatus(sha256);
                    String status = current.optString("status", "idle");
                    if (!"idle".equals(status) && !"failed".equals(status)) {
                        call.resolve(current);
                        return;
                    }
                }
                if (previousId >= 0) downloadManager().remove(previousId);

                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle("Nextspace update")
                    .setDescription("Downloading the latest secure version")
                    .setMimeType("application/vnd.android.package-archive")
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(false)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                long downloadId = downloadManager().enqueue(request);
                prefs.edit()
                    .putLong(UPDATE_DOWNLOAD_ID, downloadId)
                    .putString(UPDATE_SHA256, sha256)
                    .putBoolean(UPDATE_VERIFIED, false)
                    .apply();
                JSObject result = new JSObject();
                result.put("status", "downloading");
                result.put("progress", 0);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Unable to start the app update download", error);
            }
        }, "Nextspace-update-download").start();
    }

    @PluginMethod
    public void getAppUpdateDownloadStatus(PluginCall call) {
        String sha256 = call.getString("sha256", "");
        new Thread(() -> {
            try {
                call.resolve(currentUpdateStatus(sha256));
            } catch (Exception error) {
                call.reject("Unable to check the update download", error);
            }
        }, "Nextspace-update-status").start();
    }

    @PluginMethod
    public void installAppUpdate(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }
        new Thread(() -> {
            try {
                String sha256 = updatePrefs().getString(UPDATE_SHA256, "");
                JSObject status = currentUpdateStatus(sha256);
                if (!"ready".equals(status.optString("status"))) {
                    call.reject("The update has not finished downloading");
                    return;
                }
                Uri file = downloadManager().getUriForDownloadedFile(updatePrefs().getLong(UPDATE_DOWNLOAD_ID, -1));
                if (file == null) {
                    call.reject("The downloaded update is unavailable");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                            Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivity(permission);
                            JSObject result = new JSObject();
                            result.put("permissionRequired", true);
                            call.resolve(result);
                            return;
                        }
                        Intent install = new Intent(Intent.ACTION_VIEW)
                            .setDataAndType(file, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(install);
                        JSObject result = new JSObject();
                        result.put("launched", true);
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("Unable to open the Android installer", error);
                    }
                });
            } catch (Exception error) {
                call.reject("Unable to prepare the app update", error);
            }
        }, "Nextspace-update-install").start();
    }
}
