package app.flywhere.flytab;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import app.flywhere.flytab.tileserver.TileServerPlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "FlyTab";
    private static final int LOCATION_PERMISSION_REQUEST = 1001;
    private static final int BG_LOCATION_PERMISSION_REQUEST = 1002;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        super.onCreate(savedInstanceState);

        // Request location permission at startup for internal GPS
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                },
                LOCATION_PERMISSION_REQUEST);
        } else {
            // Fine location already granted — request background + start service
            requestBackgroundLocationAndStartService();
        }

        // Measure the system navigation bar height and inject it as a CSS variable
        // so the tab bar can position itself above the nav bar.
        // Do NOT call setWebViewClient — that overrides Capacitor's client and breaks page loading.
        WebView wv = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(wv, (v, insets) -> {
            int navBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            float density = getResources().getDisplayMetrics().density;
            int navDp = Math.round(navBottom / density);
            if (navDp > 0) {
                wv.post(() -> wv.evaluateJavascript(
                    "document.documentElement.style.setProperty('--android-nav-height', '" + navDp + "px')",
                    null
                ));
            }
            return ViewCompat.onApplyWindowInsets(v, insets);
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LOCATION_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                requestBackgroundLocationAndStartService();
            } else {
                // Location denied — start service anyway (without location type)
                // so the process survives screen-off for Stratux/recording
                startFlightService();
            }
        } else if (requestCode == BG_LOCATION_PERMISSION_REQUEST) {
            // Start regardless of grant result — service checks permission
            // and falls back to SPECIAL_USE type if location was revoked
            startFlightService();
        }
    }

    /**
     * After fine location is granted, request background location (Android 10+)
     * so the foreground service can use GPS with screen off.
     */
    private void requestBackgroundLocationAndStartService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION },
                    BG_LOCATION_PERMISSION_REQUEST);
                return;
            }
        }
        startFlightService();
    }

    private void startFlightService() {
        Intent serviceIntent = new Intent(this, FlightService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
        Log.i(TAG, "Flight foreground service started");
    }

    @Override
    public void onDestroy() {
        stopService(new Intent(this, FlightService.class));
        super.onDestroy();
    }
}
