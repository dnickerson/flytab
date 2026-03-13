package app.flywhere.engineml;

import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

import java.util.concurrent.TimeUnit;

/**
 * Connects to the Pi engine monitor WebSocket for live engine data.
 * Parses JSON and extracts the 13 features needed by the model.
 */
public class EngineWebSocket {
    private static final String TAG = "EngineWebSocket";

    // Default WebSocket URLs
    public static final String URL_AIRCRAFT = "ws://192.168.10.1:8082/";
    public static final String URL_HOME = "ws://192.168.1.77:8082/";

    private static final String[] FEATURE_KEYS = {
        "rpm", "egt1", "egt2", "egt3", "egt4",
        "cht1", "cht2", "cht3", "cht4",
        "oil_temp", "oil_psi", "fuel_flow"
    };

    public interface LiveDataCallback {
        void onSample(float[] features);
        void onConnected();
        void onDisconnected(String reason);
        void onError(String error);
    }

    private OkHttpClient client;
    private WebSocket webSocket;
    private LiveDataCallback callback;
    private String url;
    private boolean shouldReconnect = true;
    private int reconnectAttempts = 0;
    private static final int MAX_RECONNECT_DELAY_MS = 30000;
    private final Gson gson = new Gson();

    // Default altitude when no GPS available
    private float currentAltitude = 0f;

    public EngineWebSocket(String url, LiveDataCallback callback) {
        this.url = url;
        this.callback = callback;
        this.client = new OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build();
    }

    public void connect() {
        shouldReconnect = true;
        reconnectAttempts = 0;
        doConnect();
    }

    private void doConnect() {
        Request request = new Request.Builder().url(url).build();
        webSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                Log.i(TAG, "WebSocket connected to " + url);
                reconnectAttempts = 0;
                if (callback != null) callback.onConnected();
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                try {
                    float[] features = parseEngineJson(text);
                    if (features != null && callback != null) {
                        callback.onSample(features);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Failed to parse engine data: " + e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                Log.w(TAG, "WebSocket failure: " + t.getMessage());
                if (callback != null) callback.onDisconnected(t.getMessage());
                scheduleReconnect();
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                Log.i(TAG, "WebSocket closed: " + reason);
                if (callback != null) callback.onDisconnected(reason);
                scheduleReconnect();
            }
        });
    }

    private float[] parseEngineJson(String json) {
        JsonObject obj = gson.fromJson(json, JsonObject.class);
        float[] features = new float[13]; // 12 engine params + altitude

        for (int i = 0; i < FEATURE_KEYS.length; i++) {
            if (obj.has(FEATURE_KEYS[i]) && !obj.get(FEATURE_KEYS[i]).isJsonNull()) {
                features[i] = obj.get(FEATURE_KEYS[i]).getAsFloat();
            }
        }

        // altitude_ft is the 13th feature — use GPS altitude if available in the JSON,
        // otherwise use the externally set altitude
        if (obj.has("altitude_ft") && !obj.get("altitude_ft").isJsonNull()) {
            features[12] = obj.get("altitude_ft").getAsFloat();
        } else {
            features[12] = currentAltitude;
        }

        return features;
    }

    private void scheduleReconnect() {
        if (!shouldReconnect) return;
        reconnectAttempts++;
        long delayMs = Math.min(1000L * (1 << Math.min(reconnectAttempts, 5)), MAX_RECONNECT_DELAY_MS);
        Log.i(TAG, "Reconnecting in " + delayMs + "ms (attempt " + reconnectAttempts + ")");

        new Thread(() -> {
            try {
                Thread.sleep(delayMs);
                if (shouldReconnect) doConnect();
            } catch (InterruptedException ignored) {}
        }).start();
    }

    public void setCurrentAltitude(float altitudeFt) {
        this.currentAltitude = altitudeFt;
    }

    public void disconnect() {
        shouldReconnect = false;
        if (webSocket != null) {
            webSocket.close(1000, "User disconnected");
            webSocket = null;
        }
    }

    public void setUrl(String newUrl) {
        this.url = newUrl;
    }

    public String getUrl() {
        return url;
    }

    public boolean isConnected() {
        return webSocket != null;
    }
}
