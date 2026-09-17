package app.flywhere.flytab;

import android.content.Intent;
import android.net.Uri;
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
 * Capacitor plugin receiving a PDF shared into FlyTab via Android's SEND
 * intent (e.g. "Share to FlyTab" from a file manager or another app).
 * MainActivity stashes the incoming Uri here (onNewIntent for a running
 * instance, onCreate's initial intent for a cold start); the JS side polls
 * getPendingShare() on app init/resume rather than this plugin pushing an
 * event, since a share can arrive before the WebView has any listener
 * registered to receive one.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static final String TAG = "ShareReceiver";
    // Raw file size, before base64's ~33% overhead — see the size-limit note
    // in this task's Interfaces section for reasoning.
    private static final long MAX_SHARE_BYTES = 25L * 1024 * 1024;
    private static Uri pendingUri = null;

    /** Called by MainActivity, not by JS. */
    public static void setPendingShare(Uri uri) {
        pendingUri = uri;
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        if (pendingUri == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        Uri uri = pendingUri;
        pendingUri = null; // clear so a later poll doesn't re-import the same file
        UriMeta meta = queryMeta(uri);
        if (meta.size > MAX_SHARE_BYTES) {
            Log.w(TAG, "Shared file too large (" + meta.size + " bytes), rejecting: " + meta.name);
            ret.put("ok", false);
            ret.put("tooLarge", true);
            ret.put("name", meta.name);
            call.resolve(ret);
            return;
        }
        try {
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) throw new Exception("Could not open shared file stream");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
            in.close();
            ret.put("ok", true);
            ret.put("name", meta.name);
            ret.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to read shared file", e);
            ret.put("ok", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    private static class UriMeta { String name = "shared-document.pdf"; long size = 0; }

    private UriMeta queryMeta(Uri uri) {
        UriMeta meta = new UriMeta();
        try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (nameIdx >= 0) meta.name = cursor.getString(nameIdx);
                int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) meta.size = cursor.getLong(sizeIdx);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not resolve shared file metadata, using defaults", e);
        }
        return meta;
    }
}
