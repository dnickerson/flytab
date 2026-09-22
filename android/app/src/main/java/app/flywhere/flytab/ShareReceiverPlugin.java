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
import java.util.concurrent.atomic.AtomicReference;

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
    // AtomicReference, not a plain static Uri: this is written on the UI
    // thread (MainActivity.onCreate/onNewIntent) and read on Capacitor's
    // separate plugin-call thread. A plain field has no happens-before edge
    // between those threads, so the reading thread is not guaranteed to ever
    // observe the write (a real, if rare, Java Memory Model visibility
    // hazard) -- and getAndSet(null) below also makes the existing
    // read-then-clear a single atomic step, closing a second, narrower race
    // where two near-simultaneous getPendingShare() calls could otherwise
    // both observe the same non-null Uri before either cleared it.
    private static final AtomicReference<Uri> pendingUri = new AtomicReference<>();

    /** Called by MainActivity, not by JS. */
    public static void setPendingShare(Uri uri) {
        pendingUri.set(uri);
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        Uri uri = pendingUri.getAndSet(null); // clear so a later poll doesn't re-import the same file
        if (uri == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        UriMeta meta = queryMeta(uri);
        if (meta.size > MAX_SHARE_BYTES) {
            Log.w(TAG, "Shared file too large (" + meta.size + " bytes), rejecting: " + meta.name);
            ret.put("ok", false);
            ret.put("tooLarge", true);
            ret.put("name", meta.name);
            call.resolve(ret);
            return;
        }
        // try-with-resources: guarantees `in` closes on every exit path,
        // including an exception mid-read (I/O error, revoked provider
        // permission, provider crash) -- a plain in.close() after the read
        // loop is never reached in that case and leaks the stream/fd.
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("Could not open shared file stream");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            long total = 0;
            // The MAX_SHARE_BYTES check above trusts the content provider's
            // reported OpenableColumns.SIZE, which some providers (documented
            // real behavior, particularly some cloud-storage/SAF providers)
            // leave unpopulated -- queryMeta() then leaves meta.size at its
            // default 0, so `0 > MAX_SHARE_BYTES` is false and the guard
            // above silently does nothing. Enforce the real limit here too,
            // from bytes actually read, so the cap holds regardless of what
            // (or whether) the provider reports.
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > MAX_SHARE_BYTES) {
                    Log.w(TAG, "Shared file exceeded size limit while reading (" + total + "+ bytes), rejecting: " + meta.name);
                    ret.put("ok", false);
                    ret.put("tooLarge", true);
                    ret.put("name", meta.name);
                    call.resolve(ret);
                    return;
                }
                buffer.write(chunk, 0, n);
            }
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
