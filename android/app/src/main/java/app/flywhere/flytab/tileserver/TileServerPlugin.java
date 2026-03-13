package app.flywhere.flytab.tileserver;

import android.os.Environment;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Capacitor plugin that starts a local NanoHTTPD server to serve
 * map tiles, plates, and NASR data from the Android filesystem to
 * the Leaflet WebView via http://localhost:9090/
 */
@CapacitorPlugin(name = "TileServer")
public class TileServerPlugin extends Plugin {
    private static final String TAG = "TileServer";
    private static final int PORT = 9090;
    private TileServer server;

    @Override
    public void load() {
        try {
            File baseDir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
                "FlyTab"
            );
            if (!baseDir.exists()) {
                baseDir.mkdirs();
            }
            server = new TileServer(PORT, baseDir);
            server.start();
            Log.i(TAG, "Tile server started on port " + PORT + ", serving from " + baseDir.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to start tile server", e);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", server != null && server.isAlive());
        ret.put("port", PORT);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null) {
            server.stop();
            Log.i(TAG, "Tile server stopped");
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }
}
