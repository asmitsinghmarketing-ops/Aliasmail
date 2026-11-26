package com.nexternconsultancy.nextspace;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
}
