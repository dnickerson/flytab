package app.flywhere.flytab;

import android.content.res.AssetManager;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Reads a file bundled as a raw Android asset (android/app/src/main/assets/)
 * and hands it to JS as base64. Exists because this app's WebView runs at
 * an http://localhost origin (capacitor.config.ts androidScheme:'http'),
 * where a raw file:// fetch against android_asset content has no confirmed
 * reachable path -- AssetManager is a plain native API that works
 * regardless of WebView scheme configuration.
 */
@CapacitorPlugin(name = "BundledAsset")
public class BundledAssetPlugin extends Plugin {
    private static final String TAG = "BundledAsset";

    @PluginMethod
    public void readAsset(PluginCall call) {
        String path = call.getString("path");
        JSObject ret = new JSObject();
        if (path == null) {
            ret.put("ok", false);
            ret.put("error", "missing path");
            call.resolve(ret);
            return;
        }
        AssetManager assets = getContext().getAssets();
        // try-with-resources: guarantees the asset stream closes on every exit
        // path, including an exception mid-read -- same reasoning as
        // ShareReceiverPlugin.getPendingShare()'s InputStream handling.
        try (InputStream in = assets.open(path)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
            ret.put("ok", true);
            ret.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
        } catch (Exception e) {
            Log.e(TAG, "Failed to read bundled asset: " + path, e);
            ret.put("ok", false);
            ret.put("error", e.getMessage());
        }
        call.resolve(ret);
    }
}
