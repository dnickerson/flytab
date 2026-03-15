package app.flywhere.flytab;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps FlyTab alive when the screen is off.
 * In the cockpit, the pilot may turn off the screen to reduce heat/glare
 * but Stratux WebSocket data and flight recording must continue.
 *
 * Holds a PARTIAL_WAKE_LOCK (CPU only, screen stays off) and posts a
 * persistent notification so Android won't kill the process.
 *
 * NOTE: This tablet has NO internal GPS. All GPS data comes from Stratux
 * via WebSocket. No native LocationManager requests are needed.
 */
public class FlightService extends Service {
    private static final String TAG = "FlightService";
    private static final String CHANNEL_ID = "flytab_flight";
    private static final int NOTIFICATION_ID = 1;
    // Wake lock timeout: 8 hours. Covers the longest GA flight day.
    private static final long WAKE_LOCK_TIMEOUT_MS = 8 * 60 * 60 * 1000L;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FlyTab::Flight");
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        Log.i(TAG, "Flight service started, CPU wake lock acquired (8h timeout)");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("FlyTab Active")
            .setContentText("Flight systems running")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build();

        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed, stopping service", e);
            stopSelf();
            return START_NOT_STICKY;
        }

        // Don't restart if the process is killed — the user must relaunch the app
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            Log.i(TAG, "CPU wake lock released");
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Flight Active", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows when FlyTab flight systems are active");
            channel.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(channel);
        }
    }
}
