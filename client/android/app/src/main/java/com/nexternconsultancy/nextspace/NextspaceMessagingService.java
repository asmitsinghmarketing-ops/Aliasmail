package com.nexternconsultancy.nextspace;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class NextspaceMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        NativeCallsPlugin.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String kind = data.getOrDefault("kind", "");
        if ("call".equals(kind)) {
            String callId = data.getOrDefault("callId", "");
            if (callId.isEmpty()) return;
            // An open app already presents its incoming-call panel through the live connection.
            // Keep the Android notification for the cases where it matters: background or closed.
            if (!MainActivity.isForeground()) {
                CallNotifications.incoming(this, callId, data.getOrDefault("title", "Incoming Nextspace call"), data.getOrDefault("body", "Open Nextspace to answer"));
            }
            NativeCallsPlugin.deliver(this, "ring", callId);
        } else {
            // Mail, notes and task changes already update their open in-app screens over the live
            // connection. Only raise a system notification while Nextspace is not in front.
            if (!MainActivity.isForeground()) {
                CallNotifications.message(this, data.getOrDefault("title", "Nextspace"), data.getOrDefault("body", "You have a new notification"));
            }
        }
    }
}
