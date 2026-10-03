package app.flywhere.flytab;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.WebSocket;

/**
 * OkHttp clients for the Stratux WebSocket channels, plus how a socket is let go.
 * Kept separate from StratuxWsPlugin (a Capacitor Plugin) so it is unit-testable
 * on the JVM — see StratuxWsClientsTest.
 */
final class StratuxWsClients {
    // Send ping every 30 s. Standard for keep-alive — short enough to detect a
    // half-closed connection in ~60 s, long enough not to load the link.
    static final long PING_INTERVAL_SEC = 30;

    private final OkHttpClient withPing;
    // Same pool/dispatcher, no protocol pings. For Stratux's /situation endpoint,
    // whose server handler never reads from the socket — golang.org/x/net/websocket
    // only answers a ping from inside Read(), so a pinged /situation socket is
    // failed by OkHttp ("didn't receive pong") ~60 s after every connect. JS
    // detects a dead situation socket by message silence instead (10 Hz stream).
    private final OkHttpClient noPing;

    StratuxWsClients() {
        withPing = new OkHttpClient.Builder()
            .pingInterval(PING_INTERVAL_SEC, TimeUnit.SECONDS)
            // Read timeout 0 = no timeout for streaming reads. Pings detect dead conn.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            // Allow some time for the initial WS handshake.
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();
        noPing = withPing.newBuilder()
            .pingInterval(0, TimeUnit.SECONDS)
            .build();
    }

    OkHttpClient forChannel(boolean ping) { return ping ? withPing : noPing; }

    /**
     * Let go of a socket JS closed or replaced. cancel(), not close(): a graceful
     * close keeps the socket's thread and TCP connection until the server
     * acknowledges the close or OkHttp's 60 s timer fires, and Stratux's /situation
     * handler never reads, so it never acknowledges — it just keeps writing 10 Hz
     * into a socket nobody wants. cancel() also aborts a not-yet-connected socket.
     */
    static void release(WebSocket ws) {
        if (ws == null) return;
        try { ws.cancel(); } catch (Exception ignored) {}
    }
}
