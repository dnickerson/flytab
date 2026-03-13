package app.flywhere.engineml;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import org.tensorflow.lite.Interpreter;
import org.tensorflow.lite.gpu.GpuDelegate;
import org.tensorflow.lite.nnapi.NnApiDelegate;

import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.HashMap;
import java.util.Map;

public class InferenceEngine {
    private static final String TAG = "InferenceEngine";

    private Interpreter interpreter;
    private String activeDelegate = "NONE";

    // Model metadata
    private int windowSize;
    private int nFeatures;
    private String[] featureCols;
    private float[] mean;
    private float[] std;
    private float globalThreshold;
    private Map<String, Float> phaseThresholds = new HashMap<>();

    // INT8 quantization parameters — set from model inspection
    private float inputScale;
    private int inputZeroPoint;
    private float outputScale;
    private int outputZeroPoint;

    // Inference results
    private float lastAnomalyScore = 0f;
    private float[] lastFeatureErrors;
    private long lastLatencyNanos = 0;
    private boolean lastIsAnomaly = false;

    public interface DelegateCallback {
        void onDelegateSelected(String delegateName);
    }

    public InferenceEngine(Context context, DelegateCallback callback) {
        loadMetadata(context);
        loadModel(context, callback);
        lastFeatureErrors = new float[nFeatures];
    }

    private void loadMetadata(Context context) {
        try (InputStream is = context.getAssets().open("anomaly_v2_metadata.json");
             InputStreamReader reader = new InputStreamReader(is)) {
            Gson gson = new Gson();
            JsonObject meta = gson.fromJson(reader, JsonObject.class);

            windowSize = meta.get("window_size").getAsInt();
            nFeatures = meta.get("n_features").getAsInt();
            globalThreshold = meta.get("threshold").getAsFloat();

            JsonArray cols = meta.getAsJsonArray("feature_cols");
            featureCols = new String[cols.size()];
            for (int i = 0; i < cols.size(); i++) {
                featureCols[i] = cols.get(i).getAsString();
            }

            JsonObject norm = meta.getAsJsonObject("normalization");
            JsonArray meanArr = norm.getAsJsonArray("mean");
            JsonArray stdArr = norm.getAsJsonArray("std");
            mean = new float[nFeatures];
            std = new float[nFeatures];
            for (int i = 0; i < nFeatures; i++) {
                mean[i] = meanArr.get(i).getAsFloat();
                std[i] = stdArr.get(i).getAsFloat();
            }

            // Load per-phase thresholds
            if (meta.has("phase_thresholds")) {
                JsonObject pt = meta.getAsJsonObject("phase_thresholds");
                for (String key : pt.keySet()) {
                    phaseThresholds.put(key, pt.get(key).getAsFloat());
                }
            }

            Log.i(TAG, "Metadata loaded: v" + meta.get("version").getAsInt()
                    + ", " + nFeatures + " features, window=" + windowSize
                    + ", global_threshold=" + globalThreshold
                    + ", phases=" + phaseThresholds.size());
        } catch (Exception e) {
            Log.e(TAG, "Failed to load metadata", e);
            throw new RuntimeException("Cannot load model metadata", e);
        }
    }

    private void loadModel(Context context, DelegateCallback callback) {
        try {
            MappedByteBuffer modelBuffer = loadModelFile(context);

            if (tryQnnDelegate(modelBuffer, callback)) { readQuantParams(); return; }
            if (tryGpuDelegate(modelBuffer, callback)) { readQuantParams(); return; }

            Log.i(TAG, "Using CPU delegate");
            Interpreter.Options options = new Interpreter.Options();
            options.setNumThreads(4);
            interpreter = new Interpreter(modelBuffer, options);
            activeDelegate = "CPU";
            if (callback != null) callback.onDelegateSelected("CPU");

            readQuantParams();
        } catch (Exception e) {
            Log.e(TAG, "Failed to load model", e);
            throw new RuntimeException("Cannot load TFLite model", e);
        }
    }

    private void readQuantParams() {
        // Read quantization params directly from the loaded interpreter
        int[] inputShape = interpreter.getInputTensor(0).shape();
        inputScale = interpreter.getInputTensor(0).quantizationParams().getScale();
        inputZeroPoint = interpreter.getInputTensor(0).quantizationParams().getZeroPoint();
        outputScale = interpreter.getOutputTensor(0).quantizationParams().getScale();
        outputZeroPoint = interpreter.getOutputTensor(0).quantizationParams().getZeroPoint();
        Log.i(TAG, String.format("Quantization: input(scale=%.6f, zp=%d) output(scale=%.6f, zp=%d)",
                inputScale, inputZeroPoint, outputScale, outputZeroPoint));
    }

