package app.flywhere.flytab;

import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.io.File;
import java.io.FileInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Sftp")
public class SftpPlugin extends Plugin {
    private static final String TAG = "SftpPlugin";
    private static final String PREFS_NAME = "flytab_sftp_prefs";
    private static final String KEY_PASSWORD = "sftp_password";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /**
     * Upload a flight CSV from Documents/FlyTab/flights/ to a remote SFTP server.
     * Runs on background thread; resolves with {ok, error?}.
     */
    @PluginMethod
    public void upload(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 22);
        String username = call.getString("username");
        String filename = call.getString("filename");
        String remotePath = call.getString("remotePath", "~/flights");
        String password = call.getString("password");

        if (host == null || username == null || filename == null || password == null) {
            call.reject("Missing required parameters: host, username, filename, password");
            return;
        }
        if (filename.contains("..") || filename.contains("/")) {
            call.reject("Invalid filename");
            return;
        }

        File flightsDir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            "FlyTab/flights"
        );
        File localFile = new File(flightsDir, filename);
        if (!localFile.exists()) {
            call.reject("File not found: " + filename);
            return;
        }

        final String finalHost = host;
        final int finalPort = port;
        final String finalUsername = username;
        final String finalRemotePath = remotePath;
        final String finalPassword = password;

        executor.execute(() -> {
            Session session = null;
            ChannelSftp channel = null;
            try {
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setPassword(finalPassword);
                session.setConfig("StrictHostKeyChecking", "no");
                session.connect(30000);

                channel = (ChannelSftp) session.openChannel("sftp");
                channel.connect(10000);

                // Create remote directory if it doesn't exist (ignore error if it does)
                try { channel.mkdir(finalRemotePath); } catch (Exception ignored) {}
                channel.cd(finalRemotePath);

                try (FileInputStream fis = new FileInputStream(localFile)) {
                    channel.put(fis, filename);
                }

                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "SFTP upload failed for " + filename, e);
                JSObject result = new JSObject();
                result.put("ok", false);
                result.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
                call.resolve(result);
            } finally {
                if (channel != null) { try { channel.disconnect(); } catch (Exception ignored) {} }
                if (session != null) { try { session.disconnect(); } catch (Exception ignored) {} }
            }
        });
    }

    /**
     * Download a file from the SFTP server to the app's cache dir as flytab-update.apk.
     * Runs on background thread; resolves with {ok, error?}.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 22);
        String username = call.getString("username");
        String password = call.getString("password");
        String remoteFile = call.getString("remoteFile");

        if (host == null || username == null || password == null || remoteFile == null) {
            call.reject("Missing required parameters: host, username, password, remoteFile");
            return;
        }

        final File localFile = new File(getContext().getCacheDir(), "flytab-update.apk");
        final String finalHost = host;
        final int finalPort = port;
        final String finalUsername = username;
        final String finalPassword = password;
        final String finalRemoteFile = remoteFile;

        executor.execute(() -> {
            Session session = null;
            ChannelSftp channel = null;
            try {
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setPassword(finalPassword);
                session.setConfig("StrictHostKeyChecking", "no");
                session.connect(30000);

                channel = (ChannelSftp) session.openChannel("sftp");
                channel.connect(10000);
                channel.get(finalRemoteFile, localFile.getAbsolutePath());

                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            } catch (Exception e) {
                localFile.delete(); // remove partial file so installApk() can't pick it up
                Log.e(TAG, "SFTP download failed", e);
                JSObject result = new JSObject();
                result.put("ok", false);
                result.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
                call.resolve(result);
            } finally {
                if (channel != null) { try { channel.disconnect(); } catch (Exception ignored) {} }
                if (session != null) { try { session.disconnect(); } catch (Exception ignored) {} }
            }
        });
    }

    /**
     * Launch the system installer for flytab-update.apk in the app cache dir.
     * The user must tap Install in the system dialog — Android enforces this.
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        File apkFile = new File(getContext().getCacheDir(), "flytab-update.apk");
        if (!apkFile.exists()) {
            call.reject("APK not found — call download() first");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch installer", e);
            call.reject("Failed to launch installer: " + e.getMessage());
        }
    }

    /** Encrypt and persist the SFTP password using Android Keystore-backed AES-256. */
    @PluginMethod
    public void savePassword(PluginCall call) {
        String password = call.getString("password");
        if (password == null) { call.reject("Missing password"); return; }
        try {
            getEncryptedPrefs().edit().putString(KEY_PASSWORD, password).apply();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to save password", e);
            call.reject("Failed to save password: " + e.getMessage());
        }
    }

    /** Retrieve the stored password. Returns {password: null} if not set. */
    @PluginMethod
    public void getPassword(PluginCall call) {
        try {
            String password = getEncryptedPrefs().getString(KEY_PASSWORD, null);
            JSObject result = new JSObject();
            result.put("password", password);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to get password", e);
            JSObject result = new JSObject();
            result.put("password", (String) null);
            call.resolve(result);
        }
    }

    /** Remove the stored password. */
    @PluginMethod
    public void clearPassword(PluginCall call) {
        try {
            getEncryptedPrefs().edit().remove(KEY_PASSWORD).apply();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear password", e);
            call.reject("Failed to clear password: " + e.getMessage());
        }
    }

    private android.content.SharedPreferences getEncryptedPrefs() throws Exception {
        String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
        return EncryptedSharedPreferences.create(
            PREFS_NAME,
            masterKeyAlias,
            getContext(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }
}
