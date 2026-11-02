package app.flywhere.flytab;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.net.Uri;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import app.flywhere.flytab.tileserver.FlightFiles;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Sftp")
public class SftpPlugin extends Plugin {
    private static final String TAG = "SftpPlugin";
    private static final String PREFS_NAME = "flytab_sftp_prefs";
    private static final String KEY_PASSWORD = "sftp_password";
    private static final String KEY_PRIVATE_KEY = "sftp_private_key";
    /** Trusted server host keys (OpenSSH known_hosts format), app-private storage. */
    private static final String KNOWN_HOSTS_FILE = "sftp_known_hosts";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    /** Unknown keys servers actually presented; trustHostKey may store only these (one use each). */
    private final PresentedKeys presentedKeys = new PresentedKeys();

    /**
     * Upload a file to a remote SFTP server: a flight file from Documents/FlyTab/flights/
     * (dir "flights", the default) to the remote path, or an airport note from
     * Documents/FlyTab/notes/ (dir "notes") to <remote path>/notes/. Source folder,
     * file name and plain-file checks: UploadSource.
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
        String dir = call.getString("dir", UploadSource.FLIGHTS);

        if (host == null || username == null || filename == null || password == null) {
            call.reject("Missing required parameters: host, username, filename, password");
            return;
        }

        UploadSource source = UploadSource.resolve(
            new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "FlyTab"),
            dir, filename);
        if (source.error != null) {
            call.reject(source.error);
            return;
        }
        final File localFile = source.file;
        final String remoteSubdir = source.remoteSubdir;

        final String finalHost = host;
        final int finalPort = port;
        final String finalUsername = username;
        final String finalRemotePath = remotePath;
        final String finalPassword = password;

        executor.execute(() -> {
            Session session = null;
            ChannelSftp channel = null;
            HostKeyStore hostKeys = null;
            try {
                // Server key checked against the pilot-trusted keys during key exchange,
                // before any password or key is sent (HostKeyStore class comment).
                hostKeys = new HostKeyStore(knownHostsFile());
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                hostKeys.applyTo(session);
                byte[] keyBytes = loadStoredKey();
                if (keyBytes != null) {
                    byte[] passphrase = finalPassword != null
                        ? finalPassword.getBytes(StandardCharsets.UTF_8) : null;
                    jsch.addIdentity("flytab", keyBytes, null, passphrase);
                }
                session.setConfig("PreferredAuthentications", "publickey,password");
                session.setPassword(finalPassword);
                session.connect(30000);

                channel = (ChannelSftp) session.openChannel("sftp");
                channel.connect(10000);

                String expandedPath = expandHome(finalRemotePath, channel);
                // Create remote directory if it doesn't exist (ignore error if it does)
                try { channel.mkdir(expandedPath); } catch (Exception ignored) {}
                channel.cd(expandedPath);
                if (remoteSubdir != null) {        // notes/ (UploadSource allow-list only)
                    try { channel.mkdir(remoteSubdir); } catch (Exception ignored) {}
                    channel.cd(remoteSubdir);
                }

                try (FileInputStream fis = new FileInputStream(localFile)) {
                    channel.put(fis, filename);
                }

                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);

            } catch (Exception e) {
                if (e instanceof HostKeyStore.DamagedException) { call.resolve(damagedStore(e, finalHost, finalPort)); return; }
                JSObject hk = hostKeyFailure(hostKeys, finalHost, finalPort);
                if (hk != null) { call.resolve(hk); return; }
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
        if (!FlightFiles.isDirectChild(getContext().getCacheDir(), localFile)) {
            localFile.delete();
            call.reject("Invalid download target");
            return;
        }
        final String finalHost = host;
        final int finalPort = port;
        final String finalUsername = username;
        final String finalPassword = password;
        final String finalRemoteFile = remoteFile;

        executor.execute(() -> {
            Session session = null;
            ChannelSftp channel = null;
            HostKeyStore hostKeys = null;
            try {
                // Server key checked against the pilot-trusted keys during key exchange,
                // before any password or key is sent (HostKeyStore class comment).
                hostKeys = new HostKeyStore(knownHostsFile());
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                hostKeys.applyTo(session);
                byte[] keyBytes = loadStoredKey();
                if (keyBytes != null) {
                    byte[] passphrase = finalPassword != null
                        ? finalPassword.getBytes(StandardCharsets.UTF_8) : null;
                    jsch.addIdentity("flytab", keyBytes, null, passphrase);
                }
                session.setConfig("PreferredAuthentications", "publickey,password");
                session.setPassword(finalPassword);
                session.connect(30000);

                channel = (ChannelSftp) session.openChannel("sftp");
                channel.connect(10000);
                channel.get(expandHome(finalRemoteFile, channel), localFile.getAbsolutePath());

                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            } catch (Exception e) {
                localFile.delete(); // remove partial file so installApk() can't pick it up
                if (e instanceof HostKeyStore.DamagedException) { call.resolve(damagedStore(e, finalHost, finalPort)); return; }
                JSObject hk = hostKeyFailure(hostKeys, finalHost, finalPort);
                if (hk != null) { call.resolve(hk); return; }
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
     * Trust a server host key after the pilot confirmed its fingerprint. The key is
     * the one returned by the failed upload/download (hostKey.keyBase64), not fetched
     * again, and its SHA256 fingerprint must equal the one shown (hostKey.fingerprint).
     * Refused if host:port already has a different key (forget it in Configuration first),
     * and unless the key is byte-for-byte the one the server presented in the last
     * failed attempt for host:port (PresentedKeys; one use).
     */
    @PluginMethod
    public void trustHostKey(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port", 22);
        String keyType = call.getString("keyType");
        String keyBase64 = call.getString("keyBase64");
        String fingerprint = call.getString("fingerprint");
        if (host == null || port == null || keyType == null || keyBase64 == null || fingerprint == null) {
            call.reject("Missing required parameters: host, port, keyType, keyBase64, fingerprint");
            return;
        }
        try {
            byte[] key = HostKeyStore.base64Decode(keyBase64);
            if (!HostKeyStore.isValidHost(host) || !presentedKeys.consume(HostKeyStore.hostId(host, port), key)) {
                throw new IllegalArgumentException("not the key the server presented — try the upload again");
            }
            new HostKeyStore(knownHostsFile()).trust(host, port, keyType, keyBase64, fingerprint);
            Log.i(TAG, "Trusted " + keyType + " key " + fingerprint + " for " + HostKeyStore.hostId(host, port));
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.w(TAG, "trustHostKey refused: " + e.getMessage());
            call.reject("Could not trust server key: " + e.getMessage());
        }
    }