    private boolean tryQnnDelegate(MappedByteBuffer modelBuffer, DelegateCallback callback) {
        // NNAPI delegate — on Snapdragon 8 Gen 4, can route to Hexagon NPU via QNN HAL
        try {
            NnApiDelegate.Options nnOptions = new NnApiDelegate.Options();
            nnOptions.setAllowFp16(true);
            NnApiDelegate nnApiDelegate = new NnApiDelegate(nnOptions);
            Interpreter.Options options = new Interpreter.Options();
            options.addDelegate(nnApiDelegate);
            interpreter = new Interpreter(modelBuffer, options);

            // Run a warmup inference to measure if NNAPI is actually accelerating
            ByteBuffer warmInput = ByteBuffer.allocateDirect(windowSize * nFeatures);
            warmInput.order(ByteOrder.nativeOrder());
            ByteBuffer warmOutput = ByteBuffer.allocateDirect(windowSize * nFeatures);
            warmOutput.order(ByteOrder.nativeOrder());

            long warmStart = System.nanoTime();
            interpreter.run(warmInput, warmOutput);
            long warmMs = (System.nanoTime() - warmStart) / 1_000_000;

            // If NNAPI+NPU is active, inference should be very fast (<2ms)
            // If it fell through to XNNPACK CPU, it'll still work but slightly slower
            String delegateLabel = warmMs < 2 ? "NPU (NNAPI)" : "NNAPI+CPU";
            activeDelegate = delegateLabel;
            Log.i(TAG, String.format("NNAPI delegate loaded (warmup: %dms → %s)", warmMs, delegateLabel));
            if (callback != null) callback.onDelegateSelected(delegateLabel);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "NNAPI delegate not available: " + e.getMessage());
            return false;
        }
    }

    private boolean tryGpuDelegate(MappedByteBuffer modelBuffer, DelegateCallback callback) {
        try {
            GpuDelegate gpuDelegate = new GpuDelegate();
            Interpreter.Options options = new Interpreter.Options();
            options.addDelegate(gpuDelegate);
            interpreter = new Interpreter(modelBuffer, options);
            activeDelegate = "GPU";
            Log.i(TAG, "GPU delegate loaded");
            if (callback != null) callback.onDelegateSelected("GPU");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "GPU delegate not available: " + e.getMessage());
            return false;
        }
    }

    private MappedByteBuffer loadModelFile(Context context) throws Exception {
        AssetFileDescriptor afd = context.getAssets().openFd("anomaly_v2.tflite");
        FileInputStream fis = new FileInputStream(afd.getFileDescriptor());
        FileChannel fc = fis.getChannel();
        MappedByteBuffer buffer = fc.map(FileChannel.MapMode.READ_ONLY,
                afd.getStartOffset(), afd.getDeclaredLength());
        fis.close();
        return buffer;
    }

    /**
     * Run inference on a (windowSize, nFeatures) window of raw engine data.
     */
    public float runInference(float[][] window) {
        if (window == null || window.length != windowSize || window[0].length != nFeatures) {
            throw new IllegalArgumentException("Window must be (" + windowSize + ", " + nFeatures + ")");
        }

        long startNanos = System.nanoTime();

        // Z-score normalize then INT8 quantize
        ByteBuffer inputBuffer = ByteBuffer.allocateDirect(windowSize * nFeatures);
        inputBuffer.order(ByteOrder.nativeOrder());
        for (int t = 0; t < windowSize; t++) {
            for (int f = 0; f < nFeatures; f++) {
                float normalized = (window[t][f] - mean[f]) / std[f];
                int quantized = Math.round(normalized / inputScale) + inputZeroPoint;
                quantized = Math.max(-128, Math.min(127, quantized));
                inputBuffer.put((byte) quantized);
            }
        }
        inputBuffer.rewind();

        ByteBuffer outputBuffer = ByteBuffer.allocateDirect(windowSize * nFeatures);
        outputBuffer.order(ByteOrder.nativeOrder());

        interpreter.run(inputBuffer, outputBuffer);
        outputBuffer.rewind();

        // Dequantize and compute MSE
        float totalMse = 0f;
        float[] featureSum = new float[nFeatures];

        for (int t = 0; t < windowSize; t++) {
            for (int f = 0; f < nFeatures; f++) {
                int outQuantized = outputBuffer.get();
                float outNormalized = (outQuantized - outputZeroPoint) * outputScale;
                float inNormalized = (window[t][f] - mean[f]) / std[f];

                float error = inNormalized - outNormalized;
                float squaredError = error * error;
                totalMse += squaredError;
                featureSum[f] += squaredError;
            }
        }

        totalMse /= (windowSize * nFeatures);
        for (int f = 0; f < nFeatures; f++) {
            lastFeatureErrors[f] = featureSum[f] / windowSize;
        }

        lastLatencyNanos = System.nanoTime() - startNanos;
        lastAnomalyScore = totalMse;

        return totalMse;
    }

    /**
     * Check if the score is anomalous for the given phase.
     */
    public boolean isAnomaly(float score, String phase) {
        float threshold = getThresholdForPhase(phase);
        lastIsAnomaly = score > threshold;
        return lastIsAnomaly;
    }

    /**
     * Get the threshold for a specific phase.
     */
    public float getThresholdForPhase(String phase) {
        Float pt = phaseThresholds.get(phase);
        return pt != null ? pt : globalThreshold;
    }

    // Getters
    public float getLastAnomalyScore() { return lastAnomalyScore; }
    public float[] getLastFeatureErrors() { return lastFeatureErrors; }
    public long getLastLatencyNanos() { return lastLatencyNanos; }
    public float getLastLatencyMs() { return lastLatencyNanos / 1_000_000f; }
    public boolean isLastAnomaly() { return lastIsAnomaly; }
    public String getActiveDelegate() { return activeDelegate; }
    public float getGlobalThreshold() { return globalThreshold; }
    public Map<String, Float> getPhaseThresholds() { return phaseThresholds; }
    public int getWindowSize() { return windowSize; }
    public int getNFeatures() { return nFeatures; }
    public String[] getFeatureCols() { return featureCols; }
    public float[] getMean() { return mean; }
    public float[] getStd() { return std; }

    public void close() {
        if (interpreter != null) {
            interpreter.close();
            interpreter = null;
        }
    }
}
