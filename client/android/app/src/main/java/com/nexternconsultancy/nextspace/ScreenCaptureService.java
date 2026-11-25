package com.nexternconsultancy.nextspace;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.view.WindowManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public class ScreenCaptureService extends Service {
    public interface Listener {
        void onFrame(String jpeg, int width, int height);
        void onStopped();
    }

    public static final String EXTRA_RESULT_CODE = "projectionResultCode";
    public static final String EXTRA_RESULT_DATA = "projectionResultData";
    private static final String ACTION_STOP = "com.nexternconsultancy.nextspace.STOP_SCREEN_SHARE";
    private static final String CHANNEL_ID = "nextspace_screen_share";
    private static final int NOTIFICATION_ID = 2402;
    private static final long FRAME_INTERVAL_MS = 125;
    private static volatile Listener listener;
    private static volatile boolean active;

    private HandlerThread captureThread;
    private Handler captureHandler;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private long lastFrameAt;
    private boolean stopping;

    public static void setListener(@Nullable Listener value) {
        listener = value;
    }

    public static boolean isActive() {
        return active;
    }

    public static void requestStop(Context context) {
        Intent stop = new Intent(context, ScreenCaptureService.class).setAction(ACTION_STOP);
        context.startService(stop);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopCapture(true);
            return START_NOT_STICKY;
        }
        if (active || intent == null) return START_NOT_STICKY;
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, ActivityResultCodes.CANCELED);
        Intent resultData = readResultData(intent);
        if (resultCode != ActivityResultCodes.OK || resultData == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0
        );
        try {
            startProjection(resultCode, resultData);
            active = true;
        } catch (RuntimeException error) {
            stopCapture(true);
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private Intent readResultData(Intent source) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return source.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
        return source.getParcelableExtra(EXTRA_RESULT_DATA);
    }

    private void startProjection(int resultCode, Intent resultData) {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(resultCode, resultData);
        if (projection == null) throw new IllegalStateException("Android did not create a media projection");

        captureThread = new HandlerThread("NextspaceScreenCapture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture(false);
            }
        }, captureHandler);

        Rect bounds = ((WindowManager) getSystemService(WINDOW_SERVICE)).getMaximumWindowMetrics().getBounds();
        int sourceWidth = Math.max(2, bounds.width());
        int sourceHeight = Math.max(2, bounds.height());
        float scale = Math.min(1f, 960f / Math.max(sourceWidth, sourceHeight));
        int width = Math.max(2, Math.round(sourceWidth * scale));
        int height = Math.max(2, Math.round(sourceHeight * scale));
        int density = getResources().getConfiguration().densityDpi;

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::consumeLatestFrame, captureHandler);
        display = projection.createVirtualDisplay(
            "Nextspace screen share",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.getSurface(),
            null,
            captureHandler
        );
    }

    private void consumeLatestFrame(ImageReader source) {
        Image image = source.acquireLatestImage();
        if (image == null) return;
        try {
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
            lastFrameAt = now;
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = rowStride - pixelStride * image.getWidth();
            int bitmapWidth = image.getWidth() + rowPadding / pixelStride;
            Bitmap padded = Bitmap.createBitmap(bitmapWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(buffer);
            Bitmap frame = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
            if (frame != padded) padded.recycle();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            frame.compress(Bitmap.CompressFormat.JPEG, 68, output);
            frame.recycle();
            Listener target = listener;
            if (target != null) target.onFrame(Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP), image.getWidth(), image.getHeight());
        } finally {
            image.close();
        }
    }

    private Notification buildNotification() {
        Intent openApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = PendingIntent.getActivity(this, 0, openApp, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stopIntent = new Intent(this, ScreenCaptureService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Sharing your screen")
            .setContentText("Nextspace is presenting your screen in the meeting")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Stop sharing", stop)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Nextspace shares your phone screen");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private synchronized void stopCapture(boolean stopProjection) {
        if (stopping) return;
        stopping = true;
        active = false;
        if (display != null) display.release();
        display = null;
        if (reader != null) reader.close();
        reader = null;
        MediaProjection current = projection;
        projection = null;
        if (stopProjection && current != null) current.stop();
        if (captureThread != null) captureThread.quitSafely();
        captureThread = null;
        captureHandler = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        Listener target = listener;
        if (target != null) target.onStopped();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopCapture(true);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static final class ActivityResultCodes {
        static final int OK = -1;
        static final int CANCELED = 0;
    }
}