    /** Forget every trusted key for host:port (Configuration → Flight Upload only). */
    @PluginMethod
    public void forgetHostKey(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port", 22);
        if (host == null || port == null) {
            call.reject("Missing required parameters: host, port");
            return;
        }
        try {
            int removed = HostKeyStore.forgetOrReset(knownHostsFile(), host, port);
            Log.i(TAG, removed < 0 ? "Server key store was damaged: reset"
                : "Forgot " + removed + " key(s) for " + HostKeyStore.hostId(host, port));
            JSObject result = new JSObject();
            result.put("removed", Math.max(removed, 0));
            result.put("reset", removed < 0);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not forget server key: " + e.getMessage());
        }
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
        String refusal;
        if (!FlightFiles.isPlainFileIn(getContext().getCacheDir(), apkFile)) {
            refusal = "the downloaded file is not a plain file in the app's cache";
        } else {
            try {
                refusal = checkUpdateApk(apkFile);
            } catch (Exception e) {
                refusal = "it could not be checked (" + e.getMessage() + ")";
            }
        }
        if (refusal != null) {
            apkFile.delete();
            Log.w(TAG, "Update refused: " + refusal);
            call.reject("Update refused: " + refusal + ". The downloaded file was deleted.");
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

    /**
     * Same package, same signing certificate(s) and a strictly higher versionCode than
     * the installed FlyTab (ApkCheck), else the reason. API 28+ reads SigningInfo
     * (GET_SIGNING_CERTIFICATES); minSdk 24-27 needs GET_SIGNATURES.
     */
    @SuppressWarnings("deprecation")
    private String checkUpdateApk(File apkFile) throws PackageManager.NameNotFoundException {
        PackageManager pm = getContext().getPackageManager();
        String own = getContext().getPackageName();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = pm.getPackageInfo(own, flags);
        PackageInfo apk = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        return ApkCheck.refusal(
            own, PackageInfoCompat.getLongVersionCode(installed), signerHashes(installed),
            apk != null ? apk.packageName : null,
            apk != null ? PackageInfoCompat.getLongVersionCode(apk) : -1,
            apk != null ? signerHashes(apk) : null);
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signerHashes(PackageInfo pi) {
        Set<String> out = new HashSet<>();
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo si = pi.signingInfo;
            if (si != null) sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
        } else {
            sigs = pi.signatures;
        }
        if (sigs != null) for (Signature s : sigs) out.add(ApkCheck.sha256Hex(s.toByteArray()));
        return out;
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

    @PluginMethod
    public void importKey(PluginCall call) {
        String keyPath = call.getString("keyPath");
        if (keyPath == null || keyPath.isEmpty()) {
            call.reject("Missing keyPath");
            return;
        }
        if (keyPath.contains("..")) {
            call.reject("Invalid keyPath");
            return;
        }

        File keyFile = keyPath.startsWith("/")
            ? new File(keyPath)
            : new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), keyPath);

        // Canonical-path guard: absolute paths must resolve within Documents or app storage
        if (keyPath.startsWith("/")) {
            try {
                String canonical = keyFile.getCanonicalPath();
                String docsRoot = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOCUMENTS).getCanonicalPath();
                String appRoot = getContext().getFilesDir().getCanonicalPath();
                if (!canonical.startsWith(docsRoot) && !canonical.startsWith(appRoot)) {
                    call.reject("Invalid keyPath");
                    return;
                }
            } catch (java.io.IOException e) {
                call.reject("Invalid keyPath");
                return;
            }
        }

        if (!keyFile.exists()) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", "File not found: " + keyFile.getAbsolutePath());
            call.resolve(result);
            return;
        }

