package app.flywhere.flytab;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
 *   StratuxWS.open({ channel, url, session, ping })   // channel = 'traffic'|'situation'|'weather'|'jsonio'
 *                                      // ping (default true) = send WebSocket protocol pings
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

    // Channel → owning socket. Token-based so events that OkHttp delivers before
    // newWebSocket() returns are not dropped (see StratuxChannelRegistry).
    private final StratuxChannelRegistry<WebSocket> channels = new StratuxChannelRegistry<>();
    private StratuxWsClients clients;

    @Override
    public void load() {
        clients = new StratuxWsClients();
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String channel = call.getString("channel");
        final String url     = call.getString("url");
        final String session = call.getString("session", "");
        final boolean ping   = Boolean.TRUE.equals(call.getBoolean("ping", true));
        if (channel == null || url == null) {
            call.reject("channel and url are required");
            return;
        }

        // Claim the channel BEFORE creating the socket, and close any socket that
        // owned it before.
        final StratuxChannelRegistry.Claim<WebSocket> claim = channels.claim(channel);
        final long token = claim.token;
        StratuxWsClients.release(claim.previous);

        Request req = new Request.Builder().url(url).build();
        WebSocket ws = clients.forChannel(ping).newWebSocket(req, new WebSocketListener() {
            // current() returns true only if THIS listener's claim still owns the
            // channel. Prevents events from a cancelled (replaced) socket from being
            // delivered to JS as if they were a new socket's events. The session
            // field on each event lets the JS side disambiguate when wrappers are
            // torn down and rebuilt rapidly.
            private boolean current() {
                return channels.isCurrent(channel, token);
            }

            private JSObject base() {
                JSObject ev = new JSObject();
                ev.put("channel", channel);
                ev.put("session", session);
                return ev;
            }

            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (!current()) return;
                Log.i(TAG, channel + " WS opened: " + url);
                notifyListeners("open", base());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (!current()) return;
                JSObject ev = base();
                ev.put("data", text);
                notifyListeners("message", ev);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (!current()) return;
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
                if (!channels.release(channel, token)) return;
                Log.i(TAG, channel + " WS closed code=" + code + " reason=\"" + reason + "\"");
                JSObject ev = base();
                ev.put("code", code);
                ev.put("reason", reason == null ? "" : reason);
                notifyListeners("close", ev);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (!channels.release(channel, token)) return;
                String msg = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                Log.w(TAG, channel + " WS failure: " + msg);
                JSObject errEv = base();
                errEv.put("message", msg);
                notifyListeners("error", errEv);
                JSObject closeEv = base();
                closeEv.put("code", 1006);
                closeEv.put("reason", "ping_timeout_or_network_failure");
                notifyListeners("close", closeEv);
            }
        });
        // False if the socket already failed/closed (already reported to JS) —
        // then it simply isn't registered.
        channels.attach(channel, token, ws);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String channel = call.getString("channel");
        if (channel == null) { call.reject("channel required"); return; }
        StratuxWsClients.release(channels.releaseChannel(channel));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : channels.releaseAll()) StratuxWsClients.release(ws);
    }
}
