package app.flywhere.flytab;

import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UserInfo;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * SFTP server host keys trusted by the pilot, kept in an OpenSSH-format known_hosts
 * file in the app's private storage. Plain Java (no Android types) so it can be
 * compiled and exercised against a real sshd off-device.
 *
 * Used as JSch's HostKeyRepository with StrictHostKeyChecking=yes and no UserInfo.
 * JSch 0.2.17 Session.checkHost() runs right after key exchange, before NEWKEYS and
 * before any user authentication, and throws a plain JSchException ("reject HostKey"
 * / "HostKey has been changed") whenever check() is not OK. The exception carries no
 * key, so the verdict and the presented key are recorded here by check() and read
 * back with {@link #lastVerdict()} after connect() fails.
 *
 * Differences from JSch's KnownHosts, on purpose:
 *  - A host:port that has ANY key on record but not the presented one is CHANGED.
 *    KnownHosts only says CHANGED for a different key of the SAME type; a key of
 *    another type is NOT_INCLUDED, which would let an interceptor offering a
 *    different key type get a "first connection" prompt instead of a refusal.
 *  - No fallback from "[host]:port" to "host": keys are per host:port.
 *  - add() does nothing. Keys are added only through {@link #trust}, after the pilot
 *    confirmed the fingerprint.
 */
public final class HostKeyStore implements HostKeyRepository {

    /**
     * The known_hosts file has a line this class can't read. Connections are refused
     * (fail closed) until the pilot forgets the server key in Configuration, which
     * resets the store ({@link #forgetOrReset}).
     */
    public static final class DamagedException extends IOException {
        public static final String MESSAGE =
            "Server key store damaged — forget the server key in Configuration → Flight Upload to reset";
        DamagedException(String detail) { super(MESSAGE + " (" + detail + ")"); }
    }

    /** Result of the last check() on this instance. */
    public static final class Verdict {
        public final int result;          // OK / NOT_INCLUDED / CHANGED
        public final String hostId;       // known_hosts host field: host or [host]:port
        public final byte[] key;          // SSH public key blob the server presented
        public final String keyType;      // e.g. ssh-ed25519
        public final String fingerprint;  // SHA256:<base64, no padding> (ssh-keygen -l)
        public final String keyBase64;
        public final List<String> knownFingerprints; // keys on record for hostId

        Verdict(int result, String hostId, byte[] key, List<String> known) {
            this.result = result;
            this.hostId = hostId;
            this.key = key;
            this.keyType = keyTypeOf(key);
            this.fingerprint = fingerprintSha256(key);
            this.keyBase64 = base64Encode(key);
            this.knownFingerprints = known;
        }
    }

    private static final class Entry {
        final String hostId;
        final String keyType;
        final byte[] key;
        Entry(String hostId, String keyType, byte[] key) {
            this.hostId = hostId; this.keyType = keyType; this.key = key;
        }
    }

    // Host names, IPv4 and IPv6 literals. No spaces, commas, '#', brackets or '/',
    // so a host can never break or inject a known_hosts line.
    private static final Pattern HOST_RE = Pattern.compile("^[A-Za-z0-9._:%-]{1,253}$");
    private static final List<String> TRUSTABLE_TYPES = Arrays.asList(
        "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
        "ssh-rsa", "ssh-ed448");

    private final File file;
    private final List<Entry> entries = new ArrayList<>();
    private Verdict last;

    public HostKeyStore(File file) throws IOException {
        this.file = file;
        load();
    }

    // ── Public helpers ────────────────────────────────────────────────────────

    /** The known_hosts host field JSch passes to check(): host for port 22, else [host]:port. */
    public static String hostId(String host, int port) {
        String h = host.toLowerCase(Locale.ROOT);
        return port == 22 ? h : "[" + h + "]:" + port;
    }

    public static boolean isValidHost(String host) {
        return host != null && HOST_RE.matcher(host).matches();
    }

    /** SHA-256 fingerprint in ssh-keygen -l format: "SHA256:" + base64 without padding. */
    public static String fingerprintSha256(byte[] blob) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(blob);
            String b = base64Encode(d);
            int end = b.length();
            while (end > 0 && b.charAt(end - 1) == '=') end--;
            return "SHA256:" + b.substring(0, end);
        } catch (Exception e) {
            return "SHA256:?";
        }
    }

    /** Key algorithm name from an SSH public key blob (its first SSH string), or null. */
    public static String keyTypeOf(byte[] blob) {
        if (blob == null || blob.length < 4) return null;
        int len = ((blob[0] & 0xff) << 24) | ((blob[1] & 0xff) << 16)
                | ((blob[2] & 0xff) << 8) | (blob[3] & 0xff);
        if (len <= 0 || len > 64 || 4 + len > blob.length) return null;
        String name = new String(blob, 4, len, StandardCharsets.US_ASCII);
        return name.matches("^[a-z0-9@.-]+$") ? name : null;
    }

    /** ssh-ed25519 -> ed25519, ecdsa-sha2-* -> ecdsa, ssh-rsa -> rsa (the sshd key file name). */
    public static String shortType(String keyType) {
        if (keyType == null) return null;
        if (keyType.equals("ssh-ed25519")) return "ed25519";
        if (keyType.equals("ssh-ed448")) return "ed448";
        if (keyType.startsWith("ecdsa-sha2-")) return "ecdsa";
        if (keyType.equals("ssh-rsa")) return "rsa";
        if (keyType.equals("ssh-dss")) return "dsa";
        return null;
    }

    /**
     * Make a session verify the server key against this store: strict checking, this
     * repository, no UserInfo (so JSch never prompts or inserts). Call before connect().
     */
    public void applyTo(Session session) {
        session.setHostKeyRepository(this);
        session.setConfig("StrictHostKeyChecking", "yes");
        session.setUserInfo(null);
    }

    /**
     * After connect() threw: the verdict if it failed because of the host key
     * (unknown or changed), else null (network error, auth failure, ...).
     */
    public synchronized Verdict failedVerdict() {
        return last != null && last.result != OK ? last : null;
    }

    /** Verdict of the last check() call on this instance, or null if none happened. */
    public synchronized Verdict lastVerdict() {
        return last;
    }

    /** SHA256 fingerprints of the keys on record for host:port. */
    public synchronized List<String> fingerprintsFor(String host, int port) {
        return fingerprintsForId(hostId(host, port));
    }

    /**
     * Trust exactly this key for host:port. Allowed only when host:port has no key on
     * record (a changed key must be forgotten first, from Configuration), and only when
     * the key's fingerprint equals the one the pilot was shown.
     */
    public synchronized void trust(String host, int port, String keyType, String keyBase64,
                                   String expectedFingerprint) throws IOException {
        if (!isValidHost(host)) throw new IllegalArgumentException("Invalid host");
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid port");
        byte[] key = base64Decode(keyBase64);
        if (key == null || key.length < 16 || key.length > 8192) {
            throw new IllegalArgumentException("Invalid key");
        }
        String actualType = keyTypeOf(key);
        if (actualType == null || !actualType.equals(keyType) || !TRUSTABLE_TYPES.contains(actualType)) {
            throw new IllegalArgumentException("Key type mismatch or unsupported: " + keyType);
        }
        if (expectedFingerprint == null || !fingerprintSha256(key).equals(expectedFingerprint)) {
            throw new IllegalArgumentException("Fingerprint does not match the key");
        }
        String id = hostId(host, port);
        for (Entry e : entries) {
            if (!e.hostId.equalsIgnoreCase(id)) continue;
            if (Arrays.equals(e.key, key)) return;       // already trusted
            throw new IllegalStateException("A different key is already on record for " + id);
        }
        entries.add(new Entry(id, actualType, key));
        save();
    }

    /**
     * Forget host:port. If the store is damaged (unreadable line), delete the whole
     * file instead and return -1: the pilot asked for a reset from Configuration.
     */
    public static int forgetOrReset(File file, String host, int port) throws IOException {
        if (!isValidHost(host)) throw new IllegalArgumentException("Invalid host");
        try {
            return new HostKeyStore(file).forget(host, port);
        } catch (DamagedException e) {
            if (file.exists() && !file.delete()) throw new IOException("Cannot reset " + file);
            return -1;
        }
    }

    /** Remove every key on record for host:port. Returns how many were removed. */
    public synchronized int forget(String host, int port) throws IOException {
        if (!isValidHost(host)) throw new IllegalArgumentException("Invalid host");
        String id = hostId(host, port);
        int before = entries.size();
        entries.removeIf(e -> e.hostId.equalsIgnoreCase(id));
        int removed = before - entries.size();
        if (removed > 0) save();
        return removed;
    }

    // ── HostKeyRepository ─────────────────────────────────────────────────────

    @Override
    public synchronized int check(String host, byte[] key) {
        int result = NOT_INCLUDED;
        if (host != null && key != null) {
            for (Entry e : entries) {
                if (!e.hostId.equalsIgnoreCase(host)) continue;
                if (Arrays.equals(e.key, key)) { result = OK; break; }
                result = CHANGED;
            }
        }
        byte[] copy = key != null ? key.clone() : new byte[0];
        last = new Verdict(result, host, copy, host != null ? fingerprintsForId(host) : new ArrayList<>());
        return result;
    }

    /** Never adds: JSch must not insert keys on its own. See {@link #trust}. */
    @Override
    public void add(HostKey hostkey, UserInfo ui) {
        // intentionally empty
    }

    @Override
    public synchronized void remove(String host, String type) {
        remove(host, type, null);
    }

    @Override
    public synchronized void remove(String host, String type, byte[] key) {
        // JSch only calls this when replacing a changed key after a UserInfo prompt,
        // which never happens here (no UserInfo). Kept read-only on purpose.
    }

    @Override
    public String getKnownHostsRepositoryID() {
        return file.getAbsolutePath();
    }

    @Override
    public synchronized HostKey[] getHostKey() {
        return toHostKeys(null, null);
    }

    /** Used by JSch to prefer the known key's algorithm and to check @revoked markers. */
    @Override
    public synchronized HostKey[] getHostKey(String host, String type) {
        return toHostKeys(host, type);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private List<String> fingerprintsForId(String id) {
        List<String> out = new ArrayList<>();
        for (Entry e : entries) {
            if (e.hostId.equalsIgnoreCase(id)) out.add(fingerprintSha256(e.key) + " (" + e.keyType + ")");
        }
        return out;
    }

    private HostKey[] toHostKeys(String host, String type) {
        List<HostKey> out = new ArrayList<>();
        for (Entry e : entries) {
            if (host != null && !e.hostId.equalsIgnoreCase(host)) continue;
            if (type != null && !e.keyType.equals(type)) continue;
            try {
                out.add(new HostKey(e.hostId, HostKey.GUESS, e.key)); // marker "" (not @revoked)
            } catch (Exception ignored) {
                // a key JSch cannot classify is still matched byte-for-byte by check()
            }
        }
        return out.toArray(new HostKey[0]);
    }

    /**
     * Blank lines and # comments are skipped. Any other line must be exactly what
     * save() writes (host, key type, base64 key whose type matches); otherwise the
     * store is DAMAGED and nothing is trusted: dropping a line could silently turn a
     * known server into an "unknown" one and bring back the first-connection prompt.
     */
    private void load() throws IOException {
        entries.clear();
        if (!file.exists()) return;
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            int n = 0;
            while ((line = r.readLine()) != null) {
                n++;
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] p = line.split("\\s+");
                if (p.length != 3 || !isValidHostId(p[0])) throw new DamagedException("line " + n);
                byte[] key = base64Decode(p[2]);
                String t = key != null ? keyTypeOf(key) : null;
                if (t == null || !t.equals(p[1])) throw new DamagedException("line " + n);
                entries.add(new Entry(p[0], t, key));
            }
        }
    }

    /** host, or [host]:port with port 1-65535 (the forms hostId() writes). */
    private static boolean isValidHostId(String id) {
        if (id.startsWith("[")) {
            int close = id.indexOf("]:");
            if (close < 2) return false;
            String port = id.substring(close + 2);
            if (!port.matches("^[0-9]{1,5}$")) return false;
            int pn = Integer.parseInt(port);
            return pn >= 1 && pn <= 65535 && isValidHost(id.substring(1, close));
        }
        return isValidHost(id);
    }

    private void save() throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp);
             Writer w = new OutputStreamWriter(fos, StandardCharsets.UTF_8)) {
            for (Entry e : entries) {
                w.write(e.hostId + " " + e.keyType + " " + base64Encode(e.key) + "\n");
            }
            w.flush();
            fos.getFD().sync();      // on disk before the rename makes it the store
        }
        if (!tmp.renameTo(file)) {
            tmp.delete();
            throw new IOException("Cannot write " + file);
        }
    }

    // RFC 4648 base64 (standard alphabet, padded). java.util.Base64 needs API 26;
    // minSdk is 24, and this class must stay free of android.util.Base64.
    private static final char[] B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    public static String base64Encode(byte[] in) {
        StringBuilder sb = new StringBuilder((in.length + 2) / 3 * 4);
        for (int i = 0; i < in.length; i += 3) {
            int b0 = in[i] & 0xff;
            int b1 = i + 1 < in.length ? in[i + 1] & 0xff : 0;
            int b2 = i + 2 < in.length ? in[i + 2] & 0xff : 0;
            sb.append(B64[b0 >>> 2]);
            sb.append(B64[((b0 & 3) << 4) | (b1 >>> 4)]);
            sb.append(i + 1 < in.length ? B64[((b1 & 15) << 2) | (b2 >>> 6)] : '=');
            sb.append(i + 2 < in.length ? B64[b2 & 63] : '=');
        }
        return sb.toString();
    }

    /** Strict decode: standard alphabet, length a multiple of 4, padding only at the end. Null if invalid. */
    public static byte[] base64Decode(String s) {
        if (s == null || s.isEmpty() || s.length() % 4 != 0) return null;
        int pad = 0;
        if (s.endsWith("==")) pad = 2; else if (s.endsWith("=")) pad = 1;
        int n = s.length() / 4 * 3 - pad;
        byte[] out = new byte[n];
        int o = 0;
        for (int i = 0; i < s.length(); i += 4) {
            int[] v = new int[4];
            for (int j = 0; j < 4; j++) {
                char c = s.charAt(i + j);
                if (c == '=') {
                    if (i + 4 != s.length() || j < 4 - pad) return null;
                    v[j] = 0;
                } else {
                    int idx = c >= 'A' && c <= 'Z' ? c - 'A'
                            : c >= 'a' && c <= 'z' ? c - 'a' + 26
                            : c >= '0' && c <= '9' ? c - '0' + 52
                            : c == '+' ? 62 : c == '/' ? 63 : -1;
                    if (idx < 0) return null;
                    v[j] = idx;
                }
            }
            int x = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
            if (o < n) out[o++] = (byte) (x >>> 16);
            if (o < n) out[o++] = (byte) (x >>> 8);
            if (o < n) out[o++] = (byte) x;
        }
        return out;
    }
}
