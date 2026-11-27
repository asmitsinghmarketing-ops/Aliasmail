package com.nexternconsultancy.nextspace;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground = false;
    private String activeCallId = "";
    private String activeCallTitle = "Nextspace call";
    private boolean activeCallVideo = false;

    static boolean isForeground() {
        return foreground;
    }

    private boolean pictureInPictureSupported() {
        return Build.VERSION.SDK_INT >= 26
            && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private PictureInPictureParams pictureInPictureParams(boolean autoEnter) {
        Rational ratio = activeCallVideo ? new Rational(16, 9) : new Rational(1, 1);
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(ratio);
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setAutoEnterEnabled(autoEnter);
            builder.setSeamlessResizeEnabled(true);
        }
        if (Build.VERSION.SDK_INT >= 33) builder.setTitle(activeCallTitle);
        return builder.build();
    }

    void setActiveCall(String callId, String title, boolean video) {
        activeCallId = callId;
        activeCallTitle = title == null || title.isEmpty() ? "Nextspace call" : title;
        activeCallVideo = video;
        Intent mediaService = new Intent(this, CallMediaService.class)
            .setAction(CallMediaService.ACTION_START)
            .putExtra(CallMediaService.EXTRA_CALL_ID, callId)
            .putExtra(CallMediaService.EXTRA_TITLE, activeCallTitle)
            .putExtra(CallMediaService.EXTRA_VIDEO, video);
        ContextCompat.startForegroundService(this, mediaService);
        if (pictureInPictureSupported()) setPictureInPictureParams(pictureInPictureParams(true));
    }

    void clearActiveCall(String callId) {
        if (!activeCallId.equals(callId)) return;
        activeCallId = "";
        stopService(new Intent(this, CallMediaService.class).setAction(CallMediaService.ACTION_STOP));
        if (pictureInPictureSupported()) setPictureInPictureParams(pictureInPictureParams(false));
        if (Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode()) finish();
    }

    boolean enterCallPictureInPicture() {
        if (activeCallId.isEmpty() || !pictureInPictureSupported() || isInPictureInPictureMode()) return false;
        return enterPictureInPictureMode(pictureInPictureParams(Build.VERSION.SDK_INT >= 31));
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeScreenSharePlugin.class);
        registerPlugin(NativeCallsPlugin.class);
        super.onCreate(savedInstanceState);
        NativeCallsPlugin.acceptIntent(this, getIntent());

        // Android 15+ draws apps edge-to-edge. Keep the WebView inside the status, cutout and
        // navigation bars so Nextspace controls are never covered by notifications or gestures.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets safe = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);

        // Give React the first chance to close its current panel or minimize a meeting. If it
        // has nothing open, use normal WebView history; at the app root, background the task so
        // an active microphone/camera session is not destroyed by an accidental Back press.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge.getWebView();
                String script = "(() => { const event = new CustomEvent('nextspace:native-back', "
                    + "{ cancelable: true }); return !window.dispatchEvent(event); })()";
                webView.evaluateJavascript(script, handled -> {
                    if ("true".equals(handled)) return;
                    if (webView.canGoBack()) webView.goBack();
                    else moveTaskToBack(true);
                });
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NativeCallsPlugin.acceptIntent(this, intent);
    }

    @Override
    public void onUserLeaveHint() {
        if (Build.VERSION.SDK_INT < 31) enterCallPictureInPicture();
        super.onUserLeaveHint();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPictureInPictureMode, newConfig);
        if (inPictureInPictureMode) foreground = true;
        NativeCallsPlugin.onPictureInPictureChanged(inPictureInPictureMode);
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
        NativeCallsPlugin.onForeground();
    }

    @Override
    public void onPause() {
        if (Build.VERSION.SDK_INT < 26 || !isInPictureInPictureMode()) foreground = false;
        super.onPause();
    }
}
