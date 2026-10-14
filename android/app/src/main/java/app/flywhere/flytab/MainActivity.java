package app.flywhere.flytab;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import app.flywhere.flytab.tileserver.TileServerPlugin;
import app.flywhere.flytab.engineml.EngineMLPlugin;
import app.flywhere.flytab.SftpPlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "FlyTab";
    /** Between onStart and onStop: FlyTab has a visible window and may start an activity. */
    private boolean visible = false;
    /** Same, for AppHealth.isOnScreen (the page can't tell: see KeepAliveWebView). */
    private static volatile boolean onScreen = false;

    static boolean isOnScreen() { return onScreen; }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        registerPlugin(EngineMLPlugin.class);
        registerPlugin(SftpPlugin.class);
        registerPlugin(StratuxWsPlugin.class);
        registerPlugin(EngineWsPlugin.class);
        registerPlugin(StratuxUdpPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(BundledAssetPlugin.class);
        registerPlugin(VpnStatusPlugin.class);
        registerPlugin(AppHealthPlugin.class);
        super.onCreate(savedInstanceState);

        // Without this, a dead WebView renderer takes the whole app down
        // (Capacitor returns false: "not handled", and Chromium aborts the app).
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                handleRendererGone(webView, detail);
                return true;
            }
        });

        // Capture a share intent that launched a cold start (app not running).
        // A share arriving while the app is already running goes to onNewIntent
        // instead, since launchMode is singleTask.
        handleIncomingIntent(getIntent());

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

    /**
     * Stashes an incoming SEND intent's file Uri on ShareReceiverPlugin for the
     * JS side to poll. Called both from onCreate (cold start) and onNewIntent
     * (already running — launchMode is singleTask, so a new share does not
     * re-trigger onCreate).
     */
    private void handleIncomingIntent(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) {
                Log.i(TAG, "Received shared file: " + uri);
                ShareReceiverPlugin.setPendingShare(uri);
            }
        }
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        reportOnScreen(true);
    }

    @Override
    public void onStop() {
        reportOnScreen(false);
        super.onStop();
    }

    /**
     * KeepAliveWebView makes the page always look visible to Chromium, so tell
     * it the real state: window event 'flytab:screen' { onScreen }. (Screen off
     * also stops the activity.)
     */
    private void reportOnScreen(boolean on) {
        visible = on;
        onScreen = on;
        if (getBridge() != null) {
            getBridge().triggerWindowJSEvent("flytab:screen", "{\"onScreen\":" + on + "}");
        }
    }

    /**
     * The WebView's renderer process died. 2026-10-14 12:11 in flight: a SIGSEGV
     * inside WebView 155's JavaScript engine. Nobody handled it, so Chromium
     * aborted FlyTab too. Everything FlyTab does runs in that WebView, and Android
     * says a WebView whose renderer is gone can't be reused. So:
     *  - on screen: start FlyTab afresh in a new process (RestartActivity), as the
     *    pilot did by hand; the web app resumes the flight recording;
     *  - off screen: Android won't let an app start an activity from the
     *    background (a foreground service doesn't count), so end the process
     *    cleanly; the next tap on FlyTab starts it fresh;
     *  - after MAX_RESTARTS inside WINDOW_MS: stop, don't loop.
     * Each event is kept for the next launch to log and show the pilot
     * (AppHealthPlugin).
     */
    private void handleRendererGone(WebView view, RenderProcessGoneDetail detail) {
        long now = System.currentTimeMillis();
        boolean crashed = detail.didCrash();
        int priority = detail.rendererPriorityAtExit();
        SharedPreferences prefs = getSharedPreferences(RendererRecoveryLogic.PREFS, MODE_PRIVATE);
        String restarts = prefs.getString(RendererRecoveryLogic.KEY_RESTARTS, "");
        RendererRecoveryLogic.Action action =
            RendererRecoveryLogic.decide(visible, now, RendererRecoveryLogic.parseTimes(restarts));

        SharedPreferences.Editor edit = prefs.edit().putString(RendererRecoveryLogic.KEY_PENDING,
            RendererRecoveryLogic.appendEvent(prefs.getString(RendererRecoveryLogic.KEY_PENDING, ""),
                now, crashed, priority, action));
        if (action == RendererRecoveryLogic.Action.RESTART) {
            edit.putString(RendererRecoveryLogic.KEY_RESTARTS, RendererRecoveryLogic.addTime(restarts, now));
        }
        edit.commit();   // synchronous: this process is about to end
        Log.e(TAG, "WebView renderer " + (crashed ? "crashed" : "was killed by Android")
            + " (priority " + priority + ") -> " + action);

        // Android: remove the dead WebView from the view hierarchy and destroy it.
        ViewParent parent = view.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
        view.destroy();

        if (action == RendererRecoveryLogic.Action.RESTART) {
            try {
                startActivity(new Intent(this, RestartActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(RestartActivity.EXTRA_PID, Process.myPid()));
                // RestartActivity ends this process. If it never comes up, don't
                // leave a blank FlyTab on screen.
                new Handler(Looper.getMainLooper()).postDelayed(MainActivity::endProcess, 5000);
                return;
            } catch (RuntimeException e) {
                Log.e(TAG, "Restart after renderer loss failed", e);
            }
        }
        endProcess();
    }

    private static void endProcess() {
        Process.killProcess(Process.myPid());
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
