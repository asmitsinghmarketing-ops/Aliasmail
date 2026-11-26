package com.nexternconsultancy.nextspace;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getStringExtra("nextspace_call_action");
        String callId = intent.getStringExtra("nextspace_call_id");
        if (action == null || callId == null) return;
        NativeCallsPlugin.deliver(context, action, callId);
        ((android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(CallNotifications.id(callId));
    }
}
