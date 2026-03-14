package app.flywhere.flytab;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.LocationRequest;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that keeps FlyTab alive when the screen is off.
 * In the cockpit, the pilot may turn off the screen to reduce heat/glare
 * but GPS tracking, Stratux data, and flight recording must continue.
 *
 * Holds a PARTIAL_WAKE_LOCK (CPU only, screen stays off) and posts a
 * persistent notification so Android won't kill the process.
 */
public class FlightService extends Service {
    private static final String TAG = "FlightService";
    private static final String CHANNEL_ID = "flytab_flight";
    private static final int NOTIFICATION_ID = 1;
    // Safety-net timeout: 24 hours. Covers longest GA flight imaginable.
    // If onDestroy doesn't fire (process killed), the system releases
    // the wake lock after this timeout instead of holding it until reboot.
    private static final long WAKE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000L;
    private PowerManager.WakeLock wakeLock;
    private LocationManager locationManager;
    private LocationListener locationListener;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FlyTab::Flight");
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        Log.i(TAG, "Flight service started, CPU wake lock acquired (24h timeout)");

        // Keep a persistent native GPS request so the system location arrow stays solid.
        // The WebView watchPosition creates ephemeral requests that cycle the indicator.
        // This listener discards the data — the WebView handles GPS display.
        startNativeLocationUpdates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Tap notification → bring app back to foreground
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

        // On API 34+, must specify foreground service type in code.
        // Use FOREGROUND_SERVICE_TYPE_LOCATION only if we have the permission —
        // otherwise crash on START_STICKY restart if user revoked location in Settings.
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                boolean hasLocation = ContextCompat.checkSelfPermission(this,
                    Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                if (hasLocation) {
                    startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                } else {
                    startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                }
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // Last resort: if startForeground fails for any reason, log and stop
            // rather than letting Android ANR-kill the app after 5 seconds.
            Log.e(TAG, "startForeground failed, stopping service", e);
            stopSelf();
            return START_NOT_STICKY;
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopNativeLocationUpdates();
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

    private void startNativeLocationUpdates() {
        if (ContextCompat.checkSelfPermission(this,
                Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "No location permission, skipping native GPS");
            return;
        }
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        locationListener = new LocationListener() {
            @Override public void onLocationChanged(Location loc) { /* WebView handles display */ }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override public void onProviderEnabled(String provider) {}
            @Override public void onProviderDisabled(String provider) {}
        };
        // Request HIGH_ACCURACY fused location at 1Hz to keep GPS arrow solid.
        // Plain requestLocationUpdates(FUSED, interval, dist) defaults to BALANCED
        // which doesn't keep the GPS hardware active on Android 16.
        try {
            LocationRequest locReq = new LocationRequest.Builder(1000)
                .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
                .setMinUpdateDistanceMeters(0)
                .build();
            locationManager.requestLocationUpdates(
                LocationManager.FUSED_PROVIDER, locReq,
                getMainExecutor(), locationListener);
            Log.i(TAG, "Native GPS started (fused HIGH_ACCURACY 1Hz)");
        } catch (Exception e) {
            Log.w(TAG, "Native GPS request failed: " + e.getMessage());
        }
    }

    private void stopNativeLocationUpdates() {
        if (locationManager != null && locationListener != null) {
            locationManager.removeUpdates(locationListener);
            Log.i(TAG, "Native GPS updates stopped");
        }
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
