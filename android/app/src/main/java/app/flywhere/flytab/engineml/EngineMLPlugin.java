package app.flywhere.flytab.engineml;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * Capacitor plugin exposing EngineML inference to the FlyTab WebView.
 *
 * JS calls processSample() at 1Hz with engine data. The plugin maintains
 * a 60-sample rolling window internally and runs inference when full.
 * Returns anomaly score, phase, advisories, and per-feature errors.
 */
@CapacitorPlugin(name = "EngineML")
public class EngineMLPlugin extends Plugin {
    private static final String TAG = "EngineML";
    private static final int WINDOW_SIZE = 60;
    private static final int N_FEATURES = 12;

    private InferenceEngine inferenceEngine;
    private ThresholdAdapter thresholdAdapter;
    private PhaseDetector phaseDetector;
    private EngineAdvisor engineAdvisor;

    private float[][] window;
    private int windowPos;
    private boolean windowFull;
    private boolean initialized;

    @PluginMethod
    public void initialize(PluginCall call) {
        if (initialized) {
            JSObject ret = new JSObject();
            ret.put("status", "already_initialized");
            ret.put("delegate", inferenceEngine.getActiveDelegate());
            call.resolve(ret);
            return;
        }

        try {
            inferenceEngine = new InferenceEngine(getContext(), (delegateName) -> {
                Log.i(TAG, "ML delegate: " + delegateName);
            });

            thresholdAdapter = new ThresholdAdapter(getContext(), inferenceEngine.getPhaseThresholds());
            phaseDetector = new PhaseDetector();
            engineAdvisor = new EngineAdvisor();

            window = new float[WINDOW_SIZE][N_FEATURES];
            windowPos = 0;
            windowFull = false;
            initialized = true;

            JSObject ret = new JSObject();
            ret.put("status", "ok");
            ret.put("delegate", inferenceEngine.getActiveDelegate());
            ret.put("windowSize", WINDOW_SIZE);
            ret.put("nFeatures", N_FEATURES);
            ret.put("globalThreshold", inferenceEngine.getGlobalThreshold());
            call.resolve(ret);

            Log.i(TAG, "EngineML initialized — delegate: " + inferenceEngine.getActiveDelegate());
        } catch (Exception e) {
            Log.e(TAG, "Init failed", e);
            call.reject("EngineML init failed: " + e.getMessage());
        }
    }

