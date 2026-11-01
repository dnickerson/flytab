package app.flywhere.flytab;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Server host keys that a real connection attempt presented and that are not yet
 * trusted, one per host:port (plain Java, no Android types). trustHostKey may only
 * store a key remembered here, byte for byte, and each entry is good for one try:
 * a script in the WebView can't make FlyTab trust a key no server sent.
 */
public final class PresentedKeys {
    private final Map<String, byte[]> pending = new HashMap<>();

    /** Remember the key the server at hostId presented (replaces an older one). */
    public synchronized void remember(String hostId, byte[] key) {
        if (hostId == null || key == null) return;
        pending.put(hostId.toLowerCase(Locale.ROOT), key.clone());
    }

    /**
     * True if key is exactly the one last presented by hostId. The entry is removed
     * either way (one use): a failed or repeated trust needs a new connection attempt.
     */
    public synchronized boolean consume(String hostId, byte[] key) {
        if (hostId == null) return false;
        byte[] seen = pending.remove(hostId.toLowerCase(Locale.ROOT));
        return seen != null && key != null && Arrays.equals(seen, key);
    }
}
