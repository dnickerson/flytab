package app.flywhere.flytab;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import app.flywhere.flytab.tileserver.TileServerPlugin;
import app.flywhere.flytab.engineml.EngineMLPlugin;
import app.flywhere.flytab.SftpPlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "FlyTab";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        registerPlugin(EngineMLPlugin.class);
        registerPlugin(SftpPlugin.class);
        registerPlugin(StratuxWsPlugin.class);
        registerPlugin(EngineWsPlugin.class);
        registerPlugin(StratuxUdpPlugin.class);
        super.onCreate(savedInstanceState);

        // Request "All files access" (MANAGE_EXTERNAL_STORAGE) — required to read
        // MBTiles databases from Documents/FlyTab/tiles/ via the NanoHTTPD tile server.
        // Must be requested at runtime via Settings on Android 11+; declaring in the
        // manifest alone is not sufficient and the grant is revoked on reinstall.
        checkStoragePermission();

        // Start flight service (keeps CPU awake for Stratux WebSocket when screen is off)
        startFlightService();

        // Back button → exit confirmation dialog
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Exit FlyTab?")
                    .setMessage("This will stop flight services and engine monitoring.")
                    .setPositiveButton("Exit", (dialog, which) -> {
                        Log.i(TAG, "User confirmed exit — stopping FlightService");
                        stopService(new Intent(MainActivity.this, FlightService.class));
                        finishAndRemoveTask();
                    })
                    .setNegativeButton("Cancel", null)
                    .setCancelable(true)
                    .show();
            }
        });

        // Allow HTTP requests from the HTTPS localhost origin (home server, NanoHTTPD on 9090)
        WebView wv = getBridge().getWebView();
        wv.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Inject Android nav bar height as CSS variable
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

    private void checkStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                new AlertDialog.Builder(this)
                    .setTitle("Storage Access Required")
                    .setMessage("FlyTab needs access to all files to read chart tiles and approach plates stored in Documents/FlyTab.\n\nTap OK to open the permission screen, then enable \"Allow management of all files\".")
                    .setPositiveButton("OK", (dialog, which) -> {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    })
                    .setNegativeButton("Not now", null)
                    .setCancelable(false)
                    .show();
            }
        }
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
        // Only stop the service if the Activity is truly finishing (user exit),
        // not on config changes (rotation, locale) which recreate the Activity.
        if (isFinishing()) {
            stopService(new Intent(this, FlightService.class));
        }
        super.onDestroy();
    }
}