        if (keyFile.length() > 65536) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", "Key file too large");
            call.resolve(result);
            return;
        }

        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            try (FileInputStream fis = new FileInputStream(keyFile)) {
                while ((n = fis.read(buf)) != -1) baos.write(buf, 0, n);
            }
            String encoded = Base64.encodeToString(baos.toByteArray(), Base64.DEFAULT);
            getEncryptedPrefs().edit().putString(KEY_PRIVATE_KEY, encoded).apply();
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to import key", e);
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
            call.resolve(result);
        }
    }

    @PluginMethod
    public void clearKey(PluginCall call) {
        try {
            getEncryptedPrefs().edit().remove(KEY_PRIVATE_KEY).apply();
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear key", e);
        }
        call.resolve();
    }

    @PluginMethod
    public void getKeyStatus(PluginCall call) {
        try {
            String encoded = getEncryptedPrefs().getString(KEY_PRIVATE_KEY, null);
            JSObject result = new JSObject();
            result.put("hasKey", encoded != null);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to read key status", e);
            JSObject result = new JSObject();
            result.put("hasKey", false);
            call.resolve(result);
        }
    }

    private File knownHostsFile() {
        return new File(getContext().getFilesDir(), KNOWN_HOSTS_FILE);
    }

    /**
     * Result for an operation stopped by the server host key, or null if it failed for
     * another reason. Unknown key: carries the key so the pilot's Trust stores exactly
     * the key they were shown. Changed key: no key (it can't be trusted from here),
     * plus the fingerprints on record.
     */
    private JSObject hostKeyFailure(HostKeyStore store, String host, int port) {
        HostKeyStore.Verdict v = store != null ? store.failedVerdict() : null;
        if (v == null) return null;
        boolean changed = v.result == com.jcraft.jsch.HostKeyRepository.CHANGED;
        JSObject hk = new JSObject();
        hk.put("status", changed ? "changed" : "unknown");
        hk.put("host", host);
        hk.put("port", port);
        hk.put("keyType", v.keyType);
        hk.put("shortType", HostKeyStore.shortType(v.keyType));
        hk.put("fingerprint", v.fingerprint);
        if (changed) {
            hk.put("knownFingerprints", new JSArray(v.knownFingerprints));
            Log.w(TAG, "Server key CHANGED for " + v.hostId + ": presented " + v.fingerprint
                + " (" + v.keyType + "), on record " + v.knownFingerprints);
        } else {
            hk.put("keyBase64", v.keyBase64);
            presentedKeys.remember(v.hostId, v.key);
            Log.i(TAG, "Unknown server key for " + v.hostId + ": " + v.fingerprint + " (" + v.keyType + ")");
        }
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("error", changed
            ? "Server key for " + host + " has CHANGED — possible interception."
            : "Unknown server key for " + host);
        result.put("hostKey", hk);
        return result;
    }

    /** Result when known_hosts can't be read: nothing is trusted until it is reset. */
    private JSObject damagedStore(Exception e, String host, int port) {
        Log.w(TAG, e.getMessage());
        JSObject hk = new JSObject();
        hk.put("status", "damaged");
        hk.put("host", host);
        hk.put("port", port);
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("error", HostKeyStore.DamagedException.MESSAGE);
        result.put("hostKey", hk);
        return result;
    }

    /** Expand a leading ~ or ~/ in an SFTP path using the channel's home directory. */
    private String expandHome(String path, ChannelSftp channel) {
        if (path == null) return path;
        if (path.equals("~")) {
            try { return channel.getHome(); } catch (Exception e) { return path; }
        }
        if (path.startsWith("~/")) {
            try { return channel.getHome() + path.substring(1); } catch (Exception e) { return path; }
        }
        return path;
    }

    private byte[] loadStoredKey() {
        try {
            String encoded = getEncryptedPrefs().getString(KEY_PRIVATE_KEY, null);
            if (encoded == null) return null;
            return Base64.decode(encoded, Base64.DEFAULT);
        } catch (Exception e) {
            Log.e(TAG, "Failed to load stored key", e);
            return null;
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
