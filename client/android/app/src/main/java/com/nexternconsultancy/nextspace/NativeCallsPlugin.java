package com.nexternconsultancy.nextspace;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
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
import java.lang.ref.WeakReference;

@CapacitorPlugin(
    name = "NativeCalls",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class NativeCallsPlugin extends Plugin {
    static final String PREFS = "nextspace_native_calls";
    static final String TOKEN = "fcm_token";
    static final String ACTION = "pending_action";
    static final String CALL_ID = "pending_call_id";
    private static WeakReference<NativeCallsPlugin> active = new WeakReference<>(null);

    @Override
    public void load() {
        active = new WeakReference<>(this);
        emitPending();
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
        if (plugin != null) plugin.emitPending();
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
}
