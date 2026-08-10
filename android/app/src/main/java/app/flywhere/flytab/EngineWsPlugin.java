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
 * Native WebSocket transport for the Pi engine monitor. Mirrors StratuxWsPlugin —
 * same problem, same fix: the browser WebSocket API can't send/receive protocol-level
 * ping/pong and can't detect a half-closed connection (peer stops sending, no
 * FIN/RST — readyState stays OPEN forever, onclose never fires). OkHttp's
 * pingInterval kills a dead connection in ~30s and surfaces a real close event so
 * the JS reconnect / HTTP-fallback path in engine-client.js runs.
 *
 * JS API (identical shape to StratuxWS):
 *   EngineWS.open({ channel, url, session })
 *   EngineWS.close({ channel })
 *   EngineWS.addListener('message', ({channel, session, data}) => …)
 *   EngineWS.addListener('open',    ({channel, session}) => …)
 *   EngineWS.addListener('close',   ({channel, session, code, reason}) => …)
 *   EngineWS.addListener('error',   ({channel, session, message}) => …)
 */
@CapacitorPlugin(name = "EngineWS")
public class EngineWsPlugin extends Plugin {
    private static final String TAG = "EngineWS";
    private static final long PING_INTERVAL_SEC = 30;

    private final Map<String, WebSocket> sockets = new HashMap<>();
    private OkHttpClient client;

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .pingInterval(PING_INTERVAL_SEC, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
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

        WebSocket old = sockets.remove(channel);
        if (old != null) {
            try { old.cancel(); } catch (Exception ignored) {}
        }

        Request req = new Request.Builder().url(url).build();
        WebSocket ws = client.newWebSocket(req, new WebSocketListener() {
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
