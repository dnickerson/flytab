package app.flywhere.flytab.engineml;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import org.tensorflow.lite.DataType;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

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

    // Tensor dtype — detected at load time from the actual model, not from metadata
    private boolean isFloat32 = false;

    // INT8 quantization parameters (only used when isFloat32 == false)
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

            if (tryQnnDelegate(modelBuffer, callback)) { readTensorParams(); return; }
            if (tryGpuDelegate(modelBuffer, callback)) { readTensorParams(); return; }

            Log.i(TAG, "Using CPU delegate");
            Interpreter.Options options = new Interpreter.Options();
            options.setNumThreads(4);
            interpreter = new Interpreter(modelBuffer, options);
            activeDelegate = "CPU";
            if (callback != null) callback.onDelegateSelected("CPU");

            readTensorParams();
        } catch (Exception e) {
            Log.e(TAG, "Failed to load model", e);
            throw new RuntimeException("Cannot load TFLite model", e);
        }
    }

    /**
     * Detect actual input/output dtype from the loaded interpreter.
     * Authoritative source — do NOT rely on metadata "quantization" field.
     */
    private void readTensorParams() {
        DataType dtype = interpreter.getInputTensor(0).dataType();
        isFloat32 = (dtype == DataType.FLOAT32);

        inputScale = interpreter.getInputTensor(0).quantizationParams().getScale();
        inputZeroPoint = interpreter.getInputTensor(0).quantizationParams().getZeroPoint();
        outputScale = interpreter.getOutputTensor(0).quantizationParams().getScale();
        outputZeroPoint = interpreter.getOutputTensor(0).quantizationParams().getZeroPoint();

        Log.i(TAG, String.format("Model dtype: %s (%s), quant: in(scale=%.6f, zp=%d) out(scale=%.6f, zp=%d)",
                dtype, isFloat32 ? "float array path" : "INT8 ByteBuffer path",
                inputScale, inputZeroPoint, outputScale, outputZeroPoint));
    }

    private boolean tryQnnDelegate(MappedByteBuffer modelBuffer, DelegateCallback callback) {
        try {
            NnApiDelegate.Options nnOptions = new NnApiDelegate.Options();
            nnOptions.setAllowFp16(true);
            NnApiDelegate nnApiDelegate = new NnApiDelegate(nnOptions);
            Interpreter.Options options = new Interpreter.Options();
            options.addDelegate(nnApiDelegate);
            interpreter = new Interpreter(modelBuffer, options);

            // Detect dtype before warmup so we allocate the right buffer type
            readTensorParams();

            // Warmup — use float arrays for float32, ByteBuffer for INT8
            long warmStart = System.nanoTime();
            if (isFloat32) {
                float[][][] warmIn  = new float[1][windowSize][nFeatures];
                float[][][] warmOut = new float[1][windowSize][nFeatures];
                interpreter.run(warmIn, warmOut);
            } else {
                ByteBuffer warmIn  = ByteBuffer.allocateDirect(windowSize * nFeatures);
                ByteBuffer warmOut = ByteBuffer.allocateDirect(windowSize * nFeatures);
                warmIn.order(ByteOrder.nativeOrder());
                warmOut.order(ByteOrder.nativeOrder());
                interpreter.run(warmIn, warmOut);
            }
            long warmMs = (System.nanoTime() - warmStart) / 1_000_000;

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

    // Safety timeout — catches any future model/delegate hangs without blocking the plugin.
    private static final long INFERENCE_TIMEOUT_MS = 500;

    /**
     * Run inference on a (windowSize, nFeatures) window of raw engine data.
     *
     * Float32 models: uses float[][][] Java arrays — compatible with XNNPACK partial delegation.
     * INT8 models: uses ByteBuffer with quantization math.
     */
    public float runInference(float[][] window) throws TimeoutException {
        if (window == null || window.length != windowSize || window[0].length != nFeatures) {
            throw new IllegalArgumentException("Window must be (" + windowSize + ", " + nFeatures + ")");
        }

        final float[][] w = window;
        final long startNanos = System.nanoTime();

        // Z-score normalize — shared by both paths
        final float[][][] normalizedInput = new float[1][windowSize][nFeatures];
        for (int t = 0; t < windowSize; t++) {
            for (int f = 0; f < nFeatures; f++) {
                normalizedInput[0][t][f] = (w[t][f] - mean[f]) / std[f];
            }
        }

        // Build typed input/output for the interpreter
        final Object inferInput;
        final Object inferOutput;

        if (isFloat32) {
            // float[][][] — canonical type for float32 TFLite, works with XNNPACK
            inferInput = normalizedInput;
            inferOutput = new float[1][windowSize][nFeatures];
        } else {
            // ByteBuffer — INT8 quantized path
            ByteBuffer inBuf = ByteBuffer.allocateDirect(windowSize * nFeatures);
            inBuf.order(ByteOrder.nativeOrder());
            for (int t = 0; t < windowSize; t++) {
                for (int f = 0; f < nFeatures; f++) {
                    float norm = normalizedInput[0][t][f];
                    int q = inputScale > 0
                        ? Math.round(norm / inputScale) + inputZeroPoint
                        : Math.round(norm * 127f);
                    inBuf.put((byte) Math.max(-128, Math.min(127, q)));
                }
            }
            inBuf.rewind();
            inferInput = inBuf;
            ByteBuffer outBuf = ByteBuffer.allocateDirect(windowSize * nFeatures);
            outBuf.order(ByteOrder.nativeOrder());
            inferOutput = outBuf;
        }

        ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "tflite-inference");
            t.setDaemon(true);
            return t;
        });

        Future<?> future = exec.submit(() -> interpreter.run(inferInput, inferOutput));

        try {
            future.get(INFERENCE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            Log.w(TAG, "TFLite inference timed out after " + INFERENCE_TIMEOUT_MS + "ms — skipping score");
            throw e;
        } catch (Exception e) {
            Log.e(TAG, "TFLite inference failed", e);
            throw new RuntimeException("Inference failed: " + e.getMessage(), e);
        } finally {
            exec.shutdownNow();
        }

        // Compute MSE between normalized input and model output
        float totalMse = 0f;
        float[] featureSum = new float[nFeatures];

        if (isFloat32) {
            float[][][] out = (float[][][]) inferOutput;
            for (int t = 0; t < windowSize; t++) {
                for (int f = 0; f < nFeatures; f++) {
                    float error = normalizedInput[0][t][f] - out[0][t][f];
                    float sq = error * error;
                    totalMse += sq;
                    featureSum[f] += sq;
                }
            }
        } else {
            ByteBuffer outBuf = (ByteBuffer) inferOutput;
            outBuf.rewind();
            for (int t = 0; t < windowSize; t++) {
                for (int f = 0; f < nFeatures; f++) {
                    int outQ = outBuf.get();
                    float outNorm = outputScale > 0
                        ? (outQ - outputZeroPoint) * outputScale
                        : outQ / 127f;
                    float error = normalizedInput[0][t][f] - outNorm;
                    float sq = error * error;
                    totalMse += sq;
                    featureSum[f] += sq;
                }
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

    public boolean isAnomaly(float score, String phase) {
        float threshold = getThresholdForPhase(phase);
        lastIsAnomaly = score > threshold;
        return lastIsAnomaly;
    }

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
    public boolean isFloat32() { return isFloat32; }

    public void close() {
        if (interpreter != null) {
            interpreter.close();
            interpreter = null;
        }
    }
}
