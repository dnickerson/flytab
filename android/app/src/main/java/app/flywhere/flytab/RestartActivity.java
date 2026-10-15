package app.flywhere.flytab;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;

/**
 * Starts FlyTab afresh in a new process after the WebView's renderer died
 * (MainActivity.handleRendererGone). Runs in its own ":restart" process
 * (AndroidManifest), so it can end the old one and then launch MainActivity
 * cleanly: same pattern as Jake Wharton's ProcessPhoenix.
 *
 * A fresh process, not just a new WebView, because the old process still holds
 * TileServer's port 9090, the Stratux UDP socket and the native WebSockets; new
 * plugin instances in the same process would collide with them.
 */
public class RestartActivity extends Activity {
    static final String EXTRA_PID = "flytab_restart_main_pid";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pid = getIntent().getIntExtra(EXTRA_PID, -1);
        if (pid > 0 && pid != Process.myPid()) Process.killProcess(pid);

        Intent main = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(main);
        finish();
        Runtime.getRuntime().exit(0);
    }
}
