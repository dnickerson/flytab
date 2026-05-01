package app.flywhere.flytab;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native WebSocket transport for Stratux. Used in place of the browser WebSocket API
 * because the browser API can't:
 *   - send/receive WebSocket protocol-level ping/pong frames
 *   - enable TCP keepalive
 *   - detect half-closed connections
 *
 * Symptoms of those gaps in flight: traffic WS readyState stays OPEN forever while no
 * messages flow and onclose never fires. OkHttp's pingInterval kills dead connections
 * in ~30 s and surfaces a real close event so the JS reconnect path runs.
 *
 * JS API:
 *   StratuxWS.open({ channel, url })   // channel = 'traffic'|'situation'|'weather'|'jsonio'
 *   StratuxWS.close({ channel })
 *   StratuxWS.addListener('message', ({channel, data}) => …)
 *   StratuxWS.addListener('open',    ({channel}) => …)
 *   StratuxWS.addListener('close',   ({channel, code, reason}) => …)
 *   StratuxWS.addListener('error',   ({channel, message}) => …)
 *
 * Each channel is a single WebSocket; opening a channel that already has an open
 * socket closes the old one first.
 */
@CapacitorPlugin(name = "StratuxWS")
public class StratuxWsPlugin extends Plugin {
    private static final String TAG = "StratuxWS";

    // Send ping every 30 s. Standard for keep-alive — short enough to detect a
    // half-closed connection in ~60 s, long enough not to load the link.
    private static final long PING_INTERVAL_SEC = 30;

    private final Map<String, WebSocket> sockets = new HashMap<>();
    private OkHttpClient client;

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .pingInterval(PING_INTERVAL_SEC, TimeUnit.SECONDS)
            // Read timeout 0 = no timeout for streaming reads. Pings detect dead conn.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            // Allow some time for the initial WS handshake.
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String channel = call.getString("channel");
        final String url     = call.getString("url");
        final String session = call.getString("session", "");
        if (channel == null || url == null) {
            call.reject("channel and url are required");
            return;
        }

        // Close any existing socket on this channel before opening a new one.
        WebSocket old = sockets.remove(channel);
        if (old != null) {
            try { old.cancel(); } catch (Exception ignored) {}
        }

        Request req = new Request.Builder().url(url).build();
        WebSocket ws = client.newWebSocket(req, new WebSocketListener() {
            // current() returns true only if THIS listener's socket is still the
            // active one for this channel. Prevents events from a cancelled
            // (replaced) socket from being delivered to JS as if they were a new
            // socket's events. The session field on each event lets the JS side
            // disambiguate when wrappers are torn down and rebuilt rapidly.
            private boolean current(WebSocket self) {
                return sockets.get(channel) == self;
            }

            private JSObject base() {
                JSObject ev = new JSObject();
                ev.put("channel", channel);
                ev.put("session", session);
                return ev;
            }

            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (!current(webSocket)) return;
                Log.i(TAG, channel + " WS opened: " + url);
                notifyListeners("open", base());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (!current(webSocket)) return;
                JSObject ev = base();
                ev.put("data", text);
                notifyListeners("message", ev);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (!current(webSocket)) return;
                JSObject ev = base();
                ev.put("data", bytes.base64());
                ev.put("binary", true);
                notifyListeners("message", ev);
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (!current(webSocket)) return;
                Log.i(TAG, channel + " WS closed code=" + code + " reason=\"" + reason + "\"");
                sockets.remove(channel);
                JSObject ev = base();
                ev.put("code", code);
                ev.put("reason", reason == null ? "" : reason);
                notifyListeners("close", ev);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (!current(webSocket)) return;
                String msg = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                Log.w(TAG, channel + " WS failure: " + msg);
                sockets.remove(channel);
                JSObject errEv = base();
                errEv.put("message", msg);
                notifyListeners("error", errEv);
                JSObject closeEv = base();
                closeEv.put("code", 1006);
                closeEv.put("reason", "ping_timeout_or_network_failure");
                notifyListeners("close", closeEv);
            }
        });
        sockets.put(channel, ws);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String channel = call.getString("channel");
        if (channel == null) { call.reject("channel required"); return; }
        WebSocket ws = sockets.remove(channel);
        if (ws != null) {
            try { ws.close(1000, "client_close"); } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : sockets.values()) {
            try { ws.cancel(); } catch (Exception ignored) {}
        }
        sockets.clear();
    }
}
