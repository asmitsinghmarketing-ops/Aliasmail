package com.nexternconsultancy.nextspace;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;

/** Keeps Android's camera/microphone allowance active while a WebRTC call is in PiP/background. */
public final class CallMediaService extends Service {
    static final String ACTION_START = "com.nexternconsultancy.nextspace.START_CALL_MEDIA";
    static final String ACTION_STOP = "com.nexternconsultancy.nextspace.STOP_CALL_MEDIA";
    static final String EXTRA_CALL_ID = "call_id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_VIDEO = "video";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        String callId = intent == null ? "" : intent.getStringExtra(EXTRA_CALL_ID);
        String title = intent == null ? "Nextspace call" : intent.getStringExtra(EXTRA_TITLE);
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        if (callId == null || callId.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (video) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(CallNotifications.id(callId), CallNotifications.ongoingNotification(this, callId, title, video, System.currentTimeMillis()), types);
        } else {
            startForeground(CallNotifications.id(callId), CallNotifications.ongoingNotification(this, callId, title, video, System.currentTimeMillis()));
        }
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
