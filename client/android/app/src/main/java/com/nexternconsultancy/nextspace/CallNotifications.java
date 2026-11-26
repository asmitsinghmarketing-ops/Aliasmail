package com.nexternconsultancy.nextspace;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;

final class CallNotifications {
    private static final String CALLS = "nextspace_incoming_calls";
    private static final String MESSAGES = "nextspace_notifications";
    private CallNotifications() {}

    static int id(String callId) { return 41000 + Math.abs(callId.hashCode() % 20000); }

    private static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel calls = new NotificationChannel(CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Incoming Nextspace voice and video calls");
        calls.setVibrationPattern(new long[] { 0, 700, 250, 700, 350, 1100 });
        calls.enableVibration(true);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        manager.createNotificationChannel(calls);
        manager.createNotificationChannel(new NotificationChannel(MESSAGES, "Nextspace notifications", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static PendingIntent action(Context context, String callId, String action, int offset) {
        Intent intent = new Intent(context, CallActionReceiver.class)
            .putExtra("nextspace_call_action", action).putExtra("nextspace_call_id", callId);
        return PendingIntent.getBroadcast(context, id(callId) + offset, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent open(Context context, String callId) {
        Intent intent = new Intent(context, MainActivity.class)
            .putExtra("nextspace_call_action", "open").putExtra("nextspace_call_id", callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, id(callId) + 3, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void incoming(Context context, String callId, String title, String body) {
        channels(context);
        PendingIntent accept = action(context, callId, "accept", 1);
        PendingIntent decline = action(context, callId, "decline", 2);
        PendingIntent open = open(context, callId);
        Person caller = new Person.Builder().setName(title.replaceFirst("^Incoming (video|voice) call from ", "")).setImportant(true).build();
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CALLS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title).setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(false).setOngoing(true)
            .setTimeoutAfter(90_000)
            .setContentIntent(open).setFullScreenIntent(open, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, accept));
        context.getSystemService(NotificationManager.class).notify(id(callId), notification.build());
    }

    static void message(Context context, String title, String body) {
        channels(context);
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(context, 40001, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, MESSAGES)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT).setAutoCancel(true).setContentIntent(open);
        context.getSystemService(NotificationManager.class).notify(40001, notification.build());
    }
}
