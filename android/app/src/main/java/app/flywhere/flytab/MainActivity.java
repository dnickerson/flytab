package app.flywhere.flytab;

import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import app.flywhere.flytab.tileserver.TileServerPlugin;
import app.flywhere.flytab.engineml.EngineMLPlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "FlyTab";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        registerPlugin(EngineMLPlugin.class);
        super.onCreate(savedInstanceState);

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

        // Inject Android nav bar height as CSS variable
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
