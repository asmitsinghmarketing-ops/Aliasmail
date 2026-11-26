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
            CallNotifications.incoming(this, callId, data.getOrDefault("title", "Incoming Nextspace call"), data.getOrDefault("body", "Open Nextspace to answer"));
            NativeCallsPlugin.deliver(this, "ring", callId);
        } else {
            CallNotifications.message(this, data.getOrDefault("title", "Nextspace"), data.getOrDefault("body", "You have a new notification"));
        }
    }
}
