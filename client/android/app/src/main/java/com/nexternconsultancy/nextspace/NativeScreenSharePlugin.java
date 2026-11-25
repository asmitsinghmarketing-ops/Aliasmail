package com.nexternconsultancy.nextspace;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeScreenShare")
public class NativeScreenSharePlugin extends Plugin implements ScreenCaptureService.Listener {
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        ScreenCaptureService.setListener(this);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ScreenCaptureService.isActive()) {
            call.reject("A screen-sharing session is already active");
            return;
        }
        MediaProjectionManager manager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, manager.createScreenCaptureIntent(), "capturePermissionResult");
    }

    @ActivityCallback
    private void capturePermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Screen sharing was cancelled");
            return;
        }
        Intent service = new Intent(getContext(), ScreenCaptureService.class)
            .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.getResultCode())
            .putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data);
        ContextCompat.startForegroundService(getContext(), service);
        JSObject response = new JSObject();
        response.put("started", true);
        call.resolve(response);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ScreenCaptureService.requestStop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject response = new JSObject();
        response.put("active", ScreenCaptureService.isActive());
        call.resolve(response);
    }

    @Override
    public void onFrame(String jpeg, int width, int height) {
        main.post(() -> {
            JSObject frame = new JSObject();
            frame.put("jpeg", jpeg);
            frame.put("width", width);
            frame.put("height", height);
            notifyListeners("frame", frame);
        });
    }

    @Override
    public void onStopped() {
        main.post(() -> notifyListeners("stopped", new JSObject(), true));
    }

    @Override
    protected void handleOnDestroy() {
        ScreenCaptureService.setListener(null);
    }
}
