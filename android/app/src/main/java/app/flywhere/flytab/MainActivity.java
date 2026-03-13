package app.flywhere.flytab;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import app.flywhere.flytab.tileserver.TileServerPlugin;

public class MainActivity extends BridgeActivity {
    private static final int LOCATION_PERMISSION_REQUEST = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TileServerPlugin.class);
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
}