    /**
     * Process one second of engine data. Maintains rolling window internally.
     * When window is full (60 samples), runs inference and returns results.
     *
     * Expected JS call:
     *   EngineML.processSample({
     *     rpm, egt1, egt2, egt3, egt4, cht1, cht2, cht3, cht4,
     *     oil_temp, oil_press, fuel_flow,
     *     altitude, mp, carb_temp, fuel_remaining, ground_speed, distance_nm
     *   })
     * altitude is used for phase detection only, not as an ML feature.
     */
    @PluginMethod
    public void processSample(PluginCall call) {
        if (!initialized) {
            call.reject("Not initialized — call initialize() first");
            return;
        }

        try {
            // Extract 12 ML features (altitude excluded — used for phase detection only)
            float rpm = f(call, "rpm");
            float egt1 = f(call, "egt1");
            float egt2 = f(call, "egt2");
            float egt3 = f(call, "egt3");
            float egt4 = f(call, "egt4");
            float cht1 = f(call, "cht1");
            float cht2 = f(call, "cht2");
            float cht3 = f(call, "cht3");
            float cht4 = f(call, "cht4");
            float oilTemp = f(call, "oil_temp");
            float oilPress = f(call, "oil_press");
            float fuelFlow = f(call, "fuel_flow");

            // Extra fields for phase detection and advisor (not ML features)
            float altitude = f(call, "altitude");
            float mp = f(call, "mp");
            float carbTemp = f(call, "carb_temp");
            float fuelRemaining = f(call, "fuel_remaining");
            float groundSpeed = f(call, "ground_speed");
            float distanceNm = f(call, "distance_nm");

            float[] features = { rpm, egt1, egt2, egt3, egt4, cht1, cht2, cht3, cht4,
                                 oilTemp, oilPress, fuelFlow };

            // Add to rolling window
            System.arraycopy(features, 0, window[windowPos], 0, N_FEATURES);
            windowPos = (windowPos + 1) % WINDOW_SIZE;
            if (windowPos == 0) windowFull = true;

            // Detect phase
            String phase = phaseDetector.detect(rpm, altitude, groundSpeed);

            // Feed advisor
            engineAdvisor.addSample(features, mp, carbTemp, fuelRemaining, altitude);

            JSObject ret = new JSObject();
            ret.put("phase", phase);
            ret.put("windowReady", windowFull);

            if (windowFull && rpm > 100) {
                // Build ordered window (oldest to newest)
                float[][] orderedWindow = new float[WINDOW_SIZE][N_FEATURES];
                for (int i = 0; i < WINDOW_SIZE; i++) {
                    int idx = (windowPos + i) % WINDOW_SIZE;
                    System.arraycopy(window[idx], 0, orderedWindow[i], 0, N_FEATURES);
                }

                try {
                    // Run inference — throws TimeoutException if interpreter.run() hangs
                    float score = inferenceEngine.runInference(orderedWindow);
                    float threshold = thresholdAdapter.getThreshold(phase);
                    boolean anomaly = score > threshold;

                    // Adapt threshold with normal scores
                    if (!anomaly) {
                        thresholdAdapter.recordNormalScore(phase, score);
                    }

                    // Get advisories
                    List<EngineAdvisor.Advisory> advisories = engineAdvisor.advise(
                        features, phase, score, anomaly, distanceNm, groundSpeed);

                    ret.put("score", score);
                    ret.put("threshold", threshold);
                    ret.put("anomaly", anomaly);
                    ret.put("latencyMs", inferenceEngine.getLastLatencyMs());
                    ret.put("thresholdAdapted", thresholdAdapter.isAdapted(phase));

                    // Feature errors (which component is anomalous)
                    float[] errors = inferenceEngine.getLastFeatureErrors();
                    if (errors != null) {
                        JSArray errArr = new JSArray();
                        String[] featureNames = inferenceEngine.getFeatureCols();
                        for (int i = 0; i < errors.length && i < featureNames.length; i++) {
                            JSObject fe = new JSObject();
                            fe.put("name", featureNames[i]);
                            fe.put("error", errors[i]);
                            errArr.put(fe);
                        }
                        ret.put("featureErrors", errArr);
                    }

                    // Advisories
                    JSArray advArr = new JSArray();
                    for (EngineAdvisor.Advisory adv : advisories) {
                        JSObject a = new JSObject();
                        a.put("message", adv.message);
                        a.put("severity", adv.severity);
                        a.put("category", adv.category);
                        advArr.put(a);
                    }
                    ret.put("advisories", advArr);

                } catch (TimeoutException te) {
                    // Inference hung — resolve without score so the plugin stays responsive.
                    // The JS side will see phase+windowReady but no score for this sample.
                    Log.w(TAG, "Inference timed out — resolving without score");
                } catch (Exception ie) {
                    Log.w(TAG, "Inference error — resolving without score", ie);
                }
            }

            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "processSample error", e);
            call.reject("processSample failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("initialized", initialized);
        if (initialized) {
            ret.put("delegate", inferenceEngine.getActiveDelegate());
            ret.put("windowFull", windowFull);
            ret.put("windowPos", windowPos);
            ret.put("globalThreshold", inferenceEngine.getGlobalThreshold());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void resetThresholds(PluginCall call) {
        if (thresholdAdapter != null) {
            thresholdAdapter.resetAll();
        }
        call.resolve(new JSObject().put("status", "ok"));
    }

    /** Safe float extraction from PluginCall (handles nullable Double) */
    private static float f(PluginCall call, String key) {
        Double v = call.getDouble(key, 0.0);
        return v != null ? v.floatValue() : 0f;
    }

    @Override
    protected void handleOnDestroy() {
        if (inferenceEngine != null) {
            inferenceEngine.close();
            Log.i(TAG, "EngineML resources released");
        }
    }
}
